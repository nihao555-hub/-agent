"""LangGraph wiring for the AI Super Sales pipeline.

    检索官 → 画像官 → 阶段官 → 异议官 ─┬─(high churn)─→ 挽回官 ─┐
                                      └─(else)──────→ 跳过挽回 ─┴→ 话术官 → 报价官 → 跟进官 → CRM官

The conditional edge after the objection agent is what makes this a real agent
graph (state-driven routing) rather than a fixed sequential chain.
"""

from __future__ import annotations

from langgraph.graph import END, StateGraph

from . import nodes
from .state import SalesState

# Ordered list of (node_key, human label) used by the API to stream a plan.
PIPELINE: list[tuple[str, str]] = [
    ("retrieve", "检索官"),
    ("profile", "客户画像官"),
    ("stage", "商机阶段判断官"),
    ("objection", "异议拆解官"),
    ("recovery", "流失挽回官"),
    ("script", "话术生成官"),
    ("quote", "报价官"),
    ("followup", "跟进策略官"),
    ("crm", "CRM 建档官"),
    ("coach", "赢率评分/复盘官"),
]


def _route_after_objection(state: SalesState) -> str:
    return "recovery" if state.get("churn_risk") == "high" else "skip_recovery"


def build_graph():
    g = StateGraph(SalesState)

    g.add_node("retrieve", nodes.retrieve_node)
    g.add_node("profile", nodes.profile_node)
    g.add_node("stage", nodes.stage_node)
    g.add_node("objection", nodes.objection_node)
    g.add_node("recovery", nodes.recovery_node)
    g.add_node("skip_recovery", nodes.skip_recovery_node)
    g.add_node("script", nodes.script_node)
    g.add_node("quote", nodes.quote_node)
    g.add_node("followup", nodes.followup_node)
    g.add_node("crm", nodes.crm_node)
    g.add_node("coach", nodes.coach_node)

    g.set_entry_point("retrieve")
    g.add_edge("retrieve", "profile")
    g.add_edge("profile", "stage")
    g.add_edge("stage", "objection")

    g.add_conditional_edges(
        "objection",
        _route_after_objection,
        {"recovery": "recovery", "skip_recovery": "skip_recovery"},
    )
    g.add_edge("recovery", "script")
    g.add_edge("skip_recovery", "script")

    g.add_edge("script", "quote")
    g.add_edge("quote", "followup")
    g.add_edge("followup", "crm")
    g.add_edge("crm", "coach")
    g.add_edge("coach", END)

    return g.compile()


# node key -> which state field it populates (for streaming the result per step)
NODE_OUTPUT_FIELD: dict[str, str] = {
    "retrieve": "evidence",
    "profile": "profile",
    "stage": "stage",
    "objection": "objections",
    "recovery": "recovery",
    "skip_recovery": "recovery",
    "script": "script",
    "quote": "quote",
    "followup": "followup",
    "crm": "crm",
    "coach": "coach",
}
