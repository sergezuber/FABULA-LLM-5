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


def compare_and_store(state, lock, key, prefix, floor=2000, thresh=0.98):
    """Like `update_prefix_and_check`, but ALSO returns the previous prefix — read inside the same
    critical section as the compare-and-store. Reading it separately lets a concurrent same-model request
    swap the baseline in between, so the logged CAUSE could describe a different comparison than the
    logged NUMBERS. Returns (prev, break_descriptor_or_None)."""
    with lock:
        prev = state.get(key)
        state[key] = prefix
    if not prefix or not prev:
        return prev, None
    shared = shared_prefix_len(prev, prefix)
    small = min(len(prev), len(prefix))
    if small > floor and shared / small < thresh:
        return prev, (shared, len(prefix), 100.0 * shared / small)
    return prev, None


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


# ─────────────────────────────────────────────────────────────────────────────────────────────────
# W5 — prefill/cache. Four mechanisms, all keyed on the request bytes or on measured timing and never
# on which model is in the socket (RULE #14).
# ─────────────────────────────────────────────────────────────────────────────────────────────────
import math
import os
import threading
import time

# --- 1. WHY did the prefix break? (arXiv:2605.05696, Irminsul) ------------------------------------
# Agentic workloads put bit-identical tokens at SHIFTED positions every turn, voiding the prefix cache
# at the first divergent byte. The old telemetry only knew THAT the prefix broke. The two causes need
# opposite responses: a position-shift died on content the server already had and is fixable by
# reordering OUR injections; a content-break is real change and reordering would not help.
_SHIFT_PROBE = 256          # bytes of context used to look for the moved content
_SHIFT_MAX_SCAN = 1 << 20   # how far past the divergence we look — bounds the work on huge prefixes
_SHIFT_MIN_OVERLAP = 32     # below this an "alignment" is a coincidence, not evidence
_SHIFT_MIN_RATIO = 0.5      # ...and so is a sliver: the moved content must be most of what is below
_SHIFT_MIN_RECOVERED = 256  # a "shift" recovering less than this is noise: reordering could not save
                            # enough prefill to matter, and 49 bytes of ubiquitous JSON boilerplate at a
                            # tail can fake the alignment (found by the independent verifier)


def _aligns(prev, cur, d, s):
    """Does a shift of `s` bytes at the divergence point actually align the two strings? Insertion of s
    means cur[d+s:] is prev[d:]; removal (s<0) is the mirror. Compared over the OVERLAP only, so a shift
    that co-occurs with tail growth — the shape that actually happens between two real turns — still
    verifies."""
    if s > 0:
        a, b = cur[d + s:], prev[d:]
    elif s < 0:
        a, b = cur[d:], prev[d - s:]
    else:
        return False
    n = min(len(a), len(b))
    if n < _SHIFT_MIN_OVERLAP or a[:n] != b[:n]:
        return False
    # A 49-byte JSON tail ('", "role": "assistant", ...') occurs everywhere; matching it after skipping
    # 6KB of genuinely different content is a coincidence, not a shift. Real moved content is the bulk of
    # what lies below the divergence.
    below = min(len(prev) - d, len(cur) - d)
    if n < _SHIFT_MIN_RECOVERED:
        return False
    return below <= 0 or n >= max(_SHIFT_MIN_OVERLAP, _SHIFT_MIN_RATIO * below)


