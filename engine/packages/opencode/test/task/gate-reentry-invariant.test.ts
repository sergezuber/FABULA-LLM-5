// W4 — the task gate's re-entry budget must NOT be re-armable inside a single turn.
//
// Fact-checked finding (2026-07-19): the gate called `taskGateState.clear()` from BOTH of its non-re-entry
// branches — CAP-EXCEEDED and SETTLED (the board went empty). Either one let it earn a fresh 3 re-entries
// every time a different gate carried the turn forward, so
// the harness's re-entry bounds composed as a PRODUCT rather than a SUM (an estimated ~71-115 gate
// re-entries per turn instead of ~17-31 — the SHAPE is proven below, the range is an estimate). This is
// exactly the Infinite-Agentic-Loop shape arXiv:2607.01641 names: a framework feedback edge whose own
// counter is re-armable. The reset now lives at the real turn boundary (SessionPrompt.prompt).
//
// This is the SHIPPED guard, so it is written to survive a determined refactor:
//   - the behavioural half drives the REAL `TaskGate.decide` against a REAL TaskRegistry (real DB, real
//     open task) and a REAL TaskGateState, replaying prompt.ts's own gate control flow. It would FAIL if
//     `decide` were deleted — an earlier version bumped a counter by hand and asserted the counter it had
//     just bumped, which proved nothing.
//   - CONTROL runs replay EACH historical broken flow (reset on cap, reset on settle) so every assertion is
//     provably non-vacuous. Removing only the cap-branch reset is what left the settled one live: an
//     independent verifier measured 6 re-entries in one turn before it was removed too.
//   - the reset is asserted to exist EXACTLY ONCE in prompt.ts. A guard scoped to one BLOCK is the wrong
//     invariant: the same verifier put a reset one line ABOVE the block and measured 30 re-entries against
//     a cap of 3, green all the way.
//   - the measured contribution is asserted EQUAL to the ALDG's declared cap for this edge — the link that
//     makes `sumOfCaps()` (and therefore the shared budget) true rather than decorative.
//   - the structural half reads the cap branch by MEANING (brace-matched region, strings/comments stripped,
//     alias-aware) instead of grepping one literal, so `const reset = taskGateState.clear` does not slip by.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { readFileSync } from "node:fs"
import { TaskGate, MAX_TASK_GATE_MAIN_REACT } from "../../src/task/gate"
import { TaskGateState } from "../../src/task/gate-state"
import { TaskRegistry } from "../../src/task/registry"
import { Session as SessionNs } from "../../src/session"
import { RE_ENTRY_EDGES } from "../../src/session/loopgraph"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { SessionID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  TaskGateState.defaultLayer,
  TaskRegistry.defaultLayer,
  SessionNs.defaultLayer,
)
const it = testEffect(env)

/**
 * Replay of SessionPrompt.prompt's task-gate control flow over `consultations` finish events, against the
 * REAL gate + REAL registry + REAL persisted counter. `resetOnCap` selects the BROKEN pre-W4 behavior, so
 * the same code path measures both worlds and the fixed assertion cannot be vacuous.
 * Returns the number of times the gate carried the turn forward (= re-entries it contributed to the turn).
 */
