// FABULA-LLM-5 — fabula-goaudit: a Go security/defect audit built as a DETERMINISTIC FLOOR under an
// LLM layer, not as a prompt that hopes.
//
// The measurement that dictates the shape (arXiv:2602.16741, 9,366 trials / 8 models): of every
// defence tried for an AI security reviewer, static-analysis cross-referencing is the best —
// 96.9% detection, recovering 47% of the reviewer's baseline misses — and the detection gap between
// commercial and open-weight models is 89-96% vs 53-72%. Whatever model sits in the socket (RULE #14),
// it therefore reviews Go on top of evidence a program produced. The second measurement
// (arXiv:2601.19239, 222 real vulnerabilities, 385 hand-labelled reports): 85.3% false discovery rate,
// dominated by source/sink specs that miss the project's real APIs. So a criterion a linter already
// decides is never handed to the model, and every model-reported finding must cite file:line.
//
// Three surfaces:
//   hook  tool.execute.after — SELF-FIRING (RULE #9): a GREEN verify_done on a change that touched Go
//                              source runs the floor once and, if it is not clean, plants a
//                              "NOT YET DONE" steer carrying the program-produced findings.
//   tool  go_security_scan   — run the floor on demand; returns the same evidence block.
//   tool  go_audit_criteria  — the LLM half: only the criteria no Go linter can decide, grounded in
//                              the floor's output and required to cite file:line.
//
// Pure core lib/gofloor.ts · runner lib/gofloorrun.ts. Toggle id "goaudit";
// kill-switch FABULA_GO_FLOOR=0; tool selection FABULA_GO_TOOLS; budget FABULA_GO_FLOOR_TIMEOUT_MS.

import type { Plugin } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin"
import * as path from "node:path"
import { gate } from "./lib/manage"
import { callAux } from "./lib/auxLLM"
import { BASH_EDIT_MARKER, editUnits } from "./lib/edittools"
import {
  armsFloor,
  blockingFindings,
  criteriaAuditPrompt,
  criteriaFor,
  goFloorBlock,
  goFloorSteer,
  goSourceEdits,
  parseCriteriaFindings,
  safeGoTarget,
  type FloorResult,
  type GoCriterion,
} from "./lib/gofloor"
import { findGoModuleRoot, floorEnabled, runFloor, spawnExec } from "./lib/gofloorrun"

const z = tool.schema

/** Per-turn state. The gate is about the change JUST made, not the whole session. */
interface AuditState {
  goEdits: Set<string>
  fired: boolean
}
const states = new Map<string, AuditState>()
function stateFor(sid: string): AuditState {
  let s = states.get(sid)
  if (!s) {
    s = { goEdits: new Set(), fired: false }
    states.set(sid, s)
  }
  return s
}

function cwdOf(input: any): string {
  return input?.directory || input?.cwd || process.cwd()
}

/** Run the floor for whatever module encloses `dir`. Null = not a Go module, and the plugin then
 *  stays completely silent, which is why a non-Go repository pays nothing for having this installed. */
async function floorFor(dir: string): Promise<FloorResult | null> {
  const root = await findGoModuleRoot(dir)
  if (!root) return null
  return await runFloor({ dir: root, exec: spawnExec(), env: process.env })
}

