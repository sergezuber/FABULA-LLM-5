# Pure helpers for the :1235 adapter (unit-testable, no I/O):
#   - prefix/cache-diff: local servers (LM Studio MLX / llama.cpp) reuse the KV cache ONLY while the
#     request PREFIX is byte-stable. A plugin reordering tool schemas or mutating the system block
#     silently breaks it and multiplies wall-clock (our measured #1 cost is prefill). These functions
#     let the adapter — the one choke-point every request passes — see and log when the prefix breaks.
#   - overflow classification: catch context-overflow, including SILENT cases local models produce
#     (MiMo truncates the prompt to fit -> stop='length', 0 output; z.ai accepts overflow silently).
import json
import re


def stable_prefix(body: dict) -> str:
    """The parts that SHOULD stay byte-identical across a session's turns and thus be prefix-cached:
    the tool definitions + every message except the last (the last user/assistant turn is the only
    thing that legitimately grows). Returned as a canonical string for prefix comparison."""
    if not isinstance(body, dict):
        return ""
    parts = []
    tools = body.get("tools")
    if tools:
        parts.append(json.dumps(tools, sort_keys=True, ensure_ascii=False))
    msgs = body.get("messages") or []
    for m in msgs[:-1]:
        parts.append(json.dumps(m, sort_keys=True, ensure_ascii=False))
    return "\n".join(parts)


def shared_prefix_len(a: str, b: str) -> int:
    """Length of the common leading substring of a and b (the reusable KV-cache prefix)."""
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


# Explicit context-overflow error fragments across the local/OpenAI-compatible servers behind the
# adapter. NON_OVERFLOW excludes throttling messages that merely mention tokens.
_OVERFLOW_PATTERNS = [
    r"context length",
    r"maximum context length",
    r"greater than the context length",
    r"prompt has \d+ tokens but",
    r"exceed(s|ed)? the (maximum )?context",
    r"reduce the (length|number of|input)",
    r"too (large|long) .*context",
    r"context window",
]
_NON_OVERFLOW = [r"rate.?limit", r"too many requests", r"quota"]


def classify_overflow(status, body_text, finish_reason="", output_tokens=-1,
                      input_tokens=-1, context_window=0):
    """Return '' (not an overflow) or a short reason string. Covers explicit provider errors AND the
    two silent cases local models produce with NO error at all."""
    t = (body_text or "").lower()
    if any(re.search(p, t) for p in _NON_OVERFLOW):
        return ""
    if isinstance(status, int) and status >= 400 and any(re.search(p, t) for p in _OVERFLOW_PATTERNS):
        return "explicit-overflow-error"
    # silent: MiMo/llama.cpp truncate the prompt to fit -> 'length' stop, zero output, input ~= window.
    if finish_reason == "length" and output_tokens == 0 and context_window and input_tokens >= 0.95 * context_window:
        return "silent-truncation-length"
    # z.ai style: overflow accepted silently -> normal 'stop' but input already exceeds the window.
    if finish_reason == "stop" and context_window and input_tokens > context_window:
        return "silent-overflow-accepted"
    return ""


def update_prefix_and_check(state, lock, key, prefix, floor=2000, thresh=0.98):
    """Atomically store `prefix` as the last-seen request prefix for model `key` and compare it to the
    PREVIOUS one, returning a CACHE-BREAK descriptor `(shared, total, pct)` when the reusable KV-cache
    prefix dropped below `thresh` on a large-enough prefix, else None.

    ThreadingHTTPServer serves requests concurrently, so the get-then-set on the shared `state` dict
    MUST be atomic: without the lock, two same-model requests interleave and one reads the OTHER's
    prefix — a spurious CACHE-BREAK, or a lost update. `lock` (a threading.Lock) guards exactly the
    compare-and-store; the ratio math runs outside it on locals. Same-thread callers pass the same
    (state, lock) the adapter uses so the test exercises the REAL code path (no duplicated logic)."""
    with lock:
        prev = state.get(key)
        state[key] = prefix
    if not prefix or not prev:
        return None
    shared = shared_prefix_len(prev, prefix)
    small = min(len(prev), len(prefix))
    if small > floor and shared / small < thresh:
        return (shared, len(prefix), 100.0 * shared / small)
    return None


def drain_with_idle_split(read_fn, set_timeout, idle_timeout, on_chunk):
    """Drain a response body with a FIRST-TOKEN vs INTER-TOKEN idle split (the watchdog for the
    NON-streaming path; the streaming loop mirrors this inline).

    The caller opens the socket with the FIRST-TOKEN (prefill) budget, then hands us `read_fn`
    (each call returns up to N bytes, b'' at EOF, raises socket.timeout after `first_token`s of
    silence on the FIRST read). The moment the FIRST non-empty chunk arrives we call
    `set_timeout(idle_timeout)` so every SUBSEQUENT read is bounded by the smaller inter-token idle
    budget instead — a model that streamed one token then froze is cut in `idle_timeout`s, not the
    much larger prefill budget. `on_chunk(bytes)` accumulates (or forwards) each chunk. Returns the
    total number of bytes drained. socket.timeout is re-raised so the caller aborts/retries — this is
    pure control flow (no network), unit-tested in test_adapter_util.py.
    """
    first = True
    total = 0
    while True:
        piece = read_fn()
        if not piece:
            return total
        if first:
            first = False
            set_timeout(idle_timeout)
        on_chunk(piece)
        total += len(piece)


def clamp_max_tokens(requested, context_window, prompt_tokens, safety=4096, floor=1):
    """Dynamic clamp: never let the output budget overflow the window. Returns the max_tokens to send,
    or None when the window is unknown (leave the request untouched)."""
    if not context_window or prompt_tokens < 0:
        return None
    room = context_window - prompt_tokens - safety
    room = max(floor, room)
    if not isinstance(requested, int) or requested <= 0:
        return room
    return min(requested, room)


def dump_last_request(obj, path):
    """Phase-0 context audit tap (Context OS design, section 9): atomically write the
    LAST chat-completions request body to `path` so `context_audit.py analyze` can produce the
    per-layer token breakdown from the REAL wire. Atomic replace so a concurrent reader never
    sees a torn file. Never raises — auditing must never break a live request."""
    if not path:
        return False
    try:
        import os as _os
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(obj, f, ensure_ascii=False)
        _os.replace(tmp, path)
        return True
    except Exception:
        return False