const runTurn = (
  sid: SessionID,
  consultations: number,
  opts: { resetOnCap?: boolean; resetOnSettle?: boolean } = {},
) =>
  Effect.gen(function* () {
    const state = yield* TaskGateState.Service
    let reentries = 0
    let sawCap = false
    for (let i = 0; i < consultations; i++) {
      const decision = yield* TaskGate.decide({
        session_id: sid,
        reactCount: yield* state.get(sid),
        maxReact: MAX_TASK_GATE_MAIN_REACT,
        mode: "main",
      })
      // THE SHIPPED POLICY, not a copy of it: the same function the run loop calls. If a future change
      // makes the counter resettable mid-turn, it changes HERE and these assertions go red.
      const step = TaskGate.gateTurnStep(decision)
      if (!step.reenter) {
        if (decision.capExceeded) {
          sawCap = true
          // Historical re-arm path #1 (pre-W4): clear on the cap, and it re-arms as soon as another gate
          // carries the turn forward.
          if (opts.resetOnCap) yield* state.clear(sid)
        } else if (opts.resetOnSettle) {
          // Historical re-arm path #2: clear when the board settles, so each new batch earns a fresh cap.
          // Removing only path #1 left this one live — an independent verifier measured 6 re-entries/turn.
          yield* state.clear(sid)
        }
        continue // some other gate carries the turn forward; the loop consults us again
      }
      if (step.bump) yield* state.bump(sid)
      reentries++
    }
    return { reentries, sawCap, finalCount: yield* state.get(sid) }
  })

/** A REAL session + a REAL non-terminal task: the registry is FK-bound to a session row, so an invented
 *  id would never have exercised the real gate at all. */
const openSessionWithTask = Effect.gen(function* () {
  const session = yield* SessionNs.Service.use((svc) => svc.create({}))
  yield* TaskRegistry.Service.use((reg) => reg.create({ session_id: session.id, summary: "still open" }))
  return session.id as SessionID
})

describe("task-gate re-entry budget is not re-armable within a turn", () => {
  it.live("the REAL gate contributes exactly its cap per turn, however often it is consulted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sid = yield* openSessionWithTask

        // Consulted far more often than its cap — the composition scenario: other gates keep the turn alive.
        for (const consultations of [4, 10, 40]) {
          yield* TaskGateState.Service.use((s) => s.clear(sid)) // fresh turn
          const r = yield* runTurn(sid, consultations, {})
          expect(r.sawCap).toBe(true) // the cap really was reached (otherwise this proves nothing)
          expect(r.reentries).toBe(MAX_TASK_GATE_MAIN_REACT)
          expect(r.finalCount).toBe(MAX_TASK_GATE_MAIN_REACT) // never silently re-armed
        }
      }),
    ),
  )

  it.live("CONTROL: replaying the pre-W4 reset re-arms the cap — the assertion above is not vacuous", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sid = yield* openSessionWithTask
        const broken = yield* runTurn(sid, 40, { resetOnCap: true })
        // The blow-up shape: re-entries grow with how long the turn lives instead of being capped by it.
        expect(broken.reentries).toBeGreaterThan(MAX_TASK_GATE_MAIN_REACT)
        expect(broken.finalCount).toBeLessThan(MAX_TASK_GATE_MAIN_REACT) // the tell: counter dropped mid-turn
      }),
    ),
  )


  it.live("settling the board mid-turn does NOT earn a fresh budget (the second re-arm path)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // An independent verifier measured 6 re-entries in ONE turn here: the gate hit its cap, the board
        // then went empty (settled branch cleared the counter), a new task appeared, and the gate earned a
        // full fresh 3. Removing only the cap-branch reset left the composition a product of settle cycles.
        const session = yield* SessionNs.Service.use((svc) => svc.create({}))
        const sid = session.id as SessionID
        const reg = yield* TaskRegistry.Service
        const first = yield* reg.create({ session_id: sid, summary: "batch one" })

        let total = (yield* runTurn(sid, 10, {})).reentries
        expect(total).toBe(MAX_TASK_GATE_MAIN_REACT)

        // the board settles, then new work appears — all still inside the SAME turn
        yield* reg.done({ session_id: sid, id: first.id })
        yield* runTurn(sid, 3, {}) // consulted with an empty board
        yield* reg.create({ session_id: sid, summary: "batch two" })
        total += (yield* runTurn(sid, 10, {})).reentries

        // The cap is the gate's budget for the TURN — not for each batch of tasks.
        expect(total).toBe(MAX_TASK_GATE_MAIN_REACT)
      }),
    ),
  )


  it.live("CONTROL: replaying the settled-branch reset re-arms the cap through settle cycles", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service.use((svc) => svc.create({}))
        const sid = session.id as SessionID
        const reg = yield* TaskRegistry.Service
        const first = yield* reg.create({ session_id: sid, summary: "batch one" })

        let total = (yield* runTurn(sid, 10, { resetOnSettle: true })).reentries
        yield* reg.done({ session_id: sid, id: first.id })
        yield* runTurn(sid, 3, { resetOnSettle: true }) // empty board clears the counter in the BROKEN flow
        yield* reg.create({ session_id: sid, summary: "batch two" })
        total += (yield* runTurn(sid, 10, { resetOnSettle: true })).reentries

        // Without the fix the second batch earns a full fresh cap — the product the verifier measured.
        expect(total).toBeGreaterThan(MAX_TASK_GATE_MAIN_REACT)
      }),
    ),
  )

  it.live("the measured contribution IS the cap the ALDG declares — sumOfCaps() rests on this", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sid = yield* openSessionWithTask
        const declared = RE_ENTRY_EDGES.find((e) => e.id === "task-settle")
        expect(declared).toBeDefined()
        const r = yield* runTurn(sid, 25, {})
        // If the registry ever drifts from the gate's real behavior, the declared worst case — and the
        // shared budget derived from it — becomes a lie. Measure, don't assume.
        expect(r.reentries).toBe(declared!.cap)
      }),
    ),
  )

  it.live("the real turn boundary DOES start a fresh budget (the gate is never dead for the session)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sid = yield* openSessionWithTask
        const state = yield* TaskGateState.Service
        const first = yield* runTurn(sid, 10, {})
        expect(first.reentries).toBe(MAX_TASK_GATE_MAIN_REACT)

        yield* state.clear(sid) // SessionPrompt.prompt clears on a real user message
        expect(yield* state.get(sid)).toBe(0)
        const second = yield* runTurn(sid, 10, {})
        expect(second.reentries).toBe(MAX_TASK_GATE_MAIN_REACT) // next turn gets its own full budget
      }),
    ),
  )
})

