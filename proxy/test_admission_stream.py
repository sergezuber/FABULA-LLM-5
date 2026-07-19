# Durable guards for the adapter's admission-control STREAMING edges — the paths a unit test of the
# gate class cannot see, because they only exist on the real request path:
#
#   1. A queued streaming client whose keepalive already committed the 200/SSE response, followed by an
#      upstream ERROR. The error must travel as an in-band SSE event and the chunked body must terminate
#      properly. The broken shape — a second raw HTTP status line written into the committed body — is
#      exactly the byte-fusing class the SSE-framing fix in the adapter exists to prevent, and it shipped
#      here once before being caught by an independent verifier against the live server.
#   2. A GET (the app's own liveness probe is `GET /v1/models`) must neither crash nor queue behind a
#      generation. It once crashed with UnboundLocalError because only the POST branch bound `j`, and
#      neither a 62-case suite nor two verification passes had exercised a single GET.
#
# Run: python3 -m pytest test_admission_stream.py -q -p no:docker
import http.client
import importlib.util
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class FakeUpstream(BaseHTTPRequestHandler):
    """POST /chat/completions: body containing "boom" -> HTTP 400; otherwise a short SSE stream held
    open long enough that a second client genuinely queues. GET -> instant model list."""

    hold = 1.2

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
        if b"boom" in body:
            msg = json.dumps({"error": "'messages' array must contain valid roles"}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for i in range(4):
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"tok%d"}}]}\n\n' % i)
            self.wfile.flush()
            time.sleep(self.hold / 4)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self):
        msg = b'{"data":[{"id":"fake-model"}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        self.wfile.write(msg)

    def log_message(self, *a):
        pass


class Rig:
    """The REAL adapter Handler on a real socket, its upstream pointed at the fake above."""

    def __enter__(self):
        self.up = ThreadingHTTPServer(("127.0.0.1", _free_port()), FakeUpstream)
        threading.Thread(target=self.up.serve_forever, daemon=True).start()
        old = {k: os.environ.get(k) for k in ("UPSTREAM", "FABULA_MAX_CONCURRENT_UPSTREAM")}
        os.environ["UPSTREAM"] = "http://127.0.0.1:%d" % self.up.server_address[1]
        os.environ["FABULA_MAX_CONCURRENT_UPSTREAM"] = "1"
        self._old = old
        spec = importlib.util.spec_from_file_location("adapter_under_test", HERE / "lmstudio-adapter.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["adapter_under_test"] = mod
        spec.loader.exec_module(mod)
        self.srv = ThreadingHTTPServer(("127.0.0.1", _free_port()), mod.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        for s in (self.srv, self.up):
            try:
                s.shutdown()
                s.server_close()
            except Exception:
                pass
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        sys.modules.pop("adapter_under_test", None)
        return False

    def raw_post(self, payload, timeout=30):
        """POST and capture the RAW bytes of the response, so a fused second status line cannot hide
        behind a lenient client."""
        body = json.dumps(payload).encode()
        s = socket.create_connection(("127.0.0.1", self.port), timeout=timeout)
        s.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                  b"Content-Length: %d\r\nConnection: close\r\n\r\n%s" % (len(body), body))
        out = b""
        try:
            while True:
                b_ = s.recv(65536)
                if not b_:
                    break
                out += b_
        except socket.timeout:
            pass
        s.close()
        return out


def stream_msgs(text):
    return {"model": "m", "stream": True, "max_tokens": 8,
            "messages": [{"role": "system", "content": "S" * 400}, {"role": "user", "content": text}]}


def test_queued_stream_upstream_error_stays_single_response():
    """THE D1 GUARD. Client B queues behind A; B's request draws an upstream 400 AFTER B's keepalive
    committed the 200/SSE response. B must see ONE status line, the error as SSE data, and a properly
    terminated chunked body — never a second raw HTTP response fused into the stream."""
    with Rig() as rig:
        results = {}

        def first():
            results["a"] = rig.raw_post(stream_msgs("fine"))

        ta = threading.Thread(target=first)
        ta.start()
        time.sleep(0.35)                                   # A holds the slot; B will queue
        results["b"] = rig.raw_post(stream_msgs("boom"))   # upstream 400 for B, after B queued
        ta.join()

        raw = results["b"]
        assert raw.count(b"HTTP/1.1") == 1, "a second HTTP status line was fused into the body:\n%r" % raw
        assert b"upstream-error-after-keepalive" in raw or b'"error"' in raw, \
            "the upstream error never reached the client as an SSE event:\n%r" % raw
        assert b"data: [DONE]" in raw, "the SSE stream was not finished cleanly:\n%r" % raw
        assert b"0\r\n\r\n" in raw, "the chunked body was never terminated:\n%r" % raw
        # and the healthy first client got a complete ordinary stream
        assert results["a"].count(b"HTTP/1.1") == 1 and b"data: [DONE]" in results["a"]


def test_get_survives_and_bypasses_the_gate():
    """THE LIVENESS GUARD. A GET must not crash (`j` is bound only in the POST branch) and must not
    queue behind a generation — `GET /v1/models` is how the app decides the adapter is alive."""
    with Rig() as rig:
        hold = threading.Thread(target=lambda: rig.raw_post(stream_msgs("fine")))
        hold.start()
        time.sleep(0.3)                    # the generation now holds the only slot
        t0 = time.time()
        c = http.client.HTTPConnection("127.0.0.1", rig.port, timeout=10)
        c.request("GET", "/v1/models")
        r = c.getresponse()
        body = r.read()
        dt = time.time() - t0
        hold.join()
        assert r.status == 200, "GET failed: %s %r" % (r.status, body)
        assert b"fake-model" in body
        assert dt < 0.8, "the liveness GET queued behind the generation (%.2fs)" % dt
