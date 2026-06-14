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
os.environ["SUPER_SALES_DB"] = os.path.join(tempfile.gettempdir(), f"calib_{int(time.time())}.db")

from app import closer, llm, simulator, store  # noqa: E402

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

# country/language variety so the closer's language-mirroring gets exercised.
LOCALES = [
    ("United States", "English"),
    ("Germany", "German"),
    ("Saudi Arabia", "Arabic"),
    ("Japan", "Japanese"),
    ("Brazil", "Portuguese"),
    ("China", "Chinese"),
]


def _run_conversation(scenario: dict[str, Any], persona_key: str, locale: tuple[str, str], turns: int) -> dict[str, Any]:
    country, _lang = locale
    cust = store.create_customer(
        name=f"{persona_key}@{country}",
        platform="sandbox",
        country=country,
        category=scenario["category"],
        customer_type=scenario["customer_type"],
    )
    cid = cust["id"]
    handoff = False
    final_stage = ""
    for _ in range(turns):
        sim = simulator.next_message(cid, persona_key)
        store.add_message(cid, "customer", sim["text"])
        decision = closer.decide(cid, sim["text"])
        closer.apply_decision(cid, decision)
        final_stage = decision.get("stage", final_stage)
        if decision.get("handoff"):
            handoff = True
            break
    return {
        "customer_id": cid,
        "persona": persona_key,
        "country": country,
        "scenario": scenario["product"]["name"],
        "handoff": handoff,
        "final_stage": final_stage,
        "transcript": store.transcript(cid, limit=80),
    }


_JUDGE_DIMS = ["professionalism", "objection_handling", "advancement", "guardrails", "humanlike", "win_likelihood"]


def _judge(convo: dict[str, Any]) -> dict[str, Any]:
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
    try:
        data = llm.chat_json(system, user, temperature=0.2)
    except Exception as e:  # noqa: BLE001
        return {"scores": {d: 0 for d in _JUDGE_DIMS}, "note": f"评分失败: {e}"}
    scores = data.get("scores", {}) if isinstance(data.get("scores"), dict) else {}
    clean = {d: int(scores.get(d, 0) or 0) for d in _JUDGE_DIMS}
    return {
        "scores": clean,
        "weakest": data.get("weakest", ""),
        "issues": data.get("issues", []),
        "fix": data.get("fix", ""),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=1, help="每个 persona×locale 组合跑几轮")
    ap.add_argument("--turns", type=int, default=6, help="每段对话最多多少来回")
    ap.add_argument("--personas", default="haggler,skeptic,aloof_dm,competitor,warm_indecisive",
                    help="逗号分隔的 persona key")
    ap.add_argument("--locales", type=int, default=3, help="使用前 N 个国家/语言组合")
    ap.add_argument("--out", default="calib_report.json")
    args = ap.parse_args()

    for sc in SCENARIOS:
        p = sc["product"]
        store.create_product(p["name"], p["summary"], p["details"], p["price_info"],
                              p["price_min"], p["price_max"], p["currency"])

    persona_keys = [k.strip() for k in args.personas.split(",") if k.strip()]
    locales = LOCALES[: max(1, args.locales)]
    print(f"LLM available: {llm.llm_available()} | model: {llm.model_name()}")
    print(f"scenarios={len(SCENARIOS)} personas={persona_keys} locales={[loc[0] for loc in locales]} "
          f"rounds={args.rounds} turns={args.turns}\n")

    convos: list[dict[str, Any]] = []
    for sc in SCENARIOS:
        for pk in persona_keys:
            for loc in locales:
                for _ in range(args.rounds):
                    convo = _run_conversation(sc, pk, loc, args.turns)
                    convo["judge"] = _judge(convo)
                    convos.append(convo)
                    s = convo["judge"]["scores"]
                    avg = round(statistics.mean(s.values()), 1) if s else 0
                    print(f"  [{convo['scenario'][:14]:<14}] {pk:<16} {loc[0]:<13} "
                          f"avg={avg:<4} handoff={convo['handoff']} stage={convo['final_stage']}")

    # aggregate
    per_dim: dict[str, list[int]] = {d: [] for d in _JUDGE_DIMS}
    for c in convos:
        for d, v in c["judge"]["scores"].items():
            per_dim[d].append(v)
    dim_avg = {d: round(statistics.mean(v), 2) if v else 0 for d, v in per_dim.items()}
    weakest = sorted(dim_avg.items(), key=lambda kv: kv[1])[:2]
    all_issues = [i for c in convos for i in c["judge"].get("issues", [])]
    handoff_rate = round(sum(c["handoff"] for c in convos) / max(1, len(convos)), 2)

    report = {
        "summary": {
            "conversations": len(convos),
            "dimension_avg": dim_avg,
            "weakest_dimensions": [w[0] for w in weakest],
            "handoff_rate": handoff_rate,
        },
        "top_issues": all_issues[:20],
        "conversations": convos,
    }
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("\n=== 维度均分 ===")
    for d, v in dim_avg.items():
        print(f"  {d:<20} {v}")
    print(f"\n最弱维度: {[w[0] for w in weakest]} | 转人工率: {handoff_rate}")
    print(f"报告已写入: {args.out}")


if __name__ == "__main__":
    main()
