import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

// MEASURED 2026-08-01 in the live log: three MCP startup failures read
//   ENOENT: no such file or directory, posix_spawn '/Users/…/serena'
// while that command was present and answered a full MCP handshake in 0.5s. What was missing was the
// WORKING DIRECTORY — two leftover bench dirs and one deleted test dir. Anyone reading that message goes
// and checks a binary that is fine.
//
// This test pins the FACT the diagnosis rests on, in the platform rather than in our own code: a spawn
// into a removed cwd reports ENOENT and names the COMMAND. If a future runtime ever stopped doing that,
// the special-casing in mcp/index.ts would be dead weight and this test says so.
// The command has to be one THIS system certainly has, and its name has to be the one the message will
// carry. `/bin/echo` is a real file on one family of systems and nothing at all on the other, where the
// check failed at "the command is real" — before it could measure anything about spawning.
const REAL_COMMAND =
  process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe") : "/bin/echo"
const COMMAND_NAME = process.platform === "win32" ? "cmd" : "echo"
const ECHO_ARGS = process.platform === "win32" ? ["/d", "/c", "echo", "hi"] : ["hi"]

describe("a spawn into a removed working directory blames the command", () => {
  test("ENOENT names a binary that certainly exists", () => {
    const gone = mkdtempSync(join(tmpdir(), "mcp-cwd-"))
    rmSync(gone, { recursive: true, force: true })
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(REAL_COMMAND)).toBe(true) // the command is real

    const r = spawnSync(REAL_COMMAND, ECHO_ARGS, { cwd: gone })
    expect(r.error).toBeDefined()
    const msg = String(r.error?.message ?? "")
    expect(msg).toContain("ENOENT")
    // …and this is the trap: the message carries the COMMAND, not the missing directory.
    expect(msg).toContain("echo")
    expect(msg).not.toContain(gone)
  })

  test("the same command in a directory that exists runs fine — so the cwd is the only difference", () => {
    const here = mkdtempSync(join(tmpdir(), "mcp-cwd-ok-"))
    try {
      const r = spawnSync(REAL_COMMAND, ECHO_ARGS, { cwd: here, encoding: "utf8" })
      expect(r.error).toBeUndefined()
      expect(r.stdout.trim()).toBe("hi")
    } finally {
      rmSync(here, { recursive: true, force: true })
    }
  })
})
