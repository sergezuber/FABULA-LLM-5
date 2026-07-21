// Guards the checkpoint-writer's READ scope.
//
// Measured failure this pins (reproduced end-to-end twice, with unique markers planted in the corpus and
// then found inside the writer's own session — so this is what it read, not a guess about what it might):
// the checkpoint-writer, whose entire job is to write a state summary from the transcript it is handed,
// instead read the project DIRECTORY and then every corpus file. On a small corpus it survived and wrote
// a partial checkpoint; on a real one (18 chapters) it exhausted its context and never reached the write,
// leaving all 11 sections of checkpoint.md as "(none yet)". The harness then reset the conversation onto
// that empty checkpoint and the main agent restarted its task from zero. Eight writers ran for that
// session; none produced state.
//
// The control cases matter as much as the blocking one: a guard that also blocked the MAIN agent would
// break every ordinary read in the product while still passing a naive "writer is blocked" assertion.
import { describe, test, expect } from "bun:test"
import * as path from "path"
import { assertCheckpointWriterReadAllowed } from "../../src/tool/memory-path-guard"

const MEMORY_ROOT = "/data/memory"
const SID = "ses_test123"
const call = (target: string, agentName: string) =>
  assertCheckpointWriterReadAllowed({ target, agentName, memoryRoot: () => MEMORY_ROOT })

describe("checkpoint-writer read scope", () => {
  test("BLOCKS the exact reads that emptied the checkpoint (project corpus)", () => {
    // the real paths from the reproduction, in the order the writer issued them
    expect(() => call("/Users/x/GitHub/BOOK/корпус", "checkpoint-writer")).toThrow()
    expect(() => call("/Users/x/GitHub/BOOK/глава_01.md", "checkpoint-writer")).toThrow()
    expect(() => call("/Users/x/GitHub/BOOK/глава_14_курсор.md", "checkpoint-writer")).toThrow()
  })

  test("the refusal names the corrective action, not just 'denied'", () => {
    // A guard whose message does not say what to do instead just produces a retry loop.
    expect(() => call("/Users/x/project/src/app.ts", "checkpoint-writer")).toThrow(/transcript/)
  })

  test("ALLOWS the writer its own four working paths", () => {
    expect(() => call(path.join(MEMORY_ROOT, "sessions", SID, "checkpoint.md"), "checkpoint-writer")).not.toThrow()
    expect(() => call(path.join(MEMORY_ROOT, "sessions", SID, "notes.md"), "checkpoint-writer")).not.toThrow()
    expect(() => call(path.join(MEMORY_ROOT, "projects", "global", "MEMORY.md"), "checkpoint-writer")).not.toThrow()
    expect(() => call(path.join(MEMORY_ROOT, "sessions", SID, "tasks", "T1", "progress.md"), "checkpoint-writer")).not.toThrow()
    expect(() => call(MEMORY_ROOT, "checkpoint-writer")).not.toThrow()
  })

  test("CONTROL: the main agent is untouched — same project paths stay readable", () => {
    expect(() => call("/Users/x/GitHub/BOOK/глава_01.md", "main")).not.toThrow()
    expect(() => call("/Users/x/project/src/app.ts", "main")).not.toThrow()
    expect(() => call(path.join(MEMORY_ROOT, "sessions", SID, "notes.md"), "main")).not.toThrow()
  })

  test("CONTROL: other subagents are untouched", () => {
    for (const agent of ["general", "explore", "dream", "summary", "task"]) {
      expect(() => call("/Users/x/GitHub/BOOK/глава_01.md", agent)).not.toThrow()
    }
  })

  test("REGRESSION: a non-writer never even evaluates the memory root", () => {
    // The bug this pins was mine, caught in a live run and not by any green test. The first version took
    // the RESOLVED root as an argument, so it was computed for every read by every agent; one wrong
    // Global import then threw `undefined is not an object` on EVERY read in the product — the writer's
    // own files included — and the resulting tool status was plain `[error]`, visually identical to the
    // guard correctly refusing a project file. Only the error TEXT distinguished a working guard from a
    // crashing one. A thunk that explodes if touched makes that class impossible to reintroduce quietly.
    const explode = () => {
      throw new Error("memory root must not be resolved for a non-writer")
    }
    for (const agent of ["main", "general", "explore", "dream"]) {
      expect(() =>
        assertCheckpointWriterReadAllowed({ target: "/any/project/file.ts", agentName: agent, memoryRoot: explode }),
      ).not.toThrow()
    }
    // …and for the writer it IS resolved (otherwise the guard could not decide anything)
    expect(() =>
      assertCheckpointWriterReadAllowed({ target: "/x.ts", agentName: "checkpoint-writer", memoryRoot: explode }),
    ).toThrow(/must not be resolved/)
  })

  test("a sibling directory sharing the root's prefix is NOT inside the root", () => {
    // "/data/memory-old/x.md" starts with "/data/memory" as a STRING but is a different tree.
    expect(() => call("/data/memory-old/leak.md", "checkpoint-writer")).toThrow()
  })
})
