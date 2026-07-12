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
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from adapter_util import (
    stable_prefix, shared_prefix_len, classify_overflow, clamp_max_tokens, drain_with_idle_split,
    update_prefix_and_check, dump_last_request,
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
                        _cb = update_prefix_and_check(_PREFIX_STATE, _PREFIX_LOCK, _key, stable_prefix(j))
                        if _cb:
                            sys.stderr.write(
                                "[fabula-adapter] CACHE-BREAK model=%s: shared prefix %d/%d (%.0f%%) — "
                                "a hook likely mutated the stable system/tools block\n"
                                % (_key, _cb[0], _cb[1], _cb[2]))
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

        def _open_upstream(timeout):
            r = urllib.request.Request(UPSTREAM + self.path,
                                       data=body if body else None,
                                       headers=self._fwd_headers(), method=method)
            return urllib.request.urlopen(r, timeout=timeout)

        try:
            # Open with the FIRST-TOKEN (prefill) budget for BOTH paths; each path drops the socket
            # to the smaller inter-token idle once the first byte lands (see set_read_timeout).
            resp = _open_upstream(FIRST_TOKEN_TIMEOUT)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        except Exception as e:
            msg = json.dumps({"error": str(e)}).encode()
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
                               STREAM_IDLE_TIMEOUT if forwarded else FIRST_TOKEN_TIMEOUT,
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
                    set_read_timeout(resp, STREAM_IDLE_TIMEOUT)  # split: first byte in -> inter-token idle
                forwarded = True
                # Split on SSE event boundaries: forward whole events, hold the remainder.
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
                                  STREAM_IDLE_TIMEOUT, _buf.append)
        except (socket.timeout, TimeoutError):
            sys.stderr.write("[fabula-adapter] non-stream idle-timeout (first_token=%ss idle=%ss) — "
                             "aborting\n" % (FIRST_TOKEN_TIMEOUT, STREAM_IDLE_TIMEOUT))
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

    def do_POST(self):
        self._proxy("POST")

    def do_GET(self):
        self._proxy("GET")

    def do_DELETE(self):
        self._proxy("DELETE")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
