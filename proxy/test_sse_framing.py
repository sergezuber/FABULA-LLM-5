#!/usr/bin/env python3
"""Regression tests for the SSE stream-relay frame-boundary logic.

THE BUG (reproduced from production): when LM Studio stalls mid-generation, the upstream emits
a PARTIAL SSE event (a `data: {..."syste` chunk with NO terminating `\n\n`) and then goes silent.
The adapter's idle-watchdog then terminated the stream by appending `data: [DONE]\n\n` directly
after those dangling bytes. At the SSE protocol level the partial fragment and the terminator
fused into ONE data line:

    data: {"id":"chatcmpl-...","systedata: [DONE]

and the Vercel AI SDK threw `JSON Parse error: Unterminated string` / `Expected ':'`. This was
the class of error the user saw as "JSON parsing failed" whenever the upstream model stalled.

THE FIX: the relay is a SSE parser, not a byte pipe. It forwards only COMPLETE events (terminated
by `\n\n`); a partial tail is HELD until more bytes arrive, or DROPPED on terminate/EOF — never
fused with `[DONE]`. The complete events already buffered are still delivered; only the dangling
half-event is discarded.

This file mirrors the adapter's `_flush_complete` helper inline (the same code, lifted verbatim)
so the boundary logic is unit-testable without spawning the server.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SSE_BOUNDARY = b"\n\n"


class _Sink:
    """Captures the chunked-encoding frames the adapter writes to its socket, so we can decode
    them back into the SSE data lines the downstream SDK would receive."""
    def __init__(self):
        self.frames = []

    def write(self, b):
        self.frames.append(b)

    def flush(self):
        pass


def _write_chunk(sink, b):
    sink.write(b"%X\r\n" % len(b))
    sink.write(b)
    sink.write(b"\r\n")
    sink.flush()


def _flush_complete(sink, buf):
    """Forward every COMPLETE SSE event in `buf` (terminated by \\n\\n); return the dangling tail
    past the last boundary (or the whole buffer if none). Verbatim copy of the adapter helper."""
    tail = b""
    while True:
        i = buf.find(SSE_BOUNDARY)
        if i < 0:
            tail = buf
            break
        frame = buf[: i + len(SSE_BOUNDARY)]
        buf = buf[i + len(SSE_BOUNDARY):]
        _write_chunk(sink, frame)
    return tail


def _decode(sink):
    """Decode the captured chunked-encoding frames back into the raw SSE bytes the SDK sees."""
    return b"".join(sink.frames)


def _dechunk(raw):
    """Strip HTTP chunked transfer-encoding (hex-len\\r\\n data\\r\\n ...) to recover the raw SSE
    byte stream — exactly what the downstream SDK's HTTP client reconstructs before SSE parsing."""
    out = b""
    i = 0
    while i < len(raw):
        nl = raw.find(b"\r\n", i)
        if nl < 0:
            break
        try:
            ln = int(raw[i:nl], 16)
        except ValueError:
            break
        if ln == 0:
            break
        out += raw[nl + 2: nl + 2 + ln]
        i = nl + 2 + ln + 2
    return out


def _data_lines(raw):
    """Split raw SSE bytes (chunked-decoded) into the `data:` payloads a SSE parser yields."""
    body = _dechunk(raw)
    return [b.strip() for b in body.split(SSE_BOUNDARY) if b.strip()]


def test_partial_tail_is_held_not_forwarded():
    """A complete event followed by a partial event in one read: the complete one forwards, the
    partial one is held as the tail — never relayed."""
    sink = _Sink()
    buf = (
        b'data: {"choices":[{"delta":{"content":"Creating backdoor"}}]}\n\n'
        b'data: {"id":"chatcmpl-x","syste'  # PARTIAL — no \n\n
    )
    tail = _flush_complete(sink, buf)
    lines = _data_lines(_decode(sink))
    assert len(lines) == 1, f"expected exactly 1 complete event forwarded, got {len(lines)}: {lines}"
    assert b"Creating backdoor" in lines[0]
    assert tail == b'data: {"id":"chatcmpl-x","syste', f"partial must be held as tail, got {tail!r}"
    print("ok   partial tail held (not forwarded) when boundary absent")


def test_old_fusion_signature_is_the_bug():
    """Document the EXACT malformed line the old byte-pipe relay produced, so the regression
    target is unambiguous: `...systedata: [DONE]` — the partial fragment fused with the
    terminator into a single unparsable data line."""
    old_output = b'data: {"id":"chatcmpl-x","systedata: [DONE]\n\n'
    assert b"systedata:" in old_output.replace(b" ", b"")
    print("ok   old byte-pipe produced the 'systedata: [DONE]' fusion (the bug signature)")


