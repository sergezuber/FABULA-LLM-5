import { test, expect } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { defaultSandboxConfig, buildSeatbeltProfile, sandboxArgv } from "./sandbox"

test("profile denies reading secret dirs and writing secret files", () => {
  const p = buildSeatbeltProfile(defaultSandboxConfig("/Users/x"))
  expect(p).toContain("(version 1)")
  expect(p).toContain("(allow default)")
  expect(p).toContain("file-read*")
  expect(p).toContain('(subpath "/Users/x/.ssh")')
  expect(p).toContain("file-write*")
  // NOT `toContain('\.env$')` — in a JS string literal that IS `.env$`, so the old assertion passed
  // against the broken `\\.env$` output too. The doubled backslash is the defect; name it exactly.
  expect(p).toContain('(regex #"\\.env$")')
  expect(p).not.toContain('\\\\.env$')
})

test("sandboxArgv shape", () => {
  expect(sandboxArgv("echo hi", "(version 1)(allow default)")).toEqual(["sandbox-exec", "-p", "(version 1)(allow default)", "bash", "-lc", "echo hi"])
})

// LIVE: the kernel actually blocks a read of a "secret" dir but allows a normal command.
const hasSbx = existsSync("/usr/bin/sandbox-exec")
test.if(hasSbx)("kernel BLOCKS read of a denied dir, ALLOWS a normal command", () => {
  // realpath: Seatbelt matches the CANONICAL path; tmpdir() on macOS is a /var -> /private/var symlink.
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "sbx-home-")))
  mkdirSync(path.join(home, ".ssh"))
  writeFileSync(path.join(home, ".ssh", "id_rsa"), "TOPSECRET")
  const profile = buildSeatbeltProfile(defaultSandboxConfig(home))
  // normal command works
  const ok = spawnSync("sandbox-exec", ["-p", profile, "bash", "-lc", "echo alive"], { encoding: "utf8" })
  expect(ok.status).toBe(0)
  expect(ok.stdout.trim()).toBe("alive")
  // reading the denied secret is blocked by the kernel (non-zero exit; no secret leaked to stdout)
  const blocked = spawnSync("sandbox-exec", ["-p", profile, "bash", "-lc", `cat ${path.join(home, ".ssh", "id_rsa")}`], { encoding: "utf8" })
  expect(blocked.status).not.toBe(0)
  expect(blocked.stdout).not.toContain("TOPSECRET")
})

// LIVE: the WRITE half. MEASURED 2026-08-01 that four of the six write rules never matched — .env, .key,
// .pem and .p12 files were all created inside the sandbox — because the regex literals were escaped with
// the STRING escaper. Only the kernel can answer whether a profile denies anything, so only the kernel is
// asked. The two controls are what keep this from passing on a profile that simply denies everything.
test.if(hasSbx)("kernel BLOCKS writing every secret file shape, and still allows ordinary files", () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "sbx-w-")))
  const profile = buildSeatbeltProfile(defaultSandboxConfig(home))
  const wrote = (name: string): boolean => {
    const target = path.join(home, name)
    spawnSync("sandbox-exec", ["-p", profile, "bash", "-lc", `echo hi > '${target}'`], { encoding: "utf8" })
    return existsSync(target)
  }
  for (const secret of ["x.env", "x.key", "x.pem", "x.p12", "id_rsa", "id_ed25519"]) {
    expect(`${secret}:${wrote(secret)}`).toBe(`${secret}:false`)
  }
  for (const ordinary of ["notes.txt", "main.ts"]) {
    expect(`${ordinary}:${wrote(ordinary)}`).toBe(`${ordinary}:true`)
  }
})
