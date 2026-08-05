#!/usr/bin/env python3
import http.client
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE_PORT = 1331
ADAPTER_PORT = 1337
ADAPTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")
STATE = {"stream_closed": threading.Event(), "nonstream_closed": threading.Event()}


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = json.loads(self.rfile.read(length) if length else b"{}")
        if body.get("stream"):
            self.stream_response()
            return
        self.nonstream_response()

    def stream_response(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for i in range(100000):
                event = ('data: {"choices":[{"delta":{"content":"t%d "}}]}\n\n' % i).encode()
                self.wfile.write(event)
                self.wfile.flush()
                time.sleep(0.01)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            STATE["stream_closed"].set()

    def nonstream_response(self):
        payload = b'{"choices":[{"message":{"content":"' + b"x" * (1024 * 1024) + b'"}}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            # CHUNK AND PACE chosen so the case finishes well inside the wait on any timer granularity.
            # It used to be 256 chunks paced at 10ms — about 2.5s where a sleep is accurate, and past the
            # 3s budget on a platform whose sleep rounds up to ~15ms, so the check could fail for the
            # fixture being slow rather than for the adapter missing a departed client. The property is
            # that the upstream is abandoned mid-body, which needs several chunks, not hundreds.
            for offset in range(0, len(payload), 32768):
                self.wfile.write(payload[offset:offset + 32768])
                self.wfile.flush()
                time.sleep(0.02)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            STATE["nonstream_closed"].set()


def run_fake():
    ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake).serve_forever()


def start_adapter():
    env = dict(os.environ)
    env.update({
        "UPSTREAM": "http://127.0.0.1:%d" % FAKE_PORT,
        "ADAPTER_PORT": str(ADAPTER_PORT),
        "FABULA_STREAM_IDLE_TIMEOUT": "30",
        "FABULA_FIRST_TOKEN_TIMEOUT": "30",
        "FABULA_STREAM_RETRIES": "0",
    })
    return subprocess.Popen([sys.executable, ADAPTER], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def stream_disconnect():
    body = json.dumps({"model": "x", "stream": True, "messages": [{"role": "user", "content": "hi"}]}).encode()
    connection = http.client.HTTPConnection("127.0.0.1", ADAPTER_PORT, timeout=10)
    connection.request("POST", "/v1/chat/completions", body=body, headers={"Content-Type": "application/json"})
    response = connection.getresponse()
    received = b""
    while b"\n\n" not in received:
        piece = response.read(4096)
        if not piece:
            break
        received += piece
    connection.close()
    return b"data:" in received


def nonstream_disconnect():
    body = json.dumps({"model": "x", "stream": False, "messages": [{"role": "user", "content": "hi"}]}).encode()
    connection = http.client.HTTPConnection("127.0.0.1", ADAPTER_PORT, timeout=10)
    connection.request("POST", "/v1/chat/completions", body=body, headers={"Content-Type": "application/json"})
    connection.close()


def main():
    threading.Thread(target=run_fake, daemon=True).start()
    time.sleep(0.4)
    process = start_adapter()
    try:
        time.sleep(0.8)
        STATE["stream_closed"].clear()
        received = stream_disconnect()
        # Generous, and deliberately so: this waits for a FAILURE to be observed, so a budget
        # that is merely adequate turns a slow machine into a false negative.
        stream_closed = STATE["stream_closed"].wait(15)
        STATE["nonstream_closed"].clear()
        nonstream_disconnect()
        nonstream_closed = STATE["nonstream_closed"].wait(15)
    finally:
        stop(process)
    logs = process.stderr.read().decode(errors="replace")
    stream_log = "stream client disconnected mid-stream" in logs
    nonstream_log = "non-stream client disconnected mid-buffer" in logs
    passed = received and stream_closed and nonstream_closed and stream_log and nonstream_log
    print("stream: received=%s upstream_closed=%s log=%s" % (received, stream_closed, stream_log))
    print("nonstream: upstream_closed=%s log=%s" % (nonstream_closed, nonstream_log))
    print("RESULT:", "PASS" if passed else "FAIL")
    return bool(passed)

# ── pytest collection ───────────────────────────────────────────────────────────────────────────────
# MEASURED 2026-08-01: `pytest -q` in proxy/ reported "110 passed" while FIVE of the 17 files
# contributed ZERO tests — this one among them — because all of their work sat behind
# `if __name__ == "__main__":`. pytest imported the module, found no `test_*` callable, and moved on, so
# a regression here would have left the project's declared adapter gate GREEN. `main()` now returns a
# verdict instead of exiting, and one body serves both the script and the suite.


def test_client_disconnect():
    assert main(), "see the printed report above for which case failed"


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
