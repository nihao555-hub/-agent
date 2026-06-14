"""Real-time AI closer — the autonomous deal-closing decision loop.

Where the original pipeline analyses a *finished* transcript once, this drives a
*live* conversation: given the customer's latest inbound message plus durable
memory + product catalog + seller settings + retrieved methodology, it makes one
orchestrated decision and returns:

  * ``cot``      — the chain-of-thought, one step per internal role
                   (记忆官 / 线索情报官 / 本地化官 / 策略官 / 隐私红线官 / 拟人化官),
                   so the UI right panel can show the agent thinking live.
  * ``reply``    — the actual short messages to send (split, human-like).
  * ``send_asset`` — an optional product asset id to attach (privacy-checked).
  * ``stage`` / ``win_score`` / ``next_step`` — updated deal state.
  * ``new_memory`` — facts to persist (pain / commitment / objection / preference / taboo).
  * ``handoff``  — whether to hand off to a human (payment / contract / red-line hit).
  * ``cited``    — methodology IDs grounding the decision (溯源).

It degrades gracefully to a deterministic reply when no LLM key is configured.
"""

from __future__ import annotations

from typing import Any

from . import llm, store
from .retrieval import retrieve

# Country → methodology IDs to bias localization retrieval toward.
_COUNTRY_HINTS: dict[str, str] = {
    "美国": "GLOBAL-01 北美 ROI 直接",
    "us": "GLOBAL-01 北美 ROI 直接",
    "日本": "GLOBAL-02 日本 礼仪 稟議 LINE",
    "japan": "GLOBAL-02 日本 礼仪 稟議 LINE",
    "中东": "GLOBAL-03 中东 关系 议价 宗教",
    "沙特": "GLOBAL-03 中东 关系 议价 宗教",
    "迪拜": "GLOBAL-03 中东 关系 议价 宗教",
    "东南亚": "GLOBAL-04 东南亚 关系 价格 移动端",
    "印尼": "GLOBAL-04 东南亚 印尼 宗教",
    "泰国": "GLOBAL-04 东南亚 泰国 礼貌",
    "越南": "GLOBAL-04 东南亚 越南 性价比",
    "欧洲": "GLOBAL-05 欧洲 严谨 GDPR 流程",
    "德国": "GLOBAL-05 德国 规格 质保",
    "拉美": "GLOBAL-06 拉美 热情 关系 西语",
    "巴西": "GLOBAL-06 巴西 葡语 WhatsApp Pix",
    "印度": "GLOBAL-07 印度 议价 性价比",
    "中国": "GLOBAL-08 中国 私域 人情 面子",
    "韩国": "GLOBAL-11 韩国 等级 KakaoTalk",
    "非洲": "GLOBAL-12 非洲 移动 M-Pesa",
}

_CATEGORY_HINTS: dict[str, str] = {
    "saas": "CAT-SAAS 软件 ROI 试用",
    "软件": "CAT-SAAS 软件 ROI 试用",
    "电商": "CAT-ECOM 实物 图片 视频 促销",
    "零售": "CAT-ECOM 实物 图片 视频 促销",
    "大宗": "CAT-HIGHTICKET 高客单 MEDDIC",
    "设备": "CAT-HIGHTICKET 高客单 MEDDIC",
    "金融": "CAT-FININS 合规 信任",
    "保险": "CAT-FININS 合规 信任",
    "教育": "CAT-EDU 体验课 效果",
    "外贸": "CAT-TRADE 报价 物流 付款",
    "跨境": "CAT-TRADE 报价 物流 付款",
}


def _hint(mapping: dict[str, str], value: str) -> str:
    v = (value or "").lower()
    for key, hint in mapping.items():
        if key in v:
            return hint
    return ""


def _localization_query(customer: dict[str, Any], settings: dict[str, str]) -> str:
    country = customer.get("country") or settings.get("target_country", "")
    category = customer.get("category") or settings.get("target_category", "")
    return " ".join(filter(None, [_hint(_COUNTRY_HINTS, country), _hint(_CATEGORY_HINTS, category)]))


