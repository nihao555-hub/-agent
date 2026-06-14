"""LLM client wrapper.

Talks to any OpenAI-compatible endpoint (configured for grsai / gpt-5.5 by
default). Provides a `chat_json` helper that asks the model for strict JSON and
self-corrects once if the first response fails to parse.

When no API key is configured, `llm_available()` returns False and callers fall
back to the deterministic rule-based path so the whole pipeline still runs
offline (no key, no network) — same "兜底" philosophy as the rest of the repo.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from openai import OpenAI

_API_KEY = os.getenv("LLM_API_KEY", "").strip()
_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.grsai.com/v1").strip()
_MODEL = os.getenv("LLM_MODEL", "gpt-5.5").strip()
_TIMEOUT = float(os.getenv("LLM_TIMEOUT_MS", "60000")) / 1000.0

_client: OpenAI | None = None


def llm_available() -> bool:
    return bool(_API_KEY)


def model_name() -> str:
    return _MODEL


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=_API_KEY, base_url=_BASE_URL, timeout=_TIMEOUT)
    return _client


def _extract_json(text: str) -> dict[str, Any]:
    """Best-effort JSON extraction from a model reply."""
    text = text.strip()
    # strip ```json fences
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # grab the outermost {...}
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("no JSON object found in model reply")


def chat_json(system: str, user: str, *, temperature: float = 0.4, model: str | None = None) -> dict[str, Any]:
    """Ask the model for a JSON object, retrying once with a repair prompt.

    ``model`` lets callers route to a *different* model than the default (used by
    the calibration judge to de-correlate from the closer model — anti-overfit)."""
    client = _get_client()
    use_model = (model or _MODEL).strip()
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    last_err: Exception | None = None
    for attempt in range(2):
        resp = client.chat.completions.create(
            model=use_model,
            messages=messages,  # type: ignore[arg-type]
            temperature=temperature,
        )
        content = resp.choices[0].message.content or ""
        try:
            return _extract_json(content)
        except (ValueError, json.JSONDecodeError) as err:  # self-correct once
            last_err = err
            messages.append({"role": "assistant", "content": content})
            messages.append(
                {
                    "role": "user",
                    "content": "上一条回复不是合法 JSON。请只输出一个合法的 JSON 对象，"
                    "不要包含任何解释文字或 markdown 代码块。",
                }
            )
    raise RuntimeError(f"LLM 未能返回合法 JSON: {last_err}")
