"""Inbound channel webhooks — the missing half that closes the deal loop.

The send-side adapters (``channels.py``) push our replies out; these handlers
take real customer messages *in*, route them to the right durable customer,
run one closer decision, and (unless the operator is in 人审/semi mode) auto-send
the reply back through the same channel — so a conversation can run multi-turn
on a real platform until a payment/contract red-line trips a human handoff.

Supported now:
  * WhatsApp via a 3rd-party gateway (Evolution API) — parses ``messages.upsert``
    webhook events posted by the gateway.
  * Telegram Bot API — POST update.

Security:
  * If ``WA_GATEWAY_WEBHOOK_TOKEN`` is set, inbound WhatsApp posts must carry a
    matching ``apikey`` header; otherwise (dev) we don't block.

Everything is credential-gated: with no env configured the handlers simply
report "not configured" rather than doing anything.
"""

from __future__ import annotations

import os
from typing import Any

from . import closer, store


def _ingest(platform: str, external_id: str, text: str, name: str = "") -> dict[str, Any]:
    """Route one inbound message: find-or-create the customer, decide, auto-send.

    Honors 人审 (semi) mode — then we store + suggest but never auto-send."""
    if not external_id or not text:
        return {"ok": False, "error": "empty message"}
    customer = store.get_customer_by_handle(platform, external_id)
    if customer is None:
        customer = store.create_customer(
            name or f"{platform}:{external_id}", platform, external_id=external_id
        )
    cid = customer["id"]
    inbound_msg = store.add_message(cid, "customer", text)
    decision = closer.decide(cid, text)
    store.set_message_translation(
        inbound_msg["id"],
        decision.get("inbound_translation", ""),
        decision.get("customer_lang", ""),
    )
    mode = store.get_settings().get("mode", "auto")
    sent: list[dict[str, Any]] = []
    if mode != "semi":
        sent = closer.apply_decision(cid, decision)
    return {
        "ok": True,
        "customer_id": cid,
        "auto_sent": bool(sent),
        "handoff": bool(decision.get("handoff")),
        "stage": decision.get("stage", ""),
    }


# ──────────────────────── WhatsApp via Evolution API gateway ────────────────────────


def whatsapp_token_ok(apikey_header: str) -> bool:
    """Optional shared-secret check on inbound gateway posts."""
    expected = os.getenv("WA_GATEWAY_WEBHOOK_TOKEN", "")
    return True if not expected else apikey_header == expected


def _evolution_text(message: dict[str, Any]) -> str:
    """Pull plain text out of a Baileys/Evolution message object."""
    if not isinstance(message, dict):
        return ""
    if message.get("conversation"):
        return str(message["conversation"])
    ext = message.get("extendedTextMessage")
    if isinstance(ext, dict) and ext.get("text"):
        return str(ext["text"])
    return ""


def handle_whatsapp(body: dict[str, Any]) -> dict[str, Any]:
    """Parse an Evolution API ``messages.upsert`` event and route inbound texts.

    Tolerates both single-event ({"data": {...}}) and batched ({"data": [...]})
    shapes. Skips our own outbound echoes (``key.fromMe``)."""
    if body.get("event") and body.get("event") != "messages.upsert":
        return {"ok": True, "handled": 0}
    data = body.get("data", [])
    items = data if isinstance(data, list) else [data]
    results: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        key = item.get("key", {})
        if key.get("fromMe"):
            continue
        jid = str(key.get("remoteJid", ""))
        number = jid.split("@", 1)[0]
        if not number or "@g.us" in jid:  # skip groups
            continue
        text = _evolution_text(item.get("message", {}))
        if not text:
            continue
        results.append(_ingest("whatsapp", number, text, item.get("pushName", "")))
    return {"ok": True, "handled": len(results), "results": results}


# ───────────────────────────────── Telegram ──────────────────────────────────


def handle_telegram(body: dict[str, Any]) -> dict[str, Any]:
    """Parse a Telegram Bot API update and route the text message."""
    msg = body.get("message") or body.get("edited_message") or {}
    chat = msg.get("chat", {})
    chat_id = str(chat.get("id", ""))
    text = msg.get("text", "")
    name = chat.get("title") or " ".join(
        filter(None, [chat.get("first_name", ""), chat.get("last_name", "")])
    ) or chat.get("username", "")
    if not chat_id or not text:
        return {"ok": True, "handled": 0}
    return {"ok": True, "handled": 1, "results": [_ingest("telegram", chat_id, text, name)]}
