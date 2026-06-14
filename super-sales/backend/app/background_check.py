"""AI background-check engine for sales prospecting (公司 + 决策人公开调研).

Multiple complementary, key-free open-source engines feed one sales-tailored
LLM brief:

  Company signal
  1. **theHarvester** (laramies/theHarvester, 12k+★) — passive network footprint
     (subdomains / public emails / IPs) from free sources.
  2. **business_intel** — free public commercial intel (Wikidata scale/industry/
     HQ/founding, Wikipedia blurb, Google News headlines).
  3. **SpiderFoot** (smicallef/spiderfoot, ~14k★) — broad OSINT aggregation
     (opt-in via SPIDERFOOT_ENABLE).

  Decision-maker signal (people_osint, only when a contact is provided)
  4. **Maigret** (soxoj/maigret, ~33k★) — username → accounts across 3000+ sites.
  5. **Blackbird** (p1ngul1n0/blackbird, ~6k★) — username/email web footprint.
  6. **Holehe** (megadose/holehe) — email → registered services.

The combined PUBLIC signal is summarised by the LLM into a short brief whose
style adapts to ``customer_type``: ``b2b`` → consultative (decision-makers,
buying signals, pain points, ROI); ``b2c`` → 带货/激发购买欲 (Streamer-Sales
style) used ONLY when the customer is a consumer and we are simply selling goods.

Hard red lines (enforced by design):
  * PUBLIC information only — for legitimate sales due diligence. We never harvest
    credentials, never scrape behind logins, never fabricate private data.
  * Every source is public and key-free; intrusive scanning is not used.

It degrades gracefully: any missing engine / no network still yields a
structured (sparse) result and the LLM reasons from whatever public signal exists.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from typing import Any

from . import business_intel, llm, people_osint, spiderfoot_intel

# SpiderFoot company-OSINT is opt-in (heavier/slower); business_intel + theHarvester
# already cover the company path, so default off unless explicitly enabled.
_SPIDERFOOT_ENABLE = os.getenv("SPIDERFOOT_ENABLE", "").lower() in {"1", "true", "yes"}

# Path to the theHarvester CLI (its own venv keeps deps off the backend).
_THEHARVESTER_BIN = os.getenv(
    "THEHARVESTER_BIN", os.path.expanduser("~/theHarvester/.venv/bin/theHarvester")
)
# Free, public, no-key passive sources. Override via env if desired.
_SOURCES = os.getenv("THEHARVESTER_SOURCES", "hackertarget,crtsh,certspotter,rapiddns")
_TIMEOUT_S = int(os.getenv("THEHARVESTER_TIMEOUT", "60"))

_DOMAIN_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,})+", re.I)


def harvester_available() -> bool:
    return os.path.exists(_THEHARVESTER_BIN)


def available() -> bool:
    """The feature is usable even without theHarvester — business intel needs
    no key or binary, only public network access."""
    return True


def _guess_domain(company: str, domain: str) -> str:
    if domain:
        d = domain.strip().lower()
        d = re.sub(r"^https?://", "", d).split("/")[0]
        return d
    m = _DOMAIN_RE.search(company or "")
    return m.group(0).lower() if m else ""


def _run_theharvester(domain: str) -> dict[str, Any]:
    """Run a passive recon pass; return parsed hosts/emails/ips (best-effort)."""
    if not harvester_available() or not domain:
        return {"hosts": [], "emails": [], "ips": [], "available": harvester_available()}
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "out")
        try:
            subprocess.run(
                [_THEHARVESTER_BIN, "-d", domain, "-b", _SOURCES, "-f", out],
                capture_output=True,
                timeout=_TIMEOUT_S,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {"hosts": [], "emails": [], "ips": [], "available": True, "note": "timeout"}
        path = f"{out}.json"
        if not os.path.exists(path):
            return {"hosts": [], "emails": [], "ips": [], "available": True}
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError):
            data = {}
    hosts = [str(h).split(":")[0] for h in data.get("hosts", []) if h]
    return {
        "hosts": sorted(set(hosts))[:40],
        "emails": sorted(set(data.get("emails", [])))[:20],
        "ips": sorted(set(data.get("ips", [])))[:20],
        "available": True,
    }


def _brief(
    company: str,
    domain: str,
    country: str,
    footprint: dict[str, Any],
    intel: dict[str, Any],
    company_osint: dict[str, Any],
    people: dict[str, Any],
    lang: str,
    customer_type: str,
) -> dict[str, Any]:
    """Summarise the public signal into a sales-useful brief via the LLM.

    The brief style adapts to ``customer_type`` (b2b consultative vs b2c 带货)."""
    if not llm.llm_available():
        return {}
    is_b2c = customer_type == "b2c"
    if is_b2c:
        role = (
            "你是一名顶级带货销冠（C 端卖货场景）。基于【公开】信息为销售提炼能激发购买欲的情报，"
            "风格借鉴中文带货话术：突出卖点冲击、稀缺/限时、从众、利益点，但不得编造、不得虚假承诺。"
        )
        extra_fields = (
            "buying_triggers(能促单的心理触发点数组，如稀缺/从众/痛点)、"
            "sales_angle(带货切入角度，一句能抓住客户的开场)"
        )
    else:
        role = (
            "你是一名资深 B2B 销售情报分析师（顾问式销售）。基于【公开】企业与决策人信息，"
            "为销冠提炼可用于开场、建立专业感、推进成单的情报。"
        )
        extra_fields = (
            "buying_triggers(可能的采购/合作信号数组)、"
            "sales_angle(最可能打动该公司的顾问式销售切入角度，结合其痛点与 ROI)"
        )
    system = (
        f"{role} 只用公开商业信息，绝不编造具体隐私数据，不确定就标注'推测'。"
        f"用客户的语言（{lang or '中文'}）撰写文本字段的内容。只输出 JSON，字段："
        "company_profile(一句话公司画像)、industry_guess(行业)、company_scale(规模推断)、"
        "footprint_summary(一句话网络足迹/OSINT 概述)、recent_developments(近期公开动态要点数组，"
        "基于给出的新闻，没有就空数组)、possible_decision_makers(可能的决策人公开职衔数组，不要编造人名)、"
        "contact_summary(若给出对接人公开账号，则一句话画像，否则空字符串)、"
        "icebreakers(针对该对接人/公司的破冰话题数组，结合其公开账号/动态，没有依据就给通用话题)、"
        "talking_points(3-5 条建立信任的话题数组)、"
        "company_scale_money(一句话经营/预算线索，结合上市状态/财报/员工数，没有就空字符串)、"
        "tech_stack(对方公开技术栈线索数组，结合给出的官网技术标记，没有就空数组)、"
        "competitive_landscape(一句话竞争态势/替换或互补机会，没有依据就空字符串)、"
        f"{extra_fields}、caution(合规/沟通注意事项)。"
    )
    wd = intel.get("wikidata", {})
    edgar = intel.get("edgar", {}) or {}
    tech = intel.get("tech_stack", []) or []
    subdomains = footprint.get("hosts", [])
    news_lines = [f"{n.get('date', '')} {n.get('title', '')}（{n.get('source', '')}）" for n in intel.get("news", [])]
    signal_lines = [f"{n.get('date', '')} {n.get('title', '')}（{n.get('source', '')}）" for n in intel.get("signals", [])]
    osint_lines = spiderfoot_intel.summary_lines(company_osint)
    people_lines = people_osint.summary_lines(people)
    if edgar.get("is_public"):
        edgar_line = (
            f"上市公司｜代码={edgar.get('ticker', '?')}({edgar.get('exchange', '?')}) "
            f"SIC 行业={edgar.get('sic_industry', '?')} 财年末={edgar.get('fiscal_year_end', '?')} "
            f"近期备案={', '.join(edgar.get('recent_filings', [])) or '无'}"
        )
    else:
        edgar_line = "未匹配到美股公开备案（可能非上市/非美股）"
    user = (
        f"客户类型：{'C 端消费者(纯卖货)' if is_b2c else 'B 端企业(顾问式)'}\n"
        f"公司名：{company or '未知'}\n国家：{country or '未知'}\n主域名：{domain or '未知'}\n"
        f"Wikidata 画像：行业={wd.get('industry', '?')} 员工数={wd.get('employees', '?')} "
        f"总部={wd.get('headquarters', '?')} 国家={wd.get('country', '?')} 成立={wd.get('inception', '?')}\n"
        f"SEC EDGAR 经营信号：{edgar_line}\n"
        f"维基百科简介：{intel.get('summary') or '无'}\n"
        f"官网简介：{intel.get('site_blurb') or '无'}\n"
        f"官网技术栈线索：{', '.join(tech) or '无'}\n"
        f"近期公开新闻（{len(news_lines)}）：\n" + ("\n".join(f"- {x}" for x in news_lines[:8]) or "无") + "\n"
        f"采购/经营信号新闻（{len(signal_lines)}）：\n" + ("\n".join(f"- {x}" for x in signal_lines[:6]) or "无") + "\n"
        f"公开子域（{len(subdomains)}）：{', '.join(subdomains[:25]) or '无'}\n"
        f"公开邮箱：{', '.join(footprint.get('emails', [])) or '无'}\n"
        f"公司 OSINT(SpiderFoot)：\n" + ("\n".join(f"- {x}" for x in osint_lines) or "无") + "\n"
        f"对接人：{people.get('name') or people.get('username') or people.get('email') or '未指定'}\n"
        f"对接人公开足迹(Maigret/Blackbird/Holehe)：\n" + ("\n".join(f"- {x}" for x in people_lines) or "无") + "\n"
        f"销售对客户使用的语言：{lang or '中文'}\n"
    )
    try:
        return llm.chat_json(system, user, temperature=0.5 if is_b2c else 0.4)
    except Exception:  # noqa: BLE001
        return {}


def check_company(
    company: str,
    domain: str = "",
    country: str = "",
    lang: str = "",
    *,
    contact_name: str = "",
    contact_email: str = "",
    contact_username: str = "",
    customer_type: str = "b2b",
) -> dict[str, Any]:
    """Run public company + decision-maker OSINT + LLM brief. Always structured."""
    customer_type = "b2c" if str(customer_type).lower() == "b2c" else "b2b"
    resolved = _guess_domain(company, domain)
    footprint = _run_theharvester(resolved)
    intel = business_intel.enrich(company, resolved, country, lang=lang or "en")
    company_osint = (
        spiderfoot_intel.scan(resolved)
        if _SPIDERFOOT_ENABLE and resolved
        else {"available": False}
    )
    has_contact = bool(contact_name or contact_email or contact_username)
    people = (
        people_osint.investigate(contact_name, contact_email, contact_username)
        if has_contact
        else {"available": False}
    )
    brief = _brief(
        company, resolved, country, footprint, intel, company_osint, people, lang, customer_type
    )
    engines = []
    if footprint.get("available"):
        engines.append("theHarvester")
    if intel.get("available"):
        engines.append("business-intel")
    if company_osint.get("available"):
        engines.append("spiderfoot")
    for e in people.get("engines", []) if isinstance(people, dict) else []:
        engines.append(e)
    return {
        "company": company,
        "domain": resolved,
        "country": country,
        "customer_type": customer_type,
        "footprint": footprint,
        "intel": intel,
        "company_osint": company_osint,
        "contact": people,
        "brief": brief,
        "engine": "+".join(engines) or "unavailable",
    }
