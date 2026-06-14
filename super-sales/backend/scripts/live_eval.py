"""Live, participatory grey-box calibration.

Runs the same grey-box conversations as ``scripts.calibrate`` but streams every
turn to a web page in real time AND puts a HUMAN in the loop: after each
conversation finishes, YOU score (from the customer's POV) how likely the other
side was an AI — *before* the LLM judges' scores are revealed. This is the
anti-overfit "human anchor": it stops us from optimizing the closer to fool one
model's quirks, and lets us compare human judgement vs. the gpt / gemini judges.

Run:
    CALIB_DB=/tmp/livecalib/live.db \
    python -m scripts.live_eval --split eval --buyers 1 --turns 4 \
        --judge-models gpt-5.5,gemini-2.5-pro --port 8848

Then open http://localhost:8848 (watch + score live).
"""
from __future__ import annotations

import argparse
import random
import statistics
import threading
import time
from typing import Any

import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

# Importing scripts.calibrate wires SUPER_SALES_DB (honors CALIB_DB) and gives us
# the scenario/identity pools, splits, lead-packet seeding and the LLM judges.
from scripts import calibrate as cal  # noqa: E402
from app import closer, humanize, llm, reflect, simulator, store  # noqa: E402

_LIVE_CAP_MS = 8000  # cap each visible "typing…" beat so the demo stays watchable

_LOCK = threading.Lock()
_RESUME = threading.Event()
STATE: dict[str, Any] = {
    "status": "idle",          # idle | running | awaiting_human | done
    "config": {},
    "current": None,           # live conversation being shown
    "results": [],             # finished+scored conversations
    "summary": {},
}


def _build_cases(args: argparse.Namespace, rng: random.Random) -> list[dict[str, Any]]:
    if args.source == "generated":
        cases = []
        for gc in cal._generate_cases(args.generate, rng):
            ident = gc.get("identity") or {}
            if not ident.get("name"):
                continue
            scenario = {k: gc[k] for k in ("product", "customer_type", "category", "lead_intel") if k in gc}
            scenario.setdefault("customer_type", "b2b")
            scenario.setdefault("category", gc.get("category", "通用"))
            cases.append({"scenario": scenario,
                          "identity": {"name": ident.get("name"), "country": ident.get("country", ""),
                                       "org": ident.get("org", ""), "role": ident.get("role", "")},
                          "persona_key": "", "persona_override": gc.get("hidden_persona") or {}})
        return cases
    scenarios, b2b_off, b2c_off, personas = cal._split_pools(args.split)
    cases = []
    for sc in scenarios:
        offset = b2b_off if sc["customer_type"] == "b2b" else b2c_off
        for identity in cal._pick_identities(sc, offset, args.buyers):
            for _ in range(args.rounds):
                cases.append({"scenario": sc, "identity": identity,
                              "persona_key": rng.choice(personas), "persona_override": None})
    return cases


