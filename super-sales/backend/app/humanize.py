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

# tuning knobs (milliseconds)
_READ_MS_PER_CHAR = 22          # time to "read" the customer's message
_READ_MIN, _READ_MAX = 600, 6000
_THINK_MS = 700                 # brief pause before starting to type the first reply
_TYPE_MS_PER_CHAR = 70          # typing speed (~14 chars/sec, casual IM typing)
_TYPE_MIN, _TYPE_MAX = 900, 9000
_JITTER = 0.25                  # +/- 25% randomness


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def pacing(inbound: str, replies: list[str], seed: int | None = None) -> list[int]:
    """Return a delay (ms) to wait before showing each reply message.

    delays[0] = read the inbound + think + type the first message.
    delays[i] = type the i-th message (a short inter-message beat is implicit).
    """
    rng = random.Random(seed)
    read = _clamp(len(inbound or "") * _READ_MS_PER_CHAR, _READ_MIN, _READ_MAX)
    out: list[int] = []
    for i, msg in enumerate(replies):
        typing = _clamp(len(msg or "") * _TYPE_MS_PER_CHAR, _TYPE_MIN, _TYPE_MAX)
        base = (read + _THINK_MS + typing) if i == 0 else typing
        jitter = 1 + rng.uniform(-_JITTER, _JITTER)
        out.append(int(base * jitter))
    return out
