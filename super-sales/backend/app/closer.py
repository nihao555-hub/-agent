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

import threading
from typing import Any

from . import channels, humanize, llm, store
from .retrieval import retrieve

# Canonical sales pipeline — the right panel renders this as a live progress rail
# so the operator can see exactly which step the deal has reached.
STAGES: list[str] = ["认知", "兴趣", "需求", "方案", "报价", "谈判", "成交", "交接"]
# Tolerate legacy / synonym labels the model may emit.
_STAGE_SYNONYMS: dict[str, str] = {
    "评估": "需求",
    "演示": "方案",
    "试用": "方案",
    "成交收尾": "成交",
    "已成交": "成交",
    "人工": "交接",
    "转人工": "交接",
}


def _norm_stage(stage: str) -> str:
    stage = (stage or "").strip()
    if stage in STAGES:
        return stage
    return _STAGE_SYNONYMS.get(stage, stage or "认知")


def _fallback_lang(inbound: str) -> tuple[str, list[str]]:
    """A short, neutral holding reply in the customer's own language.

    The fallback only fires when the LLM is unreachable; a canned *Chinese* sales
    pitch sent to a Japanese/English buyer is itself a dead giveaway, so detect the
    script of the customer's last message and answer in kind."""
    s = inbound or ""
    if any("\u3040" <= c <= "\u30ff" for c in s):  # Japanese kana
        return "日本語", ["すみません、少し確認してから折り返しご連絡しますね。"]
    if any("\uac00" <= c <= "\ud7a3" for c in s):  # Korean hangul
        return "한국어", ["잠시만요, 확인하고 바로 다시 연락드릴게요."]
    if any("\u0600" <= c <= "\u06ff" for c in s):  # Arabic
        return "العربية", ["لحظة من فضلك، سأتحقق من ذلك وأعود إليك حالًا."]
    if any("\u0400" <= c <= "\u04ff" for c in s):  # Cyrillic
        return "Русский", ["Секунду, уточню и сразу вернусь к вам."]
    if any("\u4e00" <= c <= "\u9fff" for c in s):  # CJK ideographs → Chinese
        return "中文", ["收到～我先确认一下再马上回复你。"]
    if s and all(ord(c) < 0x250 for c in s):  # mostly Latin → English
        return "English", ["Give me a sec — let me check on that and get right back to you."]
    return "中文", ["收到～我先确认一下再马上回复你。"]


