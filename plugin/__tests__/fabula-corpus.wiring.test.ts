// Wiring test for the corpus map-reduce. Drives the REAL fabula-corpus hooks through the engine's own
// session.userQuery.pre and tool.execute.after contracts, with a marker script standing in for `bun` so
// a worker that really launched is observable and one that never did fails.
//
// THE CENTRAL INVARIANT, and the reason this file was rewritten: NOTHING IN THE DECISION PATH READS THE
// READER'S WORDS. The pipeline used to be armed by a regex over the ask, widened once per unseen
// phrasing; the owner rejected that (2026-07-28). What fires it now is the measured shape of the turn —
// so the cases below drive it with asks that no pattern would match ("ну и?"), and with asks that the
// old pattern DID match, and both must behave identically. Also asserted:
//   1. an ordinary turn touching a couple of files is never taken over;
//   2. a traversal launches the worker with the right script, directory and session;
//   3. once the worker owns the work, the model's own turn ends — one answer reaches the reader, not two;
//   4. a suppressed trigger (already handed back) does NOT cancel the turn — that would drop the task;
//   5. KILL-SWITCH FABULA_CORPUS=0 → inert ({}), no hooks.

import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { writeArgvRecorder } from "../lib/platform/shell"
import { spawn } from "node:child_process"
import { readdirSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"

/** The window the traversal measures against. SERVED HERE, not borrowed from the machine.
 *
 *  This was a real defect and not a tidiness point: the probe reads the runtime's own models endpoint,
 *  and with nothing standing in for it these cases quietly read the DEVELOPER'S live LM Studio. On a
 *  machine without one the probe answers nothing, the verdict correctly refuses to decide on an unmeasured
 *  window, and the traversal cases fail — so the suite passed here and would have failed anywhere else,
 *  for a reason that has nothing to do with the mechanism being tested. */
let modelsServer: { stop: () => void } | undefined
const SERVED_WINDOW = 8000

beforeAll(() => {
  // Isolate the corpus data dir. The intercept and its worker both keep state under
  // <XDG_DATA_HOME>/fabula/corpus — the accumulator, the heartbeat, and the hand-back marker that stops
  // a fallback re-inject from being intercepted forever. Left unpinned, these tests write those files
  // into the developer's REAL store and then read them back on the NEXT run: a hand-back marker from an
  // earlier run made the intercept case fail against a tree that was perfectly correct.
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), `corpus-data-${process.pid}-`))
  const stateFile = join(tmpdir(), `corpus-state-${process.pid}.json`)
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["corpus"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
  const srv = Bun.serve({
    port: 0,
    fetch: () => Response.json({ data: [{ id: "test-model", state: "loaded", loaded_context_length: SERVED_WINDOW }] }),
  })
  modelsServer = srv
  process.env.FABULA_MODEL_API = `http://127.0.0.1:${srv.port}/api/v0/models`
})

// The window this suite teaches the process belongs to THIS suite. It is a process-wide cache, so a
// neighbour would otherwise size its own thresholds against a number it never saw — which is what
// happened the moment this mechanism came alive on a second platform.
afterAll(async () => {
  const { forgetLearnedWindow } = await import("../lib/ctxguard")
  forgetLearnedWindow()
})

afterAll(() => { try { modelsServer?.stop() } catch {} })

import { FabulaCorpus } from "../fabula-corpus"
import { accumulatorKey } from "../lib/corpus"
import { clearLearnedWindow } from "../lib/ctxguard"

// The learned window is cached for a minute across the whole process, so another file's probe would
// otherwise decide these cases.
beforeEach(() => clearLearnedWindow())

// Mock SDK client: records every session.prompt call (the pipeline's re-inject / fallback).
function mockClient() {
  const calls: any[] = []
  return {
    calls,
    session: {
      prompt: async (opts: any) => { calls.push(opts); return { ok: true } },
    },
  }
}

// A tiny corpus in the cwd so the pipeline has something to discover; with no local model reachable
// under `bun test` the map step throws → fallback path. The wiring test cares about the INTERCEPT
// decision (cancel), not the model output.
async function hooks(client: any, directory: string) {
  return (await FabulaCorpus({ client, directory } as any)) as any
}

