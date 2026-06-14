#!/usr/bin/env python3
"""Crawl *public* sales-knowledge pages → structured playbook entries.

Built on `scrapling` (https://github.com/D4Vinci/Scrapling). Turns public,
encyclopedic sales-methodology pages ("新手 → 销冠" material: SPIN / Challenger /
Sandler / MEDDIC / Cialdini influence / objection handling / closing / pipeline
SOP) into normalised, citable knowledge entries that the closer's RAG can use.

Two modes:
  * ``--builtin``  : crawl a curated list of public sales-knowledge pages
                     (mostly Wikipedia, CC BY-SA, robots-friendly) — works out
                     of the box, no seeds file needed.
  * ``--seeds f``  : crawl operator-supplied public URLs (one per line).
  * ``--crawl``    : additionally follow on-page links within the same domain
                     whose anchor text looks sales-related, up to ``--max-pages``
                     — this is how we pull *large amounts* of public knowledge.

Output: JSONL (one entry per chunk). With ``--merge-playbook`` the entries are
also written to ``app/data/crawled_knowledge.jsonl``, which the retriever loads
at startup and folds into the live knowledge base — so crawled knowledge is
actually used by the AI, not just parked on disk.

Compliance is intentional, not incidental:
  * Only public pages; ``robots.txt`` is honoured; polite delay + identifying UA.
  * Long articles are chunked into short *facts for internal reference* and the
    source URL is kept on every entry for attribution — we don't republish whole
    copyrighted texts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.robotparser
from collections import deque
from urllib.parse import urljoin, urlparse

_UA = "SuperSalesKnowledgeBot/1.0 (+internal sales research; respects robots.txt)"

# Curated public sales-knowledge seeds (verified to exist; CC BY-SA encyclopedic
# coverage of the core "novice → top closer" methodology surface).
BUILTIN_SEEDS: list[str] = [
    "https://en.wikipedia.org/wiki/Sales",
    "https://en.wikipedia.org/wiki/Sales_process",
    "https://en.wikipedia.org/wiki/Solution_selling",
    "https://en.wikipedia.org/wiki/The_Challenger_Sale",
    "https://en.wikipedia.org/wiki/Closing_(sales)",
    "https://en.wikipedia.org/wiki/Cold_calling",
    "https://en.wikipedia.org/wiki/Upselling",
    "https://en.wikipedia.org/wiki/Sales_management",
    "https://en.wikipedia.org/wiki/Lead_generation",
    "https://en.wikipedia.org/wiki/Value_proposition",
    "https://en.wikipedia.org/wiki/Negotiation",
    "https://en.wikipedia.org/wiki/Persuasion",
    "https://en.wikipedia.org/wiki/Robert_Cialdini",
    "https://en.wikipedia.org/wiki/AIDA_(marketing)",
    "https://en.wikipedia.org/wiki/Buyer_decision_process",
    "https://en.wikipedia.org/wiki/Customer_relationship_management",
    "https://en.wikipedia.org/wiki/Account-based_marketing",
]

# Anchor text that marks a link worth following in --crawl mode.
_RELEVANT = re.compile(
    r"sell|sales|selling|negotiat|persuas|custom|buyer|closing|prospect|"
    r"objection|pipeline|marketing|influence|deal|account|lead|pitch|crm",
    re.I,
)
_CHUNK = 900  # target characters per knowledge chunk


def _slug(url: str) -> str:
    p = urlparse(url)
    base = (p.path.strip("/").replace("/", "-") or p.netloc).lower()
    return re.sub(r"[^a-z0-9\-]+", "-", base)[:48] or "page"


_ROBOTS: dict[str, urllib.robotparser.RobotFileParser] = {}


def _robots(url: str):
    """Fetch & cache robots.txt via scrapling (proper UA), parse with stdlib."""
    from scrapling.fetchers import Fetcher  # type: ignore

    p = urlparse(url)
    root = f"{p.scheme}://{p.netloc}"
    if root in _ROBOTS:
        return _ROBOTS[root]
    rp = urllib.robotparser.RobotFileParser()
    try:
        resp = Fetcher.get(f"{root}/robots.txt", timeout=15)
        if resp.status == 200:
            rp.parse(resp.body.decode("utf-8", "ignore").splitlines())
        else:
            rp.allow_all = True  # no robots → assume allowed
    except Exception:  # noqa: BLE001
        rp.allow_all = True
    _ROBOTS[root] = rp
    return rp


def _allowed(url: str) -> bool:
    try:
        return _robots(url).can_fetch(_UA, url)
    except Exception:  # noqa: BLE001
        return False


def _first(page, selector: str) -> str:
    hits = page.css(selector)
    return str(hits[0]) if hits else ""


def _fetch(url: str) -> tuple[str, str, list[str]]:
    """Return (title, main_text, same-domain sales-relevant links)."""
    from scrapling.fetchers import Fetcher  # type: ignore

    page = Fetcher.get(url, timeout=25)
    if page.status != 200:
        return "", "", []
    title = _first(page, "title::text") or _first(page, "h1::text") or url
    paras = []
    for el in page.css("article p, main p, p"):
        txt = str(el.text or "").strip()
        if txt and len(txt) > 40:
            paras.append(txt)
    text = "\n".join(paras)
    host = urlparse(url).netloc
    links: list[str] = []
    for a in page.css("a"):
        href = a.attrib.get("href", "")
        anchor = str(a.text or "")
        if not href or href.startswith("#"):
            continue
        full = urljoin(url, href)
        pu = urlparse(full)
        if pu.netloc == host and pu.path.startswith("/wiki/") and ":" not in pu.path:
            if _RELEVANT.search(anchor) or _RELEVANT.search(pu.path):
                links.append(full.split("#")[0])
    return str(title).strip(), text.strip(), list(dict.fromkeys(links))


def _chunk(text: str) -> list[str]:
    """Pack paragraphs into ~_CHUNK-sized chunks (keeps entries citable & small)."""
    chunks, buf = [], ""
    for para in text.split("\n"):
        if len(buf) + len(para) + 1 > _CHUNK and buf:
            chunks.append(buf.strip())
            buf = ""
        buf += para + "\n"
    if buf.strip():
        chunks.append(buf.strip())
    return chunks


def _clean_title(title: str) -> str:
    return re.sub(r"\s*[-—|].*$", "", title).strip()[:120]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--builtin", action="store_true", help="crawl the curated public seed list")
    ap.add_argument("--seeds", help="text file, one public URL per line")
    ap.add_argument("--out", default="crawled_knowledge.jsonl")
    ap.add_argument("--topic", default="公开销售知识")
    ap.add_argument("--crawl", action="store_true", help="follow on-page same-domain sales links")
    ap.add_argument("--max-pages", type=int, default=40)
    ap.add_argument("--delay", type=float, default=1.5, help="polite delay between requests (s)")
    ap.add_argument(
        "--merge-playbook",
        action="store_true",
        help="also write entries to app/data/crawled_knowledge.jsonl (loaded by the retriever)",
    )
    args = ap.parse_args()

    try:
        import scrapling  # noqa: F401
    except ImportError:
        print('scrapling not installed. Install it first:\n  pip install "scrapling[fetchers]"')
        return 1

    seeds: list[str] = []
    if args.builtin:
        seeds += BUILTIN_SEEDS
    if args.seeds:
        with open(args.seeds, encoding="utf-8") as fh:
            seeds += [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    if not seeds:
        print("no seeds. Use --builtin and/or --seeds <file>.")
        return 1

    queue: deque[str] = deque(dict.fromkeys(seeds))
    seen: set[str] = set()
    entries: list[dict[str, str]] = []
    pages = 0

    while queue and pages < args.max_pages:
        url = queue.popleft()
        if url in seen:
            continue
        seen.add(url)
        if not _allowed(url):
            print(f"[skip] robots.txt disallows: {url}")
            continue
        try:
            title, text, links = _fetch(url)
        except Exception as e:  # noqa: BLE001
            print(f"[err ] {url}: {e}")
            continue
        if len(text) < 200:
            print(f"[thin] {url}: too little extractable text, skipped")
            time.sleep(args.delay)
            continue
        pages += 1
        chunks = _chunk(text)
        base_id = _slug(url).upper()
        clean = _clean_title(title)
        for i, ch in enumerate(chunks):
            entries.append(
                {
                    "id": f"WEB-{base_id}-{i:02d}",
                    "topic": args.topic,
                    "title": f"{clean}（公开资料 {i + 1}/{len(chunks)}）",
                    "text": ch[:2000],
                    "source": url,
                }
            )
        print(f"[ok  ] {url} → {len(chunks)} chunks  (page {pages}/{args.max_pages})")
        if args.crawl:
            for link in links:
                if link not in seen:
                    queue.append(link)
        time.sleep(args.delay)

    with open(args.out, "w", encoding="utf-8") as out:
        for e in entries:
            out.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"\nwrote {len(entries)} entries from {pages} pages → {args.out}")

    if args.merge_playbook:
        data_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "app", "data")
        os.makedirs(data_dir, exist_ok=True)
        dest = os.path.join(data_dir, "crawled_knowledge.jsonl")
        with open(dest, "w", encoding="utf-8") as out:
            for e in entries:
                out.write(json.dumps(e, ensure_ascii=False) + "\n")
        print(f"merged into retriever corpus → {dest}")

    print("next: ingest into RAGFlow (scripts/ragflow_ingest.py) for multimodal RAG, or it's already")
    print("live for the local retriever if you used --merge-playbook.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