def classify_break(prev, cur):
    """Classify a prefix divergence. PURE and stateless — the adapter is a ThreadingHTTPServer, so a
    classifier holding state would pass a single-threaded test and lie in production.

    Returns a dict carrying the class and its evidence:
      cls="growth"          the previous prefix is a proper prefix of the current one (healthy: the
                            conversation grew). NEVER a break.
      cls="unchanged"       identical. Not a break.
      cls="shrink"          the current prefix is a proper prefix of the previous one (compaction, a
                            tool-mask change). The server's cache still covers all of it: not a break.
      cls="position-shift"  bit-identical content that MOVED, with `shift` = how far (negative =
                            content was removed above). Actionable: this one is ours to fix.
      cls="content-break"   genuine change, no alignment found within the scan budget, or an alignment
                            too small to be evidence (< _SHIFT_MIN_RECOVERED recovered bytes — a short
                            boilerplate tail can coincidentally align, and a shift that would recover
                            almost nothing is not worth acting on either way).
    """
    prev = prev or ""
    cur = cur or ""
    d = shared_prefix_len(prev, cur)
    if d == len(prev) and d == len(cur):
        return {"cls": "unchanged", "divergence": d}
    if d == len(prev):
        return {"cls": "growth", "divergence": d, "added": len(cur) - d}
    if d == len(cur):
        return {"cls": "shrink", "divergence": d, "removed": len(prev) - d}

    # A real divergence. Was the content below it merely moved?
    # Insertion: the previous content reappears further down in `cur`.
    probe = prev[d:d + _SHIFT_PROBE]
    if len(probe) >= _SHIFT_MIN_OVERLAP:
        at = cur.find(probe, d, d + _SHIFT_MAX_SCAN + _SHIFT_PROBE)
        if at > d and _aligns(prev, cur, d, at - d):
            return {"cls": "position-shift", "shift": at - d, "divergence": d,
                    "recovered": min(len(prev) - d, len(cur) - at)}
    # Removal: the current content appears further down in `prev`.
    probe = cur[d:d + _SHIFT_PROBE]
    if len(probe) >= _SHIFT_MIN_OVERLAP:
        at = prev.find(probe, d, d + _SHIFT_MAX_SCAN + _SHIFT_PROBE)
        if at > d and _aligns(prev, cur, d, -(at - d)):
            return {"cls": "position-shift", "shift": -(at - d), "divergence": d,
                    "recovered": min(len(cur) - d, len(prev) - at)}
    return {"cls": "content-break", "divergence": d}


# --- 2. Which of OUR injections moved the stable content? -----------------------------------------
# A block is VOLATILE when it changes every turn (steers, system-reminders, tool results, timestamps).
# Anything volatile sitting ABOVE stable content shifts every stable token below it — the position-shift
# cause we can actually remove. Classification is by CONTENT, not by role or index: this codebase has
# shipped a per-turn steer INSIDE the system block, which a role-only audit cannot see.
_VOLATILE_MARKERS = (
    "<system-reminder>", "auto-rewind", "⚠️", "reproduce-first gate", "change-quiz gate",
    "verify_done result",
)
_VOLATILE_RE = re.compile(
    r"<system-reminder>|auto-rewind|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|"
    r"^\s*(gate|steer):", re.I | re.M)


def _block_text(m):
    if isinstance(m, dict):
        c = m.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
        return json.dumps(m, ensure_ascii=False)
    return str(m)


# Roles whose content is regenerated every turn regardless of what it says. Role and content are BOTH
# needed: a role-only audit misses a per-turn steer planted inside the system block (this codebase has
# shipped exactly that), and a content-only audit misses a replayed tool result that happens to use
# none of the marker words.
_VOLATILE_ROLES = ("tool", "function", "tool_result")


def _is_volatile(text, role=None):
    if role and str(role).strip().lower() in _VOLATILE_ROLES:
        return True
    t = (text or "").lower()
    if _VOLATILE_RE.search(text or ""):
        return True
    return any(mk in t for mk in _VOLATILE_MARKERS)