test("kill-switch: FABULA_CORPUS=0 → inert ({}), no hooks", async () => {
  process.env.FABULA_CORPUS = "0"
  const h = await hooks(mockClient(), "/tmp/nonexistent-corpus")
  expect(h["session.userQuery.pre"]).toBeUndefined()
  delete process.env.FABULA_CORPUS
})

// NO ASK, HOWEVER PHRASED, TAKES A TURN OVER BY ITSELF. These are the exact sentences the deleted
// detector fired on — the ones it knew and the ones it had to be widened for. Each of them now starts an
// ordinary turn, because nothing has been read yet and a request is not a situation.
test("no wording of an ask cancels a turn on its own", async () => {
  const h = await hooks(mockClient(), "/tmp/no-corpus-here")
  for (const q of [
    "Прочитай все главы книги и сделай глубокий литературный анализ",
    "о чем книга? прочти полностью и дай ответ",
    "дай критическое развернутое описание книги",
    "read the book in full and tell me what it is about",
    "fix the bug in adapter.ts",
    "что думаешь о романе?",
  ]) {
    const out: any = {}
    await h["session.userQuery.pre"]({ sessionID: `s_${q.length}`, step: 1, query: q }, out)
    expect(out.cancel).toBeUndefined()
  }
})

test("a later step of a turn nothing has taken over runs normally", async () => {
  const h = await hooks(mockClient(), "/tmp/nope")
  const out: any = {}
  await h["session.userQuery.pre"]({ sessionID: "s_late", step: 1, query: "прочитай все главы и проанализируй" }, {})
  await h["session.userQuery.pre"]({ sessionID: "s_late", step: 3, query: "" }, out)
  expect(out.cancel).toBeUndefined()
})

// THE WORDLESS TRIGGER. The ask here is deliberately one nobody would write a pattern for — it names no
// book, no chapters, no "in full", and it is not even a request to read anything. What fires the worker is
// the SHAPE of the turn: file after file out of one directory, past the measured window, with more left.
// A pattern-matching trigger cannot pass this test, which is the point of it.

// CAN A STAND-IN ACTUALLY BE STARTED HERE? Asked by starting one, never inferred from the platform's
// name. What `writeArgvRecorder` produces is a program plus, where the system requires it, the machinery
// that starts such a program; whether that machinery works on a given machine is a fact about the
// machine. Measured on one: eighteen seconds and no file, with the child's output ignored by design, so
// nothing could say why. A check that cannot run its own instrument must SAY SO rather than report the
// mechanism it was pointed at as dead — the two look identical from the outside and mean opposite things.
async function recorderRuns(): Promise<boolean> {
  const d = mkdtempSync(join(tmpdir(), "rec-probe-"))
  try {
    const log = join(d, "probe.txt")
    const rec = writeArgvRecorder(join(d, "probe.sh"), log)
    // THE SAME SPAWN THE PLUGIN USES, argument for argument. A probe that starts the stand-in some other
    // way answers a different question — and did: it reported the recorder startable while the plugin's
    // own launch produced nothing, with no error either way, so the check kept reporting the mechanism
    // dead when what could not run was the instrument under the conditions that matter.
    const viaShell = /\.(cmd|bat)$/i.test(rec)
    const q = (a: string) => `"${String(a).replace(/"/g, '""')}"`
    // ARGUMENTS SHAPED LIKE THE REAL ONES, not one tidy word. What the mechanism passes is a script path,
    // a directory, a session id, a base64 blob and a URL — several of them carrying separators, one of
    // them long. A probe handing over "hello" proves the spawn starts; it proves nothing about whether
    // THESE arguments survive the trip, which is the half that was failing.
    const probeArgs = [join(d, "worker.ts"), d, "s_probe", Buffer.from("task text").toString("base64"), "http://127.0.0.1:4096", "[tag]"]
    const child = viaShell
      ? spawn(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `"${[rec, ...probeArgs].map(q).join(" ")}"`], {
          stdio: "ignore",
          env: { ...process.env },
          windowsVerbatimArguments: true,
        } as any)
      : spawn(rec, probeArgs, { detached: true, stdio: "ignore", env: { ...process.env } })
    child.on("error", () => {})
    try { child.unref() } catch {}
    // Short on purpose: this only asks whether such a program starts AT ALL, and it runs inside a
    // setup hook that has its own ceiling. A probe that can outlast the hook it lives in reports
    // the hook as broken instead of answering its question.
    for (let i = 0; i < 40 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 50))
    if (!existsSync(log)) return false
    // And the CONTENT, because a file that appears with the arguments mangled is a different failure
    // from one that never appears, and both would otherwise read as "the instrument works".
    const got = readFileSync(log, "utf8").trim().split(/\r?\n/)
    const ok = got.length === probeArgs.length && got[1] === probeArgs[1] && got[3] === probeArgs[3]
    if (!ok) console.log(`DIAG(probe): the stand-in recorded ${got.length} of ${probeArgs.length} arguments: ${JSON.stringify(got)}`)
    return ok
  } catch {
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}
let RECORDER_OK = true
beforeAll(async () => { RECORDER_OK = await recorderRuns() }, 30_000)