describe("the shipped counter policy itself", () => {
  test("gateTurnStep never resets the per-turn counter, on any decision shape", () => {
    const shapes: Parameters<typeof TaskGate.gateTurnStep>[0][] = [
      { needReentry: false, capExceeded: false, incompleteTasks: [] },
      { needReentry: false, capExceeded: true, incompleteTasks: ["t1"] },
      { needReentry: true, capExceeded: false, incompleteTasks: ["t1"], reentryText: "nudge" },
    ]
    // The policy cannot even EXPRESS a mid-turn reset — there is no such outcome in the returned shape.
    for (const d of shapes) expect(Object.keys(TaskGate.gateTurnStep(d)).sort()).toEqual(["bump", "reenter"])
    expect(TaskGate.gateTurnStep(shapes[2]).bump).toBe(true)
    expect(TaskGate.gateTurnStep(shapes[1]).bump).toBe(false)
  })
})

describe("structural guard — the reset must live at the turn boundary, not on the cap branch", () => {
  const PROMPT = readFileSync(new URL("../../src/session/prompt.ts", import.meta.url), "utf8")

  /** Source with string literals and comments blanked, so a mention inside a comment/string is never a hit
   *  and a real call inside them can never hide. */
  function stripNonCode(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
      .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => " ".repeat(m.length))
  }

  /** The cap-exceeded branch as a REGION, brace-matched from its `if` — not a slice between two literals
   *  that a reordering would silently widen or empty. */
  function capBranchRegion(src: string): string {
    // Anchor on the cap branch (unique to the MAIN gate — the subagent site has its own
    // `if (!decision.needReentry)`), then walk back to the enclosing non-re-entry block.
    const cap = src.indexOf("if (decision.capExceeded)")
    expect(cap).toBeGreaterThan(-1) // the cap branch still exists — otherwise this guard is vacuous
    const at = src.lastIndexOf("if (!decision.needReentry)", cap)
    expect(at).toBeGreaterThan(-1) // ...inside the non-re-entry block, where the resets used to live
    const open = src.indexOf("{", at)
    expect(open).toBeGreaterThan(-1)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1)
    }
    throw new Error("unbalanced braces in the cap branch")
  }

  test("neither non-re-entry branch resets the counter — including through an alias", () => {
    const code = stripNonCode(PROMPT)
    // The WHOLE `if (!decision.needReentry)` block: the cap branch AND the settled branch. Guarding only
    // the cap branch left the settled one free to re-arm the cap, which is exactly what happened.
    const region = capBranchRegion(code)

    // Direct: any `.clear(` on anything, inside the branch.
    expect(region).not.toMatch(/\.\s*clear\s*\(/)

    // Aliased: `const reset = taskGateState.clear` / `const s = taskGateState`, then called in the branch.
    const aliases = [
      ...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*taskGateState\s*\.\s*clear\b/g),
      ...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*taskGateState\b(?!\s*\.)/g),
    ].map((m) => m[1])
    for (const a of aliases) {
      expect(region).not.toMatch(new RegExp(`\\b${a}\\s*\\(`))
      expect(region).not.toMatch(new RegExp(`\\b${a}\\s*\\.\\s*clear\\b`))
    }

    // Destructured: `const { clear } = taskGateState` then a bare `clear(...)` in the branch.
    if (/\{[^}]*\bclear\b[^}]*\}\s*=\s*taskGateState\b/.test(code)) {
      expect(region).not.toMatch(/\bclear\s*\(/)
    }
  })

  // A guard scoped to ONE BLOCK watches the wrong thing: an independent verifier put the reset one line
  // ABOVE that block and measured 30 re-entries in a turn against a cap of 3 — the full product blowup —
  // with both suites green. The real invariant is not "this block does not reset", it is:
  // THE COUNTER HAS EXACTLY ONE RESET SITE IN THE WHOLE FILE, AND IT IS THE TURN BOUNDARY.
  test("exactly ONE reset of the counter exists in prompt.ts, and it is the turn boundary", () => {
    const code = stripNonCode(PROMPT)
    const resets = [...code.matchAll(/taskGateState\s*\.\s*clear\s*\(([^)]*)\)/g)]
    expect(resets.length).toBe(1) // a second reset ANYWHERE — inside the gate or beside it — fails here
    expect(resets[0][1].trim()).toBe("input.sessionID") // ...and it resets the TURN's session, not a gate-local id

    // and it lives inside SessionPrompt.prompt, not in the run loop
    const promptFn = PROMPT.indexOf('Effect.fn("SessionPrompt.prompt")')
    expect(promptFn).toBeGreaterThan(-1)
    expect(resets[0].index!).toBeGreaterThan(promptFn)
  })

  // Mutation that slipped past the first version of this guard: delete the real reset and leave a COMMENT
  // containing the literal. `toContain` on raw file text was satisfied, while the counter was never cleared
  // per turn — the gate goes permanently dead after the first capped turn and nothing notices. The assertion
  // is therefore made against CODE (comments and strings blanked), and it must live inside `prompt`.
  test("SessionPrompt.prompt clears the counter at the real turn boundary — as code, not as a comment", () => {
    const code = stripNonCode(PROMPT)
    expect(code).toMatch(/taskGateState\s*\.\s*clear\s*\(\s*input\.sessionID\s*\)/)
    // The name only appears inside a string literal, which stripNonCode blanks — but it replaces with
    // equal-length blanks, so an offset taken from the raw text is valid in the stripped text.
    const promptFn = PROMPT.indexOf('Effect.fn("SessionPrompt.prompt")')
    expect(promptFn).toBeGreaterThan(-1)
    expect(code.slice(promptFn)).toMatch(/taskGateState\s*\.\s*clear\s*\(\s*input\.sessionID\s*\)/)
  })
})
