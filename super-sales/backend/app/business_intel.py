"""Public business-intelligence enrichment for the AI background-check.

theHarvester gives a *network footprint* (domains/subdomains/public emails), but
that is thin sales intel. This module adds the commercially useful signal a
top closer actually opens with — company scale, industry, HQ, founding year,
public leadership titles, a one-line description and recent public news — using
**only free, public, no-key sources**:

  * Wikidata (SPARQL/REST): industry (P452), employees (P1128), country (P17),
    headquarters (P159), inception (P571), CEO (P169), official website (P856).
  * Wikipedia REST summary: a neutral one-line company blurb.
  * Google News RSS: recent public headlines (title + date + source).

Hard red lines (same as background_check):
  * Public **company / business** information only. Never an individual's
    private data, never credentials, never anything behind a login.
  * Every source is public and key-free; nothing here is intrusive.

Everything degrades gracefully: any lookup that errors / times out simply
contributes nothing, and the caller still gets a structured (possibly sparse)
dict.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import quote

import requests

_UA = "SuperSalesIntel/1.0 (+public company research)"
_TIMEOUT = 12

_WIKIDATA_API = "https://www.wikidata.org/w/api.php"
_WIKIDATA_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
_WIKIPEDIA_SUMMARY = "https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}"
_GNEWS_RSS = "https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={gl}:{lang}"

# SEC EDGAR (US public-company filings) — free, no key. UA must identify the caller.
_SEC_UA = "SuperSalesIntel/1.0 sales-research@example.com"
_SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"
_SEC_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik:010d}.json"

# Commercial "buying-trigger" signal: leadership / money / growth moves a closer cares about.
_SIGNAL_TERMS = "hiring OR funding OR raises OR acquisition OR layoffs OR partnership OR CEO OR CFO OR expansion"

# Public homepage tech-stack markers → (tool, what it implies for a seller).
_TECH_MARKERS: list[tuple[str, str]] = [
    ("hubspot", "HubSpot (营销/CRM)"),
    ("marketo", "Marketo (营销自动化)"),
    ("pardot", "Salesforce Pardot (B2B 营销)"),
    ("salesforce", "Salesforce (CRM)"),
    ("force.com", "Salesforce (CRM)"),
    ("intercom", "Intercom (客服/对话)"),
    ("drift.com", "Drift (对话营销)"),
    ("zendesk", "Zendesk (客服)"),
    ("segment.com", "Segment (数据/CDP)"),
    ("googletagmanager", "Google Tag Manager (分析)"),
    ("google-analytics", "Google Analytics (分析)"),
    ("shopify", "Shopify (电商)"),
    ("cloudflare", "Cloudflare (CDN/安全)"),
    ("wordpress", "WordPress (CMS)"),
    ("hsforms", "HubSpot 表单"),
    ("zoominfo", "ZoomInfo (销售情报)"),
    ("amplitude", "Amplitude (产品分析)"),
    ("mixpanel", "Mixpanel (产品分析)"),
]

# Wikidata property → human label we care about.
_PROPS = {
    "P452": "industry",
    "P1128": "employees",
    "P159": "headquarters",
    "P17": "country",
    "P571": "inception",
    "P169": "ceo_title",
    "P856": "website",
}


def _session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = _UA
    return s


def _wikidata_search(s: requests.Session, company: str) -> str:
    """Return the best-matching Wikidata QID for a company name (or '')."""
    try:
        r = s.get(
            _WIKIDATA_API,
            params={
                "action": "wbsearchentities",
                "search": company,
                "language": "en",
                "type": "item",
                "limit": 5,
                "format": "json",
            },
            timeout=_TIMEOUT,
        )
        hits = r.json().get("search", [])
    except Exception:  # noqa: BLE001
        return ""
    # prefer a hit whose description hints at a company/organisation
    for h in hits:
        desc = (h.get("description") or "").lower()
        if any(k in desc for k in ("company", "manufacturer", "corporation", "business", "brand", "enterprise")):
            return h.get("id", "")
    return hits[0].get("id", "") if hits else ""


def _resolve_labels(s: requests.Session, qids: list[str]) -> dict[str, str]:
    """Batch-resolve Wikidata QIDs → English labels."""
    qids = [q for q in qids if q]
    if not qids:
        return {}
    try:
        r = s.get(
            _WIKIDATA_API,
            params={
                "action": "wbgetentities",
                "ids": "|".join(qids[:40]),
                "props": "labels",
                "languages": "en",
                "format": "json",
            },
            timeout=_TIMEOUT,
        )
        ents = r.json().get("entities", {})
    except Exception:  # noqa: BLE001
        return {}
    return {q: (e.get("labels", {}).get("en", {}) or {}).get("value", "") for q, e in ents.items()}


def _claim_value(claim: dict[str, Any]) -> tuple[str, str]:
    """Return (kind, value) for a claim's mainsnak. kind ∈ {qid, str, time, num}."""
    snak = claim.get("mainsnak", {})
    dv = snak.get("datavalue", {})
    val = dv.get("value")
    if isinstance(val, dict) and "id" in val:
        return "qid", val["id"]
    if isinstance(val, dict) and "time" in val:
        return "time", str(val["time"])
    if isinstance(val, dict) and "amount" in val:
        return "num", str(val["amount"]).lstrip("+")
    if isinstance(val, str):
        return "str", val
    return "str", ""