def _fallback_decision(customer: dict[str, Any], inbound: str) -> dict[str, Any]:
    return {
        "cot": [
            {"role": "记忆官", "thought": "读取该客户历史与已知痛点/承诺，确认未重复发问。"},
            {"role": "线索情报官", "thought": "据画像判断当前阶段与决策角色，评估赢率。"},
            {"role": "本地化官", "thought": "按客户国家/品类调整称呼、语气与行话。"},
            {"role": "策略官", "thought": "用 SPIN 影响类提问把痛点量化，避免直接报死价。"},
            {"role": "隐私红线官", "thought": "本条回复不涉及成本价/利润/客户隐私，放行。"},
            {"role": "拟人化官", "thought": "拆成两条短消息，口语化，结尾给一个二选一下一步。"},
        ],
        "reply": [
            "收到～我先确认下你最在意的是价格、还是切换会不会麻烦？",
            "你方便的话，我可以拿你的真实场景给你算一笔账，看到底值不值，今天下午还是明天上午合适？",
        ],
        "send_asset": "",
        "stage": customer.get("stage", "认知"),
        "win_score": customer.get("win_score", 40),
        "next_step": "约一次 15 分钟场景测算/演示",
        "new_memory": [],
        "handoff": False,
        "handoff_reason": "",
        "cited": ["DISC-04", "CHAT-04", "HUMAN-02"],
    }


def _build_query(customer: dict[str, Any], inbound: str, settings: dict[str, str]) -> str:
    return "\n".join(
        filter(
            None,
            [
                settings.get("target_category", ""),
                customer.get("category", ""),
                _localization_query(customer, settings),
                store.transcript(customer["id"], limit=20),
                inbound,
            ],
        )
    )


def _evidence_block(evidence: list[dict[str, Any]]) -> str:
    if not evidence:
        return "（无检索到的方法论片段）"
    return "\n".join(f"[{e['id']}] {e['title']}：{e['text']}" for e in evidence)


