#!/usr/bin/env python3
"""Crawl *public* overseas sales-knowledge pages → structured playbook entries.

Scaffold around `scrapling` (https://github.com/D4Vinci/Scrapling). The operator
supplies a list of seed URLs (a `--seeds seeds.txt`, one URL per line); the
script fetches each page, extracts the readable main text + title, and writes
normalised entries to a JSONL that can be reviewed and then ingested into the
knowledge base (RAGFlow via ``ragflow_ingest`` or appended to the local
playbook).

Compliance is intentional, not incidental:
  * Only operator-provided, publicly reachable pages are fetched.
  * ``robots.txt`` is honoured; a polite delay + identifying UA are used.
  * Output is *structured facts for internal reference*, with the source URL kept
    on every entry for attribution — we don't republish copyrighted text.

This is a scaffold: it runs and produces JSONL when ``scrapling`` is installed
(`pip install scrapling`), and degrades to a clear message otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.robotparser
from urllib.parse import urlparse

_UA = "SuperSalesKnowledgeBot/1.0 (+internal research; respects robots.txt)"


def _slug(url: str) -> str:
    p = urlparse(url)
    base = (p.path.strip("/").replace("/", "-") or p.netloc).lower()
    return re.sub(r"[^a-z0-9\-]+", "-", base)[:48] or "page"


def _allowed(url: str) -> bool:
    try:
        p = urlparse(url)
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(f"{p.scheme}://{p.netloc}/robots.txt")
        rp.read()
        return rp.can_fetch(_UA, url)
    except Exception:  # noqa: BLE001 — if robots can't be read, be conservative
        return False


def _fetch_text(url: str) -> tuple[str, str]:
    """Return (title, main_text) for a public page using scrapling."""
    from scrapling.fetchers import Fetcher  # type: ignore

    page = Fetcher.get(url, headers={"User-Agent": _UA}, timeout=20)
    title = page.css_first("title::text") or page.css_first("h1::text") or url
    # gather paragraph-ish text, drop nav/script noise
    parts = [t.clean() for t in page.css("article p::text, main p::text, p::text")]
    text = "\n".join(p for p in parts if p and len(p) > 40)
    return str(title).strip(), text.strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", required=True, help="text file, one public URL per line")
    ap.add_argument("--out", default="crawled_knowledge.jsonl")
    ap.add_argument("--topic", default="海外公开销售知识")
    ap.add_argument("--delay", type=float, default=2.0, help="polite delay between requests (s)")
    args = ap.parse_args()

    try:
        import scrapling  # noqa: F401
    except ImportError:
        print("scrapling not installed. Install it first:\n  pip install scrapling")
        return 1

    with open(args.seeds, encoding="utf-8") as fh:
        urls = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]

    written = 0
    with open(args.out, "w", encoding="utf-8") as out:
        for url in urls:
            if not _allowed(url):
                print(f"[skip] robots.txt disallows: {url}")
                continue
            try:
                title, text = _fetch_text(url)
            except Exception as e:  # noqa: BLE001
                print(f"[err ] {url}: {e}")
                continue
            if len(text) < 120:
                print(f"[thin] {url}: too little extractable text, skipped")
                continue
            entry = {
                "id": f"WEB-{_slug(url).upper()}",
                "topic": args.topic,
                "title": title[:120],
                "text": text[:4000],
                "source": url,
            }
            out.write(json.dumps(entry, ensure_ascii=False) + "\n")
            written += 1
            print(f"[ok  ] {url} → {entry['id']}")
            time.sleep(args.delay)

    print(f"\nwrote {written} entries → {args.out}")
    print("review, then ingest into RAGFlow (scripts/ragflow_ingest.py) or merge into the playbook.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
