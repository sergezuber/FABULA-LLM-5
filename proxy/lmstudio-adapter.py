#!/usr/bin/env python3
"""
FABULA ↔ LM Studio compatibility adapter (localhost:1235 -> LM Studio :1234).

Two transparent translations that make /goal (and any generateObject/structured
call) work against LM Studio's MLX engine — WITHOUT disabling any functionality:

  1. response_format {type:"json_object"}  ->  {type:"json_schema", json_schema:{Verdict}}
     The Vercel AI SDK emits the legacy OpenAI "json_object" mode for generateObject,
     but LM Studio only accepts 'json_schema' or 'text' (returns HTTP 400 otherwise).

  2. reasoning-model structured output:  if a NON-streaming response has empty
     `content` but `reasoning_content` holds the JSON, copy it into `content` so the
     AI SDK can parse the object. (some reasoning models route json_schema output
     into the reasoning channel.)

  3. reasoning-level control (declarative): a data table `proxy/reasoning-map.json` keyed by
     model → level → apiKind maps each reasoning level to concrete request-body patches
     ({set:[{path,value}], unset:[{path}]}, path = JSON-pointer-as-list). The level is chosen
     per request via the `X-Fabula-Reasoning` header, the body's `extra_body.fabula_reasoning`,
     or the `FABULA_REASONING_LEVEL` env default. Adding a model/knob is a config edit, not code.

  4. stall watchdog: streaming reads carry a per-read *inactivity* timeout
     (FABULA_STREAM_IDLE_TIMEOUT). A stalled upstream (reasoning spiral / prefill hang
     emitting zero tokens) is aborted after that many idle seconds instead of wedging the
     agent turn for minutes — retried once if it stalls before the first byte, else the SSE
     stream is ended cleanly so the caller moves on. Optional FABULA_MAX_OUTPUT_TOKENS caps
     runaway generation. This is the harness protecting the run from the model, at the one
     transport choke-point all traffic passes through.

Streaming chat responses (request "stream": true) are passed through token-by-token (now
watchdog-guarded); only non-streaming JSON responses are additionally inspected/transformed.

Verified end-to-end: multi-turn agent loops (structured judge calls included) run
cleanly through this adapter.
"""
import errno
import json
import os
import select
import socket
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# MUST RUN BEFORE ANY os.environ.get BELOW. This block used to sit at line ~140 while constants were
# read at lines ~50-120 — Python executes top-down, so DUMP_LAST_REQUEST, CONTEXT_WINDOW and
# MAX_CONCURRENT_UPSTREAM read the environment BEFORE .env was loaded and silently ignored it: the exact
# unreachable-kill-switch class W5 documented, reintroduced for every constant above the load site.
# Found live: FABULA_DUMP_LAST_REQUEST set in .env, adapter restarted, dump never written.
# The adapter is started by a LaunchAgent, which passes NO environment of its own — so every knob below
# would silently be a code default and the documented kill-switches would be unreachable in production
# (found on review: the running process had zero FABULA_* vars). Load the repo `.env` first, letting a real
# environment variable win, so `.env` is the single place the docs can honestly point at.
def _load_dotenv(path):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                if k and k not in os.environ:
                    os.environ[k] = v.strip().strip('"').strip("'")
    except OSError:
        pass          # no .env is normal (fresh clone); never fail startup over it


_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, ".env"))


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from toolcall_text import parse_text_tool_calls, as_openai_tool_calls
from adapter_util import (
    stable_prefix, shared_prefix_len, classify_overflow, clamp_max_tokens, drain_with_idle_split,
    update_prefix_and_check, compare_and_store, dump_last_request, estimate_tokens,
    classify_break, injection_order_report, AdmissionGate, IdleBaseline,
    DegenerationDetector, sse_delta_content,
)

# Optional context window for the dynamic max_tokens clamp (0 = off). When set, every request's
# max_tokens is fitted to the remaining window so a tool call can't truncate mid-arguments (§3p2 prevention).
CONTEXT_WINDOW = int(os.environ.get("FABULA_CONTEXT_WINDOW", "0"))

# ── The window is a PROPERTY OF THE LOADED MODEL, so it is asked for, not configured ───────────────────
#
# Pinning it in .env was wrong twice over. It is a constant where FABULA is meant to derive: swap the
# model, change the load config, and a number typed yesterday silently governs today's traffic. And it is
# the wrong number the moment either changes — measured 2026-07-25, a model serving 65536 tokens was fed a
# 67850-token prefix and the serving process died mid-generation ("The model has crashed (Exit code:
# null)" in the app, ConnectionResetError here), because nothing in the loop knew what the real ceiling
# was. LM Studio publishes it per loaded model; asking costs one cached call per model id.
_WINDOW_CACHE = {}

_WINDOW_NOTED = {}

def note_window_shortfall(model_id):
    """OBSERVE ONLY — the adapter never reloads a model, and that restraint is the design.

    It sees every request, so it is the natural place to notice "loaded below what this model supports".
    Acting on it here would be wrong twice over. The ceiling moves as memory frees and fills, so a
    per-request comparison would reload, and reload again — and each reload throws away the whole prefix
    cache, costing every live conversation a full re-prefill measured in minutes. And the owner may have
    chosen that smaller window deliberately; a background actor silently overruling an owner's setting is
    the exact class of defect this project already closed in its supervision stores.

    So: one line in the log, at most once an hour per model, and nothing else.
    """
    import time as _t
    try:
        info = _model_info(model_id)
        if not info:
            return
        loaded, passport = info
        if not (loaded > 0 and passport > loaded):
            return
        last = _WINDOW_NOTED.get(model_id, 0)
        if _t.time() - last < 3600:
            return
        _WINDOW_NOTED[model_id] = _t.time()
        sys.stderr.write(
            "[fabula-adapter] WINDOW-SHORTFALL model=%s loaded=%d supports=%d "
            "(observed only; the app's model switch is what sets windows)\n"
            % (model_id, loaded, passport))
    except Exception:
        pass


_CEILING_NOTED = {}


