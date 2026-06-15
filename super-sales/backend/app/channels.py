"""Pluggable channel adapters.

Every messaging platform implements the same tiny interface so the closer never
needs to know which platform it's talking to. The ``sandbox`` channel works
right now with zero credentials (messages live in the local store), so the whole
AI-closer loop is testable end-to-end today; the real platforms (Telegram,
WhatsApp via a self-hosted gateway, LINE, WeCom) plug into the same interface
once the user provides credentials via environment variables.

Both *text* and *media* (image / video / document / audio) are transmitted: a
real salesperson does not only type — they drop a product photo, a spec PDF, a
short demo clip. ``send`` therefore takes a list of already-resolved, privacy-
checked ``assets`` (each a dict with ``kind`` / ``caption`` / ``url`` /
``local_path``) alongside the text bubbles.

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

import base64
import os
import time
from collections.abc import Callable
from typing import Any, Protocol

# Human-like send pacing: how long to "type" before each message lands. A real
# person never fires off several messages instantly; they pause to read/think
# and then type for a beat (longer messages take longer). Channels that support
# a typing indicator show it during this wait. Capped so we never hang too long.
_TYPING_CAP_MS = 12000


def _sleep_ms(ms: int) -> None:
    time.sleep(max(0, min(int(ms), _TYPING_CAP_MS)) / 1000.0)


def _asset_wait(wait_ms: int, action: Callable[[], None] | None = None) -> None:
    """Pause *before* an asset is sent — a real rep goes and finds the file
    rather than pasting it instantly. While we wait we keep refreshing an
    optional presence/"uploading…" indicator so the customer sees activity."""
    remaining = min(int(wait_ms or 0), _TYPING_CAP_MS)
    while remaining > 0:
        if action is not None:
            try:
                action()
            except Exception:  # noqa: BLE001
                pass
        step = min(remaining, 4500)
        _sleep_ms(step)
        remaining -= step


# How each asset kind maps onto Telegram's send methods (method, json/form field,
# the "upload…" chat action shown while it sends). Anything unmapped → document.
_TG_MEDIA = {
    "image": ("sendPhoto", "photo", "upload_photo"),
    "photo": ("sendPhoto", "photo", "upload_photo"),
    "video": ("sendVideo", "video", "upload_video"),
    "audio": ("sendAudio", "audio", "upload_voice"),
    "voice": ("sendVoice", "voice", "upload_voice"),
}
# WhatsApp (Evolution API) mediatype per asset kind; unmapped → document.
_WA_MEDIATYPE = {
    "image": "image", "photo": "image",
    "video": "video",
    "audio": "audio", "voice": "audio",
}


def _asset_caption(a: dict[str, Any]) -> str:
    return (a.get("caption") or a.get("filename") or "").strip()


class Channel(Protocol):
    name: str
    label: str

    def is_configured(self) -> bool: ...

    def send(self, to: str, messages: list[str], assets: list[dict[str, Any]] | None = None,
             pacing: list[int] | None = None) -> dict[str, Any]: ...


class SandboxChannel:
    """In-app channel — works with no credentials. Used for testing / manual mode."""

    name = "sandbox"
    label = "沙盒（应用内）"
    risk = "none"

    def is_configured(self) -> bool:
        return True

    def send(self, to: str, messages: list[str], assets: list[dict[str, Any]] | None = None,
             pacing: list[int] | None = None) -> dict[str, Any]:
        # Persistence is handled by the caller (closer.apply_decision) against the
        # store, so the sandbox channel is a no-op transport that always succeeds.
        # No real delay here — calibration/tests run on sandbox and must stay fast.
        return {
            "ok": True,
            "channel": self.name,
            "delivered": len(messages),
            "assets": len(assets or []),
        }


class _EnvChannel:
    """Base for real platforms: configured iff its required env vars are present."""

    name = ""
    label = ""
    risk = "official"
    required_env: tuple[str, ...] = ()

    def is_configured(self) -> bool:
        return all(os.getenv(k) for k in self.required_env)

    def send(self, to: str, messages: list[str], assets: list[dict[str, Any]] | None = None,
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
    demo end-to-end with just a @BotFather token. ``to`` is the chat id.

    Sends text *and* media: photos via sendPhoto, clips via sendVideo, files via
    sendDocument — local files are uploaded as multipart, public URLs are passed
    straight to Telegram to fetch."""

    name = "telegram"
    label = "Telegram（Bot API）"
    risk = "official"
    required_env = ("TELEGRAM_BOT_TOKEN",)

    def send(self, to: str, messages: list[str], assets: list[dict[str, Any]] | None = None,
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, assets)
        import requests

        base = os.getenv("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        api = f"{base}/bot{token}"
        delivered = 0
        for i, msg in enumerate(messages):
            # human pacing: show "typing…" then wait before the message lands.
            wait_ms = pacing[i] if pacing and i < len(pacing) else 0
            remaining = min(int(wait_ms), _TYPING_CAP_MS)
            while remaining > 0:
                try:
                    requests.post(f"{api}/sendChatAction",
                                  json={"chat_id": to, "action": "typing"}, timeout=10)
                except Exception:  # noqa: BLE001
                    break
                step = min(remaining, 4500)  # Telegram typing lasts ~5s; refresh
                _sleep_ms(step)
                remaining -= step
            r = requests.post(f"{api}/sendMessage", json={"chat_id": to, "text": msg}, timeout=15)
            if r.ok and r.json().get("ok"):
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": r.text[:200]}
        # then the media — what makes this more than a text bot. Pause to "find"
        # each file first (showing the matching upload action) so it never lands
        # the same instant as the text.
        nmsg = len(messages)
        for j, a in enumerate(assets or []):
            _, _, action = _TG_MEDIA.get(a.get("kind", ""), ("sendDocument", "document", "upload_document"))
            wait_ms = pacing[nmsg + j] if pacing and nmsg + j < len(pacing) else 0
            _asset_wait(wait_ms, lambda act=action: requests.post(
                f"{api}/sendChatAction", json={"chat_id": to, "action": act}, timeout=10))
            ok, err = self._send_media(requests, api, to, a)
            if ok:
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": err}
        return {"ok": True, "channel": self.name, "delivered": delivered, "assets": len(assets or [])}

    @staticmethod
    def _send_media(requests: Any, api: str, to: str, a: dict[str, Any]) -> tuple[bool, str]:
        method, field, action = _TG_MEDIA.get(a.get("kind", ""), ("sendDocument", "document", "upload_document"))
        caption = _asset_caption(a)
        try:
            requests.post(f"{api}/sendChatAction", json={"chat_id": to, "action": action}, timeout=10)
        except Exception:  # noqa: BLE001
            pass
        data: dict[str, Any] = {"chat_id": to}
        if caption:
            data["caption"] = caption
        local_path, url = a.get("local_path", ""), a.get("url", "")
        try:
            if local_path:
                with open(local_path, "rb") as fh:
                    r = requests.post(f"{api}/{method}", data=data, files={field: fh}, timeout=120)
            elif url:
                data[field] = url
                r = requests.post(f"{api}/{method}", data=data, timeout=30)
            else:
                return False, f"素材 {a.get('id', '')} 既无本地文件也无 URL，无法发送"
        except Exception as e:  # noqa: BLE001
            return False, f"发送素材失败：{e}"
        if r.ok and r.json().get("ok"):
            return True, ""
        return False, r.text[:200]


class WhatsAppChannel(_EnvChannel):
    """WhatsApp via a self-hosted 3rd-party gateway (Evolution API / Baileys).

    No Meta business account: you run the open-source gateway, scan a QR with a
    normal WhatsApp number, and we talk to its REST API. ``to`` is the recipient
    phone number in international format (digits only). Media goes through the
    gateway's ``sendMedia`` endpoint (local files base64-encoded, URLs passed
    through)."""

    name = "whatsapp"
    label = "WhatsApp（第三方网关 Evolution API）"
    risk = "unofficial"
    required_env = ("WA_GATEWAY_BASE", "WA_GATEWAY_API_KEY", "WA_GATEWAY_INSTANCE")

    def send(self, to: str, messages: list[str], assets: list[dict[str, Any]] | None = None,
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, assets)
        import requests

        base = os.environ["WA_GATEWAY_BASE"].rstrip("/")
        instance = os.environ["WA_GATEWAY_INSTANCE"]
        headers = {"apikey": os.environ["WA_GATEWAY_API_KEY"]}
        text_url = f"{base}/message/sendText/{instance}"
        delivered = 0
        for i, msg in enumerate(messages):
            # Evolution API shows a real "typing…" presence for ``delay`` ms before
            # the text lands — exactly the human cadence we want, done gateway-side.
            wait_ms = min(int(pacing[i]), _TYPING_CAP_MS) if pacing and i < len(pacing) else 0
            body: dict[str, Any] = {"number": to, "text": msg}
            if wait_ms > 0:
                body["delay"] = wait_ms
                body["options"] = {"delay": wait_ms, "presence": "composing"}
            r = requests.post(text_url, headers=headers, json=body, timeout=max(20, wait_ms // 1000 + 20))
            if r.ok:
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": r.text[:200]}
        media_url = f"{base}/message/sendMedia/{instance}"
        presence_url = f"{base}/chat/sendPresence/{instance}"
        nmsg = len(messages)
        for j, a in enumerate(assets or []):
            # "find the file" pause, showing a composing presence while we wait.
            wait_ms = pacing[nmsg + j] if pacing and nmsg + j < len(pacing) else 0
            _asset_wait(wait_ms, lambda: requests.post(
                presence_url, headers=headers,
                json={"number": to, "presence": "composing"}, timeout=10))
            ok, err = self._send_media(requests, media_url, headers, to, a)
            if ok:
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": err}
        return {"ok": True, "channel": self.name, "delivered": delivered, "assets": len(assets or [])}

    @staticmethod
    def _send_media(requests: Any, url: str, headers: dict[str, str], to: str,
                    a: dict[str, Any]) -> tuple[bool, str]:
        mediatype = _WA_MEDIATYPE.get(a.get("kind", ""), "document")
        caption = _asset_caption(a)
        filename = a.get("filename") or ""
        local_path, link = a.get("local_path", ""), a.get("url", "")
        body: dict[str, Any] = {"number": to, "mediatype": mediatype}
        if caption:
            body["caption"] = caption
        if filename:
            body["fileName"] = os.path.basename(filename)
        try:
            if link:
                body["media"] = link
            elif local_path:
                with open(local_path, "rb") as fh:
                    body["media"] = base64.b64encode(fh.read()).decode("ascii")
            else:
                return False, f"素材 {a.get('id', '')} 既无本地文件也无 URL，无法发送"
            r = requests.post(url, headers=headers, json=body, timeout=120)
        except Exception as e:  # noqa: BLE001
            return False, f"发送素材失败：{e}"
        if r.ok:
            return True, ""
        return False, r.text[:200]


class LineChannel(_EnvChannel):
    name = "line"
    label = "LINE（Messaging API）"
    risk = "official"
    required_env = ("LINE_CHANNEL_TOKEN",)

    def send(self, to: str, messages: list[str], assets: list[dict[str, Any]] | None = None,
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, assets)
        import requests

        base = os.getenv("LINE_API_BASE", "https://api.line.me").rstrip("/")
        headers = {"Authorization": f"Bearer {os.environ['LINE_CHANNEL_TOKEN']}"}
        text_objs: list[dict[str, Any]] = [{"type": "text", "text": m} for m in messages]
        # LINE media must be served from a public https URL (it has no upload-and-send
        # in one call). With a URL we send a real image/video bubble; otherwise we
        # fall back to a text line carrying the caption so nothing is silently dropped.
        media_objs: list[dict[str, Any]] = []
        for a in assets or []:
            link, kind, cap = a.get("url", ""), a.get("kind", ""), _asset_caption(a)
            if link.startswith("https://") and kind in ("image", "photo"):
                media_objs.append({"type": "image", "originalContentUrl": link, "previewImageUrl": link})
            elif link.startswith("https://") and kind == "video":
                media_objs.append({"type": "video", "originalContentUrl": link, "previewImageUrl": link})
            else:
                note = f"【资料】{cap}" + (f"\n{link}" if link else "")
                media_objs.append({"type": "text", "text": note})

        def _push(objs: list[dict[str, Any]], delivered: int) -> tuple[int, dict[str, Any] | None]:
            for i in range(0, len(objs), 5):  # LINE push accepts up to 5 objects per call.
                chunk = objs[i : i + 5]
                r = requests.post(
                    f"{base}/v2/bot/message/push",
                    headers=headers, json={"to": to, "messages": chunk}, timeout=15,
                )
                if r.ok:
                    delivered += len(chunk)
                else:
                    return delivered, {"ok": False, "channel": self.name,
                                       "delivered": delivered, "error": r.text[:200]}
            return delivered, None

        delivered = 0
        for i in range(0, len(text_objs), 5):
            if pacing and i < len(pacing):
                _sleep_ms(pacing[i])  # pace bursts; LINE has no public typing API
            delivered, err = _push(text_objs[i : i + 5], delivered)
            if err:
                return err
        # media: pause to "find" the file (LINE has no typing API, so just wait)
        # before the image/video/note bubbles land.
        if media_objs:
            _asset_wait(pacing[len(text_objs)] if pacing and len(text_objs) < len(pacing) else 0)
            delivered, err = _push(media_objs, delivered)
            if err:
                return err
        return {"ok": True, "channel": self.name, "delivered": delivered, "assets": len(assets or [])}


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

    def send(self, to: str, messages: list[str], assets: list[dict[str, Any]] | None = None,
             pacing: list[int] | None = None) -> dict[str, Any]:
        if not self.is_configured():
            return super().send(to, messages, assets)
        import requests

        base = os.getenv("WECOM_API_BASE", "https://qyapi.weixin.qq.com").rstrip("/")
        token = self._access_token(base)
        if not token:
            return {"ok": False, "channel": self.name, "error": "获取 WeCom access_token 失败"}
        send_url = f"{base}/cgi-bin/message/send"
        agent = os.environ["WECOM_AGENT_ID"]
        delivered = 0
        for i, msg in enumerate(messages):
            if pacing and i < len(pacing):
                _sleep_ms(pacing[i])  # pace bursts; WeCom has no public typing API
            r = requests.post(
                send_url,
                params={"access_token": token},
                json={"touser": to, "msgtype": "text", "agentid": agent, "text": {"content": msg}},
                timeout=15,
            )
            if r.ok and r.json().get("errcode") == 0:
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": r.text[:200]}
        # WeCom media requires a prior upload→media_id step; we send the asset by
        # uploading the local file (or a downloaded URL) to the temp-media API, then
        # dispatching the matching image/video/file message. Pause to "find" each
        # file first (WeCom has no typing API, so just wait) before it lands.
        nmsg = len(messages)
        for j, a in enumerate(assets or []):
            wait_ms = pacing[nmsg + j] if pacing and nmsg + j < len(pacing) else 0
            _asset_wait(wait_ms)
            ok, err = self._send_media(requests, base, token, agent, to, a)
            if ok:
                delivered += 1
            else:
                return {"ok": False, "channel": self.name, "delivered": delivered, "error": err}
        return {"ok": True, "channel": self.name, "delivered": delivered, "assets": len(assets or [])}

    @staticmethod
    def _send_media(requests: Any, base: str, token: str, agent: str, to: str,
                    a: dict[str, Any]) -> tuple[bool, str]:
        kind = a.get("kind", "")
        wecom_type = {"image": "image", "photo": "image", "video": "video", "voice": "voice"}.get(kind, "file")
        filename = os.path.basename(a.get("filename") or "asset")
        local_path, link = a.get("local_path", ""), a.get("url", "")
        try:
            if local_path:
                with open(local_path, "rb") as fh:
                    content = fh.read()
            elif link:
                content = requests.get(link, timeout=60).content
            else:
                return False, f"素材 {a.get('id', '')} 既无本地文件也无 URL，无法发送"
            up = requests.post(
                f"{base}/cgi-bin/media/upload",
                params={"access_token": token, "type": wecom_type if wecom_type != "file" else "file"},
                files={"media": (filename, content)},
                timeout=120,
            )
            media_id = up.json().get("media_id", "")
            if not media_id:
                return False, f"WeCom 素材上传失败：{up.text[:200]}"
            payload = {"touser": to, "msgtype": wecom_type, "agentid": agent,
                       wecom_type: {"media_id": media_id}}
            r = requests.post(f"{base}/cgi-bin/message/send",
                              params={"access_token": token}, json=payload, timeout=30)
        except Exception as e:  # noqa: BLE001
            return False, f"发送素材失败：{e}"
        if r.ok and r.json().get("errcode") == 0:
            return True, ""
        return False, r.text[:200]


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
