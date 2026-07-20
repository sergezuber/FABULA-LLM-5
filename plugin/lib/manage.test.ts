// Unit tests for the enable/disable state and who is allowed to change it (lib/manage.ts).
//
// The supervision layer is only a guarantee if the thing it supervises cannot switch it off. These tests
// cover that boundary — and equally that the OWNER is never locked out, because a switch the owner cannot
// reach would be a different failure, not a safer one.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isEnabled, setEnabled, readState, AGENT_PROTECTED } from "./manage"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fab-manage-"))
  process.env.FABULA_PLUGIN_STATE = path.join(dir, "fabula-state.json")
  delete process.env.FABULA_DISABLE
})
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  delete process.env.FABULA_PLUGIN_STATE
  delete process.env.FABULA_DISABLE
})

test("the agent cannot disable any part of the supervision layer", () => {
  for (const id of AGENT_PROTECTED) {
    expect(() => setEnabled(id, false, "agent")).toThrow()
    expect(isEnabled(id)).toBe(true)
  }
})

test("the refusal is loud, not silent", () => {
  // A silent no-op would look to the caller exactly like success, so an attempt to disarm the layer would
  // never surface anywhere a human reads.
  let message = ""
  try { setEnabled("security", false, "agent") } catch (e) { message = (e as Error).message }
  expect(message).toContain("supervision layer")
  expect(message).toContain("owner")
})

test("the OWNER may still disable anything — this is about who is asking", () => {
  for (const id of AGENT_PROTECTED) {
    setEnabled(id, false, "owner")
    expect(isEnabled(id)).toBe(false)
    setEnabled(id, true, "owner")
    expect(isEnabled(id)).toBe(true)
  }
})

test("the owner is the default caller, so existing call sites keep working", () => {
  setEnabled("security", false)
  expect(isEnabled("security")).toBe(false)
})

test("the agent may still toggle everything else, including turning things ON", () => {
  setEnabled("browser", false, "agent")
  expect(isEnabled("browser")).toBe(false)
  setEnabled("browser", true, "agent")
  expect(isEnabled("browser")).toBe(true)
  // enabling a protected plugin is never refused — the rule is one-directional
  expect(() => setEnabled("security", true, "agent")).not.toThrow()
})

test("a refused toggle leaves the state file untouched", () => {
  setEnabled("browser", false, "owner")
  const before = readFileSync(process.env.FABULA_PLUGIN_STATE!, "utf8")
  try { setEnabled("rewind", false, "agent") } catch {}
  expect(readFileSync(process.env.FABULA_PLUGIN_STATE!, "utf8")).toBe(before)
})

test("state writes are exact: enabling removes the id from disabled rather than shadowing it", () => {
  setEnabled("browser", false, "owner")
  expect(readState().disabled).toContain("browser")
  setEnabled("browser", true, "owner")
  expect(readState().disabled).not.toContain("browser")
})

test("FABULA_DISABLE still switches a protected plugin off — it is an owner channel", () => {
  // The env var is set by whoever launches the process, which is not the run. Locking it would take the
  // switch away from the owner without taking it away from anyone else.
  process.env.FABULA_DISABLE = "security"
  expect(isEnabled("security")).toBe(false)
})
