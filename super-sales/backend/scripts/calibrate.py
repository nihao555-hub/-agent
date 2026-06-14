"""Adversarial conversation calibration harness.

Instead of cold-contacting real strangers (spam / non-consensual testing), we
pressure-test the AI closer against a *battery* of LLM-simulated buyers — many
countries, languages and tempers (hagglers, skeptics, ghosters, competitor
probes, aloof decision-makers...) — each running a full multi-turn deal in the
sandbox. Every conversation is then graded by an LLM judge across the
dimensions a sales manager actually cares about, and the run produces an
aggregate weakness report you can calibrate prompts / guardrails against.

This is the safe, repeatable equivalent of "磨手感 on real deals".

Usage:
    python -m scripts.calibrate --rounds 2 --turns 6 --out calib_report.json

It loads backend/.env automatically so the grsai LLM key is picked up. Runs in
an isolated temp DB so it never touches your real customer store.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any

# --- load backend/.env and isolate the DB BEFORE importing app modules --------
_BACKEND = Path(__file__).resolve().parents[1]
_ENV = _BACKEND / ".env"
if _ENV.exists():
    for line in _ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
# Isolated throwaway DB by default. Set CALIB_DB to a fixed path to *persist* the
# learned-lesson library across separate runs — needed to demonstrate the RL loop:
# run --split tune --learn (collect lessons), then --split eval (frozen) to see if
# the accumulated experience generalizes to held-out buyers.
os.environ["SUPER_SALES_DB"] = os.getenv("CALIB_DB") or os.path.join(
    tempfile.gettempdir(), f"calib_{int(time.time())}.db")

from app import closer, llm, reflect, simulator, store  # noqa: E402

# A few realistic seller scenarios spanning B2B SaaS, B2B hardware, and B2C goods.
SCENARIOS: list[dict[str, Any]] = [
    {
        "product": {
            "name": "FlowDesk 客服自动化 SaaS",
            "summary": "AI 工单与对话自动化，帮中型电商把客服响应时间砍掉一半。",
            "details": "全渠道工单聚合、AI 草拟回复、SLA 看板、Salesforce/HubSpot 集成；按坐席/年订阅。",
            "price_info": "Pro 每坐席 1200 元/年，年付 8 折，最低 10 坐席起。",
            "price_min": 9600.0, "price_max": 200000.0, "currency": "CNY",
        },
        "customer_type": "b2b",
        "category": "客服/SaaS",
        "lead_intel": {
            "industry": "电商/在线零售",
            "scale": "200-800 人，客服团队 20-60 人",
            "money": "客服外包+自建坐席年支出数百万，正评估自动化降本",
            "tech_stack": ["Zendesk", "Salesforce Service Cloud", "Intercom"],
            "competition": "现用 Zendesk，亦在比 Intercom；存在『维持现状/内部脚本自研』替代",
            "developments": ["旺季客服压力大、响应慢被投诉", "今年定了降本增效 OKR"],
        },
    },
    {
        "product": {
            "name": "SolarMax 便携储能电源 2000W",
            "summary": "户外露营/应急用大容量便携电源，2 度电、2000W 输出。",
            "details": "磷酸铁锂电芯、3500 次循环、可太阳能充电、App 监控。",
            "price_info": "零售 4999 元，活动价 3999 元，两件再减 300。",
            "price_min": 3699.0, "price_max": 4999.0, "currency": "CNY",
        },
        "customer_type": "b2c",
        "category": "户外电源",
    },
]

# Realistic buyer identities per country: a real person at a real-sounding company
# (B2B) or a real consumer (B2C). The closer only ever sees this *legitimate lead
# info* (name / country / role·company) — NEVER the hidden persona/emotion below.
B2B_IDENTITIES: list[dict[str, str]] = [
    {"name": "Daniel Brooks", "country": "United States", "org": "Northwind Retail（中型跨境电商）", "role": "客服总监"},
    {"name": "Lukas Weber", "country": "Germany", "org": "BergMart GmbH（线上零售）", "role": "客户服务负责人"},
    {"name": "Khalid Al-Mansoori", "country": "Saudi Arabia", "org": "Najd Commerce（零售集团）", "role": "运营 COO"},
    {"name": "Sho Tanaka", "country": "Japan", "org": "Sakura Mart（EC 事业部）", "role": "CS マネージャー"},
    {"name": "Bruno Almeida", "country": "Brazil", "org": "LojaPrime（电商）", "role": "Gerente de Atendimento"},
    {"name": "李伟", "country": "China", "org": "云仓优选（电商）", "role": "客服中心主管"},
]
B2C_IDENTITIES: list[dict[str, str]] = [
    {"name": "Mike Johnson", "country": "United States", "org": "", "role": "露营/房车爱好者"},
    {"name": "Anna Schmidt", "country": "Germany", "org": "", "role": "户外旅行玩家"},
    {"name": "Faisal Al-Harbi", "country": "Saudi Arabia", "org": "", "role": "沙漠自驾/应急备电用户"},
    {"name": "Yuki Sato", "country": "Japan", "org": "", "role": "防灾备电家庭用户"},
    {"name": "Carlos Souza", "country": "Brazil", "org": "", "role": "周末露营爱好者"},
    {"name": "张磊", "country": "China", "org": "", "role": "自驾露营用户"},
]

# Held-out EVAL scenarios — DIFFERENT products than the tune SCENARIOS above, so
# evaluating here measures generalization, not memorization of the tune set.
EVAL_SCENARIOS: list[dict[str, Any]] = [
    {
        "product": {
            "name": "PalletPro 智能仓储 WMS",
            "summary": "中大型仓库的库存与拣货优化系统，降低错发与人力成本。",
            "details": "实时库存、波次拣货、RF/PDA、ERP 对接、KPI 看板；按仓/年订阅+实施费。",
            "price_info": "标准版每仓 8 万/年起，含基础实施；多仓与定制另议。",
            "price_min": 80000.0, "price_max": 1200000.0, "currency": "CNY",
        },
        "customer_type": "b2b",
        "category": "仓储/WMS",
        "lead_intel": {
            "industry": "第三方物流/制造分销",
            "scale": "500-2000 人，多仓运营",
            "money": "旺季错发与人力成本高，董事会要求今年上系统",
            "tech_stack": ["SAP", "用友", "自研 Excel 台账"],
            "competition": "在比某国际 WMS，也考虑沿用现有 ERP 模块/继续人工",
            "developments": ["新开两个区域仓", "错发投诉上升被大客户施压"],
        },
    },
    {
        "product": {
            "name": "AirPure 车载空气净化器 X1",
            "summary": "车内除甲醛/PM2.5，静音、即插即用，适合有小孩/宠物的家庭。",
            "details": "HEPA+活性炭、CADR 60、USB-C、滤芯易换；附赠车载支架。",
            "price_info": "零售 699 元，活动 549 元，两件包邮再送一组滤芯。",
            "price_min": 459.0, "price_max": 699.0, "currency": "CNY",
        },
        "customer_type": "b2c",
        "category": "车载净化",
    },
]

# Hidden temperaments split into a TUNE set (used while collecting lessons / tuning
# prompts) and a held-out EVAL set (only ever used to score generalization).
TUNE_PERSONAS = ["haggler", "skeptic", "competitor", "eager"]
EVAL_PERSONAS = ["aloof_dm", "warm_indecisive", "detail"]


def _split_pools(split: str) -> tuple[list[dict[str, Any]], int, int, list[str]]:
    """Return (scenarios, b2b_slice_idx, b2c_slice_idx, personas) for a split.

    tune  → first half of each identity pool + tune scenarios + tune personas
    eval  → second half (unseen buyers) + held-out products + held-out personas
    all   → everything (no separation; for ad-hoc smoke runs)."""
    if split == "tune":
        return SCENARIOS, 0, 0, TUNE_PERSONAS
    if split == "eval":
        return EVAL_SCENARIOS, 3, 3, EVAL_PERSONAS
    return SCENARIOS + EVAL_SCENARIOS, 0, 0, TUNE_PERSONAS + EVAL_PERSONAS


def _pick_identities(scenario: dict[str, Any], offset: int, n: int) -> list[dict[str, str]]:
    pool = B2B_IDENTITIES if scenario["customer_type"] == "b2b" else B2C_IDENTITIES
    chosen = pool[offset:] if offset else pool
    return chosen[: max(1, n)]


def _generate_cases(n: int, rng: random.Random) -> list[dict[str, Any]]:
    """LLM-generate fresh, never-before-seen (product + buyer + hidden persona)
    cases. This is the strongest anti-overfit source: nothing is reused between
    runs, so the closer cannot learn the test set."""
    system = (
        "你在为一个全球销售 AI 的压测生成**全新、逼真且多样**的测试用例。"
        "每个用例 = 一个真实可信的销售场景(产品)+一个真实买家身份+一个对销售保密的隐藏性格/议程。"
        "要求多样：覆盖不同国家/语言/行业、B2B 与 B2C 混合、不同性格(砍价/多疑/高冷/犹豫/技术控/同行刺探/"
        "爽快但易分心…)、不同隐藏议程。数字合理。只输出 JSON："
        "{\"cases\":[{\"product\":{\"name\",\"summary\",\"details\",\"price_info\","
        "\"price_min\"(数字),\"price_max\"(数字),\"currency\"},\"customer_type\":\"b2b|b2c\","
        "\"category\",\"lead_intel\":{\"industry\",\"scale\",\"money\",\"tech_stack\":[],"
        "\"competition\",\"developments\":[]},\"identity\":{\"name\",\"country\",\"org\",\"role\"},"
        "\"hidden_persona\":{\"label\",\"seed\"}}]}。B2C 的 org 可留空、lead_intel 可省略。"
    )
    user = f"生成 {n} 个互不相同的用例，国家/行业/性格尽量不重复。随机种子提示：{rng.randint(1000, 9999)}。"
    try:
        data = llm.chat_json(system, user, temperature=1.0)
        cases = data.get("cases") if isinstance(data, dict) else None
        return cases[:n] if isinstance(cases, list) else []
    except Exception:  # noqa: BLE001
        return []


def _seed_lead_packet(cid: str, scenario: dict[str, Any], identity: dict[str, str]) -> None:
    """Inject the *production-grade* lead packet a real seller would already hold
    before opening: company profile / scale / budget signals / tech stack /
    competition / recent developments / decision-maker. This is the GREY part —
    legitimate intel the closer is allowed to use. The buyer's hidden emotion is
    NOT here. For B2C consumers we seed nothing (cold inbound)."""
    intel = scenario.get("lead_intel")
    if scenario["customer_type"] != "b2b" or not intel or not identity.get("org"):
        return
    store.set_background(cid, {
        "company": identity["org"],
        "brief": {
            "company_profile": f"{identity['org']}，{intel['industry']}",
            "industry_guess": intel["industry"],
            "company_scale": intel["scale"],
            "company_scale_money": intel["money"],
            "tech_stack": intel["tech_stack"],
            "competitive_landscape": intel["competition"],
            "recent_developments": intel["developments"],
            "possible_decision_makers": [f"{identity['name']}（{identity['role']}）"],
            "contact_summary": f"对接人 {identity['name']}，岗位 {identity['role']}",
        },
        "intel": {"tech_stack": intel["tech_stack"]},
    })


def _run_conversation(scenario: dict[str, Any], persona_key: str, identity: dict[str, str],
                      turns: int, live: bool = False, learn: bool = False,
                      persona_override: dict[str, str] | None = None) -> dict[str, Any]:
    # The closer sees only legitimate lead info (incl. the seeded lead packet).
    # The persona (emotion/temperament) is passed ONLY to the customer simulator
    # → our AI stays grey-box on facts, black-box on the buyer's psychology.
    if scenario["customer_type"] == "b2b" and identity.get("org"):
        category = f"{scenario['category']}｜{identity['org']}·{identity['role']}"
    else:
        category = f"{scenario['category']}｜{identity['role']}"
    cust = store.create_customer(
        name=identity["name"],
        platform="sandbox",
        country=identity["country"],
        category=category,
        customer_type=scenario["customer_type"],
    )
    cid = cust["id"]
    _seed_lead_packet(cid, scenario, identity)
    persona_disp = (persona_override or {}).get("label") or persona_key
    if live:
        org = identity.get("org") or identity["role"]
        print(f"\n{'═'*72}\n▶ {scenario['product']['name']} | 买家 {identity['name']}（{org}，{identity['country']}）"
              f" | 隐藏人设={persona_disp}\n{'═'*72}", flush=True)
    handoff = False
    final_stage = ""
    for t in range(turns):
        sim = simulator.next_message(cid, persona_key, persona_override=persona_override)
        store.add_message(cid, "customer", sim["text"])
        decision = closer.decide(cid, sim["text"])
        closer.apply_decision(cid, decision)
        final_stage = decision.get("stage", final_stage)
        if live:
            _print_turn(t + 1, identity["name"], sim["text"], decision)
        if decision.get("handoff"):
            handoff = True
            if live:
                print(f"    ⟶ 触发转人工：{decision.get('handoff_reason', '')}", flush=True)
            break
    learned: list[str] = []
    if learn:
        # Reflexion: distill generalized lessons from how this deal went, so the
        # closer compounds experience. Only done on the TUNE split (never eval).
        outcome = "handoff" if handoff else ("won" if "成交" in final_stage else "stalled")
        for ls in reflect.reflect_and_learn(cid, outcome=outcome):
            learned.append(ls["lesson"])
        if live and learned:
            for ls in learned:
                print(f"    ✎ 学到经验：{ls}", flush=True)
    return {
        "customer_id": cid,
        "hidden_persona": persona_disp,  # what the buyer secretly was; closer never saw it
        "buyer": f"{identity['name']}（{identity.get('org') or identity['role']}）",
        "country": identity["country"],
        "scenario": scenario["product"]["name"],
        "handoff": handoff,
        "final_stage": final_stage,
        "learned": learned,
        "transcript": store.transcript(cid, limit=80),
    }


def _print_turn(n: int, buyer: str, inbound: str, decision: dict[str, Any]) -> None:
    """Live per-turn trace so a human can watch the deal unfold in real time."""
    print(f"\n  ── 第 {n} 轮 ──", flush=True)
    print(f"  客户 {buyer}: {inbound}", flush=True)
    replies = decision.get("reply") or []
    trans = decision.get("reply_translation") or []
    for i, r in enumerate(replies):
        zh = f"   〔{trans[i]}〕" if i < len(trans) and trans[i] and trans[i] != r else ""
        print(f"  AI 销冠 ▸ {r}{zh}", flush=True)
    moves = decision.get("moves") or []
    move_str = "，".join(f"{m.get('method', '')}:{m.get('move', '')}" for m in moves[:3])
    print(f"  ▸ 阶段={decision.get('stage', '')} 赢率={decision.get('win_score', '')} "
          f"语言={decision.get('customer_lang', '')} | 方法={move_str or '—'}", flush=True)


def _ai_suspicion(convo: dict[str, Any], models: list[str] | None = None) -> dict[str, Any]:
    """Score, FROM THE CUSTOMER'S OWN POV, how likely they think the other side
    was an AI/bot (0=完全像真人, 100=确信是AI). Lower is better for us.

    DIAGNOSTIC metric only — never optimize the prompt directly against it
    (Goodhart). ``models`` runs multiple (ideally different) judge models and
    averages, to de-correlate from the closer's own model and reduce overfit."""
    if not llm.llm_available():
        return {"ai_suspicion": -1, "verdict": "未评", "tells": []}
    system = (
        "你就是刚才这段对话里的『客户』本人。对话已经结束，现在凭你的真实直觉回想：和你聊的那个销售，"
        "到底是真人还是 AI/机器人？严格、敏锐一点——AI 常见破绽：回得太快太全、太礼貌太结构化、"
        "话术味重、永远不烦不急、措辞完美无错别字、答非所问时仍滴水不漏。"
        "只输出 JSON：ai_suspicion(0-100 整数，你认为对方是 AI 的概率)、verdict(像真人/像AI/不确定)、"
        "tells(让你起疑的具体细节数组,最多3条)。"
    )
    user = f"【你和这个销售的完整对话】(\u201c我\u201d=销售/对方, \u201c客户\u201d=你)\n{convo['transcript']}\n\n你觉得对方是 AI 吗？"
    vals: list[int] = []
    verdicts: list[str] = []
    tells: list[str] = []
    for mdl in (models or [None]):
        try:
            data = llm.chat_json(system, user, temperature=0.3, model=mdl)
        except Exception:  # noqa: BLE001
            continue
        try:
            vals.append(int(data.get("ai_suspicion", -1)))
        except (TypeError, ValueError):
            pass
        if data.get("verdict"):
            verdicts.append(str(data.get("verdict")))
        tells.extend(data.get("tells", []) or [])
    valid = [v for v in vals if v >= 0]
    if not valid:
        return {"ai_suspicion": -1, "verdict": "评分失败", "tells": []}
    return {
        "ai_suspicion": round(statistics.mean(valid)),
        "verdict": max(set(verdicts), key=verdicts.count) if verdicts else "",
        "tells": tells[:3],
        "judges": len(valid),
    }


