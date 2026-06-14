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


def _news(company: str, *, lang: str = "en", country: str = "US") -> list[dict[str, str]]:
    """Recent public headlines via Google News RSS (no key). Best-effort."""
    code = (lang or "en").split("-")[0].lower() or "en"
    gl = (country or "US").upper()[:2] or "US"
    url = _GNEWS_RSS.format(q=quote(f'"{company}"'), hl=code, gl=gl, lang=code)
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


def _site_blurb(domain: str) -> str:
    """Grab the public meta description / title of the company homepage."""
    if not domain:
        return ""
    url = domain if domain.startswith("http") else f"https://{domain}"
    try:
        r = requests.get(url, headers={"User-Agent": _UA}, timeout=_TIMEOUT)
        html = r.text[:200_000]
    except Exception:  # noqa: BLE001
        return ""
    m = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', html, re.I)
    if m:
        return m.group(1).strip()[:300]
    m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.I)
    return m.group(1).strip()[:200] if m else ""


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
    blurb = _site_blurb(domain or wd.get("website", ""))
    return {
        "wikidata": wd,
        "summary": summary,
        "news": news,
        "site_blurb": blurb,
        "available": bool(wd or summary or news),
    }