def note_context_near_ceiling(model_id, est_tokens):
    """OBSERVE ONLY — a request that is about to ask for more context than the model was loaded to hold.

    THE GAP THIS FILLS, and why it is a log rather than a refusal. Nothing anywhere checks a request's
    SIZE against the window: `derived_output_cap` clamps how much may be GENERATED, never how much
    arrives. So a prompt larger than the loaded window goes upstream unchallenged, and the recorded
    failure mode is not a clean rejection — it is the serving process dying mid-generation, which the
    caller sees as a connection reset and reads as a hang.

    It stays an observation on purpose. Refusing needs a number to refuse against, and the number here
    is an ESTIMATE from characters; the measured spread between this project's own char-per-token
    figures was 52%, which at this window is several gigabytes of cache either way. A refusal with that
    error bar would fire on exactly the long-corpus turns this project exists to make work, and a turn
    killed by a guard is worse than the thing being guarded. First the evidence, then — if the evidence
    says so — the gate.

    Rate-limited to once an hour per model, like the shortfall note beside it: a line printed on every
    request is a line nobody reads.
    """
    import time as _t
    try:
        if not (est_tokens > 0):
            return
        # The CACHED accessor, not a fresh lookup. This runs inside the request handler, and a
        # synchronous call out to the serving API from there is a network round trip on the hot path —
        # measured: the note never appeared on a real oversized request, because the lookup did not
        # return in time and the guard's own except-pass hid it. `loaded_window` answers from a TTL
        # cache and reports 0 for "unknown", which this treats as nothing to say.
        loaded = loaded_window(model_id)
        if not (loaded > 0) or est_tokens < loaded * 0.9:
            return
        last = _CEILING_NOTED.get(model_id, 0)
        if _t.time() - last < 3600:
            return
        _CEILING_NOTED[model_id] = _t.time()
        # sys.stderr, like every other line this adapter emits. It was `log(...)` — a name that does
        # not exist in this module, so the call raised NameError straight into the surrounding
        # `except: pass`. The sibling note below had the same line and has therefore never printed
        # once since it shipped: a telemetry that cannot speak looks exactly like a quiet machine.
        sys.stderr.write(
            "[fabula-adapter] CONTEXT-NEAR-CEILING model=%s estimated=%d loaded_window=%d "
            "(estimate from characters; observed only, the request was not touched)\n"
            % (model_id, est_tokens, loaded))
    except Exception:
        pass


def _model_info(model_id):
    """(loaded_window, passport) for a model, or None. Read fresh — never a remembered figure."""
    import urllib.request as _u, json as _j
    api = os.environ.get("FABULA_MODEL_API", "http://localhost:1234/api/v0/models")
    try:
        with _u.urlopen(api, timeout=1.5) as r:
            for m in (_j.loads(r.read().decode()) or {}).get("data", []):
                if m.get("id") == model_id:
                    return int(m.get("loaded_context_length") or 0), int(m.get("max_context_length") or 0)
    except Exception:
        return None
    return None


def effective_context_window(model_id):
    """The window to judge an overflow against — ASKED FOR, not configured.

    MEASURED 2026-08-01: `grep -c CONTEXT-OVERFLOW adapter.err.log` returned 0 across 564 KB of log,
    alongside 72 live `BUDGET … OVER` lines, so the classification had never once fired. The cause was
    not the classifier — handed a real window it correctly returns `silent-truncation-length` and
    `silent-overflow-accepted` — but its INPUT: the call site read `FABULA_CONTEXT_WINDOW`, and that
    variable is set nowhere. Not in `.env`, not in the LaunchAgent plist, not in the running process
    (`ps eww 1039` → 0 hits, `os.environ.get` → None). With 0 both silent branches return "" and only the
    explicit HTTP>=400 case can be detected — i.e. the two failures the detector exists FOR were the two
    it could not see.

    The window is not a thing an operator should have to type in the first place: the serving runtime
    reports it, this file already reads it for the clamp, and a typed number goes stale the moment a model
    is reloaded. An explicit FABULA_CONTEXT_WINDOW still wins, for a runtime that cannot be asked.
    """
    try:
        env = int(os.environ.get("FABULA_CONTEXT_WINDOW", "0") or 0)
    except Exception:
        env = 0
    if env > 0:
        return env
    try:
        return loaded_window(model_id) or 0
    except Exception:
        return 0


def loaded_window(model_id, timeout=1.5):
    """The serving window of `model_id` as the server itself reports it. 0 when it cannot be learned —
    every caller must treat 0 as "unknown" and fall back, never as "no room"."""
    if not model_id:
        return 0
    # Cached with a TTL, not forever: a model reload changes the answer, and a permanent cache is the same
    # staleness this function exists to remove (measured — reloaded 65536 -> 262144 and the adapter kept
    # clamping against the old figure until restarted by hand).
    import time as _t
    ent = _WINDOW_CACHE.get(model_id)
    if ent and _t.time() - ent[1] < 60:
        return ent[0]
    win = 0
    try:
        import urllib.request as _u
        base = UPSTREAM.rsplit("/v1", 1)[0] if "/v1" in UPSTREAM else UPSTREAM
        with _u.urlopen(base + "/api/v0/models", timeout=timeout) as r:
            for m in (json.loads(r.read().decode("utf-8", "replace")).get("data") or []):
                if m.get("id") == model_id and m.get("state") == "loaded":
                    win = int(m.get("loaded_context_length") or 0)
                    break
    except Exception:
        win = 0  # fail OPEN: an unknown window must never be mistaken for a full one
    if win > 0:
        _WINDOW_CACHE[model_id] = (win, _t.time())
    return win

def effective_window(model_id):
    """An explicit override still wins — someone pinning it knows something we do not. Otherwise ask."""
    note_window_shortfall(model_id)  # observe only; this function never reloads anything
    return CONTEXT_WINDOW if CONTEXT_WINDOW > 0 else loaded_window(model_id)

# The share of a window a generation may claim when the request is small — a starting point, not a rule.
# Written down because it is a judgement (how much of an empty window one answer deserves), while the
# figure that actually governs is computed below from what the request leaves free.
OUTPUT_SHARE_OF_EMPTY_WINDOW = 0.25


def derived_output_cap(model_id, input_tokens=0):
    """How much room a single generation may claim.

    A WINDOW HOLDS THE REQUEST AND THE ANSWER TOGETHER, and the serving runtime reserves both at once.
    Measured 2026-07-28: an input of 133 385 tokens fit comfortably inside a 135 168 window — and the
    request still asked for a quarter of that window on top, 33 792 more, so 167 177 was demanded of a
    135 168 machine. It died allocating, and what the reader saw was "the model has crashed". Every part
    was individually reasonable: the input fit, the share was modest, nobody added them up.

    So the ceiling is what the request LEAVES FREE, less a margin, and the fixed share applies only while
    there is room to spare. 0 (unknown window, no override) still means no clamp, exactly as before.
    """
    if MAX_OUTPUT_TOKENS > 0:
        return MAX_OUTPUT_TOKENS
    w = effective_window(model_id)
    if not (w > 0):
        return 0
    share = max(1024, int(w * OUTPUT_SHARE_OF_EMPTY_WINDOW))
    if not (input_tokens > 0):
        return share
    # A tokenizer estimate is never exact, and a runtime keeps a little for itself; leave a tenth of the
    # window unclaimed so being slightly wrong costs a shorter answer rather than a dead server.
    free = int(w - input_tokens - w * 0.1)
    if free < 256:
        return 256          # something must be generatable, or the turn cannot even report the problem
    return min(share, free)

# Phase-0 context audit tap (Context OS §9): when set to a file path, the adapter atomically
# writes the LAST /chat/completions request body there so context_audit.py can compute the
# per-layer token breakdown from the real wire. Off by default (empty).
DUMP_LAST_REQUEST = os.environ.get("FABULA_DUMP_LAST_REQUEST", "")

# Per-model stable-prefix for cache-diff telemetry (in-memory, best-effort). See adapter_util.
# ThreadingHTTPServer handles requests on many threads; _PREFIX_LOCK makes the compare-and-store atomic.
_PREFIX_STATE = {}
_PREFIX_LOCK = threading.Lock()