def injection_order_report(body):
    """Report every VOLATILE block injected into the STABLE HEAD — the run of structural messages before
    the conversation proper begins (system prompt, curated memory, replayed context). That head is what
    must stay byte-stable across turns; a per-turn injection inside it shifts every stable token below.

    SCOPE, deliberately narrow: once the real conversation has started, volatile and stable content
    interleave by nature and flagging that is noise, not a finding. A volatile block at the very TOP is
    still an offender — the fix is to move it BELOW the stable content, not above it.

    NOTE: `tools[]` is not examined. `stable_prefix` includes it, but tool schemas are a separate field
    with no ordering relative to messages, so this audit makes no claim about them.

    Pure: no I/O, no state, and the input is never mutated."""
    msgs = (body or {}).get("messages") or [] if isinstance(body, dict) else []
    blocks = []
    for i, m in enumerate(msgs):
        text = _block_text(m)
        role = (m.get("role") if isinstance(m, dict) else None) or ""
        blocks.append({"index": i,
                       "role": role,
                       "volatile": _is_volatile(text, role),
                       "text": text})
    # The stable head ends at the first genuine conversation turn. Everything after that is ordinary
    # interleaving, not an ordering bug.
    head_end = len(blocks)
    for b in blocks:
        if str(b["role"]).strip().lower() in ("user", "assistant"):
            head_end = b["index"]
            break
    body_blocks = blocks[:head_end]
    offenders = []
    for b in body_blocks:
        stable_below = [x for x in body_blocks if x["index"] > b["index"] and not x["volatile"]]
        if b["volatile"] and stable_below:
            excerpt = b["text"].strip().replace("\n", " ")[:160]
            offenders.append({
                "index": b["index"],
                "role": b["role"],
                "excerpt": excerpt,
                "text": b["text"],
                "stable_blocks_below": len(stable_below),
                "shifted_bytes": sum(len(x["text"]) for x in stable_below),
            })
    return {
        "offenders": offenders,
        "entries": offenders,
        "blocks": len(blocks),
        "clean": not offenders,
    }


# --- 3. Admission control (arXiv:2512.23029) ------------------------------------------------------
# Our serving class (quantized MoE on consumer hardware) matches cloud latency at low concurrency and
# collapses under concurrent users, dominated by prefill. Every FABULA session, background pass and
# witness call funnels through this one adapter, so this is the only place that can serialize them.
#
# THE OVERRIDING CONSTRAINT: a gate that blocks is worse than no gate at all — it would wedge the live
# app. So every degenerate path admits: limit<=0 is UNLIMITED, a wait that exceeds the budget ADMITS
# (fail-open), a re-entrant acquire from a thread that already holds a slot ADMITS (it can never
# deadlock against itself), and a fail-open admission returns NO permit so the cap cannot silently
# inflate from leaked releases.
class Admission:
    """The handle a caller holds while it occupies (or is deemed to occupy) a slot. Doubles as a context
    manager so the release cannot be forgotten on an early return or an exception."""

    def __init__(self, gate, wait=0.0, held=True, fail_open=False, reentrant=False):
        self.gate = gate
        self.wait = float(wait)
        self.wait_seconds = float(wait)
        self.held = bool(held)
        self.fail_open = bool(fail_open)
        self.reentrant = bool(reentrant)
        self._released = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()
        return False

    def release(self):
        if self._released:
            return          # idempotent: a double release must never hand out a phantom permit
        self._released = True
        self.gate._release(self)


