"""Durable store for the AI Super Sales closer.

A small SQLite-backed persistence layer so the agent keeps full context per
customer across restarts: customers, the message timeline, extracted memory
facts (pain / commitment / taboo / preference / fact), the seller's product
catalog + shareable assets, and global settings (persona, target market,
privacy red-lines).

The DB path is configurable via ``SUPER_SALES_DB`` so production can point at a
persisted volume / external disk. Everything is plain stdlib ``sqlite3`` — no
extra dependency — and access is serialized behind a lock so the FastAPI app
can call it from worker threads safely.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from typing import Any

_DB_PATH = os.getenv("SUPER_SALES_DB", os.path.join(os.path.dirname(__file__), "..", "data", "super_sales.db"))
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _now() -> float:
    return time.time()


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(os.path.abspath(_DB_PATH)), exist_ok=True)
        _conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _init_schema(_conn)
    return _conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS customers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            platform TEXT NOT NULL DEFAULT 'sandbox',
            country TEXT DEFAULT '',
            category TEXT DEFAULT '',
            stage TEXT DEFAULT '认知',
            win_score INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active',
            next_step TEXT DEFAULT '',
            tags TEXT DEFAULT '[]',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            role TEXT NOT NULL,            -- customer | agent | system
            text TEXT NOT NULL,
            asset_id TEXT DEFAULT '',
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_facts (
            id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            kind TEXT NOT NULL,           -- pain | preference | commitment | objection | taboo | fact
            text TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            summary TEXT DEFAULT '',
            details TEXT DEFAULT '',
            price_info TEXT DEFAULT '',
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            product_id TEXT DEFAULT '',
            kind TEXT NOT NULL,           -- image | video | doc | table | text
            filename TEXT NOT NULL,
            caption TEXT DEFAULT '',
            shareable INTEGER DEFAULT 1,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    conn.commit()


# --------------------------------------------------------------------------- customers


def list_customers() -> list[dict[str, Any]]:
    with _lock:
        rows = _connect().execute("SELECT * FROM customers ORDER BY updated_at DESC").fetchall()
    return [_customer_row(r) for r in rows]


def get_customer(cid: str) -> dict[str, Any] | None:
    with _lock:
        row = _connect().execute("SELECT * FROM customers WHERE id=?", (cid,)).fetchone()
    return _customer_row(row) if row else None


def create_customer(
    name: str,
    platform: str = "sandbox",
    country: str = "",
    category: str = "",
) -> dict[str, Any]:
    cid = _uid("cust")
    ts = _now()
    with _lock:
        _connect().execute(
            "INSERT INTO customers (id,name,platform,country,category,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (cid, name, platform, country, category, ts, ts),
        )
        _connect().commit()
    return get_customer(cid)  # type: ignore[return-value]


def update_customer(cid: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {"name", "platform", "country", "category", "stage", "win_score", "status", "next_step", "tags"}
    sets, vals = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        sets.append(f"{k}=?")
        vals.append(json.dumps(v, ensure_ascii=False) if k == "tags" else v)
    if not sets:
        return
    sets.append("updated_at=?")
    vals.extend([_now(), cid])
    with _lock:
        _connect().execute(f"UPDATE customers SET {','.join(sets)} WHERE id=?", vals)
        _connect().commit()


def _customer_row(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    try:
        d["tags"] = json.loads(d.get("tags") or "[]")
    except (json.JSONDecodeError, TypeError):
        d["tags"] = []
    return d


# --------------------------------------------------------------------------- messages


def add_message(customer_id: str, role: str, text: str, asset_id: str = "") -> dict[str, Any]:
    mid = _uid("msg")
    ts = _now()
    with _lock:
        _connect().execute(
            "INSERT INTO messages (id,customer_id,role,text,asset_id,created_at) VALUES (?,?,?,?,?,?)",
            (mid, customer_id, role, text, asset_id, ts),
        )
        _connect().execute("UPDATE customers SET updated_at=? WHERE id=?", (ts, customer_id))
        _connect().commit()
    return {"id": mid, "customer_id": customer_id, "role": role, "text": text, "asset_id": asset_id, "created_at": ts}


def list_messages(customer_id: str, limit: int = 200) -> list[dict[str, Any]]:
    with _lock:
        rows = _connect().execute(
            "SELECT * FROM messages WHERE customer_id=? ORDER BY created_at ASC LIMIT ?",
            (customer_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def transcript(customer_id: str, limit: int = 60) -> str:
    msgs = list_messages(customer_id, limit)
    label = {"customer": "客户", "agent": "我", "system": "系统"}
    return "\n".join(f"{label.get(m['role'], m['role'])}：{m['text']}" for m in msgs)


# --------------------------------------------------------------------------- memory facts


def add_memory(customer_id: str, kind: str, text: str) -> None:
    if not text.strip():
        return
    with _lock:
        # de-dup identical fact text per customer
        exists = _connect().execute(
            "SELECT 1 FROM memory_facts WHERE customer_id=? AND text=?",
            (customer_id, text),
        ).fetchone()
        if exists:
            return
        _connect().execute(
            "INSERT INTO memory_facts (id,customer_id,kind,text,created_at) VALUES (?,?,?,?,?)",
            (_uid("mem"), customer_id, kind, text, _now()),
        )
        _connect().commit()


def list_memory(customer_id: str) -> list[dict[str, Any]]:
    with _lock:
        rows = _connect().execute(
            "SELECT * FROM memory_facts WHERE customer_id=? ORDER BY created_at ASC",
            (customer_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def memory_block(customer_id: str) -> str:
    facts = list_memory(customer_id)
    if not facts:
        return "（暂无已记录的客户记忆）"
    kind_label = {
        "pain": "痛点",
        "preference": "偏好",
        "commitment": "我方承诺",
        "objection": "未决异议",
        "taboo": "禁忌",
        "fact": "事实",
    }
    return "\n".join(f"- [{kind_label.get(f['kind'], f['kind'])}] {f['text']}" for f in facts)


# --------------------------------------------------------------------------- products & assets


def list_products() -> list[dict[str, Any]]:
    with _lock:
        rows = _connect().execute("SELECT * FROM products ORDER BY created_at DESC").fetchall()
    products = [dict(r) for r in rows]
    for p in products:
        p["assets"] = list_assets(p["id"])
    return products


def create_product(name: str, summary: str = "", details: str = "", price_info: str = "") -> dict[str, Any]:
    pid = _uid("prod")
    with _lock:
        _connect().execute(
            "INSERT INTO products (id,name,summary,details,price_info,created_at) VALUES (?,?,?,?,?,?)",
            (pid, name, summary, details, price_info, _now()),
        )
        _connect().commit()
    with _lock:
        row = _connect().execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
    d = dict(row)
    d["assets"] = []
    return d


def add_asset(
    product_id: str, kind: str, filename: str, caption: str = "", shareable: bool = True
) -> dict[str, Any]:
    aid = _uid("asset")
    with _lock:
        _connect().execute(
            "INSERT INTO assets (id,product_id,kind,filename,caption,shareable,created_at) VALUES (?,?,?,?,?,?,?)",
            (aid, product_id, kind, filename, caption, 1 if shareable else 0, _now()),
        )
        _connect().commit()
    return {
        "id": aid,
        "product_id": product_id,
        "kind": kind,
        "filename": filename,
        "caption": caption,
        "shareable": shareable,
    }


def list_assets(product_id: str = "") -> list[dict[str, Any]]:
    with _lock:
        if product_id:
            rows = _connect().execute(
                "SELECT * FROM assets WHERE product_id=? ORDER BY created_at ASC", (product_id,)
            ).fetchall()
        else:
            rows = _connect().execute("SELECT * FROM assets ORDER BY created_at ASC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["shareable"] = bool(d["shareable"])
        out.append(d)
    return out


# --------------------------------------------------------------------------- settings


_DEFAULT_SETTINGS = {
    "company": "",
    "persona_name": "小盛",
    "persona_role": "资深销售顾问",
    "tone": "自然、专业、口语化，像真人销售在聊",
    "target_country": "",
    "target_category": "",
    "language": "中文",
    "disclose_ai": "when_asked",  # always | when_asked | never (按辖区合规)
    "privacy_redlines": "成本价、进货价、利润率、内部定价底线与让步上限、其他客户隐私与名单、内部人员联系方式、未脱敏证件/合同/财务、公司机密",
    "deal_rules": "",
}


def get_settings() -> dict[str, str]:
    with _lock:
        rows = _connect().execute("SELECT key,value FROM settings").fetchall()
    out = dict(_DEFAULT_SETTINGS)
    for r in rows:
        out[r["key"]] = r["value"]
    return out


def update_settings(values: dict[str, str]) -> dict[str, str]:
    with _lock:
        for k, v in values.items():
            _connect().execute(
                "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?",
                (k, str(v), str(v)),
            )
        _connect().commit()
    return get_settings()