# W5 admission control (arXiv:2512.23029): this serving class collapses under concurrent prefill, and
# every session/background pass/witness call funnels through this one adapter. 0 = UNLIMITED (the
# degenerate setting must be the SAFE one); a wait longer than the budget ADMITS anyway (fail-open) —
# a gate that blocks is worse than no gate, because it would wedge the live app.
MAX_CONCURRENT_UPSTREAM = int(os.environ.get("FABULA_MAX_CONCURRENT_UPSTREAM", "1") or 1)
# How long a queued caller may wait before the gate FAILS OPEN and lets it through. ONE number for every
# caller was wrong, and measurably so: a STREAMING caller is kept alive by SSE keepalives and can safely
# wait a long time, while a NON-STREAMING caller (the goal judge, embeddings, /v1/models) sits in total
# silence and must not. With a single 60s ceiling and ~30s generations, 3 of 5 parallel workflow-graph
# steps failed open and hit the model together — the gate degrading precisely under the load it exists
# for. So the ceiling splits by what the caller can survive.
def _positive(value, fallback):
    """A ceiling must always be a usable positive number: garbage in the environment falls back rather
    than disabling the gate or blocking forever."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return fallback
    return v if v == v and v > 0 and v != float("inf") else fallback


# Resolved at import, like every other knob here, because that is when this process reads its config.
ADMIT_WAIT_MAX = _positive(os.environ.get("FABULA_ADMIT_WAIT_MAX"), 60.0)                    # silent caller
ADMIT_WAIT_MAX_STREAM = max(
    ADMIT_WAIT_MAX, _positive(os.environ.get("FABULA_ADMIT_WAIT_MAX_STREAM"), 300.0)
)                                                                                            # keepalive-able


def admit_wait_max(is_stream=False, env=None):
    """How long may THIS caller wait for its slot?

    A STREAMING caller receives `: fabula-adapter queued Ns` keepalives while it waits, so a long wait is
    visible and survivable. A SILENT caller (the goal judge, embeddings, /v1/models) has no such channel:
    every second it waits is a second it cannot distinguish from a hang, so its ceiling stays exactly
    where it was before this split and never rises above it.

    One number for both was measurably wrong: with a 60s ceiling and ~30s generations, 3 of 5 parallel
    workflow-graph steps failed open and hit the model together — the gate degrading precisely under the
    load it exists for.
    """
    if env is None:
        return ADMIT_WAIT_MAX_STREAM if is_stream else ADMIT_WAIT_MAX
    silent = _positive(env.get("FABULA_ADMIT_WAIT_MAX"), 60.0)
    if not is_stream:
        return silent
    return max(silent, _positive(env.get("FABULA_ADMIT_WAIT_MAX_STREAM"), 300.0))
_ADMISSION = AdmissionGate(MAX_CONCURRENT_UPSTREAM, wait_timeout=ADMIT_WAIT_MAX)  # per-caller ceiling passed per acquire
# W5 measured idle budget: replaces the flat constant once a key has enough evidence of its own.
_IDLE = IdleBaseline(flat=float(os.environ.get("FABULA_STREAM_IDLE_TIMEOUT", "120")))
# Kill-switch for the READ-ONLY half (break classification + injection audit). Off = the pre-W5 line,
# byte-for-byte, so the mechanism can be removed from the picture without removing the telemetry.
CACHE_BREAK_CLASSIFY = os.environ.get("FABULA_CACHE_BREAK_CLASS", "1").strip().lower() not in ("0", "false", "off")

UPSTREAM = os.environ.get("UPSTREAM", "http://localhost:1234")
PORT = int(os.environ.get("ADAPTER_PORT", "1235"))

# ── stall watchdog (FIX 4): a single LLM call must never wedge a turn for minutes ──
# Local reasoning models can spiral / the prefill can stall, emitting ZERO tokens for
# many minutes until the caller's own timeout kills the whole task. A per-read socket
# timeout is an *inactivity* timeout: while tokens flow it never fires; N seconds of
# silence aborts the read. Tune generously above worst-case prefill-to-first-token
# (a ~67k-context step) but far below any minutes-long hang.
# TWO budgets (split): the prefill-to-first-token wait on a big-context step is legitimately long, but
# once tokens flow a gap that long means a spiral/hang. FIRST_TOKEN_TIMEOUT bounds the wait for the
# FIRST byte; STREAM_IDLE_TIMEOUT (smaller) bounds every gap AFTER the first byte. Applies to BOTH the
# streaming and the non-streaming path (the non-streaming read used to be a single 900s socket timeout
# — a stalled upstream mid-body wedged the turn for the full 15 min; now it is idle-watchdogged too).
FIRST_TOKEN_TIMEOUT = float(os.environ.get("FABULA_FIRST_TOKEN_TIMEOUT", "300")) # sec to the FIRST byte (prefill) -> abort
STREAM_IDLE_TIMEOUT = float(os.environ.get("FABULA_STREAM_IDLE_TIMEOUT", "120"))  # sec of zero bytes AFTER first -> abort read
STREAM_RETRIES = int(os.environ.get("FABULA_STREAM_RETRIES", "1"))               # retry once if it stalls before the 1st byte
# How long to wait out an upstream that reports the session busy (HTTP 409) before surfacing it.
# Seconds; 0 disables the wait and restores the pre-change behaviour exactly.
BUSY_RETRY_WINDOW = float(os.environ.get("FABULA_BUSY_RETRY_WINDOW", "60"))
# The client identity we declare upstream (see _fwd_headers). Empty string disables the header.
CLIENT_HINT = os.environ.get("FABULA_CLIENT_HINT", "opencode")

UPSTREAM_TIMEOUT = float(os.environ.get("FABULA_UPSTREAM_TIMEOUT", "900"))        # hard ceiling (fallback; idle watchdog fires first)
MAX_OUTPUT_TOKENS = int(os.environ.get("FABULA_MAX_OUTPUT_TOKENS", "0"))          # >0: clamp request max_tokens (cap runaway)
# This adapter always speaks OpenAI-compatible to LM Studio; the map still keys by apiKind so the
# same table can be reused by other transports.
API_KIND = "openai-compatible"
REASONING_MAP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reasoning-map.json")

# The strict verdict grammar — ONLY for the goal judge, which opts in with the
# `X-Fabula-Schema: verdict` request header. Every OTHER generateObject caller (subagent-from-
# description in agent.ts, the voice plugin, any future structured call) must NOT be forced into
# this shape — see GENERIC_OBJECT_SCHEMA and pick_object_schema below.
VERDICT_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "verdict",
        "strict": False,
        "schema": {
            "type": "object",
            "properties": {
                "ok": {"type": "boolean"},
                "impossible": {"type": "boolean"},
                "reason": {"type": "string"},
            },
            "required": ["ok", "reason"],
            "additionalProperties": False,
        },
    },
}

# Permissive default for legacy `json_object`. LM Studio rejects the bare `json_object` mode (HTTP
# 400), so we must rewrite it to a `json_schema`. The AI SDK sends bare `json_object` for EVERY
# generateObject (the per-caller Zod schema goes in the PROMPT, not response_format), so the adapter
# cannot know the caller's shape — it must therefore grant a permissive "any JSON object" grammar so
# each caller gets valid JSON of ITS OWN shape (validated caller-side by the SDK). Forcing the verdict
# shape here silently broke subagent-creation and voice for any model in the socket (the bug this fixes).
GENERIC_OBJECT_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "object",
        "strict": False,
        "schema": {
            "type": "object",
            "additionalProperties": True,
        },
    },
}

# Callers ask for the strict verdict grammar with `X-Fabula-Schema: verdict`; everything else gets
# the permissive object grammar. Pure so it is unit-testable (proxy/test_object_schema.py).
def pick_object_schema(schema_header):
    if isinstance(schema_header, str) and schema_header.strip().lower() == "verdict":
        return VERDICT_SCHEMA
    return GENERIC_OBJECT_SCHEMA


# ── reasoning-level → request-body patch table (pure, unit-tested) ───────────────────────────
_MAP_CACHE = {"mtime": None, "data": {}}


def load_reasoning_map(path=REASONING_MAP_PATH):
    """Read proxy/reasoning-map.json with an mtime cache. Never raises — a missing/broken map
    just means 'no reasoning patches' (returns {})."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        _MAP_CACHE["mtime"], _MAP_CACHE["data"] = None, {}
        return {}
    if _MAP_CACHE["mtime"] != mtime:
        try:
            with open(path, "r") as f:
                _MAP_CACHE["data"] = json.load(f)
        except Exception:
            _MAP_CACHE["data"] = {}
        _MAP_CACHE["mtime"] = mtime
    return _MAP_CACHE["data"]


