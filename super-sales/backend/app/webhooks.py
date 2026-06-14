"""Inbound channel webhooks — the missing half that closes the deal loop.

The send-side adapters (``channels.py``) push our replies out; these handlers
take real customer messages *in*, route them to the right durable customer,
run one closer decision, and (unless the operator is in 人审/semi mode) auto-send
the reply back through the same channel — so a conversation can run multi-turn
on a real platform until a payment/contract red-line trips a human handoff.

Supported now:
  * WhatsApp Cloud API (Meta) — GET verify challenge + signed POST receive.
  * Telegram Bot API — POST update.

Security:
  * WhatsApp POST bodies are verified against ``WHATSAPP_APP_SECRET`` via the
    ``X-Hub-Signature-256`` HMAC header when the secret is configured.
  * The GET verify handshake checks ``WHATSAPP_VERIFY_TOKEN``.

Everything is credential-gated: with no env configured the handlers simply
report "not configured" rather than doing anything.
"""

from __future__ import annotations

import hashlib
import hmac
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


# ───────────────────────────── WhatsApp Cloud API ─────────────────────────────


def whatsapp_verify(mode: str, token: str, challenge: str) -> tuple[int, str]:
    """Meta webhook verification handshake (GET). Returns (status, body)."""
    expected = os.getenv("WHATSAPP_VERIFY_TOKEN", "")
    if mode == "subscribe" and expected and token == expected:
        return 200, challenge
    return 403, "forbidden"


def whatsapp_signature_ok(raw_body: bytes, signature_header: str) -> bool:
    """Validate X-Hub-Signature-256. If no app secret is configured we don't
    block delivery (dev/sandbox), but when it IS set the signature must match."""
    secret = os.getenv("WHATSAPP_APP_SECRET", "")
    if not secret:
        return True
    if not signature_header.startswith("sha256="):
        return False
    digest = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, signature_header.split("=", 1)[1])


def handle_whatsapp(body: dict[str, Any]) -> dict[str, Any]:
    """Parse a WhatsApp Cloud API inbound payload and route each text message."""
    results: list[dict[str, Any]] = []
    for entry in body.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            contacts = {c.get("wa_id"): c.get("profile", {}).get("name", "") for c in value.get("contacts", [])}
            for msg in value.get("messages", []):
                if msg.get("type") != "text":
                    continue
                wa_id = msg.get("from", "")
                text = msg.get("text", {}).get("body", "")
                results.append(_ingest("whatsapp", wa_id, text, contacts.get(wa_id, "")))
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