def _wikidata_profile(s: requests.Session, company: str) -> dict[str, Any]:
    qid = _wikidata_search(s, company)
    if not qid:
        return {}
    try:
        r = s.get(_WIKIDATA_ENTITY.format(qid=qid), timeout=_TIMEOUT)
        entity = r.json().get("entities", {}).get(qid, {})
    except Exception:  # noqa: BLE001
        return {}
    claims = entity.get("claims", {})
    raw: dict[str, tuple[str, str]] = {}
    qid_refs: list[str] = []
    for pid, label in _PROPS.items():
        if pid in claims and claims[pid]:
            kind, value = _claim_value(claims[pid][0])
            raw[label] = (kind, value)
            if kind == "qid":
                qid_refs.append(value)
    labels = _resolve_labels(s, qid_refs)
    out: dict[str, Any] = {"qid": qid}
    en_label = (entity.get("labels", {}).get("en", {}) or {}).get("value", "")
    if en_label:
        out["label"] = en_label
    for label, (kind, value) in raw.items():
        if kind == "qid":
            resolved = labels.get(value, "")
            if resolved:
                out[label] = resolved
        elif kind == "time":
            m = re.search(r"(\d{4})", value)
            if m:
                out[label] = m.group(1)
        else:
            out[label] = value
    # P169 is a person QID; we only keep the *title* notion (公开职衔), never claim a name as private intel
    if "ceo_title" in out:
        out["ceo"] = out.pop("ceo_title")
    return out


def _wikipedia_summary(s: requests.Session, company: str, lang: str) -> str:
    code = (lang or "en").split("-")[0].lower() or "en"
    for lc in (code, "en"):
        try:
            r = s.get(
                _WIKIPEDIA_SUMMARY.format(lang=lc, title=quote(company)),
                timeout=_TIMEOUT,
            )
            if r.status_code == 200:
                extract = r.json().get("extract", "")
                if extract:
                    return extract[:400]
        except Exception:  # noqa: BLE001
            continue
    return ""


def _news(
    company: str, *, lang: str = "en", country: str = "US", extra: str = ""
) -> list[dict[str, str]]:
    """Recent public headlines via Google News RSS (no key). Best-effort.

    ``extra`` appends a boolean query (e.g. buying-signal terms) to bias the feed
    toward commercially actionable headlines."""
    code = (lang or "en").split("-")[0].lower() or "en"
    gl = (country or "US").upper()[:2] or "US"
    q = f'"{company}" ({extra})' if extra else f'"{company}"'
    url = _GNEWS_RSS.format(q=quote(q), hl=code, gl=gl, lang=code)
    try:
        r = requests.get(url, headers={"User-Agent": _UA}, timeout=_TIMEOUT)
        root = ET.fromstring(r.content)
    except Exception:  # noqa: BLE001
        return []
    out: list[dict[str, str]] = []
    for item in list(root.iter("item"))[:8]:
        title = (item.findtext("title") or "").strip()
        if not title:
            continue
        src_el = item.find("source")
        out.append(
            {
                "title": title,
                "date": (item.findtext("pubDate") or "").strip()[:16],
                "source": (src_el.text or "").strip() if src_el is not None else "",
            }
        )
    return out


