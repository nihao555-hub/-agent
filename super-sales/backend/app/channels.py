"""Pluggable channel adapters.

Every messaging platform implements the same tiny interface so the closer never
needs to know which platform it's talking to. The ``sandbox`` channel works
right now with zero credentials (messages live in the local store), so the whole
AI-closer loop is testable end-to-end today; the real platforms (WhatsApp Cloud
API, LINE Messaging API, WeCom) plug into the same interface once the user
provides credentials via environment variables.

Configuration is read from env so nothing secret is committed:
  * Telegram : TELEGRAM_BOT_TOKEN                   (optional TELEGRAM_API_BASE)
  * WhatsApp : via a self-hosted 3rd-party gateway (Evolution API, Baileys-based —
               github.com/EvolutionAPI/evolution-api). Scan a QR with a normal
               WhatsApp account, no Meta business account needed.
               WA_GATEWAY_BASE, WA_GATEWAY_API_KEY, WA_GATEWAY_INSTANCE
  * LINE     : LINE_CHANNEL_TOKEN                   (optional LINE_API_BASE)
  * WeCom    : WECOM_CORP_ID, WECOM_SECRET, WECOM_AGENT_ID (optional WECOM_API_BASE)

Delivery is gated purely on whether the credentials are present.
"""

from __future__ import annotations

import os
import time
from typing import Any, Protocol

# Human-like send pacing: how long to "type" before each message lands. A real
# person never fires off several messages instantly; they pause to read/think
# and then type for a beat (longer messages take longer). Channels that support
# a typing indicator show it during this wait. Capped so we never hang too long.
_TYPING_CAP_MS = 12000


def _sleep_ms(ms: int) -> None:
    time.sleep(max(0, min(int(ms), _TYPING_CAP_MS)) / 1000.0)


class Channel(Protocol):
    name: str
    label: str

    def is_configured(self) -> bool: ...

    def send(self, to: str, messages: list[str], asset_id: str = "",
             pacing: list[int] | None = None) -> dict[str, Any]: ...


class SandboxChannel:
    """In-app channel — works with no credentials. Used for testing / manual mode."""

    name = "sandbox"
    label = "沙盒（应用内）"
    risk = "none"

    def is_configured(self) -> bool:
        return True

    def send(self, to: str, messages: list[str], asset_id: str = "",
             pacing: list[int] | None = None) -> dict[str, Any]:
        # Persistence is handled by the caller (closer.apply_decision) against the
        # store, so the sandbox channel is a no-op transport that always succeeds.
        # No real delay here — calibration/tests run on sandbox and must stay fast.
        return {"ok": True, "channel": self.name, "delivered": len(messages)}


