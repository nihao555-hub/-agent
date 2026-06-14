"""AI background-check for overseas B2B prospects.

Wraps **theHarvester** (https://github.com/laramies/theHarvester, 12k+★) to do
*passive, public* company-footprint recon — domains / subdomains / public
emails / IPs from free sources (cert transparency, hackertarget, …). The raw
footprint is then summarised by the LLM into a short, sales-useful brief that
becomes extra context for the closer.

Hard red lines (enforced by design):
  * Company / public business information ONLY. We never target an individual's
    private data, never harvest credentials, never scrape behind logins.
  * Default sources require no API key and only touch public data. Key-gated or
    intrusive modules are intentionally not used.
  * A pluggable ``news`` hook lets the operator add a company-news provider
    later (needs their key); absent a key it is a no-op.

It degrades gracefully: if theHarvester is not installed, or a lookup fails /
times out, we still return a structured (possibly empty) result and let the LLM
reason from whatever public signal we have.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from typing import Any

from . import llm

# Path to the theHarvester CLI (its own venv keeps deps off the backend).
_THEHARVESTER_BIN = os.getenv(
    "THEHARVESTER_BIN", os.path.expanduser("~/theHarvester/.venv/bin/theHarvester")
)
# Free, public, no-key passive sources. Override via env if desired.
_SOURCES = os.getenv("THEHARVESTER_SOURCES", "hackertarget,crtsh,certspotter,rapiddns")
_TIMEOUT_S = int(os.getenv("THEHARVESTER_TIMEOUT", "60"))

_DOMAIN_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,})+", re.I)


def available() -> bool:
    return os.path.exists(_THEHARVESTER_BIN)


def _guess_domain(company: str, domain: str) -> str:
    if domain:
        d = domain.strip().lower()
        d = re.sub(r"^https?://", "", d).split("/")[0]
        return d
    m = _DOMAIN_RE.search(company or "")
    return m.group(0).lower() if m else ""


def _run_theharvester(domain: str) -> dict[str, Any]:
    """Run a passive recon pass; return parsed hosts/emails/ips (best-effort)."""
    if not available() or not domain:
        return {"hosts": [], "emails": [], "ips": [], "available": available()}
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


def _news(company: str) -> list[str]:
    """Pluggable company-news hook. No-op unless a provider key is configured."""
    # Intentionally empty by default — wire a provider (needs operator's key) here.
    return []


def _brief(company: str, domain: str, country: str, footprint: dict[str, Any]) -> dict[str, Any]:
    """Summarise the public footprint into a sales-useful brief via the LLM."""
    if not llm.llm_available():
        return {}
    system = (
        "你是一名 B2B 销售情报分析师。基于给出的【公开】企业足迹（域名/子域/公开邮箱）和公司名，"
        "为销售推断一份简短情报，帮助销冠开场和建立专业感。只用公开商业信息，绝不编造具体隐私数据，"
        "不确定就标注'推测'。只输出 JSON：industry_guess(行业推测)、footprint_summary(一句话足迹概述)、"
        "possible_decision_makers(可能的决策人公开职衔数组，如 CEO/采购总监，不要编造人名)、"
        "talking_points(3-5 条可用于开场/建立信任的话题数组)、sales_angle(最可能打动他们的销售切入角度)、"
        "caution(合规/沟通注意事项)。"
    )
    subdomains = footprint.get("hosts", [])
    user = (
        f"公司名：{company or '未知'}\n国家：{country or '未知'}\n主域名：{domain or '未知'}\n"
        f"公开子域（{len(subdomains)}）：{', '.join(subdomains[:25]) or '无'}\n"
        f"公开邮箱：{', '.join(footprint.get('emails', [])) or '无'}\n"
        f"近期公开动态：{'; '.join(_news(company)) or '（未接入新闻源）'}\n"
    )
    try:
        return llm.chat_json(system, user, temperature=0.4)
    except Exception:  # noqa: BLE001
        return {}


def check_company(company: str, domain: str = "", country: str = "") -> dict[str, Any]:
    """Run passive public recon + LLM brief. Always returns a structured dict."""
    resolved = _guess_domain(company, domain)
    footprint = _run_theharvester(resolved)
    brief = _brief(company, resolved, country, footprint)
    return {
        "company": company,
        "domain": resolved,
        "country": country,
        "footprint": footprint,
        "brief": brief,
        "engine": "theHarvester" if footprint.get("available") else "unavailable",
    }
