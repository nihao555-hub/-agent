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

import os
import random
import re

# --- short-message reshaping ------------------------------------------------
# Real top closers send short IM bubbles, never 200-char essays. The prompt asks
# the model to keep messages short, but prompts alone don't *guarantee* it — so
# this deterministic guard reshapes whatever the model returns into short bubbles
# regardless of model whims (and also covers the offline/fallback path). It only
# fires on genuinely long messages: short replies pass through untouched, so it
# never imposes a fixed "always N bubbles" cadence — the count tracks content.
_MSG_CAP = int(os.getenv("HUMANIZE_MSG_CAP", "48"))      # soft per-bubble char cap
_MAX_BUBBLES = int(os.getenv("HUMANIZE_MAX_BUBBLES", "5"))  # never explode a turn past this
_SENT_ENDERS = "。！？；…⁇⁈⁉．!?;"  # CJK + fullwidth + ascii sentence enders
_CLAUSE_SEPS = "、，,；;/／│|"      # secondary break points inside an over-long sentence
_BREAKABLE = _CLAUSE_SEPS + " \t"  # plus whitespace, so long latin clauses can break on words


def _sentences(text: str) -> list[str]:
    """Split into sentence-ish chunks, keeping the terminal punctuation. ASCII '.'
    only ends a sentence when followed by whitespace/end, so prices/decimals like
    ``3.999`` and abbreviations stay intact."""
    out: list[str] = []
    buf = ""
    for i, ch in enumerate(text):
        buf += ch
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if ch == "\n":
            out.append(buf)
            buf = ""
        elif ch == ".":
            if nxt in ("", " ", "\n", "\t"):
                out.append(buf)
                buf = ""
        elif ch in _SENT_ENDERS:
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return [s.strip() for s in out if s.strip()]


def _atoms(text: str, cap: int) -> list[str]:
    """Sentence chunks, but any sentence still longer than ``cap`` is further
    broken at clause separators (、，；/ …) so no single atom is a wall of text.
    A clause with no separators at all is left intact (we never cut mid-word)."""
    out: list[str] = []
    for s in _sentences(text):
        if len(s) <= cap:
            out.append(s)
            continue
        buf = ""
        for ch in s:
            buf += ch
            if ch in _BREAKABLE and len(buf) >= cap * 0.6:
                out.append(buf.strip())
                buf = ""
        if buf.strip():
            out.append(buf.strip())
    return [a for a in out if a]


def _join(a: str, b: str) -> str:
    """Concatenate two sentence chunks, inserting a space only between latin words
    (CJK runs together as it would in real typing)."""
    if a and b and re.search(r"[A-Za-z0-9]$", a) and re.match(r"[A-Za-z0-9]", b):
        return f"{a} {b}"
    return a + b


def _pack(atoms: list[str], cap: int) -> list[str]:
    """Greedily pack atoms into bubbles, each kept under ``cap`` (a single atom
    bigger than cap becomes its own bubble — we never cut mid-clause)."""
    bubbles: list[str] = []
    cur = ""
    for s in atoms:
        if cur and len(cur) + len(s) > cap:
            bubbles.append(cur)
            cur = s
        else:
            cur = _join(cur, s) if cur else s
    if cur:
        bubbles.append(cur)
    return bubbles


def reshape(replies: list[str], translations: list[str] | None = None,
            cap: int | None = None, max_bubbles: int | None = None) -> tuple[list[str], list[str]]:
    """Reshape model replies into short IM bubbles, keeping translations aligned.

    A bubble already under ``cap`` is left exactly as-is. A long one is split at
    sentence boundaries and its sentences are greedily re-packed so each bubble
    stays under ``cap``; if that still yields more than ``max_bubbles`` bubbles the
    overflow is merged back into the last one (we never *drop* content). The
    operator-facing translation rides on the first sub-bubble of each source
    message (it's internal-only, so exact per-bubble alignment isn't needed)."""
    cap = cap or _MSG_CAP
    max_bubbles = max_bubbles or _MAX_BUBBLES
    translations = translations or []
    out_r: list[str] = []
    out_t: list[str] = []
    for idx, raw in enumerate(replies):
        msg = (raw or "").strip()
        if not msg:
            continue
        tr = translations[idx] if idx < len(translations) else ""
        if len(msg) <= cap:
            out_r.append(msg)
            out_t.append(tr)
            continue
        atoms = _atoms(msg, cap)
        bubbles = _pack(atoms, cap)
        if len(bubbles) > max_bubbles:
            # Too many bubbles → widen the cap until they pack into ~max_bubbles
            # roughly-equal short bubbles (never one fat tail). Guaranteed to
            # terminate: at cap == total it collapses to a single bubble.
            total = sum(len(a) for a in atoms)
            even_cap = max(cap, -(-total // max_bubbles))  # ceil(total / max_bubbles)
            while len(_pack(atoms, even_cap)) > max_bubbles and even_cap < total:
                even_cap += max(4, cap // 4)
            bubbles = _pack(atoms, even_cap)
        for j, b in enumerate(bubbles):
            out_r.append(b.strip())
            out_t.append(tr if j == 0 else "")
    return out_r, out_t


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
