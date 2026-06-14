"""Pluggable channel adapters.

Every messaging platform implements the same tiny interface so the closer never
needs to know which platform it's talking to. The ``sandbox`` channel works
right now with zero credentials (messages live in the local store), so the whole
AI-closer loop is testable end-to-end today; the real platforms (WhatsApp Cloud
API, LINE Messaging API, WeCom) plug into the same interface once the user
provides credentials via environment variables.

Configuration is read from env so nothing secret is committed:
  * WhatsApp : WHATSAPP_TOKEN, WHATSAPP_PHONE_ID   (optional WHATSAPP_API_BASE)
  * LINE     : LINE_CHANNEL_TOKEN                   (optional LINE_API_BASE)
  * WeCom    : WECOM_CORP_ID, WECOM_SECRET, WECOM_AGENT_ID (optional WECOM_API_BASE)

Each real platform's ``send`` is fully implemented against the official HTTP API,
and the ``*_API_BASE`` overrides let you point the same adapter at a compliant
third-party gateway without code changes. Delivery is gated purely on whether the
credentials are present.
"""

from __future__ import annotations

import os
import time
from typing import Any, Protocol


class Channel(Protocol):
    name: str
    label: str

    def is_configured(self) -> bool: ...

    def send(self, to: str, messages: list[str], asset_id: str = "") -> dict[str, Any]: ...


class SandboxChannel:
    """In-app channel — works with no credentials. Used for testing / manual mode."""

    name = "sandbox"
    label = "沙盒（应用内）"
    risk = "none"

    def is_configured(self) -> bool:
        return True

    def send(self, to: str, messages: list[str], asset_id: str = "") -> dict[str, Any]:
        # Persistence is handled by the caller (closer.apply_decision) against the
        # store, so the sandbox channel is a no-op transport that always succeeds.
        return {"ok": True, "channel": self.name, "delivered": len(messages)}


class _EnvChannel:
    """Base for real platforms: configured iff its required env vars are present."""

    name = ""
    label = ""
    risk = "official"
    required_env: tuple[str, ...] = ()

    def is_configured(self) -> bool:
        return all(os.getenv(k) for k in self.required_env)

    def send(self, to: str, messages: list[str], asset_id: str = "") -> dict[str, Any]:
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

    def send(self, to: str, messages: list[str], asset_id: str = "") -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, asset_id)
        import requests

        base = os.getenv("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        delivered = 0
        for msg in messages:
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
    name = "whatsapp"
    label = "WhatsApp（Meta Cloud API）"
    risk = "official"
    required_env = ("WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID")

    def send(self, to: str, messages: list[str], asset_id: str = "") -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, asset_id)
        import requests

        base = os.getenv("WHATSAPP_API_BASE", "https://graph.facebook.com/v20.0").rstrip("/")
        url = f"{base}/{os.environ['WHATSAPP_PHONE_ID']}/messages"
        headers = {"Authorization": f"Bearer {os.environ['WHATSAPP_TOKEN']}"}
        delivered = 0
        for msg in messages:
            r = requests.post(
                url,
                headers=headers,
                json={"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": msg}},
                timeout=15,
            )
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

    def send(self, to: str, messages: list[str], asset_id: str = "") -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, asset_id)
        import requests

        base = os.getenv("LINE_API_BASE", "https://api.line.me").rstrip("/")
        headers = {"Authorization": f"Bearer {os.environ['LINE_CHANNEL_TOKEN']}"}
        # LINE push accepts up to 5 message objects per call.
        delivered = 0
        for i in range(0, len(messages), 5):
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

    def send(self, to: str, messages: list[str], asset_id: str = "") -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, asset_id)
        import requests

        base = os.getenv("WECOM_API_BASE", "https://qyapi.weixin.qq.com").rstrip("/")
        token = self._access_token(base)
        if not token:
            return {"ok": False, "channel": self.name, "error": "获取 WeCom access_token 失败"}
        delivered = 0
        for msg in messages:
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