def _homepage(domain: str) -> tuple[str, list[str]]:
    """Return (public blurb, detected tech-stack hints) from the company homepage.

    Only the publicly served HTML is inspected — no login, no intrusive probing."""
    if not domain:
        return "", []
    url = domain if domain.startswith("http") else f"https://{domain}"
    try:
        r = requests.get(url, headers={"User-Agent": _UA}, timeout=_TIMEOUT)
        html = r.text[:300_000]
    except Exception:  # noqa: BLE001
        return "", []
    blurb = ""
    m = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', html, re.I)
    if m:
        blurb = m.group(1).strip()[:300]
    else:
        m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.I)
        blurb = m.group(1).strip()[:200] if m else ""
    low = html.lower()
    tech: list[str] = []
    for marker, label in _TECH_MARKERS:
        if marker in low and label not in tech:
            tech.append(label)
    return blurb, tech[:10]


_SEC_TICKERS_CACHE: list[dict[str, Any]] | None = None


def _load_sec_tickers(s: requests.Session) -> list[dict[str, Any]]:
    global _SEC_TICKERS_CACHE
    if _SEC_TICKERS_CACHE is not None:
        return _SEC_TICKERS_CACHE
    try:
        r = s.get(_SEC_TICKERS, headers={"User-Agent": _SEC_UA}, timeout=_TIMEOUT)
        data = r.json()
        _SEC_TICKERS_CACHE = list(data.values()) if isinstance(data, dict) else []
    except Exception:  # noqa: BLE001
        _SEC_TICKERS_CACHE = []
    return _SEC_TICKERS_CACHE


def _norm_company(name: str) -> str:
    n = re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower())
    n = re.sub(r"\b(inc|corp|corporation|co|ltd|llc|plc|holdings|group|the)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def _sec_edgar(s: requests.Session, company: str) -> dict[str, Any]:
    """Public-company basics from SEC EDGAR (no key): ticker, SIC industry, recent
    filings. Strong B2B signal — public co. ⇒ budget cycles, earnings, 8-K events."""
    target = _norm_company(company)
    if not target:
        return {}
    cik = ""
    for row in _load_sec_tickers(s):
        if _norm_company(str(row.get("title", ""))) == target:
            cik = str(row.get("cik_str", ""))
            break
    if not cik:
        # fall back to a loose contains-match (handles "GitLab" vs "GitLab Inc.")
        for row in _load_sec_tickers(s):
            t = _norm_company(str(row.get("title", "")))
            if t and (t.startswith(target) or target.startswith(t)):
                cik = str(row.get("cik_str", ""))
                break
    if not cik:
        return {}
    try:
        r = s.get(
            _SEC_SUBMISSIONS.format(cik=int(cik)),
            headers={"User-Agent": _SEC_UA},
            timeout=_TIMEOUT,
        )
        d = r.json()
    except Exception:  # noqa: BLE001
        return {}
    recent = d.get("filings", {}).get("recent", {})
    forms = recent.get("form", []) or []
    dates = recent.get("filingDate", []) or []
    filings: list[str] = []
    for form, date in zip(forms, dates):
        if form in ("10-K", "10-Q", "8-K", "S-1", "DEF 14A") and len(filings) < 6:
            filings.append(f"{date} {form}")
    return {
        "is_public": True,
        "ticker": (d.get("tickers") or [""])[0],
        "exchange": (d.get("exchanges") or [""])[0],
        "sic_industry": d.get("sicDescription", ""),
        "fiscal_year_end": d.get("fiscalYearEnd", ""),
        "recent_filings": filings,
    }


def enrich(company: str, domain: str = "", country: str = "", *, lang: str = "en") -> dict[str, Any]:
    """Aggregate free public business intel. Always returns a structured dict."""
    company = (company or "").strip()
    if not company:
        return {"wikidata": {}, "summary": "", "news": [], "site_blurb": "", "available": False}
    s = _session()
    wd = _wikidata_profile(s, company)
    summary = _wikipedia_summary(s, company, lang)
    gl = (country or "US").upper()[:2] or "US"
    news = _news(company, lang=lang, country=gl)
    signals = _news(company, lang=lang, country=gl, extra=_SIGNAL_TERMS)
    blurb, tech = _homepage(domain or wd.get("website", ""))
    edgar = _sec_edgar(s, company)
    return {
        "wikidata": wd,
        "summary": summary,
        "news": news,
        "signals": signals,
        "site_blurb": blurb,
        "tech_stack": tech,
        "edgar": edgar,
        "available": bool(wd or summary or news or edgar or tech),
    }