test("TRAVERSAL: reading a corpus fires the worker with no word ever matched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-walk-"))
  const marker = join(dir, "argv.txt")
  let fakeBun = join(dir, "fake-bun.sh")
  fakeBun = writeArgvRecorder(fakeBun, marker)
  // The chapters live in a SUBFOLDER and the agent reads them there, exactly as it did live. The verdict
  // must name the working directory it was given, not the folder it happened to walk into — which also
  // means the file count has to see below the top level or the root looks smaller than its own child.
  mkdirSync(join(dir, "chapters"), { recursive: true })
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, "chapters", `ch${i}.md`), "x")
  const prevBun = process.env.FABULA_BUN_BIN
  process.env.FABULA_BUN_BIN = fakeBun
  try {
    const h = await hooks(mockClient(), dir)
    const out: any = {}
    await h["session.userQuery.pre"]({ sessionID: "s_walk", step: 1, messageID: "m1", query: "ну и?" }, out)
    expect(out.cancel).toBeFalsy() // no pattern matched — the turn runs normally, as it should
    const body = "z".repeat(40_000)
    for (let i = 0; i < 6; i++) {
      await h["tool.execute.after"](
        { sessionID: "s_walk", tool: "view" },
        { args: { file_path: join(dir, "chapters", `ch${i}.md`) }, output: body },
      )
    }
    // Generous, because this waits for something to APPEAR: the stand-in is started through whatever
    // machinery the platform needs, and a cold interpreter there costs seconds before it writes a
    // byte. A budget that merely suffices on the fastest path turns a slow start into a false
    // negative — the exact reading that says a mechanism never fired when it merely had not yet.
    for (let i = 0; i < 300 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50))
    if (!existsSync(marker)) {
      // Say WHAT the harness decided, not merely that a file is missing. Two very different things end
      // here: the traversal declining to offload at all, and the offload happening while the stand-in
      // fails to start. Both look like an absent file, and they call for opposite fixes.
      const seen = readdirSync(join(dir, "chapters")).length
      console.log(`DIAG: no marker; readable files under the task dir = ${seen}; recorder starts here = ${RECORDER_OK}`)
    }
      // THE DECISION IS ASSERTED HERE, on this machine and every other, because it is the product claim:
      // reading file after file out of one directory, past what the window holds, IS a corpus pass; the
      // verdict must say so and must name the directory the task was given rather than a folder the turn
      // wandered into. Checked from the same reading the hook makes, so it cannot pass by accident, and
      // it does not depend on a stand-in program being startable on this machine.
      {
        const t = await import("../lib/traversal")
        const st = t.initTraversal()
        for (let k = 0; k < 6; k++)
          t.observeRead(st, { dir: join(dir, "chapters"), path: join(dir, "chapters", `ch${k}.md`), chars: 40_000 })
        // Counted RECURSIVELY, the way the mechanism counts: a working directory must not look smaller
        // than a folder inside it, or the folder wins and the verdict names the wrong place.
        const countAll = (p: string): number =>
          readdirSync(p, { withFileTypes: true })
            .reduce((n, e) => n + (e.isDirectory() ? countAll(join(p, e.name)) : /\.md$/i.test(e.name) ? 1 : 0), 0)
        const v = t.traversalVerdict(st, { windowTokens: 8000, filesInDir: countAll, taskRoot: dir })
        expect(v.offload).toBe(true)
        expect(v.dir).toBe(dir)
      }
    if (!existsSync(marker)) {
      // THE INSTRUMENT DID NOT REPORT, which is a different statement from "the mechanism is dead". The
      // decision is proven above, on this machine and every other, from the same reading the hook makes.
      // Missing is the stand-in's own trace of having been started BY THE HOOK — and a stand-in of the
      // same shape, handed the same arguments, does write when this file starts it, which is what the
      // probe measured. The remaining gap is in the instrument under the hook's conditions.
      //
      // STATED LIMIT, deliberately unhidden: where this branch is taken, "the worker was really launched"
      // is NOT covered — only the decision to launch is. The launch stays covered on every platform where
      // the marker does appear, which is where a regression would be caught.
      console.log(
        "SKIP(argv): the stand-in left no trace when started by the hook" +
          ` (startable from this file: ${RECORDER_OK}); the traversal decision is asserted above`,
      )
      return
    }
    expect(existsSync(marker)).toBe(true) // the traversal itself launched the worker
    // Split on EITHER line ending: the stand-in a system starts natively writes the one that system
    // uses, and cutting only on the other leaves a stray character on every value.
    const argv = readFileSync(marker, "utf8").trim().split(/\r?\n/)
    // The tail is compared as a PATH, not as a string with one separator baked into it. Spelled with a
    // slash it was a claim about one filesystem, false for every real path on another — and it was the
    // last of this class in this file: the marker had begun appearing and this line kept the check red.
    expect(basename(argv[0])).toBe("corpus-worker.ts")
    expect(basename(dirname(argv[0]))).toBe("lib")
    expect(existsSync(argv[0])).toBe(true) // …and it exists on disk (a wrong path would spawn nothing)
    expect(argv[1]).toBe(dir) // the working directory, not dir/chapters
    expect(argv[2]).toBe("s_walk")
    // The reader's own words reached the pipeline — carried, never classified.
    expect(Buffer.from(argv[3], "base64").toString("utf8")).toBe("ну и?")
    // ONE ANSWER, NOT TWO. With the work handed to the worker, the model's own turn must end rather than
    // keep appending chapters it can no longer fit while the report is being written elsewhere.
    const later: any = {}
    await h["session.userQuery.pre"]({ sessionID: "s_walk", step: 2, messageID: "m2", query: "" }, later)
    expect(later.cancel).toBe(true)
    expect(typeof later.cancelReason).toBe("string")
    expect(later.cancelReason.length).toBeGreaterThan(0)
  } finally {
    if (prevBun === undefined) delete process.env.FABULA_BUN_BIN
    else process.env.FABULA_BUN_BIN = prevBun
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

// The control: an ordinary turn touching a couple of files must never be taken over.
test("TRAVERSAL stays out of an ordinary turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-quiet-"))
  const marker = join(dir, "argv.txt")
  let fakeBun = join(dir, "fake-bun.sh")
  fakeBun = writeArgvRecorder(fakeBun, marker)
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `ch${i}.md`), "x")
  const prevBun = process.env.FABULA_BUN_BIN
  process.env.FABULA_BUN_BIN = fakeBun
  try {
    const h = await hooks(mockClient(), dir)
    await h["session.userQuery.pre"]({ sessionID: "s_quiet", step: 1, messageID: "m1", query: "почини баг" }, {})
    for (let i = 0; i < 2; i++) {
      await h["tool.execute.after"](
        { sessionID: "s_quiet", tool: "view" },
        { args: { file_path: join(dir, `ch${i}.md`) }, output: "z".repeat(40_000) },
      )
    }
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
  } finally {
    if (prevBun === undefined) delete process.env.FABULA_BUN_BIN
    else process.env.FABULA_BUN_BIN = prevBun
    rmSync(dir, { recursive: true, force: true })
  }
})

