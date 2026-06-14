"""Human-like message pacing for the AI closer.

Real top salespeople do not reply instantly. They take a beat to "read" the
incoming message, then "type" for a while — longer messages take longer — and
break a long thought into a few messages sent a few seconds apart.

This module turns a list of outgoing reply messages into per-message delays
(milliseconds to wait *before* revealing each message, while a "typing…"
indicator shows). The numbers are deliberately simple and rule-based; the goal
is plausible rhythm, not exact simulation. A small deterministic jitter keeps
it from feeling metronomic without making tests flaky (seeded per turn).
"""

from __future__ import annotations

import random

# tuning knobs (milliseconds) — tuned for *real* sales rhythm, not instant replies
_READ_MS_PER_CHAR = 35          # time to "read" the customer's message
_READ_MIN, _READ_MAX = 1200, 9000
_THINK_MS_PER_CHAR = 14         # extra "thinking" scaled by how much we're about to say
_THINK_MIN, _THINK_MAX = 900, 7000
_TYPE_MS_PER_CHAR = 90          # typing speed (~11 chars/sec, casual IM typing)
_TYPE_MIN, _TYPE_MAX = 1400, 14000
_JITTER = 0.25                  # +/- 25% randomness


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def plan(inbound: str, replies: list[str], seed: int | None = None) -> dict[str, object]:
    """Phase plan for a human-like turn.

    Returns ``read_ms`` (show "reading…" first), ``think_ms`` (then a thinking
    beat before the first keystroke) and ``type_ms`` — one "typing…" duration
    per outgoing message. The UI shows each phase in turn so replies arrive at a
    real person's pace instead of instantly.
    """
    rng = random.Random(seed)
    j = lambda v: int(v * (1 + rng.uniform(-_JITTER, _JITTER)))  # noqa: E731
    read = _clamp(len(inbound or "") * _READ_MS_PER_CHAR, _READ_MIN, _READ_MAX)
    first_len = len(replies[0]) if replies else 0
    think = _clamp(first_len * _THINK_MS_PER_CHAR, _THINK_MIN, _THINK_MAX)
    type_ms = [j(_clamp(len(m or "") * _TYPE_MS_PER_CHAR, _TYPE_MIN, _TYPE_MAX)) for m in replies]
    return {"read_ms": j(read), "think_ms": j(think), "type_ms": type_ms}


def send_delays(plan: dict[str, object]) -> list[int]:
    """Per-message delay (ms) to wait *before* actually sending each message on a
    real channel, with a "typing…" indicator shown during the wait. The first
    message also absorbs the read + think beat; later messages get a short gap so
    bursts don't land all at once."""
    read = int(plan.get("read_ms", 0) or 0)  # type: ignore[arg-type]
    think = int(plan.get("think_ms", 0) or 0)  # type: ignore[arg-type]
    type_ms = list(plan.get("type_ms", []) or [])  # type: ignore[arg-type]
    rng = random.Random(read * 131 + think)  # stable per-turn, not metronomic
    out: list[int] = []
    for i, t in enumerate(type_ms):
        if i == 0:
            out.append(read + think + int(t))
        else:
            gap = rng.randint(1200, 3200)  # human beat between bursts
            out.append(gap + int(t))
    return out


def pacing(inbound: str, replies: list[str], seed: int | None = None) -> list[int]:
    """Back-compat: a single delay (ms) before each message (read+think folded into [0])."""
    p = plan(inbound, replies, seed)
    type_ms = p["type_ms"]  # type: ignore[assignment]
    out: list[int] = []
    for i, t in enumerate(type_ms):  # type: ignore[arg-type]
        out.append(int(p["read_ms"]) + int(p["think_ms"]) + t if i == 0 else t)  # type: ignore[call-overload]
    return out