def set_path(obj, path, value):
    """Set a nested value; path is a list of keys, creating intermediate dicts as needed."""
    cur = obj
    for key in path[:-1]:
        nxt = cur.get(key)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[key] = nxt
        cur = nxt
    cur[path[-1]] = value


def unset_path(obj, path):
    """Delete a nested key if it exists; no-op otherwise."""
    cur = obj
    for key in path[:-1]:
        cur = cur.get(key)
        if not isinstance(cur, dict):
            return
    cur.pop(path[-1], None)


def resolve_level(headers, body):
    """Pick the reasoning level: X-Fabula-Reasoning header > body.extra_body.fabula_reasoning >
    FABULA_REASONING_LEVEL env > None."""
    if headers is not None:
        h = headers.get("X-Fabula-Reasoning")
        if h:
            return h.strip()
    if isinstance(body, dict):
        eb = body.get("extra_body")
        if isinstance(eb, dict) and eb.get("fabula_reasoning"):
            return str(eb["fabula_reasoning"]).strip()
    env = os.environ.get("FABULA_REASONING_LEVEL")
    return env.strip() if env else None


def apply_reasoning(body, mapping, level, kind=API_KIND):
    """Mutate `body` (a dict) by applying the patch for (model, level, kind) from `mapping`.
    Falls through model → '*'. Missing model/level/kind = body unchanged. Also strips the
    private `extra_body.fabula_reasoning` marker so it never reaches upstream."""
    # strip the marker regardless of whether a patch applies
    eb = body.get("extra_body") if isinstance(body, dict) else None
    if isinstance(eb, dict):
        eb.pop("fabula_reasoning", None)
    if not level or not isinstance(mapping, dict):
        return body
    model = body.get("model") if isinstance(body, dict) else None
    # FALL THROUGH PER LEVEL, not per model.
    #
    # MEASURED 2026-08-01: `mapping.get(model) or mapping.get("*")` picks the model's table if it exists
    # AT ALL, so the `*` table is never consulted for that model — for any level. Executed:
    # `model=qwen3.5 level=off` returned the body UNCHANGED even though `*` defines
    # `off -> set extra_body.thinking.type=disabled`, while the same run with a model that has no entry
    # applied it correctly. The consequence is the opposite of what a fallback is for: adding ONE level
    # for a model silently deletes every OTHER level for it, and the deletion is invisible because a
    # missing patch means "leave the body alone", which looks exactly like success.
    #
    # A level is looked up in the model's own table first and in `*` when the model has nothing to say
    # about that level, which is what "falls through model → '*'" says on the tin.
    entries = [e for e in (mapping.get(model), mapping.get("*")) if isinstance(e, dict)]
    if not entries:
        return body
    patch = None
    for entry in entries:
        per_level = entry.get(level)
        if isinstance(per_level, dict) and isinstance(per_level.get(kind), dict):
            patch = per_level[kind]
            break
    if not isinstance(patch, dict):
        return body
    for op in patch.get("unset", []):
        p = op.get("path") if isinstance(op, dict) else op
        if isinstance(p, list) and p:
            unset_path(body, p)
    for op in patch.get("set", []):
        if isinstance(op, dict) and isinstance(op.get("path"), list) and op["path"]:
            set_path(body, op["path"], op.get("value"))
    return body