class AdmissionGate:
    """Cap on CONCURRENT upstream requests. Excess callers queue FIFO."""

    def __init__(self, limit=1, wait_timeout=300.0):
        try:
            self._limit = int(limit)
        except (TypeError, ValueError):
            self._limit = 1
        self._wait_timeout = wait_timeout
        self._cv = threading.Condition()
        self._active = 0
        self._waiting = 0
        self._next_ticket = 0
        self._now_serving = 0
        self._depths = {}          # thread-id -> reentrancy depth (cv-guarded; threading.local cannot
                                   # be cleared cross-thread, which silently uncapped a released thread)
        self.admitted = 0
        self.queued = 0
        self.fail_opens = 0
        self.max_depth = 0
        self.total_wait = 0.0

    # -- introspection the telemetry line reads -----------------------------------------------------
    @property
    def limit(self):
        return self._limit

    @property
    def queue_depth(self):
        with self._cv:
            return self._waiting

    @property
    def active(self):
        with self._cv:
            return self._active

    def stats(self):
        with self._cv:
            return {"limit": self._limit, "queue_depth": self._waiting, "active": self._active,
                    "admitted": self.admitted, "queued": self.queued, "fail_opens": self.fail_opens,
                    "max_queue_depth": self.max_depth, "total_wait_seconds": round(self.total_wait, 3)}

    # -- admission ----------------------------------------------------------------------------------
    def acquire(self, timeout=None, on_wait=None):
        """Occupy a slot, queueing FIFO if the cap is reached. Returns an `Admission` (also a context
        manager). NEVER raises for capacity reasons and never returns None: the caller always proceeds.
        `on_wait(waited_seconds)` is called roughly once a second while queued, so a streaming caller
        can emit keepalives instead of looking dead."""
        if self._limit <= 0:
            return Admission(self, 0.0, held=False)            # unlimited: degenerate setting is the safe one
        tid = threading.get_ident()
        with self._cv:
            if self._depths.get(tid, 0):
                self._depths[tid] += 1
                a = Admission(self, 0.0, held=False, reentrant=True)  # cannot deadlock against itself
                a.tid = tid
                return a

        budget = self._wait_timeout if timeout is None else timeout
        started = time.monotonic()
        with self._cv:
            ticket = self._next_ticket
            self._next_ticket += 1
            self._waiting += 1
            self.max_depth = max(self.max_depth, self._waiting)
            if ticket > self._now_serving or self._active >= self._limit:
                self.queued += 1
            try:
                while self._active >= self._limit or ticket != self._now_serving:
                    waited = time.monotonic() - started
                    if budget is not None and waited >= budget:
                        # FAIL OPEN. Proceed WITHOUT a permit: releasing this admission must not add
                        # capacity the gate never had, or the cap decays with every timeout.
                        self.fail_opens += 1
                        self._now_serving = max(self._now_serving, ticket + 1)
                        self._cv.notify_all()
                        self.total_wait += waited
                        return Admission(self, waited, held=False, fail_open=True)
                    slice_ = 1.0 if budget is None else max(0.01, min(1.0, budget - waited))
                    self._cv.wait(slice_)
                    if on_wait is not None:
                        # OUTSIDE the lock: on_wait writes to a client socket, which can block for an
                        # unbounded time if that client stopped reading. Holding the condition across it
                        # would wedge every other acquire, release and telemetry read on this adapter.
                        self._cv.release()
                        try:
                            on_wait(time.monotonic() - started)
                        except Exception:
                            pass          # a keepalive failure must never break admission
                        finally:
                            self._cv.acquire()
            finally:
                self._waiting -= 1
            self._active += 1
            self._now_serving = max(self._now_serving, ticket + 1)
            self.admitted += 1
            waited = time.monotonic() - started
            self.total_wait += waited
            self._depths[tid] = 1
            adm = Admission(self, waited, held=True)
            adm.tid = tid
            return adm

    # alias so a caller can `with gate.slot():`
    def slot(self, timeout=None, on_wait=None):
        return self.acquire(timeout=timeout, on_wait=on_wait)

    def _release(self, admission):
        tid = getattr(admission, "tid", None)
        if getattr(admission, "reentrant", False):
            with self._cv:
                if tid is not None and self._depths.get(tid, 0):
                    self._depths[tid] -= 1
            return
        if not getattr(admission, "held", False):
            return          # fail-open / unlimited: no permit was taken, so none is returned
        with self._cv:
            self._active = max(0, self._active - 1)
            if tid is not None:
                self._depths.pop(tid, None)   # keyed by the ACQUIRER's tid: cross-thread release works
            self._cv.notify_all()

    def release(self):
        """Release the slot held by THIS thread (for callers that kept no handle)."""
        tid = threading.get_ident()
        with self._cv:
            if self._depths.pop(tid, None):
                self._active = max(0, self._active - 1)
                self._cv.notify_all()