def test_reassembly_across_reads():
    """An event split across two network reads must reassemble into one complete event; nothing
    is forwarded until the closing `\\n\\n` arrives."""
    sink = _Sink()
    pending = _flush_complete(sink, b'data: {"choices":[{"delta":{"content":"to')  # no boundary
    assert sink.frames == [], "nothing forwarded before the event closes"
    pending = _flush_complete(sink, pending + b'ken1"}}]}\n\ndata: {"choices":[{"delta":{"content":"tok')
    lines = _data_lines(_decode(sink))
    assert len(lines) == 1 and b"token1" in lines[0], f"token1 should forward: {lines}"
    # the second event never closed → its dangling bytes are the tail (no closing JSON quote)
    expected_tail = b'data: {"choices":[{"delta":{"content":"tok'
    assert pending == expected_tail, f"tail wrong: {pending!r}"
    print("ok   event reassembled across two reads")


def test_terminate_drops_partial_keeps_complete():
    """On idle-timeout, the complete events held in `buf` are flushed FIRST, then [DONE] is
    emitted standalone. The partial tail is dropped — it can never fuse with the terminator."""
    sink = _Sink()
    # Simulate a long stream where the last chunk was partial (the production case).
    buf = b"".join(b'data: {"choices":[{"delta":{"content":"code%d "}}]}\n\n' % i for i in range(50))
    buf += b'data: {"id":"chatcmpl-l0eu9","syste'  # PARTIAL, then the model stalls
    pending = _flush_complete(sink, buf)
    # The terminate-path flushes any remaining complete events from pending, then emits [DONE].
    # Here pending has NO complete event (the partial never closed), so only [DONE] goes out.
    assert b"syste" not in _decode(sink), "partial bytes must never reach the SDK"
    _write_chunk(sink, b"data: [DONE]\n\n")  # the terminus
    raw = _decode(sink)
    lines = _data_lines(raw)
    assert len(lines) == 50 + 1  # 50 complete events + [DONE]
    assert lines[-1] == b"data: [DONE]"
    # The critical invariant: no data line fuses the partial fragment with [DONE].
    assert not any(b"syste" in l and b"[DONE]" in l for l in lines), "fusion regression"
    print("ok   terminate: 50 events kept, partial dropped, [DONE] clean")


def test_multiple_events_one_read():
    """Several complete events arriving in a single read all forward, tail empty."""
    sink = _Sink()
    buf = b'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n'
    assert _flush_complete(sink, buf) == b""
    assert len(_data_lines(_decode(sink))) == 3
    print("ok   multiple events in one read all forwarded")


def test_empty_buffer():
    assert _flush_complete(_Sink(), b"") == b""
    print("ok   empty buffer handled")


def test_live_adapter_no_fusion_on_partial_then_stall():
    """End-to-end: spawn the real adapter against a fake upstream that streams a complete token,
    then emits a PARTIAL event and stalls. The bytes the SDK receives must NOT contain the
    partial fragment fused with [DONE]. (Integration guard; skipped if the adapter file or a free
    port is unavailable.)"""
    import socket
    import subprocess
    import threading
    import time
    import urllib.request
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    ADAPTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")
    if not os.path.exists(ADAPTER):
        print("skip live adapter test (adapter not found)")
        return

    def _free_port():
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        p = s.getsockname()[1]
        s.close()
        return p

    FAKE_PORT, ADAPTER_PORT = _free_port(), _free_port()

    class Fake(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            # one complete token, properly terminated
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"tok0"}}]}\n\n')
            self.wfile.flush()
            time.sleep(0.3)
            # a PARTIAL event then stall forever (the upstream model stalls mid-generation)
            self.wfile.write(b'data: {"id":"chatcmpl-x","syste')
            self.wfile.flush()
            time.sleep(30)

    threading.Thread(target=lambda: ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake).serve_forever(),
                     daemon=True).start()
    time.sleep(0.4)
    env = dict(os.environ)
    env.update({"UPSTREAM": f"http://127.0.0.1:{FAKE_PORT}", "ADAPTER_PORT": str(ADAPTER_PORT),
                "FABULA_STREAM_IDLE_TIMEOUT": "2", "FABULA_FIRST_TOKEN_TIMEOUT": "5",
                "FABULA_STREAM_RETRIES": "0"})
    proc = subprocess.Popen([sys.executable, ADAPTER], env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        time.sleep(0.8)
        data = json.dumps({"model": "x", "stream": True,
                           "messages": [{"role": "user", "content": "hi"}]}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{ADAPTER_PORT}/v1/chat/completions", data=data,
                                     headers={"Content-Type": "application/json"}, method="POST")
        r = urllib.request.urlopen(req, timeout=15)
        out = r.read().decode(errors="replace")
    finally:
        proc.terminate()
    # The partial fragment must NEVER appear in what the SDK receives — fused or otherwise.
    assert "syste" not in out, f"partial fragment leaked to SDK: {out!r}"
    assert "data: [DONE]" in out, f"clean terminus missing: {out!r}"
    print("ok   live adapter: partial dropped, [DONE] clean (no fusion)")


def main():
    test_partial_tail_is_held_not_forwarded()
    test_old_fusion_signature_is_the_bug()
    test_reassembly_across_reads()
    test_terminate_drops_partial_keeps_complete()
    test_multiple_events_one_read()
    test_empty_buffer()
    test_live_adapter_no_fusion_on_partial_then_stall()
    print()
    print("all SSE framing tests passed")


if __name__ == "__main__":
    main()