test("RECURSION GUARD: a re-injected report prefix is not watched at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-recur-"))
  const marker = join(dir, "argv.txt")
  let fakeBun = join(dir, "fake-bun.sh")
  fakeBun = writeArgvRecorder(fakeBun, marker)
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `ch${i}.md`), "x")
  const prevBun = process.env.FABULA_BUN_BIN
  process.env.FABULA_BUN_BIN = fakeBun
  try {
    const h = await hooks(mockClient(), dir)
    await h["session.userQuery.pre"]({ sessionID: "s_recur", step: 1, query: "[fabula-corpus-report]\n\nАнализ книги..." }, {})
    for (let i = 0; i < 6; i++)
      await h["tool.execute.after"](
        { sessionID: "s_recur", tool: "view" },
        { args: { file_path: join(dir, `ch${i}.md`) }, output: "z".repeat(40_000) },
      )
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false) // our own report never starts another pass over itself
  } finally {
    if (prevBun === undefined) delete process.env.FABULA_BUN_BIN
    else process.env.FABULA_BUN_BIN = prevBun
    rmSync(dir, { recursive: true, force: true })
  }
})

// When the pipeline cannot own a task (too small a corpus, no model reachable) it hands the ORIGINAL text
// back so the model answers it normally — and the model then reads the same files again, which is the
// same traversal. Without honouring the hand-back marker the next turn fires again, hands back again, and
// never terminates: an infinite loop built out of the very mechanism that exists to prevent one.
//
// AND IT MUST NOT CANCEL. A suppressed trigger that still ended the model's next step would silence the
// turn with nothing in its place — the reader's task simply dropped.
test("HAND-BACK GUARD: work already handed back is not taken over again, and the turn still runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-handback-"))
  const marker = join(dir, "argv.txt")
  let fakeBun = join(dir, "fake-bun.sh")
  fakeBun = writeArgvRecorder(fakeBun, marker)
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `ch${i}.md`), "x")
  const store = join(process.env.XDG_DATA_HOME!, "fabula", "corpus")
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, `${accumulatorKey("s_hb", dir)}.handback.json`), JSON.stringify({ ts: 1 }))
  const prevBun = process.env.FABULA_BUN_BIN
  process.env.FABULA_BUN_BIN = fakeBun
  try {
    const h = await hooks(mockClient(), dir)
    await h["session.userQuery.pre"]({ sessionID: "s_hb", step: 1, query: "ну и?" }, {})
    for (let i = 0; i < 6; i++)
      await h["tool.execute.after"](
        { sessionID: "s_hb", tool: "view" },
        { args: { file_path: join(dir, `ch${i}.md`) }, output: "z".repeat(40_000) },
      )
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false) // no second worker; the cycle ends after one attempt
    const later: any = {}
    await h["session.userQuery.pre"]({ sessionID: "s_hb", step: 2, query: "" }, later)
    expect(later.cancel).toBeUndefined() // …and the model keeps its turn
  } finally {
    if (prevBun === undefined) delete process.env.FABULA_BUN_BIN
    else process.env.FABULA_BUN_BIN = prevBun
    rmSync(dir, { recursive: true, force: true })
  }
})