# --- 4. A measured idle budget, not a constant (arXiv:2603.22016's measurement lesson) -------------
# A flat 120s cannot separate "a legitimately slow prefill on a big prompt" from "a wedged stream".
# Neither is a model problem: it is the harness measuring nothing. So measure — per model AND per
# prompt-size bucket, because a fast small-prompt key's evidence must never bound a big prefill.
#
# The budget is a FLOOR over the observed window, not a smoothed quantile: killing a legitimately slow
# prefill is a worse failure than a slow abort, so the largest gap actually seen is a lower bound.
class IdleBaseline:
    def __init__(self, flat=None, min_samples=50, window=200, floor=None, ceiling=None, margin=4.0,
                 enabled=None):
        self.flat = float(os.environ.get("FABULA_STREAM_IDLE_TIMEOUT", "120")) if flat is None else float(flat)
        self.min_samples = int(min_samples)
        self.window = int(window)
        # The idle budget's LOWER bound. It is the pause the watchdog will always tolerate between
        # tokens even once the measured evidence says the model is usually fast. It matters most for a
        # REASONING model: it emits a reasoning block, then goes SILENT for many seconds while it plans
        # the next step (or the first answer token) — a legitimate pause the byte-level watchdog cannot
        # tell from a hang. With the floor too low that pause is cut mid-turn (finish=other, a truncated
        # reasoning-only step that then looks like a think-only stall), AND the pause is never recorded,
        # so `observed_max` can never grow to cover it — self-reinforcing. A floor at/near `flat` lets
        # the first real pause survive and be measured, after which the budget adapts upward on its own.
        # Env-tunable per install (heavy-context reasoning models want it high); default keeps history.
        self.floor = float(os.environ.get("FABULA_IDLE_FLOOR", "30")) if floor is None else float(floor)
        self.ceiling = float(ceiling) if ceiling is not None else float(
            os.environ.get("FABULA_IDLE_CEILING", str(max(600.0, self.flat * 5))))
        self.margin = float(margin)
        if enabled is None:
            enabled = os.environ.get("FABULA_IDLE_BASELINE", "1").strip().lower() not in ("0", "false", "off")
        self.enabled = bool(enabled)
        self.max_keys = 256
        self._samples = {}
        self._lock = threading.Lock()

    @staticmethod
    def bucket(size):
        """Coarse prompt-size buckets. A 1KB prompt and a 250KB prompt are different physics; lumping
        them lets small-prompt evidence bound a big prefill."""
        try:
            n = int(size or 0)
        except (TypeError, ValueError):
            n = 0
        return 0 if n <= 0 else int(math.floor(math.log2(max(1, n))))

    def key(self, model, size, warm=True):
        # WARM is part of the key, not a detail. Buckets already separate prompt SIZE because "a 1KB
        # prompt and a 250KB prompt are different physics" — and a COLD turn and a WARM turn of the SAME
        # size are different physics for exactly the same reason: with the prefix reused the server
        # streams from cache, without it every token waits behind a full re-prefill. Mixing them let a
        # bucket fill with fast warm gaps, so `observed_max * margin` fell under the floor and the first
        # cold turn was cut by it. Measured on the live adapter: 48 of 96 terminated streams fired at
        # exactly the 30.0s floor — half of all cuts were healthy streams killed by evidence gathered
        # from turns of a different kind. Warmth is taken from compare_and_store's OWN break signal, so
        # there is one definition of "the prefix did not survive", not two.
        return (str(model or ""), self.bucket(size), bool(warm))

    def observe(self, model, size, gap, warm=True):
        """Record one observed gap. Non-finite or non-positive values are not evidence."""
        try:
            g = float(gap)
        except (TypeError, ValueError):
            return self
        if not math.isfinite(g) or g <= 0:
            return self
        with self._lock:
            k = self.key(model, size, warm)
            if k not in self._samples and len(self._samples) >= self.max_keys:
                self._samples.pop(next(iter(self._samples)), None)   # bounded: never grows unbounded
            buf = self._samples.setdefault(k, [])
            buf.append(g)
            if len(buf) > self.window:
                del buf[:-self.window]
        return self

    # aliases the adapter and tests may use
    record = observe
    add = observe

    def budget(self, model, size=0, warm=True):
        """The idle budget for this key. Querying NEVER mutates state. Cold start (and the kill-switch)
        return exactly today's flat constant — the honest answer when nothing has been measured."""
        if not self.enabled:
            return self.flat
        with self._lock:
            buf = list(self._samples.get(self.key(model, size, warm), ()))
        if len(buf) < self.min_samples:
            return self.flat
        observed_max = max(buf)
        value = max(self.floor, observed_max * self.margin)
        value = min(value, self.ceiling)
        # never tighter than the evidence, whatever the clamps say
        return max(value, observed_max)

    # aliases
    timeout_for = budget
    budget_for = budget

    def stats(self):
        with self._lock:
            return {k: len(v) for k, v in self._samples.items()}
