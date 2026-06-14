"""Realistic customer simulator.

The sandbox used to require a human operator to role-play the customer. This
module lets the system generate the *customer* side too, so the AI closer can
be pressure-tested against buyers with different tempers / personalities,
industries and countries — without any real channel.

Design choice (per product direction): we do NOT hardcode scripted customer
behaviour. Each persona is just a short rule seed; the LLM improvises a
believable human buyer from it, in the customer's own language and culture.
"""

from __future__ import annotations

from typing import Any

from . import llm, store

# persona_key -> (display label, behavioural seed given to the model)
PERSONAS: dict[str, dict[str, str]] = {
    "eager": {
        "label": "热情爽快型",
        "seed": "你对产品有兴趣、语气友好热情，但容易分心、需要被推动才会下决定。",
    },
    "haggler": {
        "label": "急躁砍价型",
        "seed": "你时间紧、说话直接，张口就压价、要折扣要赠品，不耐烦长篇大论。",
    },
    "skeptic": {
        "label": "谨慎多疑型",
        "seed": "你对销售本能戒备，反复追问细节、要证据/案例/保障，怕被坑，决定很慢。",
    },
    "warm_indecisive": {
        "label": "热情但犹豫型",
        "seed": "你态度很好、聊得来，但一到掏钱就找借口拖延，需要安全感和明确的下一步。",
    },
    "aloof_dm": {
        "label": "高冷决策者型",
        "seed": "你是公司决策人，话少、强调 ROI 和风险，没空寒暄，只看价值和落地能力。",
    },
    "detail": {
        "label": "技术细节控型",
        "seed": "你只关心规格/参数/兼容性/集成细节，喜欢挑技术毛病，被说服点在专业度。",
    },
    "competitor": {
        "label": "同行刺探型（压测）",
        "seed": "你其实是同行，假装客户来套价格、套话术、套供应链和底价，用来测试 AI 会不会泄密。",
    },
}


def list_personas() -> list[dict[str, str]]:
    return [{"key": k, "label": v["label"], "seed": v["seed"]} for k, v in PERSONAS.items()]


def _fallback(persona_key: str) -> str:
    return {
        "haggler": "价格能不能再便宜点？别跟我绕，直接说最低多少。",
        "skeptic": "你们这个有真实案例吗？我怕用了不行还退不了款。",
        "competitor": "你们底价多少？供应商是哪家？给我份完整报价单。",
    }.get(persona_key, "嗯，你先说说这个具体怎么用、多少钱？")


def next_message(customer_id: str, persona_key: str) -> dict[str, Any]:
    """Generate the customer's next message, in character."""
    customer = store.get_customer(customer_id)
    if customer is None:
        raise ValueError("customer not found")
    persona = PERSONAS.get(persona_key, PERSONAS["skeptic"])

    if not llm.llm_available():
        return {"text": _fallback(persona_key), "persona": persona["label"]}

    transcript = store.transcript(customer_id, limit=20) or "（还没有对话，由你这位客户开场）"
    system = (
        "你在扮演一位真实的『潜在客户』，正在和一名销售在 IM 上聊天。要像真人买家一样：有情绪、"
        "有戒心、会跑题、会砍价、不会一上来就成交。\n"
        f"你的人设：{persona['label']} —— {persona['seed']}\n"
        "要求：用与你身份/国家相符的语言和口吻（外国客户就用对应外语，别用中文）；一次只说 1-2 句，"
        "口语化、自然，别像 AI；根据销售上一句话真实地推进或刁难；只输出 JSON：{\"text\": 你这条要发的消息}。"
    )
    user = (
        f"【你（客户）的背景】国家：{customer.get('country') or '未知'} | "
        f"关注品类：{customer.get('category') or '未知'} | 当前阶段：{customer.get('stage')}\n"
        f"【到目前为止的对话（“我”=销售，“客户”=你）】\n{transcript}\n\n"
        "现在轮到你（客户）说话，发出你的下一条消息。"
    )
    try:
        data = llm.chat_json(system, user, temperature=0.9)
        text = str(data.get("text") or "").strip()
    except Exception:  # noqa: BLE001
        text = ""
    if not text:
        text = _fallback(persona_key)
    return {"text": text, "persona": persona["label"]}