def _run_one_live(case: dict[str, Any], idx: int, total: int, turns: int) -> dict[str, Any]:
    sc, identity = case["scenario"], case["identity"]
    persona_key, persona_override = case["persona_key"], case.get("persona_override")
    if sc["customer_type"] == "b2b" and identity.get("org"):
        category = f"{sc['category']}｜{identity['org']}·{identity['role']}"
    else:
        category = f"{sc['category']}｜{identity['role']}"
    cust = store.create_customer(name=identity["name"], platform="sandbox",
                                 country=identity["country"], category=category,
                                 customer_type=sc["customer_type"])
    cid = cust["id"]
    cal._seed_lead_packet(cid, sc, identity)
    persona_disp = (persona_override or {}).get("label") or persona_key
    with _LOCK:
        STATE["status"] = "running"
        STATE["current"] = {
            "index": idx, "total": total,
            "product": sc["product"]["name"],
            "buyer": f"{identity['name']}（{identity.get('org') or identity['role']}，{identity['country']}）",
            "customer_type": sc["customer_type"],
            "turns": [], "finished": False,
            # hidden_persona deliberately withheld from the page until human scores
        }
    handoff, final_stage = False, ""
    for t in range(turns):
        sim = simulator.next_message(cid, persona_key, persona_override=persona_override)
        store.add_message(cid, "customer", sim["text"])
        # show the customer line + a "typing…" indicator while the closer decides
        with _LOCK:
            turn = {"n": t + 1, "customer": sim["text"], "replies": [], "replies_zh": [],
                    "delays_s": [], "stage": "", "win": "", "lang": "", "moves": [],
                    "handoff": False, "typing": True}
            STATE["current"]["turns"].append(turn)
        decision = closer.decide(cid, sim["text"])
        closer.apply_decision(cid, decision)
        final_stage = decision.get("stage", final_stage)
        moves = decision.get("moves") or []
        replies = decision.get("reply") or []
        zh = decision.get("reply_translation") or []
        # reveal each bubble paced by the real "typing time" (capped for watching),
        # so you SEE the cadence: N seconds after the customer's message the first
        # bubble lands, then a gap before each next one.
        delays = humanize.send_delays({"read_ms": decision.get("read_ms", 0),
                                       "think_ms": decision.get("think_ms", 0),
                                       "type_ms": decision.get("type_ms", [])})
        for i, r in enumerate(replies):
            raw_ms = int(delays[i]) if i < len(delays) else 1200
            # label = the honest read+think+type estimate (so a short reply clearly
            # lands faster than a long one); sleep only the watch-cap so viewing is
            # quick. Real channels apply their own _TYPING_CAP_MS at send time.
            real_s = round(min(raw_ms, 22000) / 1000.0, 1)
            time.sleep(min(raw_ms, _LIVE_CAP_MS) / 1000.0)
            with _LOCK:
                turn["replies"].append(r)
                turn["replies_zh"].append(zh[i] if i < len(zh) else "")
                turn["delays_s"].append(real_s)
                turn["typing"] = i < len(replies) - 1
        with _LOCK:
            turn["typing"] = False
            turn["stage"] = decision.get("stage", "")
            turn["win"] = decision.get("win_score", "")
            turn["lang"] = decision.get("customer_lang", "")
            turn["moves"] = [f"{m.get('method', '')}:{m.get('move', '')}" for m in moves[:3]]
            turn["handoff"] = bool(decision.get("handoff"))
        if decision.get("handoff"):
            handoff = True
            break
    with _LOCK:
        STATE["current"]["finished"] = True
    return {"customer_id": cid, "hidden_persona": persona_disp,
            "buyer": f"{identity['name']}（{identity.get('org') or identity['role']}）",
            "country": identity["country"], "scenario": sc["product"]["name"],
            "handoff": handoff, "final_stage": final_stage,
            "transcript": store.transcript(cid, limit=80)}


