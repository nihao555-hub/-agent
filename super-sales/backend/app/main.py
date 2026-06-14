"""FastAPI entrypoint for AI Super Sales.

Exposes:
  GET  /api/health      — engine + retrieval backend status
  GET  /api/sample      — a demo conversation to prefill the UI
  POST /api/run         — run the whole pipeline, return final state (JSON)
  POST /api/run/stream  — run the pipeline, stream每个 agent 的进度与结果 (SSE)
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import channels, closer, llm, simulator, store
from .graph import NODE_OUTPUT_FIELD, PIPELINE, build_graph
from .retrieval import retrieval_backend
from .state import SalesState

app = FastAPI(title="AI 超级销售", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_graph = build_graph()

SAMPLE_CONVERSATION = """\
客户：你好，我看了你们速达云的进销存系统。
我：王总您好！是的，我们专门做食品批发这一块的进销存+对账。
客户：我们现在用的管家婆，一年才两三千，你们这个是不是贵不少？
我：我们标准版确实比单机版高一些，但多门店对账、智能核账这块能省很多人力。
客户：嗯……我们有 5 个档口，对账确实头疼，经常对不平。
我：那我们这套就很合适，对账自动核平，出错能追溯到单据。
客户：价格还是有点高，我再考虑考虑吧，最近也忙。
我：好的王总，那您先看看资料。
（客户已读未回，2 天没消息）
"""


class RunRequest(BaseModel):
    conversation: str = Field(..., description="客户的微信/私域聊天记录")
    product: str = Field("", description="在卖什么产品（可选）")
    seller_notes: str = Field("", description="销售补充备注（可选）")


@app.get("/api/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "engine": "llm" if llm.llm_available() else "fallback",
        "model": llm.model_name() if llm.llm_available() else None,
        "retrieval_backend": retrieval_backend(),
        "pipeline": [{"key": k, "label": v} for k, v in PIPELINE],
        "channels": channels.list_channels(),
        "live_closer": True,
        "sales_stages": closer.STAGES,
        "personas": simulator.list_personas(),
    }


@app.get("/api/playbook")
def playbook() -> dict[str, object]:
    from .knowledge import PLAYBOOK

    return {"count": len(PLAYBOOK), "items": PLAYBOOK}


@app.get("/api/sample")
def sample() -> dict[str, str]:
    return {
        "conversation": SAMPLE_CONVERSATION,
        "product": "速达云食品批发进销存 SaaS",
    }


def _initial_state(req: RunRequest) -> SalesState:
    return SalesState(
        conversation=req.conversation,
        product=req.product,
        seller_notes=req.seller_notes,
        evidence=[],
        meta={},
    )


@app.post("/api/run")
def run(req: RunRequest) -> dict[str, object]:
    final = _graph.invoke(_initial_state(req))
    return dict(final)


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _run_stream(req: RunRequest) -> AsyncGenerator[str, None]:
    plan = [{"key": k, "label": v} for k, v in PIPELINE]
    yield _sse(
        "start",
        {
            "plan": plan,
            "engine": "llm" if llm.llm_available() else "fallback",
            "retrieval_backend": retrieval_backend(),
        },
    )

    # The LangGraph run is synchronous and CPU/IO blocking (LLM calls). Run it in
    # a worker thread and push each node update onto an asyncio queue so the event
    # loop stays free to flush every SSE chunk the moment a node finishes.
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, object] | None] = asyncio.Queue()
    state = _initial_state(req)

    def _worker() -> None:
        local = dict(state)
        try:
            for update in _graph.stream(state, stream_mode="updates"):
                for node_name, partial in update.items():
                    field = NODE_OUTPUT_FIELD.get(node_name, node_name)
                    result = partial.get(field) if isinstance(partial, dict) else None
                    if isinstance(partial, dict):
                        local.update(partial)
                    loop.call_soon_threadsafe(
                        queue.put_nowait,
                        ("step", {"node": node_name, "field": field, "result": result}),
                    )
            loop.call_soon_threadsafe(queue.put_nowait, ("done", {"state": local}))
        except Exception as exc:  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, ("error", {"message": str(exc)}))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=_worker, daemon=True).start()

    while True:
        item = await queue.get()
        if item is None:
            break
        event, data = item
        yield _sse(event, data)


@app.post("/api/run/stream")
async def run_stream(req: RunRequest) -> StreamingResponse:
    return StreamingResponse(
        _run_stream(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ====================================================================== 实时成交闭环
# Live AI-closer: durable per-customer conversations across channels.


class CustomerCreate(BaseModel):
    name: str
    platform: str = "sandbox"
    country: str = ""
    category: str = ""


class InboundMessage(BaseModel):
    text: str = Field(..., description="客户发来的消息")
    auto_send: bool = Field(True, description="是否自动把 AI 生成的回复发出去")


class ManualMessage(BaseModel):
    text: str


class ProductCreate(BaseModel):
    name: str
    summary: str = ""
    details: str = ""
    price_info: str = ""


class AssetCreate(BaseModel):
    product_id: str
    kind: str = "image"
    filename: str
    caption: str = ""
    shareable: bool = True


class SettingsUpdate(BaseModel):
    values: dict[str, str]


@app.get("/api/channels")
def get_channels() -> dict[str, object]:
    return {"channels": channels.list_channels()}


@app.get("/api/settings")
def read_settings() -> dict[str, str]:
    return store.get_settings()


@app.post("/api/settings")
def write_settings(req: SettingsUpdate) -> dict[str, str]:
    return store.update_settings(req.values)


@app.get("/api/customers")
def get_customers() -> dict[str, object]:
    return {"customers": store.list_customers()}


@app.post("/api/customers")
def post_customer(req: CustomerCreate) -> dict[str, object]:
    return store.create_customer(req.name, req.platform, req.country, req.category)


@app.get("/api/customers/{cid}")
def get_customer_detail(cid: str) -> dict[str, object]:
    customer = store.get_customer(cid)
    if customer is None:
        return {"error": "customer not found"}
    return {
        "customer": customer,
        "messages": store.list_messages(cid),
        "memory": store.list_memory(cid),
    }


@app.post("/api/customers/{cid}/inbound")
def post_inbound(cid: str, req: InboundMessage) -> dict[str, object]:
    if store.get_customer(cid) is None:
        return {"error": "customer not found"}
    inbound_msg = store.add_message(cid, "customer", req.text)
    decision = closer.decide(cid, req.text)
    # backfill the operator-facing translation onto the customer's message (双语对照)
    store.set_message_translation(
        inbound_msg["id"],
        decision.get("inbound_translation", ""),
        decision.get("customer_lang", ""),
    )
    sent: list[dict[str, object]] = []
    if req.auto_send:
        sent = closer.apply_decision(cid, decision)
    decision.pop("evidence", None)
    return {
        "decision": decision,
        "sent": sent,
        "customer": store.get_customer(cid),
        "messages": store.list_messages(cid),
        "memory": store.list_memory(cid),
    }


class SimulateRequest(BaseModel):
    persona: str = Field("skeptic", description="客户人设 key")
    auto_send: bool = Field(True, description="生成客户消息后是否立即跑 AI 销冠回复")


@app.post("/api/customers/{cid}/simulate")
def post_simulate(cid: str, req: SimulateRequest) -> dict[str, object]:
    """Generate the *customer*'s next message (in character) and optionally let
    the AI closer respond — lets us pressure-test against different tempers."""
    if store.get_customer(cid) is None:
        return {"error": "customer not found"}
    sim = simulator.next_message(cid, req.persona)
    if not req.auto_send:
        msg = store.add_message(cid, "customer", sim["text"])
        return {"customer_message": msg, "persona": sim["persona"], "messages": store.list_messages(cid)}
    result = post_inbound(cid, InboundMessage(text=sim["text"], auto_send=True))
    result["persona"] = sim["persona"]
    return result


@app.post("/api/customers/{cid}/send")
def post_send(cid: str, req: ManualMessage) -> dict[str, object]:
    if store.get_customer(cid) is None:
        return {"error": "customer not found"}
    return store.add_message(cid, "agent", req.text)


@app.get("/api/products")
def get_products() -> dict[str, object]:
    return {"products": store.list_products()}


@app.post("/api/products")
def post_product(req: ProductCreate) -> dict[str, object]:
    return store.create_product(req.name, req.summary, req.details, req.price_info)


@app.post("/api/assets")
def post_asset(req: AssetCreate) -> dict[str, object]:
    return store.add_asset(req.product_id, req.kind, req.filename, req.caption, req.shareable)
