"""AI background-check for overseas B2B prospects.

Two complementary public-only engines feed one LLM brief:

  1. **theHarvester** (https://github.com/laramies/theHarvester, 12k+★) — passive
     network footprint (domains / subdomains / public emails / IPs) from free
     sources (cert transparency, hackertarget, …). Optional; needs the binary.
  2. **business_intel** — free public commercial intel (Wikidata scale/industry/
     HQ/founding, Wikipedia blurb, Google News headlines). No key, no binary.

The combined public signal is summarised by the LLM into a short, sales-useful
brief that becomes extra context for the closer.

Hard red lines (enforced by design):
  * Company / public business information ONLY. We never target an individual's
    private data, never harvest credentials, never scrape behind logins.
  * Every source is public and key-free; intrusive modules are not used.

It degrades gracefully: with no theHarvester binary we still return business
intel; with no network at all we still return a structured (sparse) result and
let the LLM reason from whatever public signal exists.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from typing import Any

from . import business_intel, llm

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
    lang: str,
) -> dict[str, Any]:
    """Summarise the public signal into a sales-useful brief via the LLM."""
    if not llm.llm_available():
        return {}
    system = (
        "你是一名 B2B 销售情报分析师。基于给出的【公开】企业信息（公司画像/行业/规模/总部/成立年/"
        "公开新闻/官网简介/网络足迹），为销售提炼一份简短情报，帮助销冠开场和建立专业感。"
        "只用公开商业信息，绝不编造具体隐私数据，不确定就标注'推测'。只输出 JSON："
        "company_profile(一句话公司画像)、industry_guess(行业)、company_scale(规模推断，如员工数/体量)、"
        "footprint_summary(一句话网络足迹概述)、recent_developments(近期公开动态要点数组，基于给出的新闻，"
        "没有就空数组)、possible_decision_makers(可能的决策人公开职衔数组，如 CEO/采购总监，不要编造人名)、"
        "talking_points(3-5 条可用于开场/建立信任的话题数组)、sales_angle(最可能打动他们的销售切入角度)、"
        "caution(合规/沟通注意事项)。"
    )
    wd = intel.get("wikidata", {})
    subdomains = footprint.get("hosts", [])
    news_lines = [f"{n.get('date', '')} {n.get('title', '')}（{n.get('source', '')}）" for n in intel.get("news", [])]
    user = (
        f"公司名：{company or '未知'}\n国家：{country or '未知'}\n主域名：{domain or '未知'}\n"
        f"Wikidata 画像：行业={wd.get('industry', '?')} 员工数={wd.get('employees', '?')} "
        f"总部={wd.get('headquarters', '?')} 国家={wd.get('country', '?')} 成立={wd.get('inception', '?')}\n"
        f"维基百科简介：{intel.get('summary') or '无'}\n"
        f"官网简介：{intel.get('site_blurb') or '无'}\n"
        f"近期公开新闻（{len(news_lines)}）：\n" + ("\n".join(f"- {x}" for x in news_lines[:8]) or "无") + "\n"
        f"公开子域（{len(subdomains)}）：{', '.join(subdomains[:25]) or '无'}\n"
        f"公开邮箱：{', '.join(footprint.get('emails', [])) or '无'}\n"
        f"销售对客户使用的语言：{lang or '中文'}\n"
    )
    try:
        return llm.chat_json(system, user, temperature=0.4)
    except Exception:  # noqa: BLE001
        return {}


def check_company(
    company: str, domain: str = "", country: str = "", lang: str = ""
) -> dict[str, Any]:
    """Run public footprint + business intel + LLM brief. Always structured."""
    resolved = _guess_domain(company, domain)
    footprint = _run_theharvester(resolved)
    intel = business_intel.enrich(company, resolved, country, lang=lang or "en")
    brief = _brief(company, resolved, country, footprint, intel, lang)
    engines = []
    if footprint.get("available"):
        engines.append("theHarvester")
    if intel.get("available"):
        engines.append("business-intel")
    return {
        "company": company,
        "domain": resolved,
        "country": country,
        "footprint": footprint,
        "intel": intel,
        "brief": brief,
        "engine": "+".join(engines) or "unavailable",
    }