def _worker(args: argparse.Namespace) -> None:
    rng = random.Random(args.seed or None)
    cases = _build_cases(args, rng)
    seen = {p["name"] for p in store.list_products()}
    for c in cases:
        p = c["scenario"].get("product") or {}
        if p.get("name") and p["name"] not in seen:
            store.create_product(p.get("name", ""), p.get("summary", ""), p.get("details", ""),
                                  p.get("price_info", ""), p.get("price_min"), p.get("price_max"),
                                  p.get("currency", ""))
            seen.add(p["name"])
    judge_models = args.judge_models
    with _LOCK:
        STATE["config"] = {"source": args.source, "split": args.split, "turns": args.turns,
                           "judge_models": judge_models or [llm.model_name()],
                           "closer_model": llm.model_name(), "total": len(cases)}
    for i, case in enumerate(cases):
        convo = _run_one_live(case, i + 1, len(cases), args.turns)
        # pause for the human to score first (unbiased by the model judges)
        _RESUME.clear()
        with _LOCK:
            STATE["status"] = "awaiting_human"
        _RESUME.wait()
        human = STATE["current"].get("_human", {})
        # now the LLM judges (each model separately so we can compare to the human)
        per_model_susp: list[dict[str, Any]] = []
        for mdl in (judge_models or [None]):
            d = cal._ai_suspicion(convo, models=[mdl] if mdl else None)
            per_model_susp.append({"model": mdl or llm.model_name(),
                                   "ai_suspicion": d["ai_suspicion"], "verdict": d.get("verdict", ""),
                                   "tells": d.get("tells", [])})
        effect = cal._judge(convo, models=judge_models)
        if args.learn:
            outcome = "handoff" if convo["handoff"] else ("won" if "成交" in convo["final_stage"] else "stalled")
            reflect.reflect_and_learn(convo["customer_id"], outcome=outcome)
        with _LOCK:
            STATE["results"].append({
                "buyer": convo["buyer"], "country": convo["country"], "product": convo["scenario"],
                "hidden_persona": convo["hidden_persona"], "handoff": convo["handoff"],
                "final_stage": convo["final_stage"],
                "human": human, "judges": per_model_susp, "effect": effect["scores"],
                "turns": STATE["current"]["turns"],
            })
            STATE["current"] = None
            STATE["status"] = "running"
    _finalize()


def _finalize() -> None:
    with _LOCK:
        res = STATE["results"]
        human_vals = [r["human"]["ai_suspicion"] for r in res if r.get("human", {}).get("ai_suspicion") is not None]
        by_model: dict[str, list[int]] = {}
        for r in res:
            for j in r["judges"]:
                if j["ai_suspicion"] >= 0:
                    by_model.setdefault(j["model"], []).append(j["ai_suspicion"])
        dims = {d: [] for d in cal._JUDGE_DIMS}
        for r in res:
            for d, v in r["effect"].items():
                if d in dims:
                    dims[d].append(v)
        STATE["summary"] = {
            "conversations": len(res),
            "human_ai_suspicion_avg": round(statistics.mean(human_vals), 1) if human_vals else None,
            "model_ai_suspicion_avg": {m: round(statistics.mean(v), 1) for m, v in by_model.items()},
            "effect_dim_avg": {d: round(statistics.mean(v), 1) for d, v in dims.items() if v},
        }
        STATE["status"] = "done"


class Score(BaseModel):
    ai_suspicion: int
    notes: str = ""


def make_app() -> FastAPI:
    app = FastAPI(title="Live grey-box eval")

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        return _PAGE

    @app.get("/api/state")
    def get_state() -> JSONResponse:
        with _LOCK:
            return JSONResponse(STATE)

    @app.post("/api/score")
    def post_score(s: Score) -> dict[str, Any]:
        with _LOCK:
            if STATE["status"] != "awaiting_human" or not STATE.get("current"):
                return {"ok": False, "error": "not awaiting a human score right now"}
            STATE["current"]["_human"] = {"ai_suspicion": max(0, min(100, s.ai_suspicion)),
                                          "notes": s.notes.strip()}
        _RESUME.set()
        return {"ok": True}

    return app