def set_read_timeout(resp, seconds):
    """Retune the read (inactivity) timeout of an OPEN urllib response mid-stream — used to drop from
    the FIRST-TOKEN budget to the smaller INTER-TOKEN idle once the first byte has arrived. Best-effort:
    CPython http.client wraps the socket in a BufferedReader over SocketIO; if the internals differ we
    silently keep the open-time budget (the watchdog still fires, just at the larger value)."""
    try:
        sock = getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None)
        if sock is not None:
            sock.settimeout(seconds)
    except Exception:
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _read_body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return self.rfile.read(n) if n else b""

    # WHO WE ARE, DECLARED ONCE. Some runtimes key real behaviour on the client's identity, and a
    # client that declares nothing gets the weakest branch. MTPLX is the measured case: three
    # conditions of its cache policy all require the hint to be exactly "opencode" — with it the
    # cross-session block-prefix restore is enabled UNCONDITIONALLY (mtplx/generation.py
    # `_opencode_compact_tool_history_policy`); without it that path falls back to an env-decided
    # default, so a new session re-prefills its whole prompt. Measured here: ~2.2 misses per task at
    # ~48s each, on prompts two sessions share 94.6% of.
    #
    # This is a statement of fact, not a costume: the engine IS a fork of the OpenCode terminal
    # agent, and the tool contract and prompt shape reaching the runtime are OpenCode's. A caller
    # that has its own opinion still wins — the header is only supplied when absent.
    # FABULA_CLIENT_HINT="" removes it entirely.
    def _fwd_headers(self):
        out = {k: v for k, v in self.headers.items()
               if k.lower() not in ("host", "content-length", "accept-encoding",
                                    "x-fabula-reasoning", "x-fabula-schema")}
        if CLIENT_HINT and not any(k.lower() in ("x-mtplx-client", "x-client-name") for k in out):
            out["X-MTPLX-Client"] = CLIENT_HINT
        return out

    def _proxy(self, method):
        body = self._read_body()
        is_stream = False
        j = None   # bound only when a JSON body is parsed; every later use must tolerate None (GETs have no body)
        try:
            if body:
                j = json.loads(body)
                if isinstance(j, dict):
                    is_stream = bool(j.get("stream"))
                    changed = False
                    rf = j.get("response_format")
                    # FIX 1: json_object is rejected by LM Studio -> rewrite to json_schema.
                    # Default to a PERMISSIVE object grammar so every caller (subagent creation,
                    # voice, …) gets valid JSON of its OWN shape; only the goal judge opts into the
                    # strict verdict grammar via the `X-Fabula-Schema: verdict` header.
                    if isinstance(rf, dict) and rf.get("type") == "json_object":
                        j["response_format"] = pick_object_schema(self.headers.get("X-Fabula-Schema"))
                        changed = True
                    # FIX 3: declarative reasoning-level body patches (config-driven)
                    level = resolve_level(self.headers, j)
                    if level or (isinstance(j.get("extra_body"), dict)
                                 and "fabula_reasoning" in j["extra_body"]):
                        apply_reasoning(j, load_reasoning_map(), level)
                        changed = True
                    # FIX 4b: optional hard output cap — bounds a runaway reasoning/generation spiral
                    # Cap DERIVED from the loaded model's own window (derived_output_cap). An explicit
                    # FABULA_MAX_OUTPUT_TOKENS still wins; with neither an override nor a knowable window the
                    # request passes through untouched. A caller asking 32000 tokens of a 65536-token model
                    # needs this: prompt plus reply has to fit, and only the server knows the ceiling.
                    # The estimate is already computed a few lines below for the near-ceiling note; it is
                    # needed HERE too, because a ceiling that ignores what the request already occupies is
                    # the arithmetic that killed the server — input fit, the share was modest, and nobody
                    # added them up.
                    _est_in = estimate_tokens(body) if body else 0
                    _cap = derived_output_cap(j.get("model"), _est_in)
                    # THE CLAIM THIS FILE MAKES, WRITTEN DOWN IN ONE UNIT. Everything here is tokens: what
                    # the request occupies, what it may generate, and what the runtime loaded. The defect
                    # that produced this line was an addition nobody performed; the line performs it out
                    # loud so the next reader does not have to trust anyone's summary — including mine,
                    # which was wrong five times today for want of exactly this.
                    _w_now = effective_window(j.get("model"))
                    if _w_now > 0:
                        sys.stderr.write(
                            "[fabula-adapter] BUDGET tokens in=%d + out<=%d = %d of window %d %s\n"
                            % (_est_in, _cap, _est_in + _cap, _w_now,
                               "OK" if _est_in + _cap <= _w_now else "OVER"))
                    if _cap > 0:
                        cur = j.get("max_tokens")
                        newv = _cap if not isinstance(cur, int) else min(cur, _cap)
                        if cur != newv:
                            j["max_tokens"] = newv
                            changed = True
                    # The near-ceiling note asks the SERVER what window is loaded, so it needs no
                    # configured value and must not sit behind one — put inside the branch below it
                    # simply never ran, which the first live oversized request revealed.
                    note_context_near_ceiling(j.get("model"), estimate_tokens(body) if body else 0)
                    # §3p2 prevention: fit max_tokens to the remaining window so a tool call can't
                    # truncate mid-arguments. Prompt tokens estimated with the one measured ratio.
                    if CONTEXT_WINDOW > 0:
                        est = estimate_tokens(body) if body else 0
                        fitted = clamp_max_tokens(j.get("max_tokens"), CONTEXT_WINDOW, est)
                        if fitted is not None and j.get("max_tokens") != fitted:
                            j["max_tokens"] = fitted
                            changed = True
                    # cache-diff telemetry: the KV cache is reused only while the request PREFIX is
                    # byte-stable; log a CACHE-BREAK when a hook mutated it (our measured #1 cost). The
                    # atomic compare-and-store (thread-safe under _PREFIX_LOCK) lives in adapter_util so
                    # it is unit-tested, incl. under concurrency.
                    try:
                        _key = str(j.get("model") or "?")
                        _sp = stable_prefix(j)
                        _prev_sp, _cb = compare_and_store(_PREFIX_STATE, _PREFIX_LOCK, _key, _sp)
                        # A turn whose prefix survived streams from cache; one whose prefix broke waits
                        # behind a full re-prefill. Those are different physics and must not share an
                        # idle-budget bucket — `_cb` is compare_and_store's own break signal, so the
                        # definition of "the prefix did not survive" stays single.
                        self._idle_warm = not _cb
                        if _cb and not CACHE_BREAK_CLASSIFY:
                            sys.stderr.write(
                                "[fabula-adapter] CACHE-BREAK model=%s: shared prefix %d/%d (%.0f%%) — "
                                "a hook likely mutated the stable system/tools block\n"
                                % (_key, _cb[0], _cb[1], _cb[2]))
                        elif _cb:
                            # WHY it broke decides what to do about it (arXiv:2605.05696): a
                            # position-shift died on content the server already had — ours to fix by
                            # reordering — while a content-break is real change and reordering is no cure.
                            _cls = classify_break(_prev_sp or "", _sp)
                            _shift = _cls.get("shift")
                            # Search AT AND ABOVE the divergence, not just the stable head — the head is
                            # one block on real traffic, so the head-only search could never name anyone.
                            # shared/total is exactly where the prefixes stopped matching.
                            _frac = (float(_cb[0]) / float(_cb[1])) if _cb[1] else None
                            _order = injection_order_report(j, divergence_fraction=_frac)
                            _blame = ""
                            if _cls.get("cls") == "position-shift" and _order.get("offenders"):
                                _o = _order["offenders"][-1]  # the one CLOSEST to the divergence
                                _blame = " — likely volatile block #%d (%s) above %d stable block(s): %r" % (
                                    _o["index"], _o["role"], _o["stable_blocks_below"], _o["excerpt"][:80])
                            sys.stderr.write(
                                "[fabula-adapter] CACHE-BREAK model=%s cause=%s%s shared=%d/%d (%.0f%%) "
                                "queue_depth=%d active=%d%s\n"
                                % (_key, _cls.get("cls", "?"),
                                   (" shift=%+d" % _shift) if isinstance(_shift, int) else "",
                                   _cb[0], _cb[1], _cb[2],
                                   _ADMISSION.queue_depth, _ADMISSION.active, _blame))
                    except Exception:
                        pass
                    # Phase-0 audit tap: capture the final (post-transform) body for offline
                    # layer analysis. Atomic + never-raises inside dump_last_request.
                    if DUMP_LAST_REQUEST and "/chat/completions" in self.path:
                        dump_last_request(j, DUMP_LAST_REQUEST)
                    if changed:
                        body = json.dumps(j).encode()
        except Exception:
            pass

        # W5: serialize upstream work. Acquired HERE (not at request entry) because a queued STREAMING
        # client must be kept alive, and only now do we know it is one. Released in handle_one_request's
        # finally, which also covers early returns, exceptions and a client that disconnects while queued.
        _ka = {"committed": False}

        def _keepalive(waited):
            if not is_stream:
                return
            try:
                if not _ka["committed"]:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    _ka["committed"] = True
                # an SSE comment: valid framing, ignored by every client, keeps the connection warm
                payload = b": fabula-adapter queued %.1fs\n\n" % waited
                self.wfile.write(b"%X\r\n" % len(payload))
                self.wfile.write(payload)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            except Exception:
                # The write failed: the queued client is GONE. Record it so the request is dropped on
                # admission instead of running a full generation nobody will read (the permit was always
                # released; the wasted GPU work was not — found by the independent verifier).
                _ka["dead"] = True

        def _sse_error_and_close(status, payload):
            """Finish a response the keepalive already committed as 200/SSE. The status line is gone, so
            the error has to travel as an SSE event and the chunked body has to be terminated properly —
            anything else fuses a second HTTP response into the stream and the SDK sees garbage."""
            try:
                body_txt = payload.decode("utf-8", "replace") if isinstance(payload, (bytes, bytearray)) else str(payload)
            except Exception:
                body_txt = ""
            try:
                ev = ("data: " + json.dumps({"error": {"message": body_txt, "upstream_status": status},
                                             "fabula_adapter": "upstream-error-after-keepalive"})
                      + "\n\n" + "data: [DONE]\n\n").encode()
                self.wfile.write(b"%X\r\n" % len(ev))
                self.wfile.write(ev)
                self.wfile.write(b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

        # Only INFERENCE work is admission-controlled. The paper's collapse (arXiv:2512.23029) is about
        # concurrent PREFILL on the big model; a liveness GET or a small-model embedding call queued
        # behind a long generation would break the app's health checks for nothing.
        _gated = method == "POST" and ("/chat/completions" in self.path or self.path.rstrip("/").endswith("/completions"))
        if _gated:
            # WHO IS ASKING. The engine states it (session/llm.ts): a system-spawned actor is work nobody
                # is watching. A request that says nothing counts as a live turn — the safe direction, and
                # the reason every existing caller keeps exactly the treatment it had.
                try:
                    _prio = int(self.headers.get("x-fabula-priority", "0") or 0)
                except (TypeError, ValueError):
                    _prio = 0
                self._adm = _ADMISSION.acquire(timeout=admit_wait_max(is_stream), on_wait=_keepalive,
                                               priority=_prio)
        else:
            self._adm = None
        self._headers_committed = _ka
        if _gated and _ka.get("dead"):
            adm = self._adm
            self._adm = None
            if adm is not None:
                adm.release()
            sys.stderr.write("[fabula-adapter] ADMISSION client vanished while queued — upstream call skipped\n")
            return
        if _gated and self._adm.wait > 0.05:
            sys.stderr.write("[fabula-adapter] ADMISSION waited=%.2fs queue_depth=%d active=%d%s\n"
                             % (self._adm.wait, _ADMISSION.queue_depth, _ADMISSION.active,
                                " FAIL-OPEN" if self._adm.fail_open else ""))

        # W5: the idle budget for THIS key, measured. Cold start returns exactly the flat constant.
        _idle_key = str((j or {}).get("model") or "?") if isinstance(j, dict) else "?"
        _idle_size = len(body) if body else 0
        _idle_warm = getattr(self, "_idle_warm", True)
        _idle_budget = _IDLE.budget(_idle_key, _idle_size, _idle_warm)

        def _open_upstream(timeout):
            r = urllib.request.Request(UPSTREAM + self.path,
                                       data=body if body else None,
                                       headers=self._fwd_headers(), method=method)
            return urllib.request.urlopen(r, timeout=timeout)

        # 409 IS A STATE, NOT A FAILURE. A runtime that serialises per session answers "session … is
        # already in flight" with HTTP 409 when a second request reaches the same session while a turn
        # is running (MTPLX `EngineSessionBusy`). Passing that through paints a red error card with a
        # Retry button in front of the reader — for a condition that resolves by itself in seconds and
        # that they did nothing to cause. The correct answer to "busy" is to WAIT, which is what this
        # adapter's admission gate already does for concurrency; this is the same idea one layer down,
        # for a runtime that enforces it per session rather than globally.
        #
        # Bounded and fail-loud at the end: once BUSY_RETRY_WINDOW is spent the 409 travels exactly as
        # it did before, because a session still busy a minute later is a real problem the reader must
        # see. Waiting is not swallowing — proven in both directions by proxy/test_busy_retry.py.
        def _open_waiting_out_busy():
            deadline = time.time() + BUSY_RETRY_WINDOW
            delay = 0.25
            while True:
                try:
                    return _open_upstream(FIRST_TOKEN_TIMEOUT)
                except urllib.error.HTTPError as e:
                    if e.code != 409 or time.time() >= deadline:
                        raise
                    # Read and discard so the connection is released before sleeping.
                    try:
                        e.read()
                    except Exception:
                        pass
                    sys.stderr.write("[fabula-adapter] upstream busy (409) — waiting %.2fs\n" % delay)
                    sys.stderr.flush()
                    time.sleep(delay)
                    delay = min(delay * 2, 4.0)

        try:
            # Open with the FIRST-TOKEN (prefill) budget for BOTH paths; each path drops the socket
            # to the smaller inter-token idle once the first byte lands (see set_read_timeout).
            _t_open = time.time()
            resp = _open_waiting_out_busy()
            _gap_prev = None
        except urllib.error.HTTPError as e:
            data = e.read()
            if _ka["committed"]:
                _sse_error_and_close(int(e.code), data)
                return
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        except Exception as e:
            msg = json.dumps({"error": str(e)}).encode()
            if _ka["committed"]:
                _sse_error_and_close(502, msg)
                return
            self.send_response(502)
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return

        if is_stream:
            # Pass streaming SSE through with chunked encoding, guarded by the IDLE-WATCHDOG with the
            # FIRST-TOKEN vs INTER-TOKEN split. resp.read() carries a per-read socket timeout: while
            # tokens flow it never fires. The FIRST read is bounded by FIRST_TOKEN_TIMEOUT (prefill);
            # the moment the first byte lands we drop the socket to STREAM_IDLE_TIMEOUT (smaller) so a
            # spiral/hang AFTER the first token is cut fast. If it stalls before the first byte we
            # retry the whole request once; otherwise we end the SSE stream cleanly so the agent moves
            # on (its loop/reliability guards then handle the empty/partial turn) rather than hanging.
            #
            # FRAME BOUNDARIES (the corruption fix): the relay is a SSE parser, not a byte pipe.
            # Network reads can split an SSE event mid-field — a partial `data: {..."syste` chunk with
            # NO terminating `\n\n`. If the watchdog then appends `data: [DONE]\n\n` straight after
            # those dangling bytes (the old behaviour), the SDK sees ONE fused data line
            # `{"id":..."systedata: [DONE]` and throws JSON Parse error (Unterminated string /
            # Expected ':'). That is the class of error the user sees when the upstream model stalls mid-generation.
            # Fix: buffer upstream bytes; forward only COMPLETE events (terminated by `\n\n`); on
            # terminate/EOF, DROP any incomplete tail and emit a clean finish — no half-event is ever
            # relayed, so no malformed data line can reach the SDK.
            # If we were queued, the keepalive already committed the SSE headers and started the
            # chunked body — sending them again would fuse a second header block into the stream and
            # the client would see a truncated read.
            if not _ka["committed"]:
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type", "text/event-stream")
                self.send_header("Content-Type", ctype)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()

            detector = DegenerationDetector()

            class _DegenerationDetected(Exception):
                pass

            def _write_chunk(b):
                self.wfile.write(b"%X\r\n" % len(b))
                self.wfile.write(b)
                self.wfile.write(b"\r\n")
                self.wfile.flush()

            SSE_BOUNDARY = b"\n\n"

            def _flush_complete(buf):
                tail = b""
                while True:
                    i = buf.find(SSE_BOUNDARY)
                    if i < 0:
                        tail = buf
                        break
                    frame = buf[:i + len(SSE_BOUNDARY)]
                    buf = buf[i + len(SSE_BOUNDARY):]
                    if detector.append(sse_delta_content(frame)):
                        raise _DegenerationDetected
                    _write_chunk(frame)
                return tail

            def _terminate(buf, idle, dropped, reason):
                if buf and SSE_BOUNDARY in buf:
                    try:
                        _flush_complete(buf)
                    except Exception:
                        pass
                sys.stderr.write(
                    "[fabula-adapter] stream %s after %ss (dropped=%d trailing bytes) — "
                    "terminating stream\n" % (reason, idle, dropped))
                try:
                    _write_chunk(b"data: [DONE]\n\n")
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except Exception:
                    pass

            pending = b""
            forwarded = False
            retries = STREAM_RETRIES
            while True:
                try:
                    chunk = resp.read(2048)
                except (socket.timeout, TimeoutError):
                    if not forwarded and retries > 0:
                        retries -= 1
                        try:
                            resp.close()
                        except Exception:
                            pass
                        try:
                            resp = _open_upstream(FIRST_TOKEN_TIMEOUT)
                            continue
                        except Exception:
                            pass
                    _terminate(pending,
                               _idle_budget if forwarded else FIRST_TOKEN_TIMEOUT,
                               len(pending) - (pending.rfind(SSE_BOUNDARY) + len(SSE_BOUNDARY)
                                               if SSE_BOUNDARY in pending else 0),
                               "idle-timeout")
                    break
                except Exception:
                    break
                if not chunk:
                    # Upstream closed cleanly. Forward any final complete events; a dangling tail here
                    # means upstream itself ended mid-event — drop it rather than relay a bad line.
                    if pending and SSE_BOUNDARY in pending:
                        try:
                            _flush_complete(pending)
                        except Exception:
                            pass
                    try:
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except Exception:
                        pass
                    break
                if not forwarded:
                    # The first byte landed. NOTE what is NOT done here: the prefill time is NOT fed to
                    # the idle baseline. That budget governs INTER-TOKEN gaps, and sampling time-to-first-
                    # token to bound it is a category error — it measured one quantity and governed
                    # another, which collapsed the watchdog to its floor and truncated healthy turns.
                    set_read_timeout(resp, _idle_budget)  # split: first byte in -> inter-token idle
                _gap_prev = time.time()
                forwarded = True
                # Split on SSE event boundaries: forward whole events, hold the remainder.
                # the real inter-token gap — the quantity the idle budget actually bounds
                try:
                    _now = time.time()
                    if forwarded and _gap_prev is not None:
                        _IDLE.observe(_idle_key, _idle_size, _now - _gap_prev, _idle_warm)
                    _gap_prev = _now
                except Exception:
                    pass
                try:
                    pending = _flush_complete(pending + chunk)
                except _DegenerationDetected:
                    sys.stderr.write("[fabula-adapter] degeneration detected — cutting stream\n")
                    try:
                        resp.close()
                    except Exception:
                        pass
                    _terminate(b"", 0, 0, "degeneration")
                    break
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    sys.stderr.write("[fabula-adapter] stream client disconnected mid-stream — "
                                     "closing upstream to abort generation\n")
                    try:
                        resp.close()
                    except Exception:
                        pass
                    break
            return

        # non-streaming: buffer with the SAME idle-watchdog + first-token/inter-token split as the
        # streaming path (the read is opened with FIRST_TOKEN_TIMEOUT; the first byte drops it to
        # STREAM_IDLE_TIMEOUT). A stalled upstream mid-body no longer wedges the turn for the full
        # UPSTREAM_TIMEOUT — it aborts after the (small) idle budget with a 504, and the agent's own
        # loop/reliability guards handle the failed turn.
        _ns_dead = {"v": False}
        def _probe_client(buf):
            if _ns_dead["v"]:
                raise ConnectionResetError("client gone")
            sock = self.request
            try:
                r, _, _ = select.select([sock], [], [], 0)
                closed = r and not sock.recv(1, socket.MSG_PEEK)
            except (BlockingIOError, InterruptedError):
                closed = False
            except OSError as e:
                # DECIDED BY ERRNO, NOT BY EXCEPTION CLASS, and the difference is a live client's turn.
                #
                # "would block" means the socket is HEALTHY and merely has nothing to read; "interrupted"
                # means a signal arrived mid-call. Neither is a disconnect. On POSIX those surface as
                # BlockingIOError/InterruptedError and are caught above — but Windows sockets report the
                # WSA family (10035/10004), and whether CPython maps those onto the same exception classes
                # is a platform detail this code must not depend on. If it does not, every one of them
                # lands here and a perfectly live client is declared dead: the upstream is closed and the
                # user's generation dies mid-answer, with nothing in the log saying why.
                #
                # Reading the number instead makes the decision identical on both, whatever the mapping.
                closed = e.errno not in _CLIENT_ALIVE_ERRNOS
            except ValueError:
                closed = True
            if closed:
                _ns_dead["v"] = True
                raise ConnectionResetError("client disconnected")
            _buf.append(buf)
        _buf = []
        try:
            drain_with_idle_split(lambda: resp.read(65536),
                                  lambda t: set_read_timeout(resp, t),
                                  _idle_budget, _probe_client)
        except ConnectionResetError:
            sys.stderr.write("[fabula-adapter] non-stream client disconnected mid-buffer — "
                             "closing upstream to abort generation\n")
            try:
                resp.close()
            except Exception:
                pass
            return
        except (socket.timeout, TimeoutError):
            sys.stderr.write("[fabula-adapter] non-stream idle-timeout (first_token=%ss idle=%ss) — "
                             "aborting\n" % (FIRST_TOKEN_TIMEOUT, _idle_budget))
            try:
                resp.close()
            except Exception:
                pass
            emsg = json.dumps({"error": "upstream idle timeout"}).encode()
            try:
                self.send_response(504)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(emsg)))
                self.end_headers()
                self.wfile.write(emsg)
            except Exception:
                pass
            return
        data = b"".join(_buf)
        try:
            obj = json.loads(data)
            msg = obj["choices"][0]["message"]
            content = msg.get("content") or ""
            reasoning = msg.get("reasoning_content") or ""
            # FIX 2: reasoning model put the JSON object in reasoning_content
            if content.strip() == "" and reasoning.strip().startswith("{"):
                msg["content"] = reasoning
                data = json.dumps(obj).encode()
            # A TOOL CALL WRITTEN AS PROSE IS STILL A TOOL CALL. Measured 2026-07-28: a turn's entire
            # answer was the markup of two calls the model meant to make. The runtime's parser did not
            # know that dialect, so it came through as ordinary content; the engine only ever reads
            # `tool_calls`, so it saw a finished turn with a little text in it. Nobody was at fault and
            # the reader got syntax instead of an answer. Converted here because this is where every
            # model in the socket passes, and a dialect one runtime parses and another does not is
            # exactly the difference the harness exists to absorb. Conservative by construction: only
            # content that is NOTHING BUT complete calls is touched (see toolcall_text.py).
            if not msg.get("tool_calls"):
                _txt_calls = parse_text_tool_calls(msg.get("content") or "")
                if _txt_calls:
                    msg["tool_calls"] = as_openai_tool_calls(_txt_calls)
                    msg["content"] = None
                    obj["choices"][0]["finish_reason"] = "tool_calls"
                    data = json.dumps(obj).encode()
                    sys.stderr.write("[fabula-adapter] TEXT-TOOL-CALL recovered %d call(s) the model wrote "
                                     "as prose\n" % len(_txt_calls))
            # overflow classification (visibility): any model in the socket can truncate the prompt SILENTLY.
            _usg = obj.get("usage") or {}
            _reason = classify_overflow(
                resp.status, "", obj["choices"][0].get("finish_reason") or "",
                output_tokens=_usg.get("completion_tokens", -1),
                input_tokens=_usg.get("prompt_tokens", -1),
                context_window=effective_context_window(obj.get("model") or body.get("model")))
            if _reason:
                sys.stderr.write("[fabula-adapter] CONTEXT-OVERFLOW (%s) usage=%s\n" % (_reason, _usg))
        except Exception:
            pass
        self.send_response(resp.status)
        for k, v in resp.headers.items():
            if k.lower() in ("transfer-encoding", "content-encoding", "connection", "content-length"):
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_one_request(self):
        """Release the admission slot after each request on the connection — this covers the handler's
        early returns, an exception mid-relay, and a client that disconnects while queued. A slot that
        leaks here silently degrades the cap to nothing, so the release lives at the outermost frame."""
        try:
            return BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, TimeoutError) as e:
            # A CLIENT HANGING UP IS NOT AN ERROR, and printing a traceback for it is not diagnostics.
            #
            # MEASURED 2026-08-01: 188 `Exception occurred during processing of request from
            # ('127.0.0.1', N)` blocks in the live log — 179 ConnectionResetError, 9 BrokenPipeError —
            # roughly 2400 of its 6781 lines. Every one came from the SAME benign frame,
            # `http/server.py:402 self.raw_requestline = self.rfile.readline(65537)`: reading the NEXT
            # request on a keep-alive connection the client had already dropped. Functionally harmless,
            # but this is the log RULE #17 mandates reading FIRST when something hangs, and a third of it
            # was this. One line each, so the fact is still on the record without burying what matters.
            self.close_connection = True
            sys.stderr.write("[fabula-adapter] client hung up (%s) — connection closed\n" % type(e).__name__)
            return None
        finally:
            adm = getattr(self, "_adm", None)
            if adm is not None:
                self._adm = None
                adm.release()

    def do_POST(self):
        self._proxy("POST")

    def do_GET(self):
        self._proxy("GET")

    def do_DELETE(self):
        self._proxy("DELETE")