class _EnvChannel:
    """Base for real platforms: configured iff its required env vars are present."""

    name = ""
    label = ""
    risk = "official"
    required_env: tuple[str, ...] = ()

    def is_configured(self) -> bool:
        return all(os.getenv(k) for k in self.required_env)

    def send(self, to: str, messages: list[str], asset_id: str = "",
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return {
                "ok": False,
                "channel": self.name,
                "error": f"未配置凭证：需要环境变量 {', '.join(self.required_env)}",
            }
        # Real HTTP delivery is wired once credentials exist; until then we report
        # configured-but-not-yet-implemented rather than silently dropping.
        return {
            "ok": False,
            "channel": self.name,
            "error": "凭证已就绪，平台发送实现待接入（占位）",
        }


class TelegramChannel(_EnvChannel):
    """Telegram Bot API — free, no business account. The one platform we can
    demo end-to-end with just a @BotFather token. ``to`` is the chat id."""

    name = "telegram"
    label = "Telegram（Bot API）"
    risk = "official"
    required_env = ("TELEGRAM_BOT_TOKEN",)

    def send(self, to: str, messages: list[str], asset_id: str = "",
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, asset_id)
        import requests

        base = os.getenv("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        delivered = 0
        for i, msg in enumerate(messages):
            # human pacing: show "typing…" then wait before the message lands.
            wait_ms = pacing[i] if pacing and i < len(pacing) else 0
            remaining = min(int(wait_ms), _TYPING_CAP_MS)
            while remaining > 0:
                try:
                    requests.post(f"{base}/bot{token}/sendChatAction",
                                  json={"chat_id": to, "action": "typing"}, timeout=10)
                except Exception:  # noqa: BLE001
                    break
                step = min(remaining, 4500)  # Telegram typing lasts ~5s; refresh
                _sleep_ms(step)
                remaining -= step
            r = requests.post(
                f"{base}/bot{token}/sendMessage",
                json={"chat_id": to, "text": msg},
                timeout=15,
            )
            if r.ok and r.json().get("ok"):
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": r.text[:200]}
        return {"ok": True, "channel": self.name, "delivered": delivered}


class WhatsAppChannel(_EnvChannel):
    """WhatsApp via a self-hosted 3rd-party gateway (Evolution API / Baileys).

    No Meta business account: you run the open-source gateway, scan a QR with a
    normal WhatsApp number, and we talk to its REST API. ``to`` is the recipient
    phone number in international format (digits only)."""

    name = "whatsapp"
    label = "WhatsApp（第三方网关 Evolution API）"
    risk = "unofficial"
    required_env = ("WA_GATEWAY_BASE", "WA_GATEWAY_API_KEY", "WA_GATEWAY_INSTANCE")

    def send(self, to: str, messages: list[str], asset_id: str = "",
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, asset_id)
        import requests

        base = os.environ["WA_GATEWAY_BASE"].rstrip("/")
        instance = os.environ["WA_GATEWAY_INSTANCE"]
        url = f"{base}/message/sendText/{instance}"
        headers = {"apikey": os.environ["WA_GATEWAY_API_KEY"]}
        delivered = 0
        for i, msg in enumerate(messages):
            # Evolution API shows a real "typing…" presence for ``delay`` ms before
            # the text lands — exactly the human cadence we want, done gateway-side.
            wait_ms = min(int(pacing[i]), _TYPING_CAP_MS) if pacing and i < len(pacing) else 0
            body = {"number": to, "text": msg}
            if wait_ms > 0:
                body["delay"] = wait_ms
                body["options"] = {"delay": wait_ms, "presence": "composing"}
            r = requests.post(url, headers=headers, json=body, timeout=max(20, wait_ms // 1000 + 20))
            if r.ok:
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": r.text[:200]}
        return {"ok": True, "channel": self.name, "delivered": delivered}


class LineChannel(_EnvChannel):
    name = "line"
    label = "LINE（Messaging API）"
    risk = "official"
    required_env = ("LINE_CHANNEL_TOKEN",)

    def send(self, to: str, messages: list[str], asset_id: str = "",
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, asset_id)
        import requests

        base = os.getenv("LINE_API_BASE", "https://api.line.me").rstrip("/")
        headers = {"Authorization": f"Bearer {os.environ['LINE_CHANNEL_TOKEN']}"}
        # LINE push accepts up to 5 message objects per call.
        delivered = 0
        for i in range(0, len(messages), 5):
            if pacing and i < len(pacing):
                _sleep_ms(pacing[i])  # pace bursts; LINE has no public typing API
            chunk = messages[i : i + 5]
            r = requests.post(
                f"{base}/v2/bot/message/push",
                headers=headers,
                json={"to": to, "messages": [{"type": "text", "text": m} for m in chunk]},
                timeout=15,
            )
            if r.ok:
                delivered += len(chunk)
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": r.text[:200]}
        return {"ok": True, "channel": self.name, "delivered": delivered}


class WeComChannel(_EnvChannel):
    name = "wecom"
    label = "企业微信 WeCom（官方）"
    risk = "official"
    required_env = ("WECOM_CORP_ID", "WECOM_SECRET", "WECOM_AGENT_ID")

    _token: tuple[str, float] = ("", 0.0)

    def _access_token(self, base: str) -> str:
        import requests

        tok, exp = self._token
        if tok and time.time() < exp:
            return tok
        r = requests.get(
            f"{base}/cgi-bin/gettoken",
            params={"corpid": os.environ["WECOM_CORP_ID"], "corpsecret": os.environ["WECOM_SECRET"]},
            timeout=15,
        )
        data = r.json()
        tok = data.get("access_token", "")
        self._token = (tok, time.time() + data.get("expires_in", 7200) - 120)
        return tok

    def send(self, to: str, messages: list[str], asset_id: str = "",
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, asset_id)
        import requests

        base = os.getenv("WECOM_API_BASE", "https://qyapi.weixin.qq.com").rstrip("/")
        token = self._access_token(base)
        if not token:
            return {"ok": False, "channel": self.name, "error": "获取 WeCom access_token 失败"}
        delivered = 0
        for i, msg in enumerate(messages):
            if pacing and i < len(pacing):
                _sleep_ms(pacing[i])  # pace bursts; WeCom has no public typing API
            r = requests.post(
                f"{base}/cgi-bin/message/send",
                params={"access_token": token},
                json={
                    "touser": to,
                    "msgtype": "text",
                    "agentid": os.environ["WECOM_AGENT_ID"],
                    "text": {"content": msg},
                },
                timeout=15,
            )
            if r.ok and r.json().get("errcode") == 0:
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": r.text[:200]}
        return {"ok": True, "channel": self.name, "delivered": delivered}


_REGISTRY: dict[str, Any] = {
    c.name: c
    for c in (
        SandboxChannel(),
        TelegramChannel(),
        WhatsAppChannel(),
        LineChannel(),
        WeComChannel(),
    )
}


def get_channel(name: str) -> Any:
    return _REGISTRY.get(name, _REGISTRY["sandbox"])


def list_channels() -> list[dict[str, Any]]:
    out = []
    for ch in _REGISTRY.values():
        out.append(
            {
                "name": ch.name,
                "label": ch.label,
                "risk": getattr(ch, "risk", "official"),
                "configured": ch.is_configured(),
            }
        )
    return out