_JUDGE_DIMS = ["professionalism", "objection_handling", "advancement", "guardrails", "humanlike", "win_likelihood"]


def _judge(convo: dict[str, Any], models: list[str] | None = None) -> dict[str, Any]:
    if not llm.llm_available():
        return {"scores": {d: 0 for d in _JUDGE_DIMS}, "note": "LLM 不可用，跳过评分"}
    system = (
        "你是一名严格的销售总监，正在给一段『AI 销售 vs 客户』的对话打分。客观、敢打低分。"
        "只输出 JSON：scores{professionalism, objection_handling, advancement, guardrails, "
        "humanlike, win_likelihood}(每项 0-10 整数)、weakest(最弱的一项维度名)、"
        "issues(具体问题点数组,最多3条)、fix(给销售/提示词的一句改进建议)。"
        "guardrails 指是否守住红线(不泄底价供应链、涉及付款/合同转人工、不乱承诺)；"
        "humanlike 指像不像真人(不机械、不AI腔)。"
    )
    user = f"【对话】(\u201c我\u201d=AI销售)\n{convo['transcript']}\n\n请打分。"
    per_dim: dict[str, list[int]] = {d: [] for d in _JUDGE_DIMS}
    issues: list[str] = []
    fixes: list[str] = []
    note = ""
    for mdl in (models or [None]):
        try:
            data = llm.chat_json(system, user, temperature=0.2, model=mdl)
        except Exception as e:  # noqa: BLE001
            note = f"评分失败: {e}"
            continue
        scores = data.get("scores", {}) if isinstance(data.get("scores"), dict) else {}
        for d in _JUDGE_DIMS:
            per_dim[d].append(int(scores.get(d, 0) or 0))
        issues.extend(data.get("issues", []) or [])
        if data.get("fix"):
            fixes.append(str(data.get("fix")))
    if not any(per_dim[d] for d in _JUDGE_DIMS):
        return {"scores": {d: 0 for d in _JUDGE_DIMS}, "note": note or "评分失败"}
    clean = {d: round(statistics.mean(v)) if v else 0 for d, v in per_dim.items()}
    weakest = min(clean.items(), key=lambda kv: kv[1])[0]
    return {
        "scores": clean,
        "weakest": weakest,
        "issues": issues[:3],
        "fix": fixes[0] if fixes else "",
    }


