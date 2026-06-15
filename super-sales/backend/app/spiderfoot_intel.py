"""SpiderFoot OSINT backend for AI background-check (公司 + 人员，公开情报聚合).

SpiderFoot (https://github.com/smicallef/spiderfoot, ~14k★) is the most complete
open-source OSINT automation framework (200+ modules). We drive its CLI in
passive, JSON mode and aggregate the event stream into a compact, citable dict
that the LLM synthesises into a background brief — on top of the免-key
Wikidata/Wikipedia/News business-intel layer and theHarvester footprint.

Design goals (consistent with the rest of the codebase):
  * Pluggable & optional — if SpiderFoot isn't installed, ``available()`` is
    False and the caller degrades gracefully (business_intel still works).
  * Public information only, passive use case (``-u passive`` / curated passive
    modules); no intrusive scanning, no credential/secret harvesting.
  * Bounded — hard timeout + capped results so a scan can't hang the request.

Configuration (env):
  SPIDERFOOT_DIR      path to the spiderfoot checkout (default ~/spiderfoot)
  SPIDERFOOT_PYTHON   python that has spiderfoot deps (default <dir>/.venv/bin/python)
  SPIDERFOOT_MODULES  comma list of modules (default: curated free passive set);
                      set to "passive" to auto-select ALL passive modules (slower,
                      richer; some modules need API keys configured in SpiderFoot).
  SPIDERFOOT_TIMEOUT  per-scan wall-clock seconds (default 120)
"""

from __future__ import annotations

import json
import os
import subprocess

_DIR = os.getenv("SPIDERFOOT_DIR", os.path.expanduser("~/spiderfoot"))
_PY = os.getenv("SPIDERFOOT_PYTHON", os.path.join(_DIR, ".venv", "bin", "python"))
# Curated free, passive, high-signal modules (no API key required).
_DEFAULT_MODULES = (
    "sfp_dnsresolve,sfp_whois,sfp_crt,sfp_sslcert,sfp_names,"
    "sfp_email,sfp_company,sfp_pageinfo,sfp_socialprofiles"
)
_MODULES = os.getenv("SPIDERFOOT_MODULES", _DEFAULT_MODULES)
_TIMEOUT = int(os.getenv("SPIDERFOOT_TIMEOUT", "120"))

# Event types we surface, mapped to compact keys (others are still counted).
_TYPE_MAP = {
    "EMAILADDR": "emails",
    "HUMAN_NAME": "names",
    "RAW_RIR_DATA": "registry",
    "COMPANY_NAME": "companies",
    "SOCIAL_MEDIA": "social_profiles",
    "INTERNET_NAME": "hostnames",
    "DOMAIN_NAME": "domains",
    "IP_ADDRESS": "ips",
    "SSL_CERTIFICATE_ISSUED": "ssl_certs",
    "PHONE_NUMBER": "phones",
    "GEOINFO": "geo",
    "WEBSERVER_TECHNOLOGY": "tech",
    "PHYSICAL_ADDRESS": "addresses",
    "ACCOUNT_EXTERNAL_OWNED": "accounts",
}
_CAP = 25  # max items kept per bucket


def available() -> bool:
    return os.path.isfile(os.path.join(_DIR, "sf.py")) and os.path.isfile(_PY)


def scan(target: str) -> dict[str, object]:
    """Run a bounded passive OSINT scan on ``target`` (domain / email / name).

    Returns a compact aggregate; degrades to ``{available: False}`` on any error.
    """
    target = (target or "").strip()
    if not target or not available():
        return {"available": False, "target": target}

    cmd = [_PY, "sf.py", "-s", target, "-o", "json", "-q", "-n"]
    if _MODULES == "passive":
        cmd += ["-u", "passive"]
    else:
        cmd += ["-m", _MODULES]

    try:
        proc = subprocess.Popen(
            cmd, cwd=_DIR, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
        )
        try:
            out, _ = proc.communicate(timeout=_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
    except Exception:  # noqa: BLE001
        return {"available": True, "target": target, "error": "scan failed"}

    events = _parse(out)
    buckets: dict[str, list[str]] = {}
    type_counts: dict[str, int] = {}
    for ev in events:
        etype = ev.get("type", "")
        data = str(ev.get("data", "")).strip()
        if not data:
            continue
        type_counts[etype] = type_counts.get(etype, 0) + 1
        key = _TYPE_MAP.get(etype)
        if key is None:
            continue
        bucket = buckets.setdefault(key, [])
        if data not in bucket and len(bucket) < _CAP:
            bucket.append(data)

    return {
        "available": True,
        "target": target,
        "modules": _MODULES,
        "total_events": len(events),
        "type_counts": type_counts,
        **buckets,
    }


def _parse(out: str) -> list[dict[str, object]]:
    out = (out or "").strip()
    if not out:
        return []
    # Normal case: a JSON array. Fall back to line-by-line for truncated output.
    try:
        data = json.loads(out)
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict)]
    except json.JSONDecodeError:
        pass
    events: list[dict[str, object]] = []
    for line in out.splitlines():
        line = line.strip().rstrip(",")
        if line.startswith("{") and line.endswith("}"):
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    events.append(obj)
            except json.JSONDecodeError:
                continue
    return events


def summary_lines(intel: dict[str, object]) -> list[str]:
    """Compact human/LLM-readable lines describing the OSINT aggregate."""
    if not intel or not intel.get("available"):
        return []
    lines: list[str] = []
    labels = {
        "emails": "邮箱",
        "names": "相关人名",
        "companies": "关联公司",
        "social_profiles": "社媒主页",
        "hostnames": "子域/主机",
        "ips": "IP",
        "phones": "电话",
        "addresses": "地址",
        "tech": "技术栈",
        "accounts": "外部账号",
    }
    for key, label in labels.items():
        vals = intel.get(key)
        if isinstance(vals, list) and vals:
            shown = "、".join(str(v) for v in vals[:6])
            extra = f"（共{len(vals)}）" if len(vals) > 6 else ""
            lines.append(f"{label}：{shown}{extra}")
    return lines
