#!/usr/bin/env python3
"""The adapter declares who its client is — and only when the caller has not.

WHY THIS EXISTS. Some runtimes key real behaviour on the client's identity: MTPLX enables its
unconditional cross-session block-prefix cache restore only when the client hint is exactly
"opencode" (mtplx/generation.py `_opencode_compact_tool_history_policy` — three fingerprint
conditions, all reachable only through that hint). That identifier is a true statement about the
tool contract and prompt shape we send, but the AI SDK under the engine introduces itself as
`ai_sdk_agent`, so every request landed in the weak branch: measured
2026-08-16, ~2.2 cache misses per task at ~48s each on prompts two sessions shared 94.6% of. With
the hint, the same restore took 1.1s.

FIVE PROPERTIES:
  1. the header arrives upstream on an ordinary request;
  2. a caller that states its own identity is NOT overridden — the adapter only fills silence;
  3. FABULA_CLIENT_HINT="" removes the header entirely (restores the prior wire bytes);
  4. a request that DECLARES A REASONING LEVEL is not given the identity — on a managed surface the
     runtime takes generation policy away from the client, so the two are mutually exclusive and the
     declaration would be discarded (measured: controls_allowed=False in 230 of 230 such requests);
  5. that split is keyed on the request, not on the machine — an ordinary turn still gets the identity.

The upstream is a fake that RECORDS headers, so each property is measured as what actually arrived,
not as what the adapter intended to send.
"""
import http.client
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE_PORT = 1341
ADAPTER_PORT = 1342
ADAPTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")
STATE = {"headers": [], "lock": threading.Lock()}


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        self.rfile.read(length) if length else b""
        with STATE["lock"]:
            STATE["headers"].append({k.lower(): v for k, v in self.headers.items()})
        payload = b'{"choices":[{"message":{"role":"assistant","content":"ok"}}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def start_adapter(hint_env):
    env = dict(os.environ)
    env.update({
        "UPSTREAM": "http://127.0.0.1:%d" % FAKE_PORT,
        "ADAPTER_PORT": str(ADAPTER_PORT),
        "FABULA_MAX_CONCURRENT_UPSTREAM": "0",
        "FABULA_STREAM_RETRIES": "0",
    })
    if hint_env is not None:
        env["FABULA_CLIENT_HINT"] = hint_env
    return subprocess.Popen([sys.executable, ADAPTER], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def wait_ready():
    for _ in range(100):
        try:
            c = http.client.HTTPConnection("127.0.0.1", ADAPTER_PORT, timeout=2)
            c.request("GET", "/v1/models")
            c.getresponse().read()
            c.close()
            return True
        except Exception:
            time.sleep(0.1)
    return False


def ask_body(extra_body_fields):
    """Same request, but the declaration travels in the BODY marker instead of the header."""
    payload = {"model": "x", "stream": False, "messages": [{"role": "user", "content": "hi"}]}
    payload.update(extra_body_fields)
    body = json.dumps(payload).encode()
    c = http.client.HTTPConnection("127.0.0.1", ADAPTER_PORT, timeout=15)
    c.request("POST", "/v1/chat/completions", body=body, headers={"Content-Type": "application/json"})
    c.getresponse().read()
    c.close()
    with STATE["lock"]:
        return STATE["headers"][-1] if STATE["headers"] else {}


def ask(extra_headers=None):
    body = json.dumps({"model": "x", "stream": False,
                       "messages": [{"role": "user", "content": "hi"}]}).encode()
    headers = {"Content-Type": "application/json"}
    headers.update(extra_headers or {})
    c = http.client.HTTPConnection("127.0.0.1", ADAPTER_PORT, timeout=15)
    c.request("POST", "/v1/chat/completions", body=body, headers=headers)
    c.getresponse().read()
    c.close()
    with STATE["lock"]:
        return STATE["headers"][-1] if STATE["headers"] else {}


def main():
    threading.Thread(target=lambda: ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake).serve_forever(),
                     daemon=True).start()
    time.sleep(0.4)

    process = start_adapter(None)  # default
    try:
        if not wait_ready():
            print("RESULT: FAIL (adapter never came up)")
            return False
        got = ask()
        default_ok = got.get("x-mtplx-client") == "opencode"
        want = "opencode"
        print(f"  default: x-mtplx-client={got.get('x-mtplx-client')!r} (want {want!r})")
        got2 = ask({"X-MTPLX-Client": "my-own-agent"})
        respect_ok = got2.get("x-mtplx-client") == "my-own-agent"
        print(f"  caller's own hint kept: {got2.get('x-mtplx-client')!r} (want 'my-own-agent')")

        # A request that declares a reasoning level must NOT also claim the managed identity: on a
        # managed surface the runtime takes generation policy away from the client entirely
        # (measured: a client_hint of the "opencode" literal -> client_controls_allowed=False in 230 of 230
        # requests), so keeping both would send a reasoning declaration the runtime discards. This
        # is the whole difference between a knob and a knob nobody turns.
        got4 = ask({"X-Fabula-Reasoning": "off"})
        split_ok = "x-mtplx-client" not in got4
        print(f"  declares a level -> identity withheld: {split_ok} (want True)")
        # ...and the body-marker channel counts the same way as the header.
        got5 = ask_body({"extra_body": {"fabula_reasoning": "off"}})
        split_body_ok = "x-mtplx-client" not in got5
        print(f"  body marker -> identity withheld: {split_body_ok} (want True)")
        # ...while an ordinary agent turn still gets it — the cache win must not be collateral.
        got6 = ask()
        still_ok = got6.get("x-mtplx-client") == "opencode"
        print(f"  ordinary turn still identified: {got6.get('x-mtplx-client')!r} (want {want!r})")
    finally:
        stop(process)

    process = start_adapter("")  # disabled
    try:
        if not wait_ready():
            print("RESULT: FAIL (adapter never came up with hint disabled)")
            return False
        got3 = ask()
        disabled_ok = "x-mtplx-client" not in got3
        print(f"  disabled: header absent={disabled_ok} (want True)")
    finally:
        stop(process)

    passed = default_ok and respect_ok and disabled_ok and split_ok and split_body_ok and still_ok
    print("RESULT:", "PASS" if passed else "FAIL")
    return passed


def test_client_hint():
    assert main(), "see the printed report above for which case failed"


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
