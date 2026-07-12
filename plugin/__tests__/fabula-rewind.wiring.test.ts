// Wiring test: drives the REAL auto-rewind hook against a REAL shadow-git workspace (no mocks).
// A green verify_done snapshots the good file state; two consecutive red verifies then trigger an
// ATOMIC file restore back to that snapshot plus a steer on the verify result. This proves LOCK 4
// end-to-end: the harness (not the model) reverts the regression and the real .git is never touched.
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { FabulaRewind } from "../fabula-rewind"

async function hooks(dir: string) {
  return (await FabulaRewind({ directory: dir } as any)) as any
}

test("plugin is enabled by default and exposes the after-hook", async () => {
  const h = await hooks(mkdtempSync(path.join(tmpdir(), "fab-rw-")))
  expect(typeof h["tool.execute.after"]).toBe("function")
})

test("green snapshot, then 2 reds → files restored to the green state + steer planted", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  const file = path.join(ws, "code.py")
  writeFileSync(file, "GOOD\n")
  const h = await hooks(ws)
  const sid = "s-rewind"

  // 1) GREEN verify — captures the good state.
  await h["tool.execute.after"](
    { tool: "verify_done", sessionID: sid, args: {} },
    { output: "✅ VERIFIED DONE", metadata: { passed: true } },
  )

  // model regresses the file
  writeFileSync(file, "BROKEN attempt 1\n")

  // 2) first RED — advances streak, no rewind yet
  const o1 = { output: "❌ FAILED — AssertionError: expected GOOD", metadata: { passed: false } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o1)
  expect(o1.output).not.toContain("AUTO-REWIND")
  expect(readFileSync(file, "utf8")).toBe("BROKEN attempt 1\n") // untouched after a single red

  // model digs deeper
  writeFileSync(file, "BROKEN attempt 2\n")

  // 3) second RED — triggers atomic restore + steer
  const o2 = { output: "❌ FAILED — AssertionError: still wrong", metadata: { passed: false } as any }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o2)
  expect(o2.output).toContain("AUTO-REWIND")
  expect(o2.output).toContain("DIFFERENT approach")
  expect(o2.metadata.autoRewind).toBeTruthy()
  // FILES actually reverted to the last green state
  expect(readFileSync(file, "utf8")).toBe("GOOD\n")
  // the real user .git was never created by the shadow store
  let hasRealGit = true
  try { readFileSync(path.join(ws, ".git", "HEAD")) } catch { hasRealGit = false }
  expect(hasRealGit).toBe(false)

  rmSync(ws, { recursive: true, force: true })
})

test("a green between reds prevents the rewind", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  writeFileSync(path.join(ws, "x.py"), "v1\n")
  const h = await hooks(ws)
  const sid = "s-recover"
  const green = () => h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "✅", metadata: { passed: true } })
  const red = async () => { const o = { output: "❌ fail", metadata: { passed: false } as any }; await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o); return o }

  await green()
  await red()
  await green()   // recovered — streak reset
  const o = await red()
  expect(o.output).not.toContain("AUTO-REWIND") // only 1 red since the last green
  rmSync(ws, { recursive: true, force: true })
})

test("rewind also removes files CREATED after the green snapshot (tracked via the before-hook)", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  const file = path.join(ws, "code.py")
  writeFileSync(file, "GOOD\n")
  const h = await hooks(ws)
  const sid = "s-created"
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "✅", metadata: { passed: true } })
  // model creates a NEW broken file (before-hook sees it does not exist yet) and edits the old one
  await h["tool.execute.before"]({ tool: "create_file", sessionID: sid, args: { file_path: "bad_new.py" } })
  writeFileSync(path.join(ws, "bad_new.py"), "BROKEN\n")
  writeFileSync(file, "BROKEN\n")
  for (let i = 0; i < 2; i++)
    await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "❌ fail", metadata: { passed: false } as any })
  expect(readFileSync(file, "utf8")).toBe("GOOD\n") // tracked file restored
  let stillThere = true
  try { readFileSync(path.join(ws, "bad_new.py")) } catch { stillThere = false }
  expect(stillThere).toBe(false) // the created file is GONE — the green state is truly back
  rmSync(ws, { recursive: true, force: true })
})

test("a green-era file deleted then re-created during the red streak SURVIVES the rewind (not unlinked)", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  const a = path.join(ws, "a.py")
  writeFileSync(a, "GREEN-A\n")
  const h = await hooks(ws)
  const sid = "s-recreate"
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "✅", metadata: { passed: true } })
  // model deletes a.py (a green-era file) then re-creates it via an edit tool during the red streak
  rmSync(a)
  await h["tool.execute.before"]({ tool: "write", sessionID: sid, args: { file_path: "a.py" } })
  writeFileSync(a, "REWRITTEN-A\n")
  for (let i = 0; i < 2; i++)
    await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "❌ fail", metadata: { passed: false } as any })
  // a.py is part of the green state → must be RESTORED to green content, never deleted
  expect(readFileSync(a, "utf8")).toBe("GREEN-A\n")
  rmSync(ws, { recursive: true, force: true })
})