export const FabulaGoAudit: Plugin = async ({ directory }: any = {}) =>
  gate("goaudit", {
    "chat.message": async (input: any) => {
      try {
        const sid = input?.sessionID
        if (!sid) return
        if (states.size > 500) states.clear()
        states.set(sid, { goEdits: new Set(), fired: false })
      } catch {}
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!output) return
      try {
        if (!floorEnabled(process.env)) return
        const sid = input?.sessionID || "?"
        const st = stateFor(sid)
        const toolName = String(input?.tool ?? "")

        // Record Go source edits. `editUnits` covers the write/edit family AND bash-tree edits
        // (sed -i, git apply, tee) — a patch applied through the shell is still a source edit.
        const units = editUnits(toolName, input?.args)
        if (units.length) {
          if (armsFloor(units, BASH_EDIT_MARKER)) {
            const named = goSourceEdits(units)
            // A named Go file is recorded as itself; an unnamable tree edit records the marker, so the
            // gate arms without pretending to know which file changed.
            for (const g of named.length ? named : [BASH_EDIT_MARKER]) st.goEdits.add(g)
          }
          return
        }

        // The gate: a GREEN verify on a change that touched Go source.
        if (toolName !== "verify_done") return
        if (output?.metadata?.passed !== true) return
        if (st.fired || st.goEdits.size === 0) return
        if (typeof output.output !== "string") return

        st.fired = true // once per turn, whatever the outcome — a gate that re-fires is a loop
        const dir = directory || cwdOf(input)
        const r = await floorFor(dir)
        if (!r) return // not a Go module: silent by construction
        const blocking = blockingFindings(r.findings)
        if (!blocking.length) {
          // Clean floor is still worth recording: it is the evidence the receipt/witness can carry.
          if (output.metadata && typeof output.metadata === "object") {
            output.metadata.goFloor = { ran: r.ran, missing: r.missing, findings: r.findings.length, blocking: 0 }
          }
          return
        }
        // Downgrade the way every other gate in this harness does: rewrite the VISIBLE verdict and set
        // this gate's OWN metadata key.
        //
        // `metadata.passed` is deliberately NOT touched, and that is load-bearing rather than stylistic.
        // It records what the TEST RUN did, and the tests really did pass — relabelling it "false" would
        // be a false statement with two measured consequences: fabula-rewind counts it as a RED verify
        // (lib/rewind, `passed !== true`) and after two such turns REVERTS files whose tests pass, and
        // the engine's judge reads the same field (session/verify-gate.ts) into `verifyRed`/`lastVerify`,
        // firing the hard-veto. A static-analysis finding is a separate claim from a test result, so it
        // travels in the text and in `goFloor` — never by rewriting the other gate's evidence.
        output.output =
          output.output.replace("✅ VERIFIED DONE", "⏳ NOT YET DONE (go security floor)") + goFloorSteer(r, blocking)
        if (output.metadata && typeof output.metadata === "object") {
          output.metadata.goFloor = { ran: r.ran, missing: r.missing, findings: r.findings.length, blocking: blocking.length }
        }
      } catch {}
    },

    tool: {
      go_security_scan: tool({
        description:
          "GO MODULES ONLY (needs a go.mod; returns a plain refusal elsewhere). Run the deterministic Go security floor " +
          "(govulncheck, gosec, staticcheck, nilaway, go vet, golangci-lint) over the module and return their findings as " +
          "evidence. Analysers that are not installed are NAMED in the output, so you always know what was not checked. govulncheck findings marked REACHABLE mean the " +
          "vulnerable symbol is actually called by this module, not merely present in go.mod. Use this BEFORE reasoning " +
          "about Go security: it costs no model tokens and its findings are facts, not opinions.",
        args: {
          path: z.string().optional().describe("Directory inside the Go module (default: the session directory)."),
          target: z.string().optional().describe('Go analysis target (default "./..." = whole module).'),
        },
        async execute(args: any, ctx: any) {
          const start = args?.path ? path.resolve(args.path) : directory || ctx?.directory || process.cwd()
          const root = await findGoModuleRoot(start)
          if (!root) return `No go.mod found at or above ${start} — this is not a Go module, so the Go floor does not apply.`
          // Refuse an unusable target out loud rather than silently analysing something else: a target
          // starting with `-` is a FLAG, and Go tools accept flags in any argv position.
          if (args?.target !== undefined && safeGoTarget(args.target) === null)
            return `Refused the target ${JSON.stringify(String(args.target))}: not a Go package pattern (expected "./...", "./internal/...", or an import path).`
          const r = await runFloor({
            dir: root,
            exec: spawnExec(),
            env: process.env,
            ...(args?.target ? { target: String(args.target) } : {}),
          })
          const block = goFloorBlock(r)
          const blocking = blockingFindings(r.findings)
          return (
            `Go module: ${root}\n${block}\n\n` +
            `${blocking.length} of ${r.findings.length} finding(s) are blocking (reachable advisory, or high/critical severity).`
          )
        },
      }),

      go_audit_criteria: tool({
        description:
          "GO CODE ONLY. Audit a Go diff against the review criteria that NO linter can decide (transaction safety, reachability of " +
          "authorization, goroutine leaks, silent skips, unbounded queries, Kafka at-least-once, sync.Pool reuse, and more). " +
          "Runs the deterministic floor first and gives its findings to the reviewer, then requires every reported finding " +
          "to cite file:line from the diff. Criteria a Go linter already covers are explicitly out of scope.",
        args: {
          diff: z.string().describe("Unified diff of the Go change to review."),
          task: z.string().optional().describe("What the change is meant to accomplish."),
          areas: z
            .array(z.enum(["tx", "concurrency", "observability", "error", "security", "api", "perf", "testing", "style"]))
            .optional()
            .describe("Restrict to these criterion areas (default: all)."),
          path: z.string().optional().describe("Directory inside the Go module, for the static-analysis floor."),
        },
        async execute(args: any, ctx: any) {
          const diff = String(args?.diff ?? "")
          if (!diff.trim()) return "No diff supplied — nothing to audit."
          const start = args?.path ? path.resolve(args.path) : directory || ctx?.directory || process.cwd()
          const root = await findGoModuleRoot(start)
          let floor: FloorResult | undefined
          if (root) {
            try {
              floor = await runFloor({ dir: root, exec: spawnExec(), env: process.env })
            } catch {}
          }
          const criteria: GoCriterion[] = criteriaFor(args?.areas)
          const prompt = criteriaAuditPrompt({ diff, criteria, ...(floor ? { floor } : {}), ...(args?.task ? { task: String(args.task) } : {}) })
          let raw = ""
          try {
            // callAux takes ONE string and returns { text, provider } — the repo-wide aux contract.
            raw = (await callAux(prompt, { maxTokens: 2000, timeoutMs: 150000 })).text
          } catch (e: any) {
            // Fail-open and say so: an audit that could not run must never read as an audit that passed.
            return (
              `${goFloorBlock(floor)}\n\n` +
              `CRITERIA AUDIT DID NOT RUN (${String(e?.message ?? e).slice(0, 200)}). The static-analysis evidence above ` +
              `still holds; the criteria half is unchecked, so do not treat this as a clean review.`
            )
          }
          const found = parseCriteriaFindings(raw)
          const head = goFloorBlock(floor)
          if (!found.length) {
            return (
              `${head}\n\nCRITERIA AUDIT: no anchored finding among ${criteria.length} criteria. ` +
              `This means nothing was tied to a file:line in the diff — it is not a proof of correctness.`
            )
          }
          const lines = found.map(
            (f) => `- ${f.criterion} (${f.confidence}) ${f.file}:${f.line}\n    evidence: ${f.evidence}\n    why: ${f.why}`,
          )
          return `${head}\n\nCRITERIA AUDIT — ${found.length} anchored finding(s):\n${lines.join("\n")}`
        },
      }),
    },
  })