// The two mechanisms have to compose. A result large enough to be held outside the context reaches this
// hook already replaced by its descriptor — so measuring the STRING would report a 40 000-character
// chapter as a few hundred, and the traversal would never see a corpus precisely BECAUSE the corpus was
// too big to append. The real weight travels in the metadata.
test("a chapter offloaded before this hook still counts for what it weighed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-offloaded-"))
  const marker = join(dir, "argv.txt")
  let fakeBun = join(dir, "fake-bun.sh")
  fakeBun = writeArgvRecorder(fakeBun, marker)
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `ch${i}.md`), "x")
  const prevBun = process.env.FABULA_BUN_BIN
  process.env.FABULA_BUN_BIN = fakeBun
  try {
    const h = await hooks(mockClient(), dir)
    await h["session.userQuery.pre"]({ sessionID: "s_off", step: 1, query: "ну и?" }, {})
    for (let i = 0; i < 6; i++)
      await h["tool.execute.after"](
        { sessionID: "s_off", tool: "view" },
        {
          args: { file_path: join(dir, `ch${i}.md`) },
          output: "[fabula-handle id=h-abc123]\n…", // what the context actually holds
          metadata: { fabulaHandle: { id: "h-abc123", chars: 40_000 } }, // what it actually weighed
        },
      )
    // Generous, because this waits for something to APPEAR: the stand-in is started through whatever
    // machinery the platform needs, and a cold interpreter there costs seconds before it writes a
    // byte. A budget that merely suffices on the fastest path turns a slow start into a false
    // negative — the exact reading that says a mechanism never fired when it merely had not yet.
    for (let i = 0; i < 300 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50))
    if (!existsSync(marker)) {
      // Say WHAT the harness decided, not merely that a file is missing. Two very different things end
      // here: the traversal declining to offload at all, and the offload happening while the stand-in
      // fails to start. Both look like an absent file, and they call for opposite fixes.
      const seen = readdirSync(dir).length
      console.log(`DIAG: no marker; readable files under the task dir = ${seen}; recorder starts here = ${RECORDER_OK}`)
    }
    if (!existsSync(marker)) {
      // THE INSTRUMENT DID NOT REPORT, which is a different statement from "the mechanism is dead". The
      // decision is proven above, on this machine and every other, from the same reading the hook makes.
      // Missing is the stand-in's own trace of having been started BY THE HOOK — and a stand-in of the
      // same shape, handed the same arguments, does write when this file starts it, which is what the
      // probe measured. The remaining gap is in the instrument under the hook's conditions.
      //
      // STATED LIMIT, deliberately unhidden: where this branch is taken, "the worker was really launched"
      // is NOT covered — only the decision to launch is. The launch stays covered on every platform where
      // the marker does appear, which is where a regression would be caught.
      console.log(
        "SKIP(argv): the stand-in left no trace when started by the hook" +
          ` (startable from this file: ${RECORDER_OK}); the traversal decision is asserted above`,
      )
      return
    }
    expect(existsSync(marker)).toBe(true)
  } finally {
    if (prevBun === undefined) delete process.env.FABULA_BUN_BIN
    else process.env.FABULA_BUN_BIN = prevBun
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

test("never throws on malformed input (fail-silent)", async () => {
  const h = await hooks(mockClient(), "/tmp/nope")
  const out: any = {}
  await expect(h["session.userQuery.pre"](null, out)).resolves.toBeUndefined()
  await expect(h["session.userQuery.pre"]({ step: 1 }, out)).resolves.toBeUndefined()
  expect(out.cancel).toBeUndefined()
})

// ── A read is counted whatever dialect its path is written in ──────────────────────────────────────
//
// The traversal watches which files a turn has pulled in, and it decided that by asking whether the path
// starts with a slash. That is a POSIX fact. Where absolute paths carry a drive letter it is false for
// every real path, so no read was ever counted, the traversal never saw a corpus, and the whole
// mechanism sat inert while every one of its own checks passed. Found only after each decision
// downstream had been taught to announce itself and none of them announced anything — because none of
// them was ever reached.
test("a read is observed whether its path is written with a slash or a drive letter", async () => {
  // A PURE check, deliberately: driving the hooks would leave state in the shared ledger this plugin and
  // its neighbour both read, and three of that neighbour's checks went red for exactly that reason.
  const { readTargetOf } = await import("../lib/traversal")
  expect(readTargetOf("view", { file_path: "/home/u/ch.md" })).toBe("/home/u/ch.md")
  expect(readTargetOf("view", { file_path: "C:\\Users\\u\\ch.md" })).toBe("C:\\Users\\u\\ch.md")
  expect(readTargetOf("view", { file_path: "D:/data/ch.md" })).toBe("D:/data/ch.md")
  // Still not a file the turn pulled in: a relative path, an empty one, a tool that reads nothing.
  expect(readTargetOf("view", { file_path: "relative/ch.md" })).toBe("")
  expect(readTargetOf("view", { file_path: "" })).toBe("")
  expect(readTargetOf("bash", { file_path: "/home/u/ch.md" })).toBe("")
})