test("bash heredoc/tee-created file is removed on rewind (bash creations tracked)", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  writeFileSync(path.join(ws, "code.py"), "GOOD\n")
  const h = await hooks(ws)
  const sid = "s-bash"
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "✅", metadata: { passed: true } })
  await h["tool.execute.before"]({ tool: "bash", sessionID: sid, args: { command: "cat > sitecustomize.py <<'EOF'\nimport broken\nEOF" } })
  writeFileSync(path.join(ws, "sitecustomize.py"), "import broken\n")
  writeFileSync(path.join(ws, "code.py"), "BROKEN\n")
  for (let i = 0; i < 2; i++)
    await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "❌ fail", metadata: { passed: false } as any })
  let gone = true
  try { readFileSync(path.join(ws, "sitecustomize.py")) } catch { gone = false }
  expect(gone).toBe(false) // the bash-created file is removed — green really restored
  rmSync(ws, { recursive: true, force: true })
})

test("successful rewind carries redStreak into the banner and metadata.autoRewind.reverted", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  writeFileSync(path.join(ws, "code.py"), "GOOD\n")
  const h = await hooks(ws)
  const sid = "s-streak"
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "✅", metadata: { passed: true } })
  writeFileSync(path.join(ws, "code.py"), "BROKEN\n")
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "❌ fail", metadata: { passed: false } as any })
  const o = { output: "❌ fail again", metadata: { passed: false } as any }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toContain("AUTO-REWIND")
  expect(o.output).not.toContain("undefined")
  expect(o.metadata.autoRewind).toBeTruthy()
  expect(typeof o.metadata.autoRewind.reverted).toBe("number")
  expect(o.metadata.autoRewind.reverted).toBe(2)
  rmSync(ws, { recursive: true, force: true })
})

test("verify that never RAN (no passed key) does not advance the streak", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  writeFileSync(path.join(ws, "x.py"), "v1\n")
  const h = await hooks(ws)
  const sid = "s-notrun"
  // 10 "no verification command detected" results (plain string → engine metadata has no `passed`)
  for (let i = 0; i < 10; i++) {
    const o = { output: "verify_done: no verification command detected in /tmp", metadata: { truncated: false } as any }
    await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
    expect(o.output).not.toContain("NOT DONE — terminal verdict")
    expect(o.output).not.toContain("AUTO-REWIND")
  }
  rmSync(ws, { recursive: true, force: true })
})

test("failed restore is reported honestly — no 'files are back' lie, no autoRewind metadata", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  const store = mkdtempSync(path.join(tmpdir(), "fab-ckstore-"))
  const prevStore = process.env.FABULA_CHECKPOINT_DIR
  process.env.FABULA_CHECKPOINT_DIR = store
  try {
    writeFileSync(path.join(ws, "code.py"), "GOOD\n")
    const h = await hooks(ws)
    const sid = "s-storegone"
    await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, { output: "✅", metadata: { passed: true } })
    rmSync(store, { recursive: true, force: true }) // the checkpoint store vanishes mid-session
    writeFileSync(path.join(ws, "code.py"), "BROKEN\n")
    const o = { output: "❌ fail", metadata: { passed: false } as any }
    await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
    const o2 = { output: "❌ fail again", metadata: { passed: false } as any }
    await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o2)
    // the rewind attempt must NOT claim success
    expect(o2.output).not.toContain("Files are back")
    expect(o2.metadata.autoRewind).toBeUndefined()
    expect(o2.output).toContain("files were NOT reverted")
    expect(readFileSync(path.join(ws, "code.py"), "utf8")).toBe("BROKEN\n") // and indeed nothing moved
  } finally {
    if (prevStore === undefined) delete process.env.FABULA_CHECKPOINT_DIR
    else process.env.FABULA_CHECKPOINT_DIR = prevStore
    rmSync(ws, { recursive: true, force: true })
  }
})

test("never-green run reaches the explicit terminal NOT DONE verdict (no silent loop)", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "fab-rw-"))
  writeFileSync(path.join(ws, "x.py"), "broken\n")
  const h = await hooks(ws)
  const sid = "s-notdone"
  const red = async (n: number) => {
    const o = { output: `❌ FAILED — AssertionError: attempt ${n}`, metadata: { passed: false } as any }
    await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
    return o
  }

  // reds below the terminal threshold stay quiet (default FABULA_NOTDONE_THRESHOLD = 4)
  for (let i = 1; i <= 3; i++) {
    const o = await red(i)
    expect(o.output).not.toContain("NOT DONE — terminal verdict")
  }
  // the 4th red with no green anchor surfaces the honest verdict on the real tool output
  const o4 = await red(4)
  expect(o4.output).toContain("❌ NOT DONE — terminal verdict")
  expect(o4.output).toContain("none has ever passed")
  expect(o4.output).toContain("done is a proof, not a feeling")
  expect(o4.metadata.notDone).toBeTruthy()
  expect(o4.metadata.notDone.redStreak).toBe(4)
  // no rewind happened (there was nothing to rewind to) and files were never touched
  expect(o4.output).not.toContain("AUTO-REWIND")
  expect(readFileSync(path.join(ws, "x.py"), "utf8")).toBe("broken\n")
  rmSync(ws, { recursive: true, force: true })
})
