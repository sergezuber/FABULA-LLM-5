#!/usr/bin/env python3
"""Test the adapter idle-watchdog against a fake stalling/normal upstream, on BOTH the streaming and
the non-streaming path (the latter used to have only a single 900s socket timeout — a mid-body stall
wedged the turn for the full 15 min; now it is idle-watchdogged with the first-token/inter-token split)."""
import json, os, socket, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE_PORT = 1330
ADAPTER_PORT = 1336
ADAPTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")

class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(n) if n else b""
        stall = b"STALL" in body
        try:
            stream = bool(json.loads(body).get("stream"))
        except Exception:
            stream = True
        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            if stall:
                time.sleep(30)   # silence longer than idle timeout -> adapter must cut it
                return
            for i in range(3):
                self.wfile.write(('data: {"choices":[{"delta":{"content":"tok%d "}}]}\n\n' % i).encode())
                self.wfile.flush(); time.sleep(0.15)
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
            return
        # non-streaming: send a complete JSON completion (or stall before the body)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.end_headers()
        if stall:
            time.sleep(30)   # never send the body -> adapter's non-stream watchdog must cut it
            return
        payload = json.dumps({"choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}],
                              "usage": {"completion_tokens": 1, "prompt_tokens": 1}}).encode()
        self.wfile.write(payload); self.wfile.flush()

def run_fake():
    ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake).serve_forever()

def post(stream=True, stall=False, timeout=40):
    content = "STALL" if stall else "hi"
    data = json.dumps({"model":"x","stream":stream,"messages":[{"role":"user","content":content}]}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{ADAPTER_PORT}/v1/chat/completions",
                                 data=data, headers={"Content-Type":"application/json"}, method="POST")
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        st, out = r.status, r.read().decode(errors="replace")   # read fully BEFORE measuring elapsed
        return time.time()-t0, st, out
    except urllib.error.HTTPError as e:
        code, out = e.code, e.read().decode(errors="replace")
        return time.time()-t0, code, out
    except Exception as e:
        return time.time()-t0, -1, f"ERR:{e}"

def main():
    threading.Thread(target=run_fake, daemon=True).start()
    time.sleep(0.4)
    env = dict(os.environ)
    env.update({"UPSTREAM": f"http://127.0.0.1:{FAKE_PORT}", "ADAPTER_PORT": str(ADAPTER_PORT),
                "FABULA_STREAM_IDLE_TIMEOUT": "2", "FABULA_FIRST_TOKEN_TIMEOUT": "3",
                "FABULA_STREAM_RETRIES": "1"})
    p = subprocess.Popen([sys.executable, ADAPTER], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    time.sleep(0.8)
    results = []
    try:
        # B: normal streaming passes through
        dt, st, out = post(stream=True, stall=False)
        okB = "tok0" in out and "tok2" in out and "[DONE]" in out
        print(f"B normal-stream:   {dt:.1f}s status={st} ok={okB}  got={out[:50]!r}")
        results.append(okB)
        # A: stall (before first byte) -> retries=1 then clean [DONE], well under the 30s fake sleep
        dt, st, out = post(stream=True, stall=True)
        okA = dt < 14 and "[DONE]" in out   # first_token=3 * (1 retry + 1) = ~6s, << 30s
        print(f"A stall-stream:    {dt:.1f}s status={st} ok={okA}  ended={'[DONE]' in out}  (cut from 30s)")
        results.append(okA)
        # C: normal non-streaming buffers + returns the JSON completion
        dt, st, out = post(stream=False, stall=False)
        okC = st == 200 and "hello" in out
        print(f"C normal-nostream: {dt:.1f}s status={st} ok={okC}  got={out[:50]!r}")
        results.append(okC)
        # D: non-streaming stall before body -> 504 after ~first_token(3s), NOT the 900s ceiling
        dt, st, out = post(stream=False, stall=True)
        okD = st == 504 and dt < 10
        print(f"D stall-nostream:  {dt:.1f}s status={st} ok={okD}  (504 after ~3s, cut from 900s)")
        results.append(okD)
        print("RESULT:", "PASS" if all(results) else "FAIL")
    finally:
        p.terminate()
        err = p.stderr.read().decode(errors="replace")
        idl = [l for l in err.splitlines() if "idle-timeout" in l]
        if idl: print("watchdog log:", idl[:3])
    sys.exit(0 if all(results) else 1)

if __name__ == "__main__":
    main()
