"""Shared graph state for the AI Super Sales multi-agent pipeline.

The state is a single mutable dict that flows through every LangGraph node.
Each agent reads what it needs and writes its own structured result back in.
"""

from __future__ import annotations

from typing import Annotated, Any, TypedDict


def _merge(left: dict | None, right: dict | None) -> dict:
    out = dict(left or {})
    out.update(right or {})
    return out


class SalesState(TypedDict, total=False):
    # --- inputs ---
    conversation: str  # raw WeChat / private-domain chat transcript
    product: str  # what we are selling (free text, optional)
    seller_notes: str  # optional extra context from the sales rep

    # --- shared working memory written by agents ---
    evidence: list[dict[str, Any]]  # retrieved playbook snippets (RAG)
    profile: dict[str, Any]  # 客户画像官
    stage: dict[str, Any]  # 商机阶段判断官
    objections: dict[str, Any]  # 异议拆解官
    recovery: dict[str, Any]  # 挽回官 (conditional)
    script: dict[str, Any]  # 话术生成官
    quote: dict[str, Any]  # 报价官
    followup: dict[str, Any]  # 跟进策略官
    crm: dict[str, Any]  # CRM 建档官

    # --- routing / bookkeeping ---
    churn_risk: str  # low | medium | high  (drives the conditional branch)
    engine: str  # "llm" | "fallback" — which path produced the outputs
    meta: Annotated[dict[str, Any], _merge]
