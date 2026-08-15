#!/usr/bin/env python3
"""A busy session is waited out; a session that stays busy is still reported.

WHY THIS EXISTS. A runtime that serialises per session answers HTTP 409 ("session … is already in
flight") when a second request reaches a session whose turn is still running. Passed through, that
paints a red error card with a Retry button in front of the reader — for a condition that resolves by
itself in a second and that they did nothing to cause. Measured live against MTPLX before the change.

THREE PROPERTIES, and the last two are what make the first honest:
  1. a transient 409 is waited out and the answer is delivered;
  2. a session that stays busy past the window still REACHES the client as 409 — waiting is not
     swallowing, and a session busy for a minute is a real problem the reader must see;
  3. FABULA_BUSY_RETRY_WINDOW=0 restores the pre-change behaviour exactly.

The upstream is a fake that counts requests, so "it waited" is measured as REQUESTS MADE, not as
elapsed time — a check that only reads the final status passes against an adapter that retries nothing
and merely got lucky, and one that reads the clock passes against a slow machine.
"""
import http.client
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE_PORT = 1334
ADAPTER_PORT = 1339
ADAPTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")

# busy_left: how many more requests the fake refuses before answering. -1 = refuse forever.
STATE = {"busy_left": 0, "requests": 0, "lock": threading.Lock()}


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        self.rfile.read(length) if length else b""
        with STATE["lock"]:
            STATE["requests"] += 1
            busy = STATE["busy_left"] != 0
            if STATE["busy_left"] > 0:
                STATE["busy_left"] -= 1
        if busy:
            # The shape MTPLX really sends: 409 with a JSON body naming the session.
            payload = b'{"detail":"session ses_test is already in flight"}'
            self.send_response(409)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        payload = b'{"choices":[{"message":{"role":"assistant","content":"done"}}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def run_fake():
    ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake).serve_forever()


def start_adapter(window):
    env = dict(os.environ)
    env.update({
        "UPSTREAM": "http://127.0.0.1:%d" % FAKE_PORT,
        "ADAPTER_PORT": str(ADAPTER_PORT),
        "FABULA_BUSY_RETRY_WINDOW": str(window),
        "FABULA_FIRST_TOKEN_TIMEOUT": "30",
        "FABULA_STREAM_RETRIES": "0",
        # The gate would serialise these one-at-a-time requests anyway; off keeps the case about 409.
        "FABULA_MAX_CONCURRENT_UPSTREAM": "0",
    })
    return subprocess.Popen([sys.executable, ADAPTER], env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE)


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def ask(timeout=30):
    """Ask once. A request that never answers reports status None rather than raising — an adapter
    that waits forever is a real failure mode of this very mechanism, and the report has to be able
    to SAY so instead of dying inside the socket with a stack trace."""
    body = json.dumps({"model": "x", "stream": False,
                       "messages": [{"role": "user", "content": "hi"}]}).encode()
    connection = http.client.HTTPConnection("127.0.0.1", ADAPTER_PORT, timeout=timeout)
    try:
        connection.request("POST", "/v1/chat/completions", body=body,
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, response.read()
    except (TimeoutError, OSError, http.client.HTTPException):
        return None, b""
    finally:
        connection.close()


def wait_ready():
    for _ in range(100):
        try:
            connection = http.client.HTTPConnection("127.0.0.1", ADAPTER_PORT, timeout=2)
            connection.request("GET", "/v1/models")
            connection.getresponse().read()
            connection.close()
            return True
        except Exception:
            time.sleep(0.1)
    return False


def case_transient():
    """Two refusals then an answer: the client sees 200 and the upstream was asked three times."""
    with STATE["lock"]:
        STATE["busy_left"], STATE["requests"] = 2, 0
    status, data = ask()
    with STATE["lock"]:
        requests = STATE["requests"]
    ok = status == 200 and b"done" in data and requests == 3
    print("  transient: status=%s requests=%d (want 200 / 3)" % (status, requests))
    return ok


def case_permanent():
    """Busy forever: the 409 still reaches the client once the window is spent."""
    with STATE["lock"]:
        STATE["busy_left"], STATE["requests"] = -1, 0
    started = time.time()
    status, _ = ask()
    elapsed = time.time() - started
    with STATE["lock"]:
        requests = STATE["requests"]
    # It must have RETRIED (more than one request) and must still have surfaced the 409.
    ok = status == 409 and requests > 1
    print("  permanent: status=%s requests=%d elapsed=%.1fs (want 409, >1 request)"
          % (status, requests, elapsed))
    return ok


def case_disabled():
    """Window 0: the 409 travels on the first attempt, exactly as before the change."""
    with STATE["lock"]:
        STATE["busy_left"], STATE["requests"] = -1, 0
    status, _ = ask(timeout=10)
    with STATE["lock"]:
        requests = STATE["requests"]
    ok = status == 409 and requests == 1
    print("  disabled: status=%s requests=%d (want 409 / exactly 1)" % (status, requests))
    return ok


def main():
    threading.Thread(target=run_fake, daemon=True).start()
    time.sleep(0.4)

    # A short window keeps the permanent case quick while still exercising several retries
    # (backoff 0.25 → 0.5 → 1.0 → 2.0 fits four attempts inside three seconds).
    process = start_adapter(window=3)
    try:
        if not wait_ready():
            print("RESULT: FAIL (adapter never came up)")
            return False
        transient = case_transient()
        permanent = case_permanent()
    finally:
        stop(process)
    logs = process.stderr.read().decode(errors="replace")
    logged = "upstream busy (409)" in logs

    process = start_adapter(window=0)
    try:
        if not wait_ready():
            print("RESULT: FAIL (adapter never came up with the wait disabled)")
            return False
        disabled = case_disabled()
    finally:
        stop(process)

    print("  log names the wait: %s" % logged)
    passed = transient and permanent and disabled and logged
    print("RESULT:", "PASS" if passed else "FAIL")
    return passed


def test_busy_retry():
    assert main(), "see the printed report above for which case failed"


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