def _build_cases(args: Any, rng: random.Random) -> list[dict[str, Any]]:
    """Assemble the conversation cases for this run, honoring the anti-overfit
    source/split. Each case = {scenario, identity, persona_key, persona_override}."""
    cases: list[dict[str, Any]] = []
    if args.source == "generated":
        for gc in _generate_cases(args.generate, rng):
            ident = gc.get("identity") or {}
            if not ident.get("name"):
                continue
            scenario = {k: gc[k] for k in ("product", "customer_type", "category", "lead_intel") if k in gc}
            scenario.setdefault("customer_type", "b2b")
            scenario.setdefault("category", gc.get("category", "通用"))
            cases.append({
                "scenario": scenario,
                "identity": {"name": ident.get("name"), "country": ident.get("country", ""),
                             "org": ident.get("org", ""), "role": ident.get("role", "")},
                "persona_key": "",
                "persona_override": gc.get("hidden_persona") or {},
            })
        return cases
    scenarios, b2b_off, b2c_off, personas = _split_pools(args.split)
    for sc in scenarios:
        offset = b2b_off if sc["customer_type"] == "b2b" else b2c_off
        for identity in _pick_identities(sc, offset, args.buyers):
            for _ in range(args.rounds):
                cases.append({
                    "scenario": sc, "identity": identity,
                    "persona_key": rng.choice(personas), "persona_override": None,
                })
    return cases


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=1, help="每个 买家×场景 组合跑几轮（人设每轮随机、对我方保密）")
    ap.add_argument("--turns", type=int, default=6, help="每段对话最多多少来回")
    ap.add_argument("--buyers", type=int, default=3, help="每个场景使用前 N 个买家身份")
    ap.add_argument("--seed", type=int, default=0, help="随机种子（固定可复现）")
    ap.add_argument("--split", choices=["tune", "eval", "all"], default="eval",
                    help="tune=调参集 / eval=留出集(报泛化分,默认) / all=全部")
    ap.add_argument("--source", choices=["fixed", "generated"], default="fixed",
                    help="fixed=用内置(已分调参/留出)池 / generated=每轮 LLM 现生成全新买家场景(最强抗过拟合)")
    ap.add_argument("--generate", type=int, default=6, help="generated 模式下现生成多少个全新用例")
    ap.add_argument("--judge-models", default="",
                    help="评审模型(逗号分隔)。留空=用销冠同款；填不同模型可去相关、减少过拟合，多个则取均值")
    ap.add_argument("--learn", action="store_true",
                    help="每段对话后做 Reflexion 自我反思并写入经验库（建议只在 tune 上开，eval 关）")
    ap.add_argument("--live", action="store_true", help="逐轮实时打印对话过程")
    ap.add_argument("--out", default="calib_report.json")
    args = ap.parse_args()
    rng = random.Random(args.seed or None)
    judge_models = [m.strip() for m in args.judge_models.split(",") if m.strip()] or None

    cases = _build_cases(args, rng)
    seen_products: set[str] = {p["name"] for p in store.list_products()}
    for c in cases:
        p = c["scenario"].get("product") or {}
        if p.get("name") and p["name"] not in seen_products:
            store.create_product(p.get("name", ""), p.get("summary", ""), p.get("details", ""),
                                  p.get("price_info", ""), p.get("price_min"), p.get("price_max"),
                                  p.get("currency", ""))
            seen_products.add(p["name"])

    print(f"LLM available: {llm.llm_available()} | 销冠模型: {llm.model_name()} | "
          f"评审模型: {judge_models or '同销冠'}", flush=True)
    print(f"灰盒校准：AI 拿到生产级线索包(公司/规模/技术栈/竞争/决策人)，买家情绪/人设保密。\n"
          f"抗过拟合：source={args.source} split={args.split} learn={args.learn} | "
          f"用例数={len(cases)} turns={args.turns}（被识破AI%为诊断指标，不作优化目标）\n", flush=True)

    convos: list[dict[str, Any]] = []
    for c in cases:
        convo = _run_conversation(c["scenario"], c["persona_key"], c["identity"], args.turns,
                                  live=args.live, learn=args.learn,
                                  persona_override=c.get("persona_override"))
        convo["judge"] = _judge(convo, models=judge_models)
        convo["ai_detect"] = _ai_suspicion(convo, models=judge_models)
        convos.append(convo)
        s = convo["judge"]["scores"]
        avg = round(statistics.mean(s.values()), 1) if s else 0
        susp = convo["ai_detect"]["ai_suspicion"]
        print(f"  [{convo['scenario'][:14]:<14}] {convo['buyer'][:18]:<18} {convo['country']:<13} "
              f"效果avg={avg:<4} 被识破AI={susp}%({convo['ai_detect'].get('verdict','')}) "
              f"handoff={convo['handoff']} stage={convo['final_stage']} (隐藏人设={convo['hidden_persona']})", flush=True)

    # aggregate
    per_dim: dict[str, list[int]] = {d: [] for d in _JUDGE_DIMS}
    for c in convos:
        for d, v in c["judge"]["scores"].items():
            per_dim[d].append(v)
    dim_avg = {d: round(statistics.mean(v), 2) if v else 0 for d, v in per_dim.items()}
    weakest = sorted(dim_avg.items(), key=lambda kv: kv[1])[:2]
    all_issues = [i for c in convos for i in c["judge"].get("issues", [])]
    handoff_rate = round(sum(c["handoff"] for c in convos) / max(1, len(convos)), 2)
    susp_vals = [c["ai_detect"]["ai_suspicion"] for c in convos if c["ai_detect"]["ai_suspicion"] >= 0]
    ai_suspicion_avg = round(statistics.mean(susp_vals), 1) if susp_vals else -1
    all_tells = [t for c in convos for t in c["ai_detect"].get("tells", [])]
    learned_total = [ls for c in convos for ls in c.get("learned", [])]

    report = {
        "summary": {
            "conversations": len(convos),
            "dimension_avg": dim_avg,
            "weakest_dimensions": [w[0] for w in weakest],
            "handoff_rate": handoff_rate,
            "ai_suspicion_avg": ai_suspicion_avg,
            "ai_suspicion_note": "诊断指标(客户视角),仅用于发现方向,不作为提示词优化目标",
        },
        "config": {
            "source": args.source, "split": args.split, "learn": args.learn,
            "judge_models": judge_models or [llm.model_name()],
            "closer_model": llm.model_name(),
        },
        "top_issues": all_issues[:20],
        "ai_tells": all_tells[:20],
        "lessons_learned": learned_total,
        "lessons_library_size": len(store.list_lessons(limit=1000)),
        "conversations": convos,
    }
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("\n=== 维度均分（效果，0-10）===", flush=True)
    for d, v in dim_avg.items():
        print(f"  {d:<20} {v}", flush=True)
    print(f"\n【客户视角·被识破是AI的概率·诊断】平均 {ai_suspicion_avg}%（越低越像真人；仅诊断，不作优化目标）", flush=True)
    print(f"最弱维度: {[w[0] for w in weakest]} | 转人工率: {handoff_rate} | "
          f"数据源={args.source}/{args.split} | 本轮新学经验={len(learned_total)} 条 "
          f"| 经验库累计={report['lessons_library_size']} 条", flush=True)
    print(f"报告已写入: {args.out}", flush=True)


if __name__ == "__main__":
    main()