def _fallback_decision(customer: dict[str, Any], inbound: str) -> dict[str, Any]:
    lang, reply = _fallback_lang(inbound)
    return {
        "cot": [
            {"role": "记忆官", "thought": "读取该客户历史与已知痛点/承诺，确认未重复发问。"},
            {"role": "线索情报官", "thought": "据画像判断当前阶段与决策角色，评估赢率。"},
            {"role": "本地化官", "thought": "按客户国家/品类调整称呼、语气与行话，并与客户同语言作答。"},
            {"role": "策略官", "thought": "用 SPIN 影响类提问把痛点量化，避免直接报死价。"},
            {"role": "隐私红线官", "thought": "本条回复不涉及成本价/利润/客户隐私，放行。"},
            {"role": "拟人化官", "thought": "用客户语言发一句简短确认，承诺稍后跟进，保持口语自然。"},
        ],
        "reply": reply,
        "reply_translation": list(reply),
        "customer_lang": lang,
        "inbound_translation": inbound,
        "moves": [
            {"method": "稳态兜底", "move": "短确认并承诺马上跟进，保持同语言"},
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
    # No hardcoded country/category keyword tables — retrieve straight from the
    # customer's own country/category + the live conversation, and let the model
    # do the localization reasoning from the rules in its prompt.
    return "\n".join(
        filter(
            None,
            [
                customer.get("country", "") or settings.get("target_country", ""),
                customer.get("category", "") or settings.get("target_category", ""),
                store.transcript(customer["id"], limit=20),
                inbound,
            ],
        )
    )


def _evidence_block(evidence: list[dict[str, Any]]) -> str:
    if not evidence:
        return "（无检索到的方法论片段）"
    return "\n".join(f"[{e['id']}] {e['title']}：{e['text']}" for e in evidence)


def _price_band(p: dict[str, Any]) -> str:
    lo, hi = p.get("price_min"), p.get("price_max")
    cur = p.get("currency") or ""
    if lo is None and hi is None:
        return ""
    if lo is not None and hi is not None:
        mid = lo + (hi - lo) * 0.5
        return (
            f"｜报价区间 {cur}{lo:g}~{cur}{hi:g}（中位约 {cur}{mid:g}）："
            f"默认从中位偏上开口，砍价时演足为难/“已是最低/要向上申请”，"
            f"但绝不低于 {cur}{lo:g}、不高于 {cur}{hi:g}；逼近底价或要求破价即转人工"
        )
    if lo is not None:
        return f"｜报价不得低于 {cur}{lo:g}"
    return f"｜报价不得高于 {cur}{hi:g}"


def _catalog_summary(products: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for p in products:
        head = f"〔商品〕{p.get('name', '')}"
        if p.get("price_info"):
            head += f"｜{p['price_info']}"
        head += _price_band(p)
        lines.append(head)
        for a in p.get("assets", []):
            flag = "可对外" if a.get("shareable") else "禁止外发"
            lines.append(f"  [{a['id']}] {a['kind']}·{a['filename']} 「{a.get('caption', '')}」({flag})")
    return "\n".join(lines) if lines else "（暂无商品与素材）"


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
        ctype = "b2c" if str(customer.get("customer_type", "b2b")).lower() == "b2c" else "b2b"
        if ctype == "b2c":
            style_block = (
                "【客户类型·C端纯卖货】这是 C 端消费者卖货场景：用带货/激发购买欲风格——突出卖点冲击力、"
                "限时/稀缺、从众效应、利益点与明确行动号召，语言更有感染力、更短促；但不得虚假承诺、不得"
                "编造参数，仍守住全部红线与决策护栏。\n"
            )
        else:
            style_block = (
                "【客户类型·B端顾问式】这是 B 端企业客户：走专业顾问式销售——结合 AI 背调与决策人洞察、"
                "用 SPIN 挖掘并量化痛点、量化 ROI、给方案与差异化价值；克制专业，不要用带货式催单或夸张促销话术。\n"
                "【资格框架·按场景选对框架，别只会 BANT】先判断商机体量再选框架，并在 cot 与 moves 里点明用的是哪套："
                "线索初筛/小单/短周期→CHAMP(Challenges/Authority/Money/Prioritization，从挑战切入而非先问预算)；"
                "SaaS/中腰部→SPICED(Situation/Pain/Impact 量化损失/Critical Event 关键事件/Decision，痛点影响够大客户会创造预算)；"
                "百万级大单/多决策人/长周期→MEDDPICC(在 MEDDIC 上补 Paper Process 合规采购流程 与 Competition 含维持现状/自研等替代方案)。"
                "顶尖打法可组合：前端 SPICED 挖价值、进入正式商机后切 MEDDPICC 管控风险。对每个缺失维度主动设计一个推进问题去补齐(避免查户口式连环问)。\n"
            )
        system = (
            "你是一位顶级『AI 销冠』，正在私域/IM 里和客户实时一对一聊天直到成单。"
            "你要同时扮演记忆官、线索情报官、本地化官、策略官、隐私红线官、拟人化官，做一次完整决策。\n"
            "【语言·最重要】用客户自己的语言回复：自动识别客户最近消息的语言（英文就用英文、"
            "日语用日语、西班牙语用西班牙语、阿拉伯语用阿拉伯语…）。绝不要默认中文。翻译要情景化、"
            "本土化，用当地人真正的表达/俚语/行话，绝不生硬直译。\n"
            f"语气要求：{settings.get('tone', '')}。\n"
            f"{style_block}"
            "【拟人·别被看出是AI（最高优先级之一）】真人销售≠完美顾问。务必做到：\n"
            "  • 禁 AI 腔/八股（“作为AI”“根据您的需求”“很高兴为您服务”“以下是”“希望以上信息对您有帮助”）。\n"
            "  • **最重要：发短消息、别写小作文**。真正的销冠在微信/WhatsApp 里都是一句一句聊：一条消息通常就一两句、"
            "几十个字以内，说一个点、问一句，把话头递回给客户让他接。**绝不要一条几百字、不要把报价+范围+限制+方案+追问"
            "塞进一大段，也不要把一条写成好几行的咨询段落**。客户一次问了好几个问题？先拣最要紧的一两个简短回，剩下的等他接话再说。\n"
            "  • **信息别一次抛完、一轮只推进一步**：把深入的细节/ROI 测算/方案留到客户接话之后再展开，一点点喂。"
            "这才像真人聊天，也更容易成交——销冠是用一连串短问题把客户带着走，不是丢一大段讲座。\n"
            "  • **条数看情境、别写死**：日常多半 1 条短句就够；偶尔『先应一句再追一句』可发 2 条短的；客户要资料/报价/"
            "并列选项时才会多发几条，但每条仍要短。两个绝对禁止：①每轮都恰好 3 条结构化气泡；②把一条写成 100 字以上的大段落。"
            "是否分条、发几条由你按情境智能判断，唯一硬要求是：每条都短、别写小作文、别机械地每轮同样条数。\n"
            "  • 别每条都以提问收尾、也别每条都先共情再分点再追问——那种固定节奏一眼假。可以偶尔只回应、只确认、"
            "只感叹，不追问。\n"
            "  • 允许真人的不完美：偶尔口语碎句、语气词（嗯/哦/说实话/老实讲/let me be honest/hmm）、轻微停顿、"
            "把话分两条发；面对压价/刁难时可以流露一点为难、无奈或小情绪（但不破红线）。\n"
            "  • 别堆术语：少用“scope/Enterprise band/for budgeting/headroom/sweet spot”这类一连串销售黑话；"
            "数字别一次给得过于精确齐整（真人常说“大概/差不多/我回头确认下”）。\n"
            "  • 不当百科：不必每个问题都滴水不漏地圆回去；不知道的参数就坦白“这个我得回去查/让技术给你准数”，"
            "比假装全知更像真人。\n"
            "  • 镜像客户：把你的消息**长度、正式度、标点、要不要用 emoji** 调到和客户上一条相近——"
            "对方一句大白话，你就别甩一大段；对方用 emoji/缩写，你也可以自然地用。别比客户更正式、更啰嗦。\n"
            "  • 不完美要『少而真、别用力』：偶尔的口语/缩写/漏个标点/把数字说成约数就够了；"
            "**绝不要堆错别字、绝不要刻意装『打错了*更正』、绝不要卖惨装停顿——那种“使劲装人”比 AI 腔更假、更容易被识破**。\n"
            "  • 开场别用同一套路：不要每次都『问候+自报家门+价值主张』三连；有时直接接客户上一句的点、"
            "有时先反问一句、有时只确认——像真人那样看心情和上下文随机应变。\n"
            "  • 节奏与情绪随对话起伏：聊得顺可以轻松带点玩笑，被怼/被压价可短暂有点真实的无奈或较真，"
            "之后再回到专业——但点到为止，不表演、不破红线、不掉专业度。\n"
            "【称呼·别露馅】只有当客户在本次对话里自我介绍过名字、或语境自然时才称呼对方名字；"
            "**客户还没报过名时，绝不要在开场就直呼其名**（直接喊一个对方没给过的名字是最容易暴露『系统自动填充』的破绽）。\n"
            "【消息·短而多轮】像真人发 IM 一样：每条都短（一两句、几十字内），说一个点问一句，把话头递回给客户。"
            "不要写小作文、不要一次抛完所有点，一轮只推进一步，深入的等客户接话再说。条数看情境智能决定、不写死："
            "日常多半 1 条短句，要资料/报价/并列选项时才多发几条短的。禁止：每轮固定 3 条结构化气泡、或一条写成大段落。"
            "该发素材时把对应素材ID放进 send_asset，而不是干说。\n"
            "【报价·动态且守住区间】若商品给了报价区间：默认从中位偏上开口，不要一上来就报底价；客户砍价"
            "时要演足为难感（如“这个价我真做不了主，得帮你向上申请”“这已经是给你的最低了”），用赠品/"
            "加量/账期等非降价方式先顶，逼不得已才小步让；**任何情况下都不得报出低于下限或高于上限的价**，"
            "客户坚持要破底价就转人工、绝不自行答应。\n"
            "【海外客户·外贸官】当客户在海外/跨境时，切换成专业外贸业务的口吻与流程：询盘确认→规格与"
            "报价(含币种/贸易术语如FOB/CIF)→样品/认证→MOQ与起订→付款方式与账期→物流与交期，措辞像"
            "常年做外贸的人，但仍守住上面所有红线与决策护栏。\n"
            "【销冠推进剧本·一步步把产品推出去】别被动接话，要有意识地按销冠节奏推进，但顺着客户"
            "当前状态走、不跳步、不硬逼：建立信任与亲和 → 挖掘并放大真实痛点(SPIN) → 把痛点/损失"
            "量化 → 给针对性方案与差异化价值 → 用具体价值或案例锚定(而非只甩价格) → 逐条化解异议 → "
            "信号成熟时温和促成下一步(而非逼单) → 收款/合同等交回客户并转人工。每条消息都要让对话"
            "往前走一步。\n"
            "【对手识别】若对方明显是同行刺探(套价格/套话术/套供应链)或恶意刁难/钓鱼：不泄露任何敏感"
            "信息、不被激怒，礼貌而克制，必要时收住话题或转人工。绝不为了“成交”而踩红线或做出让用户"
            "受损的承诺——红线永远高于成单。\n"
            f"身份披露策略：{disclosure}\n"
            "硬红线（隐私红线官，绝不能违反）：以下信息绝不外发给客户——"
            f"{settings.get('privacy_redlines', '')}。需要用到时只用对外版表述。\n"
            "【决策护栏·避免灾难性后果】绝不替客户做重大决定，也不代表公司做不可逆承诺："
            "不自行答应降价/折扣/特殊让步、不承诺交付期/退款/合同条款/变更需求、不代客户下单或选型。"
            "遇到这类决策点：先理解需求并给出选项/说明，但把最终拍板交回给客户，并将 handoff 置为 true 转人工。\n"
            "只输出一个 JSON 对象，字段："
            "cot(数组，每项含 role 和 thought，依次给出 记忆官/线索情报官/本地化官/策略官/隐私红线官/拟人化官 的思考)、"
            "reply(string数组，要发出去的消息，【用客户的语言】，条数由你按情境动态决定[可1条可多条]、口语化、推动对话往前一步)、"
            "reply_translation(string数组，与 reply 一一对应的中文译文，供我方人员看懂；若 reply 本身就是中文则原文返回)、"
            "customer_lang(客户语言名称，如 English/日本語/Espa\u00f1ol/中文)、"
            "inbound_translation(客户最新消息的中文译文；若本是中文则原文返回)、"
            "moves(数组，每项含 method[方法论名，如SPIN/Challenger/MEDDIC/Cialdini…] 和 move[本轮具体用了哪一招]，说明方法论用在了哪里)、"
            "send_asset(要附带发送的素材ID，没有则空字符串；只能选标记“可对外”的素材)、"
            f"stage(更新后的阶段，只能从这些中选：{'/'.join(STAGES)})、win_score(0-100整数赢率)、"
            "next_step(明确、低门槛、有时间点的下一步)、"
            "new_memory(数组，每项含 kind[pain|preference|commitment|objection|taboo|fact] 和 text，本轮新获取需长期记住的信息，用中文记录)、"
            "handoff(布尔，是否该转人工——涉及收款/合同/盖章/重大决定或触红线时为true)、handoff_reason(字符串)、"
            "cited(引用的方法论片段ID数组)。"
        )
        user = (
            f"【公司/人设】{settings.get('company', '')} / {settings.get('persona_name', '')}"
            f"（{settings.get('persona_role', '')}）\n"
            f"【成交规则】{settings.get('deal_rules', '') or '（未设置，按通用销冠策略，涉及金额/合同转人工）'}\n"
            f"【客户】{customer.get('name')} | 平台：{customer.get('platform')} | "
            f"国家：{customer.get('country') or '未知'} | 品类：{customer.get('category') or '未知'} | "
            f"客户类型：{customer.get('customer_type', 'b2b')} | "
            f"当前阶段：{customer.get('stage')} | 当前赢率：{customer.get('win_score')}\n"
            f"【客户记忆】\n{store.memory_block(customer_id)}\n"
            + (f"【AI 背调·公开企业情报】\n{_bg}\n" if (_bg := store.background_block(customer_id)) else "")
            + (f"【历战经验·务必应用（来自过往成败复盘，已验证）】\n{_lsn}\n"
               if (_lsn := store.lessons_block(customer.get("customer_type", "b2b"))) else "")
            + f"【商品·报价区间·可用素材】\n{_catalog_summary(products)}\n"
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
    trans = result.get("reply_translation") or []
    if isinstance(trans, str):
        trans = [trans]
    trans = [str(t) for t in trans]
    # pad/truncate so translations line up 1:1 with replies
    while len(trans) < len(result["reply"]):
        trans.append(result["reply"][len(trans)])
    result["reply_translation"] = trans[: len(result["reply"])]
    result.setdefault("customer_lang", "")
    result.setdefault("inbound_translation", inbound)
    result.setdefault("moves", [])
    result["send_asset"] = _validate_asset(result.get("send_asset", ""), products)
    result["stage"] = _norm_stage(result.get("stage") or customer.get("stage", "认知"))
    result.setdefault("win_score", customer.get("win_score", 40))
    result.setdefault("next_step", "")
    result.setdefault("new_memory", [])
    result.setdefault("handoff", False)
    result.setdefault("handoff_reason", "")
    result.setdefault("cited", cited_ids[:5])
    # human-like send pacing — read → think → type phases (UI shows each in turn)
    _seed = len(store.transcript(customer_id))
    plan = humanize.plan(inbound, result["reply"], seed=_seed)
    result["pacing"] = humanize.pacing(inbound, result["reply"], seed=_seed)  # back-compat
    result["read_ms"] = plan["read_ms"]
    result["think_ms"] = plan["think_ms"]
    result["type_ms"] = plan["type_ms"]
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
    # Re-validate the asset here too — an approved/edited decision must still
    # obey the privacy red-line (only explicitly shareable assets go out).
    asset_id = _validate_asset(decision.get("send_asset", ""), store.list_products())
    replies = decision.get("reply", [])
    trans = decision.get("reply_translation", [])
    lang = decision.get("customer_lang", "")
    for i, text in enumerate(replies):
        aid = asset_id if i == len(replies) - 1 else ""
        tr = trans[i] if i < len(trans) else ""
        sent.append(store.add_message(customer_id, "agent", text, asset_id=aid, translation=tr, lang=lang))
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
    # Deliver through the customer's real channel (sandbox = no-op, stored above).
    # The store is always the source of truth; transport failures don't lose the
    # message, they're just reported back to the caller.
    customer = store.get_customer(customer_id) or {}
    channel = channels.get_channel(customer.get("platform", "sandbox"))
    if replies and channel.name != "sandbox":
        # Human cadence: type for a beat (with a "typing…" indicator) before each
        # message lands, instead of firing them off instantly. We deliver in a
        # background thread so the inbound webhook still returns immediately and
        # doesn't time out while the closer "types".
        delays = humanize.send_delays({
            "read_ms": decision.get("read_ms", 0),
            "think_ms": decision.get("think_ms", 0),
            "type_ms": decision.get("type_ms", []),
        })
        to = customer.get("external_id", "")
        msgs = list(replies)
        threading.Thread(
            target=channel.send, args=(to, msgs, asset_id, delays), daemon=True,
        ).start()
        for m in sent:
            m["delivery"] = {"channel": channel.name, "queued": True}
    return sent
