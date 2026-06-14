"""Seed sales-playbook knowledge base.

These are short, citable snippets a senior B2B sales coach would carry in their
head: how to read a deal stage, how to handle common objections, pricing
anchors, and follow-up cadences. The retrieval agent grounds its reasoning in
these so the pipeline is "RAG", not just a bare prompt.

Each entry has a stable `id` so downstream agents can cite it (溯源).
"""

from __future__ import annotations

PLAYBOOK: list[dict[str, str]] = [
    {
        "id": "STAGE-01",
        "topic": "商机阶段",
        "title": "BANT 阶段判定",
        "text": "B2B 私域跟单常分六个阶段：初次接触→需求确认→方案介绍→报价谈判→临门一脚→已成交/流失。"
        "客户开始问价格、对比竞品、谈折扣，通常已进入『报价谈判』阶段；反复要求再考虑、已读不回则有流失风险。",
    },
    {
        "id": "STAGE-02",
        "topic": "商机阶段",
        "title": "购买信号识别",
        "text": "强购买信号：主动问交付周期、问售后、问发票合同、拉同事进群、问能否先试用。"
        "出现这些信号应尽快推进临门一脚（限时优惠 / 帮其内部立项）。",
    },
    {
        "id": "OBJ-PRICE",
        "topic": "异议处理",
        "title": "价格异议（太贵）",
        "text": "客户说『太贵 / 比同行贵』时，不要立刻降价。先用价值锚定：拆解总拥有成本(TCO)、"
        "算清节省的人力与时间、对比出问题的隐性损失；再给『错峰让利』而非直接打折，保住价格体系。",
    },
    {
        "id": "OBJ-COMPETITOR",
        "topic": "异议处理",
        "title": "竞品对比异议",
        "text": "客户拿竞品压价时，承认对方优点、再用差异化打击（服务响应、本地化、稳定性、数据安全）。"
        "切忌贬低竞品，应引导客户关注切换成本与长期 ROI。",
    },
    {
        "id": "OBJ-DELAY",
        "topic": "异议处理",
        "title": "拖延 / 再考虑",
        "text": "『我再考虑下』往往是隐藏异议（预算未批 / 不是决策人 / 还有顾虑没说）。"
        "用开放式提问挖真实顾虑：『主要是哪方面还需要确认？是预算、还是要内部对齐？』",
    },
    {
        "id": "RECOVER-01",
        "topic": "流失挽回",
        "title": "沉默客户挽回",
        "text": "客户已读不回超过 3 天，启动挽回：换个由头触达（行业资料 / 同行案例 / 限时名额），"
        "降低回复门槛，给一个二选一的小决策，避免开放式追问造成压力。",
    },
    {
        "id": "QUOTE-01",
        "topic": "报价策略",
        "title": "锚定与套餐分层",
        "text": "报价用三档套餐（标准 / 专业 / 旗舰）做锚定，主推中间档。先报价值再报价格，"
        "给出明确的限时条件而非无条件折扣，保留 1-2 个可让步项用于谈判换条件。",
    },
    {
        "id": "FOLLOW-01",
        "topic": "跟进节奏",
        "title": "跟进 cadence",
        "text": "高意向客户 24 小时内跟进，中意向 2-3 天，低意向每周一次轻触达。"
        "每次跟进都要给客户一个新的『价值由头』，而不是单纯『在吗 / 考虑得怎样』。",
    },
    {
        "id": "CLOSE-01",
        "topic": "临门一脚",
        "title": "促成成交",
        "text": "临门一脚用假设成交法（直接谈交付/开通时间）、限时限量、风险逆转（无理由退款 / 先试用）。"
        "帮客户在其公司内部完成立项话术，让对方更容易对上级交代。",
    },
]
