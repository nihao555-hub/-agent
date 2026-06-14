"""The nine sales agents (LangGraph nodes).

Each agent has two implementations:
  * an LLM path (grounded in retrieved playbook snippets, strict-JSON output),
  * a deterministic fallback used when no LLM key is configured.

Every node reads the shared `SalesState`, does one job, and writes its structured
result back. Node names map 1:1 to the agent roles the user sees in the UI.
"""

from __future__ import annotations

from typing import Any

from . import llm
from .retrieval import retrieve, retrieval_backend
from .state import SalesState

# ----------------------------------------------------------------------------- helpers


def _evidence_block(evidence: list[dict[str, Any]]) -> str:
    if not evidence:
        return "（无检索到的销售方法论片段）"
    return "\n".join(f"[{e['id']}] {e['title']}：{e['text']}" for e in evidence)


def _engine() -> str:
    return "llm" if llm.llm_available() else "fallback"


def _safe_llm(system: str, user: str, fallback: dict[str, Any], **kw: Any) -> tuple[dict[str, Any], str]:
    """Run the LLM; on any failure return the deterministic fallback."""
    if not llm.llm_available():
        return fallback, "fallback"
    try:
        return llm.chat_json(system, user, **kw), "llm"
    except Exception:  # noqa: BLE001
        return fallback, "fallback"


# ----------------------------------------------------------------------------- 1. 检索官


def retrieve_node(state: SalesState) -> dict[str, Any]:
    convo = state.get("conversation", "")
    product = state.get("product", "")
    query = f"{product}\n{convo}".strip()
    evidence = retrieve(query, k=6)
    return {
        "evidence": evidence,
        "meta": {"retrieval_backend": retrieval_backend()},
    }


# ----------------------------------------------------------------------------- 2. 客户画像官


def profile_node(state: SalesState) -> dict[str, Any]:
    convo = state.get("conversation", "")
    fallback = {
        "summary": "从对话中识别到的潜在客户，对价格较敏感，需进一步确认决策权与预算。",
        "industry": "未知",
        "role": "未知",
        "needs": ["了解产品价值", "控制采购成本"],
        "budget_sensitivity": "高",
        "decision_power": "未知",
    }
    system = (
        "你是资深 B2B 销售的『客户画像官』。基于客户的微信/私域聊天记录，刻画客户画像。"
        "只输出 JSON，字段：summary(string)、industry(string)、role(string,客户在公司的角色)、"
        "needs(string数组)、budget_sensitivity(高/中/低)、decision_power(高/中/低/未知)。"
    )
    user = f"聊天记录：\n{convo}"
    result, _ = _safe_llm(system, user, fallback)
    return {"profile": result}


# ----------------------------------------------------------------------------- 3. 商机阶段判断官


_STAGES = ["初次接触", "需求确认", "方案介绍", "报价谈判", "临门一脚", "已成交", "已流失"]


def stage_node(state: SalesState) -> dict[str, Any]:
    convo = state.get("conversation", "")
    evidence = state.get("evidence", [])
    fallback = {
        "stage": "报价谈判",
        "confidence": 0.6,
        "churn_risk": "medium",
        "buying_signals": ["主动询问价格"],
        "rationale": "客户已进入比价/谈判，存在一定流失风险（兜底判断）。",
        "cited": [e["id"] for e in evidence[:1]],
    }
    system = (
        "你是『商机阶段判断官』。结合销售方法论片段判断客户当前所处的成交阶段。"
        f"阶段只能取其一：{', '.join(_STAGES)}。"
        "只输出 JSON，字段：stage(string)、confidence(0-1数字)、churn_risk(low/medium/high)、"
        "buying_signals(string数组)、rationale(string)、cited(引用的片段ID数组)。"
    )
    user = f"销售方法论片段：\n{_evidence_block(evidence)}\n\n聊天记录：\n{convo}"
    result, _ = _safe_llm(system, user, fallback)
    risk = str(result.get("churn_risk", "medium")).lower()
    if risk not in {"low", "medium", "high"}:
        risk = "medium"
    return {"stage": result, "churn_risk": risk}


# ----------------------------------------------------------------------------- 4. 异议拆解官


def objection_node(state: SalesState) -> dict[str, Any]:
    convo = state.get("conversation", "")
    evidence = state.get("evidence", [])
    fallback = {
        "objections": [
            {
                "raw": "有点贵",
                "real_concern": "对价值与回报不确定，担心买贵了",
                "type": "价格异议",
                "counter": "用 TCO 拆解价值、对比隐性损失，给错峰让利而非直接打折。",
                "cited": ["OBJ-PRICE"],
            }
        ]
    }
    system = (
        "你是『异议拆解官』。从聊天中找出客户提出的每一条异议，挖出其背后的真实顾虑，并给出应对策略。"
        "结合方法论片段。只输出 JSON，字段：objections(数组)，每个元素含 "
        "raw(客户原话)、real_concern(真实顾虑)、type(异议类型)、counter(应对话术要点)、cited(引用片段ID数组)。"
    )
    user = f"销售方法论片段：\n{_evidence_block(evidence)}\n\n聊天记录：\n{convo}"
    result, _ = _safe_llm(system, user, fallback)
    return {"objections": result}


