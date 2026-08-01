import { describe, expect, test } from "bun:test"
import { CHECKPOINT_WRITER_TOOLS, checkpointWriterToolRefusal, assertCheckpointWriterToolAllowed } from "../../src/tool/memory-path-guard"

// MEASURED 2026-08-01: the writer's toolbelt WAS declared and WAS persisted — the sqlite actor_registry
// row reads checkpoint-writer|["read","write","edit","apply_patch","glob","grep","task"] — and NOTHING
// read it back. Every reference under actor/ is a write or a type. Measured violation: tools actually
// called inside checkpoint-writer sessions included str_replace and session_search, neither of which is
// on the list. The generic actor whitelist cannot cover it either: whitelistFor() returns early when
// input.agentID is absent, and 74 of 74 writer messages carry agentID NULL.
describe("the checkpoint-writer's declared toolbelt is enforced, not merely recorded", () => {
  test("every declared tool is permitted", () => {
    for (const t of CHECKPOINT_WRITER_TOOLS) {
      expect(checkpointWriterToolRefusal("checkpoint-writer", t)).toBeUndefined()
    }
  })

  test("the two tools measured being called outside the list are refused", () => {
    for (const t of ["str_replace", "session_search"]) {
      const refusal = checkpointWriterToolRefusal("checkpoint-writer", t)
      expect(refusal).toBeDefined()
      expect(refusal).toContain(t)
      // The message names what IS available, so the writer has somewhere to go.
      expect(refusal).toContain("read")
    }
  })

  test("no other agent is touched — this is one agent's restriction, not a global one", () => {
    for (const agent of ["build", "explore", "main", undefined]) {
      expect(checkpointWriterToolRefusal(agent, "session_search")).toBeUndefined()
      expect(checkpointWriterToolRefusal(agent, "bash")).toBeUndefined()
    }
  })

  test("the throwing form carries the same verdict — one rule, two call shapes", () => {
    expect(() => assertCheckpointWriterToolAllowed("checkpoint-writer", "read")).not.toThrow()
    expect(() => assertCheckpointWriterToolAllowed("checkpoint-writer", "bash")).toThrow(/may not call/)
    expect(() => assertCheckpointWriterToolAllowed("build", "bash")).not.toThrow()
  })
})
