"""Reflexion-style self-improvement for the closer.

This is *verbal* reinforcement learning (à la Reflexion), not gradient RL: after a
conversation ends (won / lost / handed-off / stalled) the model reviews the whole
transcript, judges what advanced vs. what triggered resistance, and distills one
or two **generalized** lessons. Lessons are stored (and de-duplicated/reinforced)
in ``store.lessons`` and injected back into the closer's prompt on every future
turn — so the closer compounds real battlefield experience over time without ever
touching model weights (auditable, reversible, API-model-friendly).

Anti-overfit is enforced at the source: the extraction prompt demands the lesson
be a transferable principle (no names, no company, no specific product/number),
and the store reinforces duplicates instead of hoarding one-off patches.
"""

from __future__ import annotations

from typing import Any

from . import llm, store

_VALID_OUTCOMES = ("won", "lost", "handoff", "stalled")


def infer_outcome(customer: dict[str, Any]) -> str:
    """Best-effort label for how the conversation ended, from durable state."""
    status = str(customer.get("status", "")).lower()
    stage = str(customer.get("stage", ""))
    if status == "handoff":
        return "handoff"
    if status in ("won", "closed", "成交"):
        return "won"
    if status in ("lost", "dead", "流失"):
        return "lost"
    if "成交" in stage:
        return "won"
    return "stalled"


def reflect_and_learn(customer_id: str, outcome: str = "") -> list[dict[str, Any]]:
    """Review one finished conversation and persist generalized lessons.

    Returns the lessons that were stored/reinforced (empty if LLM unavailable or
    nothing worth generalizing)."""
    customer = store.get_customer(customer_id)
    if customer is None:
        raise ValueError("customer not found")
    if not llm.llm_available():
        return []
    transcript = store.transcript(customer_id, limit=80)
    if not transcript.strip():
        return []
    outcome = outcome if outcome in _VALID_OUTCOMES else infer_outcome(customer)
    ctype = "b2c" if str(customer.get("customer_type", "b2b")).lower() == "b2c" else "b2b"

    system = (
        "你是一位带过很多销冠的销售教练，正在复盘一通**已结束**的销售对话，目的是让 AI 销售从这次经历里"
        "学到**可迁移到未来其它客户**的经验教训。\n"
        "铁律（否则会过拟合、毫无价值）：\n"
        "① 教训必须是**通用原则**，绝不能出现具体人名/公司名/产品名/具体数字/这次对话的专有情节；"
        "要写成『当……时，应该……/不要……』这种换个客户也成立的句式。\n"
        "② 只提炼**真正有因果证据**的 1-2 条；这次没什么可学就返回空数组，绝不硬凑。\n"
        "③ 同时关注成交效果与『像不像真人』：如果对话里有让客户起疑是 AI 的迹象，也提炼成拟人化教训。\n"
        "④ 不得违背红线精神（不教泄底价/乱承诺/越权降价等）。\n"
        "只输出 JSON：{\"lessons\":[{\"trigger\":\"适用情境(简短)\",\"lesson\":\"通用的应该/不要…\","
        "\"scope\":\"b2b|b2c|all\"}]}。"
    )
    user = (
        f"【客户类型】{ctype}\n【结局】{outcome}\n"
        f"【完整对话】(\u201c我\u201d=AI销售, \u201c客户\u201d=买家)\n{transcript}\n\n"
        "请复盘并提炼可迁移的通用教训。"
    )
    try:
        data = llm.chat_json(system, user, temperature=0.3)
    except Exception:  # noqa: BLE001
        return []
    raw = data.get("lessons") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    stored: list[dict[str, Any]] = []
    for item in raw[:2]:
        if not isinstance(item, dict):
            continue
        lesson = str(item.get("lesson", "")).strip()
        if not lesson:
            continue
        scope = str(item.get("scope", "")).strip().lower()
        if scope not in ("b2b", "b2c", "all"):
            scope = ctype
        try:
            stored.append(store.add_lesson(
                trigger=str(item.get("trigger", "")).strip(),
                lesson=lesson,
                scope=scope,
                outcome=outcome,
            ))
        except ValueError:
            continue
    store.prune_lessons()
    return stored
