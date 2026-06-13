"""三个 OSINT 工具的薄封装：maigret（库）/ sherlock（CLI）/ spiderfoot（CLI）。

每个 runner 都是「尽力而为」：
  - 工具未安装 / 调用失败 → 记一条 note 并返回空结果，绝不抛出导致整个请求失败。
  - 返回 (accounts, notes, ran)：ran 表示该工具是否真正执行成功。

account 结构与 TS 端 src/osint/collector.ts 的 accountSchema 对齐：
  {"tool": "maigret"|"sherlock"|"spiderfoot", "site": str, "url": str, "category": str|None}

合规说明：本服务不做授权校验——授权（consent）由上游 TS 后端的 service 层强制（无授权直接 403）。
本服务只应被该后端在内网调用，且仅针对候选人本人提供/确认的标识运行。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
from typing import Any

Account = dict[str, Any]

logger = logging.getLogger("osint-service")

# 可调参数（环境变量）。
MAIGRET_HOME = os.environ.get("MAIGRET_HOME", "/home/ubuntu/maigret")
MAIGRET_TOP_SITES = int(os.environ.get("MAIGRET_TOP_SITES", "300"))
MAIGRET_TIMEOUT = int(os.environ.get("MAIGRET_TIMEOUT", "20"))
SHERLOCK_TIMEOUT = int(os.environ.get("SHERLOCK_TIMEOUT", "60"))
SPIDERFOOT_HOME = os.environ.get("SPIDERFOOT_HOME", "/home/ubuntu/spiderfoot")
SPIDERFOOT_USECASE = os.environ.get("SPIDERFOOT_USECASE", "passive")
SPIDERFOOT_TIMEOUT = int(os.environ.get("SPIDERFOOT_TIMEOUT", "180"))


async def run_maigret(usernames: list[str]) -> tuple[list[Account], list[str], bool]:
    """用 maigret 作为 Python 库扫描用户名，命中即记为一条公开账号线索。"""
    accounts: list[Account] = []
    notes: list[str] = []
    if not usernames:
        return accounts, notes, False
    try:
        from maigret import search as maigret_search
        from maigret.sites import MaigretDatabase
    except Exception as exc:  # noqa: BLE001
        notes.append(f"maigret 不可用（未安装或依赖缺失）：{exc}")
        return accounts, notes, False

    db_path = os.path.join(MAIGRET_HOME, "maigret", "resources", "data.json")
    try:
        db = MaigretDatabase().load_from_path(db_path)
        sites = db.ranked_sites_dict(top=MAIGRET_TOP_SITES)
    except Exception as exc:  # noqa: BLE001
        notes.append(f"maigret 站点库加载失败（{db_path}）：{exc}")
        return accounts, notes, False

    ran = False
    for username in usernames:
        try:
            results = await maigret_search(
                username=username,
                site_dict=sites,
                logger=logger,
                timeout=MAIGRET_TIMEOUT,
                is_parsing_enabled=True,
                no_progressbar=True,
            )
            ran = True
            for site_name, result in results.items():
                status = result.get("status")
                if status is not None and status.is_found():
                    accounts.append(
                        {
                            "tool": "maigret",
                            "site": site_name,
                            "url": result.get("url_user", ""),
                            "category": f"username:{username}",
                        }
                    )
        except Exception as exc:  # noqa: BLE001
            notes.append(f"maigret 扫描 {username} 失败：{exc}")
    return accounts, notes, ran


def run_sherlock(usernames: list[str]) -> tuple[list[Account], list[str], bool]:
    """用 sherlock CLI 补充用户名在 400+ 站点的命中。"""
    accounts: list[Account] = []
    notes: list[str] = []
    if not usernames:
        return accounts, notes, False

    cmd_base: list[str] | None = None
    if shutil.which("sherlock"):
        cmd_base = ["sherlock"]
    else:
        try:
            import sherlock_project  # noqa: F401

            cmd_base = ["python", "-m", "sherlock_project"]
        except Exception:  # noqa: BLE001
            cmd_base = None
    if cmd_base is None:
        notes.append("sherlock 不可用（未安装 sherlock CLI / sherlock_project）。")
        return accounts, notes, False

    ran = False
    for username in usernames:
        try:
            proc = subprocess.run(
                [*cmd_base, username, "--print-found", "--no-color", "--timeout", "10"],
                capture_output=True,
                text=True,
                timeout=SHERLOCK_TIMEOUT,
            )
            ran = True
            for line in proc.stdout.splitlines():
                line = line.strip()
                # 形如：[+] SiteName: https://...
                if line.startswith("[+]") and "http" in line:
                    body = line[3:].strip()
                    if ":" in body:
                        site, url = body.split(":", 1)
                        url = url.strip()
                        if url.startswith("http"):
                            accounts.append(
                                {
                                    "tool": "sherlock",
                                    "site": site.strip(),
                                    "url": url,
                                    "category": f"username:{username}",
                                }
                            )
        except subprocess.TimeoutExpired:
            notes.append(f"sherlock 扫描 {username} 超时（>{SHERLOCK_TIMEOUT}s）。")
        except Exception as exc:  # noqa: BLE001
            notes.append(f"sherlock 扫描 {username} 失败：{exc}")
    return accounts, notes, ran


# spiderfoot 输出里值得作为「账号/足迹线索」保留的事件类型。
_SF_INTERESTING = {
    "SOCIAL_MEDIA",
    "ACCOUNT_EXTERNAL_OWNED",
    "USERNAME",
    "LINKED_URL_EXTERNAL",
    "EMAILADDR",
    "AFFILIATE_INTERNET_NAME",
    "WEBSERVER_BANNER",
    "DOMAIN_NAME",
}


def run_spiderfoot(targets: list[str]) -> tuple[list[Account], list[str], bool]:
    """用 spiderfoot 的无头 CLI（sf.py）对邮箱/手机号/域名/用户名做被动收集。"""
    accounts: list[Account] = []
    notes: list[str] = []
    if not targets:
        return accounts, notes, False

    sf_py = os.path.join(SPIDERFOOT_HOME, "sf.py")
    if not os.path.isfile(sf_py):
        notes.append(f"spiderfoot 不可用（未找到 {sf_py}）。")
        return accounts, notes, False

    ran = False
    for target in targets:
        try:
            proc = subprocess.run(
                ["python", sf_py, "-s", target, "-u", SPIDERFOOT_USECASE, "-o", "json", "-q", "-H"],
                capture_output=True,
                text=True,
                timeout=SPIDERFOOT_TIMEOUT,
                cwd=SPIDERFOOT_HOME,
            )
            out = proc.stdout.strip()
            if not out:
                notes.append(f"spiderfoot 对 {target} 无输出（可能依赖未装或无结果）。")
                continue
            events = json.loads(out)
            ran = True
            for ev in events if isinstance(events, list) else []:
                etype = ev.get("type") or ev.get("event_type") or ""
                data = ev.get("data", "")
                if etype in _SF_INTERESTING and isinstance(data, str) and data:
                    url = data if data.startswith("http") else ""
                    accounts.append(
                        {
                            "tool": "spiderfoot",
                            "site": etype,
                            "url": url or data,
                            "category": f"target:{target}",
                        }
                    )
        except subprocess.TimeoutExpired:
            notes.append(f"spiderfoot 对 {target} 扫描超时（>{SPIDERFOOT_TIMEOUT}s）。")
        except json.JSONDecodeError as exc:
            notes.append(f"spiderfoot 对 {target} 输出解析失败：{exc}")
        except Exception as exc:  # noqa: BLE001
            notes.append(f"spiderfoot 对 {target} 扫描失败：{exc}")
    return accounts, notes, ran


async def collect_all(
    usernames: list[str],
    emails: list[str],
    phones: list[str],
    domains: list[str],
) -> dict[str, Any]:
    """聚合三个工具的结果。spiderfoot/sherlock 为阻塞子进程，放到线程池执行。"""
    tools_ran: list[str] = []
    accounts: list[Account] = []
    notes: list[str] = []

    sf_targets = [*emails, *phones, *domains, *usernames]

    maigret_res, sherlock_res, spiderfoot_res = await asyncio.gather(
        run_maigret(usernames),
        asyncio.to_thread(run_sherlock, usernames),
        asyncio.to_thread(run_spiderfoot, sf_targets),
    )

    for tool_name, (acc, nt, ran) in (
        ("maigret", maigret_res),
        ("sherlock", sherlock_res),
        ("spiderfoot", spiderfoot_res),
    ):
        accounts.extend(acc)
        notes.extend(nt)
        if ran:
            tools_ran.append(tool_name)

    # 去重（同 tool+url）。
    seen: set[tuple[str, str]] = set()
    deduped: list[Account] = []
    for a in accounts:
        key = (a["tool"], a["url"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(a)

    if not tools_ran:
        notes.append("三个 OSINT 工具均未成功执行；请确认依赖已安装。")

    return {"tools": tools_ran, "accounts": deduped, "notes": notes}