# ----------------------------------------------------------------------------- 5. 挽回官 (conditional)


def recovery_node(state: SalesState) -> dict[str, Any]:
    convo = state.get("conversation", "")
    evidence = state.get("evidence", [])
    fallback = {
        "triggered": True,
        "risk_reason": "客户对价格犹豫且回复转冷，存在流失风险。",
        "actions": [
            "换价值由头触达：发一份同行成功案例，降低回复门槛",
            "给二选一小决策：本周三或周四安排一次 15 分钟演示",
        ],
        "message": "王总，刚帮您整理了一份同行（同体量批发商）上线后的对账提效数据，"
        "您看周三还是周四方便，我花 15 分钟给您过一遍？",
        "cited": ["RECOVER-01"],
    }
    system = (
        "你是『流失挽回官』。当前客户被判定为高流失风险。请基于方法论制定挽回策略并写一条可直接发出的挽回消息。"
        "只输出 JSON，字段：triggered(true)、risk_reason(string)、actions(string数组)、"
        "message(可直接发送的中文挽回话术)、cited(引用片段ID数组)。"
    )
    user = f"销售方法论片段：\n{_evidence_block(evidence)}\n\n聊天记录：\n{convo}"
    result, _ = _safe_llm(system, user, fallback, temperature=0.6)
    return {"recovery": result}


def skip_recovery_node(state: SalesState) -> dict[str, Any]:
    return {"recovery": {"triggered": False, "reason": "流失风险不高，本单跳过挽回官。"}}


# ----------------------------------------------------------------------------- 6. 话术生成官


def script_node(state: SalesState) -> dict[str, Any]:
    convo = state.get("conversation", "")
    evidence = state.get("evidence", [])
    objections = state.get("objections", {})
    stage = state.get("stage", {})
    fallback = {
        "next_message": "王总，理解您关注成本。我们标准版一年的投入，差不多就是一次对账出错返工的损失。"
        "这样，我帮您按门店数量算一笔账，您看是先开通试用，还是我周四上门给团队演示一次？",
        "tone": "专业 · 价值锚定 · 给二选一",
        "talking_points": ["价值锚定（TCO）", "风险逆转（先试用）", "假设成交（二选一）"],
        "cited": ["OBJ-PRICE", "CLOSE-01"],
    }
    system = (
        "你是『话术生成官』。综合客户阶段、异议与方法论，写出销售『下一句该发的微信话术』。"
        "要求口语、可直接复制发送、不超过 120 字、落地一个明确的下一步。"
        "只输出 JSON，字段：next_message(string)、tone(string)、talking_points(string数组)、cited(引用片段ID数组)。"
    )
    user = (
        f"客户阶段：{stage}\n异议：{objections}\n"
        f"方法论片段：\n{_evidence_block(evidence)}\n\n聊天记录：\n{convo}"
    )
    result, _ = _safe_llm(system, user, fallback, temperature=0.6)
    return {"script": result}


# ----------------------------------------------------------------------------- 7. 报价官


def quote_node(state: SalesState) -> dict[str, Any]:
    convo = state.get("conversation", "")
    product = state.get("product", "")
    evidence = state.get("evidence", [])
    fallback = {
        "tiers": [
            {"name": "标准版", "price": "¥3,980/年", "highlights": ["核心进销存", "基础对账", "在线客服"]},
            {"name": "专业版（推荐）", "price": "¥6,880/年", "highlights": ["多门店", "智能对账", "数据看板", "优先支持"]},
            {"name": "旗舰版", "price": "¥12,800/年", "highlights": ["定制报表", "API 对接", "专属客户成功"]},
        ],
        "recommended": "专业版（推荐）",
        "anchor_strategy": "三档锚定主推中间档；限时让利换签约周期，不直接打折。",
        "concession_levers": ["年付赠 2 个月", "免费数据迁移"],
        "cited": ["QUOTE-01"],
    }
    system = (
        "你是『报价官』。基于产品与客户情况给出三档套餐报价（标准/专业/旗舰），主推中间档，做价格锚定。"
        "只输出 JSON，字段：tiers(数组,每项含 name/price/highlights数组)、recommended(string)、"
        "anchor_strategy(string)、concession_levers(string数组)、cited(引用片段ID数组)。"
    )
    user = f"产品：{product or '（未指定，按通用 B2B SaaS 估算）'}\n方法论：\n{_evidence_block(evidence)}\n\n聊天记录：\n{convo}"
    result, _ = _safe_llm(system, user, fallback)
    return {"quote": result}


# ----------------------------------------------------------------------------- 8. 跟进策略官


