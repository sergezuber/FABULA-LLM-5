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
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from adapter_util import (
    stable_prefix, shared_prefix_len, classify_overflow, clamp_max_tokens, drain_with_idle_split,
    update_prefix_and_check, compare_and_store, dump_last_request,
    classify_break, injection_order_report, AdmissionGate, IdleBaseline,
)

# Optional context window for the dynamic max_tokens clamp (0 = off). When set, every request's
# max_tokens is fitted to the remaining window so a tool call can't truncate mid-arguments (§3p2 prevention).
CONTEXT_WINDOW = int(os.environ.get("FABULA_CONTEXT_WINDOW", "0"))

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
# A queued NON-streaming caller (the goal judge, embeddings, /v1/models) receives no keepalive — there is
# no SSE frame to send one in — so this ceiling is how long such a caller can sit silent. Keep it short
# enough that the caller survives it; past the ceiling the gate fails open and the request proceeds.
ADMIT_WAIT_MAX = float(os.environ.get("FABULA_ADMIT_WAIT_MAX", "60"))
_ADMISSION = AdmissionGate(MAX_CONCURRENT_UPSTREAM, wait_timeout=ADMIT_WAIT_MAX)
# W5 measured idle budget: replaces the flat constant once a key has enough evidence of its own.
_IDLE = IdleBaseline(flat=float(os.environ.get("FABULA_STREAM_IDLE_TIMEOUT", "120")))
# Kill-switch for the READ-ONLY half (break classification + injection audit). Off = the pre-W5 line,
# byte-for-byte, so the mechanism can be removed from the picture without removing the telemetry.
CACHE_BREAK_CLASSIFY = os.environ.get("FABULA_CACHE_BREAK_CLASS", "1").strip().lower() not in ("0", "false", "off")

# The adapter is started by a LaunchAgent, which passes NO environment of its own — so every knob below
# would silently be a code default and the documented kill-switches would be unreachable in production
# (found on review: the running process had zero FABULA_* vars). Load the repo `.env` first, letting a real
# environment variable win, so `.env` is the single place the docs can honestly point at.
def _load_dotenv(path):
    try:
        with open(path) as f:
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
    entry = mapping.get(model) or mapping.get("*")
    if not isinstance(entry, dict):
        return body
    per_level = entry.get(level)
    if not isinstance(per_level, dict):
        return body
    patch = per_level.get(kind)
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

    def _fwd_headers(self):
        return {k: v for k, v in self.headers.items()
                if k.lower() not in ("host", "content-length", "accept-encoding",
                                     "x-fabula-reasoning", "x-fabula-schema")}

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
                    if MAX_OUTPUT_TOKENS > 0:
                        cur = j.get("max_tokens")
                        newv = MAX_OUTPUT_TOKENS if not isinstance(cur, int) else min(cur, MAX_OUTPUT_TOKENS)
                        if cur != newv:
                            j["max_tokens"] = newv
                            changed = True
                    # §3p2 prevention: fit max_tokens to the remaining window so a tool call can't
                    # truncate mid-arguments. Estimate prompt tokens as chars/4 of the serialized body.
                    if CONTEXT_WINDOW > 0:
                        est = len(body) // 4 if body else 0
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
                            _order = injection_order_report(j)
                            _blame = ""
                            if _cls.get("cls") == "position-shift" and _order.get("offenders"):
                                _o = _order["offenders"][0]
                                _blame = " — volatile block #%d (%s) sits above %d stable block(s): %r" % (
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
            self._adm = _ADMISSION.acquire(timeout=ADMIT_WAIT_MAX, on_wait=_keepalive)
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
        _idle_budget = _IDLE.budget(_idle_key, _idle_size)

        def _open_upstream(timeout):
            r = urllib.request.Request(UPSTREAM + self.path,
                                       data=body if body else None,
                                       headers=self._fwd_headers(), method=method)
            return urllib.request.urlopen(r, timeout=timeout)

        try:
            # Open with the FIRST-TOKEN (prefill) budget for BOTH paths; each path drops the socket
            # to the smaller inter-token idle once the first byte lands (see set_read_timeout).
            _t_open = time.time()
            resp = _open_upstream(FIRST_TOKEN_TIMEOUT)
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

            def _write_chunk(b):
                self.wfile.write(b"%X\r\n" % len(b))
                self.wfile.write(b)
                self.wfile.write(b"\r\n")
                self.wfile.flush()

            SSE_BOUNDARY = b"\n\n"

            def _flush_complete(buf):
                """Forward every COMPLETE SSE event in `buf` (terminated by \\n\\n); return the
                dangling tail past the last boundary (or the whole buffer if none). A watchdog
                cut or a clean EOF must never relay a half-event — only whole events go out, so
                the trailing `[DONE]` can never fuse with a dangling partial into one bad line."""
                tail = b""
                while True:
                    i = buf.find(SSE_BOUNDARY)
                    if i < 0:
                        tail = buf
                        break
                    frame = buf[:i + len(SSE_BOUNDARY)]
                    buf = buf[i + len(SSE_BOUNDARY):]
                    _write_chunk(frame)
                return tail

            def _terminate(buf, idle, dropped):
                # Forward any complete events held in `buf` BEFORE the terminus — the stall happens
                # AFTER a token was buffered (resp.read can return complete+partial in one go); those
                # real tokens must reach the SDK, only the dangling tail is dropped.
                if buf and SSE_BOUNDARY in buf:
                    try:
                        _flush_complete(buf)
                    except Exception:
                        pass
                sys.stderr.write(
                    "[fabula-adapter] stream idle-timeout after %ss (dropped=%d trailing bytes) — "
                    "terminating stream\n" % (idle, dropped))
                try:
                    _write_chunk(b"data: [DONE]\n\n")
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except Exception:
                    pass

            pending = b""           # bytes past the last complete event — relayed once closed
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
                                               if SSE_BOUNDARY in pending else 0))
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
                        _IDLE.observe(_idle_key, _idle_size, _now - _gap_prev)
                    _gap_prev = _now
                except Exception:
                    pass
                pending = _flush_complete(pending + chunk)
            return

        # non-streaming: buffer with the SAME idle-watchdog + first-token/inter-token split as the
        # streaming path (the read is opened with FIRST_TOKEN_TIMEOUT; the first byte drops it to
        # STREAM_IDLE_TIMEOUT). A stalled upstream mid-body no longer wedges the turn for the full
        # UPSTREAM_TIMEOUT — it aborts after the (small) idle budget with a 504, and the agent's own
        # loop/reliability guards handle the failed turn.
        _buf = []
        try:
            drain_with_idle_split(lambda: resp.read(65536),
                                  lambda t: set_read_timeout(resp, t),
                                  _idle_budget, _buf.append)
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
            # overflow classification (visibility): any model in the socket can truncate the prompt SILENTLY.
            _usg = obj.get("usage") or {}
            _reason = classify_overflow(
                resp.status, "", obj["choices"][0].get("finish_reason") or "",
                output_tokens=_usg.get("completion_tokens", -1),
                input_tokens=_usg.get("prompt_tokens", -1),
                context_window=int(os.environ.get("FABULA_CONTEXT_WINDOW", "0")))
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


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
