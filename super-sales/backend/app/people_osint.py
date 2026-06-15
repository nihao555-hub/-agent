"""People-OSINT backend for sales background-check (决策人公开调研).

Three verified, high-star open-source engines, all key-free, driven via CLI and
aggregated into one compact dict that the LLM turns into a sales-tailored brief
(ice-breakers / decision-maker insight). Public footprint only — no private data
harvesting, no login-walled scraping.

  * **Maigret** (soxoj/maigret, ~33k★) — username → accounts across 3000+ sites.
  * **Blackbird** (p1ngul1n0/blackbird, ~6k★) — username/email → web footprint.
  * **Holehe** (megadose/holehe) — email → which services it is registered on.

Each engine is optional and time-boxed; the module degrades gracefully when an
engine is missing, offline, or slow.

Configuration (env):
  MAIGRET_BIN          maigret CLI (default: backend venv's maigret)
  MAIGRET_TOP_SITES    sites to check, ranked by traffic (default 50)
  HOLEHE_BIN           holehe CLI (default: backend venv's holehe)
  BLACKBIRD_DIR        blackbird checkout (default ~/blackbird)
  BLACKBIRD_PYTHON     python with blackbird deps (default <dir>/.venv/bin/python)
  PEOPLE_OSINT_TIMEOUT per-engine wall-clock seconds (default 90)
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import tempfile

_BACKEND_VENV = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".venv", "bin")
_MAIGRET = os.getenv("MAIGRET_BIN", os.path.join(_BACKEND_VENV, "maigret"))
_HOLEHE = os.getenv("HOLEHE_BIN", os.path.join(_BACKEND_VENV, "holehe"))
_MAIGRET_TOP = os.getenv("MAIGRET_TOP_SITES", "50")
_BB_DIR = os.getenv("BLACKBIRD_DIR", os.path.expanduser("~/blackbird"))
_BB_PY = os.getenv("BLACKBIRD_PYTHON", os.path.join(_BB_DIR, ".venv", "bin", "python"))
_TIMEOUT = int(os.getenv("PEOPLE_OSINT_TIMEOUT", "90"))

_CAP = 30
_USERNAME_RE = re.compile(r"[^a-z0-9._-]")


def maigret_available() -> bool:
    return os.path.isfile(_MAIGRET) or shutil.which("maigret") is not None


def holehe_available() -> bool:
    return os.path.isfile(_HOLEHE) or shutil.which("holehe") is not None


def blackbird_available() -> bool:
    return os.path.isfile(os.path.join(_BB_DIR, "blackbird.py")) and os.path.isfile(_BB_PY)


def available() -> bool:
    return maigret_available() or holehe_available() or blackbird_available()


def _derive_username(name: str, email: str, username: str) -> str:
    if username:
        return username.strip()
    if email and "@" in email:
        return email.split("@", 1)[0].strip()
    # collapse a person name to a plausible handle (no spaces)
    return _USERNAME_RE.sub("", (name or "").strip().lower().replace(" ", ""))


def _maigret(username: str) -> list[dict[str, str]]:
    if not username or not maigret_available():
        return []
    tmp = tempfile.mkdtemp(prefix="maigret_")
    try:
        cmd = [
            _MAIGRET, username, "-J", "simple", "-fo", tmp,
            "--top-sites", _MAIGRET_TOP, "-n", "30", "--timeout", "10",
            "--no-recursion", "--no-extracting", "--no-color",
        ]
        try:
            subprocess.run(cmd, capture_output=True, timeout=_TIMEOUT, check=False)
        except subprocess.TimeoutExpired:
            pass
        files = glob.glob(os.path.join(tmp, "report_*_simple.json"))
        if not files:
            return []
        with open(files[0], encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError, Exception):  # noqa: BLE001
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    out: list[dict[str, str]] = []
    for site, rec in data.items():
        if not isinstance(rec, dict):
            continue
        status = rec.get("status")
        claimed = isinstance(status, dict) and str(status.get("status", "")).lower() == "claimed"
        if not claimed:
            continue
        tags = status.get("tags") or [] if isinstance(status, dict) else []
        out.append({
            "site": site,
            "url": rec.get("url_user", ""),
            "tags": ", ".join(t for t in tags if t),
        })
        if len(out) >= _CAP:
            break
    return out


def _holehe(email: str) -> list[str]:
    if not email or "@" not in email or not holehe_available():
        return []
    try:
        proc = subprocess.run(
            [_HOLEHE, email, "--only-used", "--no-color", "--no-clear"],
            capture_output=True, text=True, timeout=_TIMEOUT, check=False,
        )
    except subprocess.TimeoutExpired:
        return []
    used: list[str] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("[+]") and "." in line and "Email used" not in line:
            domain = line[3:].strip()
            if domain and domain not in used:
                used.append(domain)
        if len(used) >= _CAP:
            break
    return used


def _blackbird(username: str, email: str) -> list[dict[str, str]]:
    if not blackbird_available():
        return []
    arg = ["-u", username] if username else (["-e", email] if email else [])
    if not arg:
        return []
    out_root = tempfile.mkdtemp(prefix="bb_")
    try:
        # Blackbird writes results under its cwd/results; run in an isolated dir.
        cmd = [_BB_PY, os.path.join(_BB_DIR, "blackbird.py"), *arg, "--json", "--no-update", "--no-nsfw"]
        try:
            subprocess.run(cmd, cwd=out_root, capture_output=True, timeout=_TIMEOUT, check=False)
        except subprocess.TimeoutExpired:
            pass
        files = glob.glob(os.path.join(out_root, "results", "**", "*.json"), recursive=True)
        if not files:
            return []
        with open(files[0], encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError, Exception):  # noqa: BLE001
        return []
    finally:
        shutil.rmtree(out_root, ignore_errors=True)

    items = data if isinstance(data, list) else []
    out: list[dict[str, str]] = []
    for rec in items:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("status", "")).upper() != "FOUND":
            continue
        out.append({
            "site": rec.get("name", ""),
            "url": rec.get("url", ""),
            "tags": rec.get("category", "") or "",
        })
        if len(out) >= _CAP:
            break
    return out


def investigate(name: str = "", email: str = "", username: str = "") -> dict[str, object]:
    """Run people-OSINT for a decision maker. Returns a compact, citable aggregate."""
    name, email, username = (name or "").strip(), (email or "").strip(), (username or "").strip()
    handle = _derive_username(name, email, username)
    if not available() or not (handle or email):
        return {"available": False, "name": name, "email": email, "username": handle}

    # Merge account hits from maigret + blackbird, deduped by URL.
    accounts: list[dict[str, str]] = []
    seen: set[str] = set()
    engines: list[str] = []
    if maigret_available():
        engines.append("maigret")
    if blackbird_available():
        engines.append("blackbird")
    for hit in _maigret(handle) + _blackbird(handle, email):
        key = hit.get("url") or f"{hit.get('site')}::{handle}"
        if key in seen:
            continue
        seen.add(key)
        accounts.append(hit)

    emails_used = _holehe(email) if email else []
    if email and holehe_available():
        engines.append("holehe")

    return {
        "available": True,
        "name": name,
        "email": email,
        "username": handle,
        "accounts": accounts[: _CAP],
        "account_count": len(accounts),
        "email_services": emails_used,
        "engines": engines,
    }


def summary_lines(people: dict[str, object]) -> list[str]:
    if not people or not people.get("available"):
        return []
    lines: list[str] = []
    accts = people.get("accounts")
    if isinstance(accts, list) and accts:
        sites = "、".join(str(a.get("site", "")) for a in accts[:10] if a.get("site"))
        lines.append(f"公开账号（{people.get('account_count', len(accts))}）：{sites}")
    svc = people.get("email_services")
    if isinstance(svc, list) and svc:
        lines.append(f"邮箱注册过的服务（{len(svc)}）：{('、'.join(svc[:10]))}")
    return lines