def followup_node(state: SalesState) -> dict[str, Any]:
    stage = state.get("stage", {})
    evidence = state.get("evidence", [])
    fallback = {
        "plan": [
            {"when": "当天", "action": "发送报价 + 同行案例", "goal": "建立价值锚点"},
            {"when": "第 2 天", "action": "电话确认是否收到，挖预算/决策链", "goal": "推进需求确认"},
            {"when": "第 4 天", "action": "给限时优惠名额，约演示", "goal": "制造紧迫感"},
            {"when": "第 7 天", "action": "未成交则轻触达，发行业干货", "goal": "保持温度"},
        ],
        "cadence": "高意向 24h，中意向 2-3 天，低意向每周一次",
        "cited": ["FOLLOW-01"],
    }
    system = (
        "你是『跟进策略官』。基于客户阶段制定一份可执行的跟进计划（含时间点、动作、目标）。"
        "只输出 JSON，字段：plan(数组,每项含 when/action/goal)、cadence(string)、cited(引用片段ID数组)。"
    )
    user = f"客户阶段：{stage}\n方法论：\n{_evidence_block(evidence)}"
    result, _ = _safe_llm(system, user, fallback)
    return {"followup": result}


# ----------------------------------------------------------------------------- 9. CRM 建档官


def crm_node(state: SalesState) -> dict[str, Any]:
    profile = state.get("profile", {})
    stage = state.get("stage", {})
    fallback_conf = stage.get("confidence", 0.6) if isinstance(stage, dict) else 0.6
    fallback = {
        "customer": profile.get("summary", "潜在客户") if isinstance(profile, dict) else "潜在客户",
        "stage": stage.get("stage", "报价谈判") if isinstance(stage, dict) else "报价谈判",
        "win_probability": round(float(fallback_conf) * 0.9, 2),
        "next_action": "发送专业版报价并约演示",
        "tags": ["价格敏感", "私域跟单"],
    }
    system = (
        "你是『CRM 建档官』。把本次分析沉淀为一条 CRM 记录。"
        "只输出 JSON，字段：customer(string)、stage(string)、win_probability(0-1数字)、"
        "next_action(string)、tags(string数组)。"
    )
    user = f"客户画像：{profile}\n阶段判断：{stage}"
    result, _ = _safe_llm(system, user, fallback)
    return {"crm": result, "engine": _engine()}


# ----------------------------------------------------------------------------- 10. 赢率评分/复盘官


def coach_node(state: SalesState) -> dict[str, Any]:
    """Scores the deal's win probability with a factor breakdown and coaches the
    rep on how to play the next moves like a top performer (新手 → 销冠)."""
    convo = state.get("conversation", "")
    evidence = state.get("evidence", [])
    profile = state.get("profile", {})
    stage = state.get("stage", {})
    objections = state.get("objections", {})
    quote = state.get("quote", {})
    fallback = {
        "win_score": 45,
        "factors": [
            {"name": "需求强度", "score": 70, "comment": "对账痛点明确且被客户亲口承认。"},
            {"name": "预算匹配", "score": 40, "comment": "价格敏感，价值未充分锚定。"},
            {"name": "决策权", "score": 60, "comment": "疑似老板本人，但未确认采购流程。"},
            {"name": "紧迫度", "score": 35, "comment": "已读未回，缺少明确的下一步时间。"},
            {"name": "竞争态势", "score": 50, "comment": "现用低价竞品作锚点，需做差异化。"},
        ],
        "key_risks": ["价值未量化即被压价", "无明确 next step，商机易冷掉"],
        "improvement_actions": [
            "用影响类提问把对账错误的年损失算成具体金额，再报价（SPIN）。",
            "每次跟进都带新价值由头，并锁定一个二选一的下一步时间。",
            "帮客户准备对上汇报的一页 ROI 摘要，养出内部 Champion。",
        ],
        "coaching_tip": "新手急着报价和降价，销冠先用 TCO 把『不解决的代价』讲到客户心里，"
        "再用限时让步换签约——先价值、后价格、让步必换条件。",
        "cited": ["METHOD-VALUE", "DISC-03", "FOLLOW-03"],
    }
    system = (
        "你是『赢率评分/复盘官』，一位顶级销售教练。基于客户画像、阶段、异议、报价与方法论，"
        "给这一单打一个赢率分并指出销售本可以做得更好的地方，帮助一个普通销售向销冠进化。"
        "只输出 JSON，字段：win_score(0-100整数)、"
        "factors(数组,每项含 name、score(0-100整数)、comment)、"
        "key_risks(string数组,本单最大的丢单风险)、"
        "improvement_actions(string数组,这名销售下一步应如何改进,要具体可执行)、"
        "coaching_tip(一句点醒新手的销冠心法)、cited(引用片段ID数组)。"
    )
    user = (
        f"客户画像：{profile}\n阶段：{stage}\n异议：{objections}\n报价：{quote}\n"
        f"方法论片段：\n{_evidence_block(evidence)}\n\n聊天记录：\n{convo}"
    )
    result, _ = _safe_llm(system, user, fallback, temperature=0.5)
    return {"coach": result, "engine": _engine()}