# Socket errnos that mean "the client is FINE, there is just nothing to read right now" — the POSIX
# spellings and the Windows WSA ones together, because which of them a platform raises is not this file's
# business. `getattr` with a literal fallback so the module imports on a platform whose `errno` lacks the
# WSA names entirely (every POSIX one).
_CLIENT_ALIVE_ERRNOS = frozenset({
    errno.EAGAIN,
    errno.EWOULDBLOCK,
    errno.EINTR,
    getattr(errno, "WSAEWOULDBLOCK", 10035),
    getattr(errno, "WSAEINTR", 10004),
})


def _stderr_path():
    """Where fd 2 actually lands, asked of the kernel rather than assumed.

    launchd hands the process an already-opened file via `StandardErrorPath`; nothing in this file names
    it, and hardcoding one operator's path would be wrong on every other machine. macOS answers
    `F_GETPATH` for any fd. FABULA_ADAPTER_LOG overrides, for a platform that will not."""
    named = os.environ.get("FABULA_ADAPTER_LOG")
    if named:
        return named

    # EVERY PLATFORM ANSWERS THIS, IN ITS OWN WAY, and asking only macOS meant the rotator was dead
    # everywhere else: the log this project's own rule says to read FIRST when anything hangs would have
    # grown without bound on the two platforms being ported to, while the surrounding tests passed.
    #
    # Linux (and any /proc system) publishes the answer as a symlink: /proc/self/fd/2 points at the file.
    # A service manager that hands over a pipe or a journald socket makes that link point at "pipe:[123]"
    # or "socket:[456]" — NOT an absolute path — which is exactly the case that must return None, because
    # there is no file to truncate and truncating the wrong thing is worse than not rotating.
    if sys.platform.startswith("linux"):
        try:
            p = os.readlink("/proc/self/fd/2")
            return p if p.startswith("/") and not p.startswith("/proc/") else None
        except Exception:
            return None

    if sys.platform == "darwin":
        try:
            import fcntl
            F_GETPATH = 50  # macOS <sys/fcntl.h>
            # `fcntl.fcntl` RETURNS the filled buffer; it does not mutate one passed in (a bytearray
            # argument raises "cannot be interpreted as an integer"). Caught by running the resolver in a
            # process whose fd 2 really was a file, the way launchd opens it — it answered None, so the
            # rotator would have done nothing in production while every test of the surrounding logic
            # passed.
            p = fcntl.fcntl(2, F_GETPATH, b"\0" * 1024).split(b"\0", 1)[0].decode("utf-8", "replace")
            return p if p.startswith("/") else None
        except Exception:
            return None

    # Windows has no fd-to-path call a service can rely on, and says so rather than guessing: the task
    # that starts the adapter redirects its own output, so FABULA_ADAPTER_LOG is the honest channel there.
    return None


