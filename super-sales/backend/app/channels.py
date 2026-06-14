"""Pluggable channel adapters.

Every messaging platform implements the same tiny interface so the closer never
needs to know which platform it's talking to. The ``sandbox`` channel works
right now with zero credentials (messages live in the local store), so the whole
AI-closer loop is testable end-to-end today; the real platforms (WhatsApp Cloud
API, LINE Messaging API, WeCom) plug into the same interface once the user
provides credentials via environment variables.

Configuration is read from env so nothing secret is committed:
  * WhatsApp : WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
  * LINE     : LINE_CHANNEL_TOKEN
  * WeCom    : WECOM_CORP_ID, WECOM_SECRET, WECOM_AGENT_ID
"""

from __future__ import annotations

import os
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


class WhatsAppChannel(_EnvChannel):
    name = "whatsapp"
    label = "WhatsApp（Meta Cloud API）"
    risk = "official"
    required_env = ("WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID")


class LineChannel(_EnvChannel):
    name = "line"
    label = "LINE（Messaging API）"
    risk = "official"
    required_env = ("LINE_CHANNEL_TOKEN",)


class WeComChannel(_EnvChannel):
    name = "wecom"
    label = "企业微信 WeCom（官方）"
    risk = "official"
    required_env = ("WECOM_CORP_ID", "WECOM_SECRET", "WECOM_AGENT_ID")


_REGISTRY: dict[str, Any] = {
    c.name: c
    for c in (SandboxChannel(), WhatsAppChannel(), LineChannel(), WeComChannel())
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
