#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE_PORT = 1333
ADAPTER_PORT = 1338
ADAPTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")
STATE = {"closed": threading.Event()}


def sse(delta):
    return ('data: {"choices":[{"delta":' + json.dumps({"content": delta}) + '}]}\n\n').encode()


def write_fragmented(handler, event):
    split = event.index(b'"content"') + len(b'"cont')
    handler.wfile.write(event[:split])
    handler.wfile.flush()
    time.sleep(0.002)
    handler.wfile.write(event[split:])
    handler.wfile.flush()


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        degenerate = b"DEGENERATE" in body
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            if degenerate:
                for i in range(10000):
                    write_fragmented(self, sse("глава_10" + format(i, "x")))
            else:
                for i in range(100):
                    self.wfile.write(sse("Sentence number %d about a different topic. " % i))
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            if degenerate:
                STATE["closed"].set()


def run_fake():
    ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake).serve_forever()


def post(degenerate, timeout=40):
    content = "DEGENERATE" if degenerate else "write 100 different sentences"
    data = json.dumps({"model": "x", "stream": True, "messages": [{"role": "user", "content": content}]}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:%d/v1/chat/completions" % ADAPTER_PORT,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    received = b""
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
        for line in response:
            received += line
            if b"[DONE]" in received:
                break
        return time.time() - started, response.status, received
    except Exception as err:
        return time.time() - started, -1, received + (" ERR:%s" % str(err)[:40]).encode()


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main():
    threading.Thread(target=run_fake, daemon=True).start()
    time.sleep(0.4)
    env = dict(os.environ)
    env.update({
        "UPSTREAM": "http://127.0.0.1:%d" % FAKE_PORT,
        "ADAPTER_PORT": str(ADAPTER_PORT),
        "FABULA_STREAM_IDLE_TIMEOUT": "30",
        "FABULA_FIRST_TOKEN_TIMEOUT": "30",
        "FABULA_STREAM_RETRIES": "0",
    })
    process = subprocess.Popen([sys.executable, ADAPTER], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        time.sleep(0.8)
        STATE["closed"].clear()
        a_time, _, a_body = post(degenerate=True)
        upstream_closed = STATE["closed"].wait(2)
        b_time, b_status, b_body = post(degenerate=False)
    finally:
        stop(process)
    logs = process.stderr.read().decode(errors="replace")
    detections = [line for line in logs.splitlines() if "degeneration detected" in line]
    ok_a = b"[DONE]" in a_body and a_time < 10 and upstream_closed and len(detections) == 1
    ok_b = b_status == 200 and b"Sentence number 99" in b_body and b"[DONE]" in b_body
    print("A degenerate-stream: %.1fs done=%s upstream_closed=%s logs=%d ok=%s" % (
        a_time, b"[DONE]" in a_body, upstream_closed, len(detections), ok_a))
    print("B normal-stream: %.1fs status=%d complete=%s ok=%s" % (
        b_time, b_status, b"Sentence number 99" in b_body, ok_b))
    print("RESULT:", "PASS" if ok_a and ok_b else "FAIL")
    sys.exit(0 if ok_a and ok_b else 1)


if __name__ == "__main__":
    main()