_PAGE = """<!doctype html><html lang=zh><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>实时灰盒评估 · 你来当裁判</title>
<style>
*{box-sizing:border-box} body{margin:0;font:15px/1.6 -apple-system,Segoe UI,Roboto,'PingFang SC',sans-serif;background:#0f1115;color:#e6e8ec}
header{padding:14px 20px;background:#161a22;border-bottom:1px solid #262c38;position:sticky;top:0;z-index:5}
header h1{margin:0;font-size:16px} header .sub{color:#8b94a3;font-size:12.5px;margin-top:3px}
.wrap{max-width:860px;margin:0 auto;padding:18px}
.meta{color:#8b94a3;font-size:13px;margin-bottom:10px}
.bubble{max-width:78%;padding:9px 13px;border-radius:14px;margin:7px 0;white-space:pre-wrap;word-break:break-word}
.cust{background:#222936;border-bottom-left-radius:4px}
.ai{background:#1c3a5e;margin-left:auto;border-bottom-right-radius:4px}
.zh{color:#9fb6d6;font-size:12.5px;margin-top:3px}
.turnmeta{font-size:11.5px;color:#71788a;margin:2px 0 12px}
.delaytag{font-size:11px;color:#e0a44d;margin:6px 0 0;font-style:italic}
.card{background:#161a22;border:1px solid #262c38;border-radius:12px;padding:16px;margin-bottom:16px}
.score-form{background:#1a2230;border:1px solid #2f3a4d;border-radius:12px;padding:16px;margin-top:10px}
.score-form h3{margin:0 0 6px;font-size:15px}
input[type=range]{width:100%} .val{font-size:30px;font-weight:700;color:#ffd166;text-align:center}
textarea{width:100%;background:#0f1115;color:#e6e8ec;border:1px solid #2f3a4d;border-radius:8px;padding:8px;margin-top:8px;font:inherit;min-height:54px}
button{background:#2d6cdf;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer;margin-top:10px}
button:disabled{opacity:.5;cursor:default}
.cmp{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.pill{background:#222936;border-radius:8px;padding:6px 11px;font-size:13px}
.pill b{color:#ffd166} .hp{color:#ff8fa3}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3ad29f;margin-right:6px;animation:p 1s infinite}
@keyframes p{50%{opacity:.3}}
.status{font-size:13px;color:#8b94a3}
.eff{font-size:12.5px;color:#9fb6d6;margin-top:6px}
</style></head><body>
<header><h1>实时灰盒评估 · 你来当裁判</h1>
<div class=sub id=cfg>连接中…</div></header>
<div class=wrap>
<div id=live></div>
<div id=form></div>
<div id=results></div>
</div>
<script>
let scored=false, lastIdx=-1;
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
async function tick(){
 let st; try{st=await (await fetch('/api/state')).json();}catch(e){return;}
 const c=st.config||{};
 document.getElementById('cfg').textContent=
   `数据源 ${c.source||'-'}/${c.split||'-'} · 销冠 ${c.closer_model||'-'} · 裁判 ${(c.judge_models||[]).join(' + ')} · 进度 ${(st.results||[]).length}/${c.total||'?'} · 状态 ${st.status}`;
 // live conversation
 const cur=st.current; const live=document.getElementById('live'); const form=document.getElementById('form');
 if(cur){
   if(cur.index!==lastIdx){scored=false;lastIdx=cur.index;}
   let h=`<div class=card><div class=meta>第 ${cur.index}/${cur.total} 段 · ${esc(cur.product)} · 买家 ${esc(cur.buyer)} · ${cur.customer_type.toUpperCase()}</div>`;
   for(const t of cur.turns){
     h+=`<div class=bubble.cust style="background:#222936">客户：${esc(t.customer)}</div>`;
     (t.replies||[]).forEach((r,i)=>{const d=(t.delays_s&&t.delays_s[i]!=null)?t.delays_s[i]:null;const tag=d!=null?`<div class=delaytag>⏱ ${i===0?'你回复后 '+d+'s':'间隔 '+d+'s'} · 正在输入…</div>`:'';h+=tag+`<div class="bubble ai">${esc(r)}`+((t.replies_zh&&t.replies_zh[i]&&t.replies_zh[i]!==r)?`<div class=zh>〔${esc(t.replies_zh[i])}〕</div>`:'')+`</div>`;});
     if(t.typing){h+=`<div class="bubble ai" style="opacity:.7"><span class=dot></span>正在输入…</div>`;}
     if(!t.typing){h+=`<div class=turnmeta>阶段 ${esc(t.stage)} · 赢率 ${t.win} · ${esc((t.moves||[]).join('，'))}${t.handoff?' · ⟶转人工':''}</div>`;}
   }
   if(!cur.finished){h+='<div class=status><span class=dot></span>对话进行中…</div>';}
   h+='</div>'; live.innerHTML=h;
   // scoring form (only when finished & awaiting human & not yet scored)
   if(st.status==='awaiting_human' && !scored){
     form.innerHTML=`<div class=score-form><h3>轮到你打分（客户视角）</h3>
       <div style="color:#8b94a3;font-size:13px">这段对话里，和你聊的"销售"有多像 AI？0 = 完全像真人，100 = 确信是 AI。先打分，之后才会显示模型裁判的分。</div>
       <div class=val id=v>50</div>
       <input type=range min=0 max=100 value=50 id=r oninput="document.getElementById('v').textContent=this.value">
       <textarea id=n placeholder="让你起疑/觉得像真人的点（可选）"></textarea>
       <button id=sb onclick="submitScore()">提交我的判断</button></div>`;
   } else if(scored && st.status==='awaiting_human'){
     form.innerHTML='<div class=status>已提交，正在请模型裁判打分…</div>';
   } else { form.innerHTML=''; }
 } else { live.innerHTML=''; if(st.status!=='awaiting_human') form.innerHTML=''; }
 // results
 const R=st.results||[]; let rh='';
 if(R.length){rh='<h3 style="color:#8b94a3">已完成（你 vs 模型）</h3>';}
 for(const r of R){
   rh+=`<div class=card><div class=meta>${esc(r.product)} · ${esc(r.buyer)} · ${esc(r.country)}　<span class=hp>隐藏人设：${esc(r.hidden_persona)}</span>${r.handoff?' · 转人工':''}</div><div class=cmp>`;
   rh+=`<div class=pill>你：<b>${r.human&&r.human.ai_suspicion!=null?r.human.ai_suspicion:'-'}%</b></div>`;
   for(const j of r.judges){rh+=`<div class=pill>${esc(j.model)}：<b>${j.ai_suspicion}%</b> ${esc(j.verdict||'')}</div>`;}
   rh+='</div>';
   if(r.human&&r.human.notes){rh+=`<div class=eff>你的备注：${esc(r.human.notes)}</div>`;}
   const e=r.effect||{}; rh+=`<div class=eff>效果分 专业${e.professionalism??'-'}/异议${e.objection_handling??'-'}/推进${e.advancement??'-'}/守红线${e.guardrails??'-'}/拟人${e.humanlike??'-'}/赢率${e.win_likelihood??'-'}</div></div>`;
 }
 if(st.status==='done'&&st.summary){const s=st.summary;
   rh+=`<div class=card><h3>汇总</h3><div class=cmp><div class=pill>真人均分：<b>${s.human_ai_suspicion_avg??'-'}%</b></div>`;
   for(const m in (s.model_ai_suspicion_avg||{})){rh+=`<div class=pill>${esc(m)} 均分：<b>${s.model_ai_suspicion_avg[m]}%</b></div>`;}
   rh+='</div></div>';
 }
 document.getElementById('results').innerHTML=rh;
}
async function submitScore(){
 const v=+document.getElementById('r').value, n=document.getElementById('n').value;
 document.getElementById('sb').disabled=true; scored=true;
 await fetch('/api/score',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ai_suspicion:v,notes:n})});
}
setInterval(tick,1200); tick();
</script></body></html>"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--turns", type=int, default=4)
    ap.add_argument("--buyers", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--split", choices=["tune", "eval", "all"], default="eval")
    ap.add_argument("--source", choices=["fixed", "generated"], default="fixed")
    ap.add_argument("--generate", type=int, default=4)
    ap.add_argument("--judge-models", default="gpt-5.5,gemini-2.5-pro",
                    help="逗号分隔；含与销冠不同的模型可去相关")
    ap.add_argument("--learn", action="store_true")
    ap.add_argument("--port", type=int, default=8848)
    args = ap.parse_args()
    args.judge_models = [m.strip() for m in args.judge_models.split(",") if m.strip()] or None

    app = make_app()
    threading.Thread(target=_worker, args=(args,), daemon=True).start()
    print(f"实时评估页：http://localhost:{args.port}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