def _assets_summary(products: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for p in products:
        for a in p.get("assets", []):
            flag = "可对外" if a.get("shareable") else "禁止外发"
            lines.append(f"[{a['id']}] {a['kind']}·{a['filename']} 「{a.get('caption', '')}」({flag})")
    return "\n".join(lines) if lines else "（暂无可用素材）"


def decide(customer_id: str, inbound: str) -> dict[str, Any]:
    """Produce the next action for a live conversation turn."""
    customer = store.get_customer(customer_id)
    if customer is None:
        raise ValueError("customer not found")
    settings = store.get_settings()
    products = store.list_products()

    query = _build_query(customer, inbound, settings)
    evidence = retrieve(query, k=8)
    cited_ids = [e["id"] for e in evidence]

    fallback = _fallback_decision(customer, inbound)
    if not llm.llm_available():
        result = fallback
    else:
        disclosure = {
            "always": "对外必须主动表明你是 AI/智能客服。",
            "when_asked": "可像真人一样自然交流；被直接问到是否真人/AI 时如实告知，并可转人工；不主动强调也不主动欺骗。",
            "never": "尽量自然拟人（注意：部分辖区/平台要求披露身份，关闭披露可能有合规风险）。",
        }.get(settings.get("disclose_ai", "when_asked"), "")
        system = (
            "你是一位顶级『AI 销冠』，正在私域/IM 里和客户实时一对一聊天直到成单。"
            "你要同时扮演记忆官、线索情报官、本地化官、策略官、隐私红线官、拟人化官，做一次完整决策。\n"
            f"语气要求：{settings.get('tone', '')}；语言：{settings.get('language', '中文')}。\n"
            f"身份披露策略：{disclosure}\n"
            "硬红线（隐私红线官，绝不能违反）：以下信息绝不外发给客户——"
            f"{settings.get('privacy_redlines', '')}。需要用到时只用对外版表述。\n"
            "只输出一个 JSON 对象，字段："
            "cot(数组，每项含 role 和 thought，依次给出 记忆官/线索情报官/本地化官/策略官/隐私红线官/拟人化官 的思考)、"
            "reply(string数组，要发出去的消息，已按真人习惯拆成1-3条短消息、口语化、结尾带明确下一步)、"
            "send_asset(要附带发送的素材ID，没有则空字符串；只能选标记“可对外”的素材)、"
            "stage(更新后的阶段：认知/兴趣/评估/谈判/成交)、win_score(0-100整数赢率)、"
            "next_step(明确、低门槛、有时间点的下一步)、"
            "new_memory(数组，每项含 kind[pain|preference|commitment|objection|taboo|fact] 和 text，本轮新获取需长期记住的信息)、"
            "handoff(布尔，是否该转人工——涉及收款/合同/盖章或触红线时为true)、handoff_reason(字符串)、"
            "cited(引用的方法论片段ID数组)。"
        )
        user = (
            f"【公司/人设】{settings.get('company', '')} / {settings.get('persona_name', '')}"
            f"（{settings.get('persona_role', '')}）\n"
            f"【成交规则】{settings.get('deal_rules', '') or '（未设置，按通用销冠策略，涉及金额/合同转人工）'}\n"
            f"【客户】{customer.get('name')} | 平台：{customer.get('platform')} | "
            f"国家：{customer.get('country') or '未知'} | 品类：{customer.get('category') or '未知'} | "
            f"当前阶段：{customer.get('stage')} | 当前赢率：{customer.get('win_score')}\n"
            f"【客户记忆】\n{store.memory_block(customer_id)}\n"
            f"【商品与可用素材】\n{_assets_summary(products)}\n"
            f"【最近对话】\n{store.transcript(customer_id, limit=20)}\n"
            f"【客户最新消息】{inbound}\n\n"
            f"【可引用的方法论片段】\n{_evidence_block(evidence)}"
        )
        try:
            result = llm.chat_json(system, user, temperature=0.6)
        except Exception:  # noqa: BLE001
            result = fallback

    # normalise / guard
    result.setdefault("cot", fallback["cot"])
    reply = result.get("reply") or fallback["reply"]
    if isinstance(reply, str):
        reply = [reply]
    result["reply"] = [str(m) for m in reply if str(m).strip()]
    result["send_asset"] = _validate_asset(result.get("send_asset", ""), products)
    result.setdefault("stage", customer.get("stage", "认知"))
    result.setdefault("win_score", customer.get("win_score", 40))
    result.setdefault("next_step", "")
    result.setdefault("new_memory", [])
    result.setdefault("handoff", False)
    result.setdefault("handoff_reason", "")
    result.setdefault("cited", cited_ids[:5])
    result["evidence"] = evidence
    result["engine"] = "llm" if llm.llm_available() else "fallback"
    return result


def _validate_asset(asset_id: str, products: list[dict[str, Any]]) -> str:
    """Privacy red-line: only allow attaching assets explicitly marked shareable."""
    if not asset_id:
        return ""
    for p in products:
        for a in p.get("assets", []):
            if a["id"] == asset_id and a.get("shareable"):
                return asset_id
    return ""


def apply_decision(customer_id: str, decision: dict[str, Any]) -> list[dict[str, Any]]:
    """Persist a decision: send agent messages, update state, store new memory."""
    sent: list[dict[str, Any]] = []
    asset_id = decision.get("send_asset", "")
    for i, text in enumerate(decision.get("reply", [])):
        aid = asset_id if i == len(decision["reply"]) - 1 else ""
        sent.append(store.add_message(customer_id, "agent", text, asset_id=aid))
    for fact in decision.get("new_memory", []):
        if isinstance(fact, dict) and fact.get("text"):
            store.add_memory(customer_id, fact.get("kind", "fact"), str(fact["text"]))
    store.update_customer(
        customer_id,
        stage=decision.get("stage", "认知"),
        win_score=int(decision.get("win_score", 0) or 0),
        next_step=decision.get("next_step", ""),
        status="handoff" if decision.get("handoff") else "active",
    )
    return sent