def _rotate_log_forever():
    """Keep the diagnostic log bounded.

    MEASURED 2026-08-01: nothing bounded it. `grep -c "rotat\\|RotatingFile\\|maxBytes"` returned 0, the
    plist uses a plain append-only `StandardErrorPath`, and the file stood at 568 KB and grew during the
    audit itself. Its two siblings, `adapter.err.log.old` and `adapter.err.log.pre25`, are hand-made
    copies — the rotation existed, performed by a person. This is the log RULE #17 mandates reading FIRST
    when anything hangs, so it being unbounded is a diagnostic problem, not a disk one.

    Truncating IN PLACE is what makes this safe under launchd: fd 2 was opened with O_APPEND, so the very
    next write lands at offset 0 of the same inode. Renaming the file instead would leave the process
    writing into a file nobody is reading."""
    path = _stderr_path()
    if not path:
        return
    try:
        limit = int(os.environ.get("FABULA_ADAPTER_LOG_MAX", str(20 * 1024 * 1024)) or 0)
    except Exception:
        limit = 20 * 1024 * 1024
    if limit <= 0:
        return
    import shutil, time as _t
    while True:
        try:
            if os.path.getsize(path) > limit:
                shutil.copyfile(path, path + ".1")  # ONE previous generation, so a rotation loses nothing
                os.truncate(path, 0)
                sys.stderr.write("[fabula-adapter] log rotated at %d bytes; previous generation kept at %s.1\n" % (limit, path))
        except Exception:
            pass
        _t.sleep(60)


if __name__ == "__main__":
    threading.Thread(target=_rotate_log_forever, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
