// FABULA coordinator (§ disrupt #4) — a VERIFIED team, not just an agent loop.
//
// When work is split across workers (each spawned via the engine's own task/AgentTool), every worker's
// run leaves its own Proof-of-Done receipt. This plugin composes those receipts into a PROOF TREE whose
// composite verdict is honest: VERIFIED only if every leaf is VERIFIED; a single NOT DONE anywhere makes
// the whole NOT DONE. That is supply-chain provenance for AI work — an SBOM for an agent trajectory.
//
//   subreceipt_add — a worker's receipt (from its project dir, or a given path) joins the tree.
//   proof_tree     — render the tree + the composite verdict + counts.
//
// This never fakes spawning — the workers are real engine subagents; the plugin turns their proofs into a
// verified tree (state in .fabula/coordinator/tree.json, a companion to the receipt — never modified).
// Logic (the tree, the composite verdict) is the pure lib/coordinator.ts; this file is the fs glue.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { gate } from "./lib/manage"
import { parseReceipt, receiptId } from "./lib/registry"
import { proofRoot, leaf, addChild, treeVerdict, countByVerdict, renderTree, type ProofNode, type Verdict } from "./lib/coordinator"

const z = tool.schema
const TREE = ".fabula/coordinator/tree.json"

// Recursively normalize `children` to an array at EVERY depth: loadTree only validated the root, so a
// corrupt NESTED node's non-array children would crash treeVerdict/flatten/renderTree (which recurse
// through n.children.map/flatMap). Sanitizing at the load boundary keeps the pure tree functions safe.
function sanitizeNode(n: any): ProofNode {
  return { ...n, children: Array.isArray(n?.children) ? n.children.map(sanitizeNode) : [] }
}
function loadTree(dir: string, rootTask: string): ProofNode {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, TREE), "utf8"))
    if (j && typeof j === "object" && Array.isArray(j.children)) return sanitizeNode(j)
  } catch {}
  return proofRoot("root", rootTask)
}
function saveTree(dir: string, tree: ProofNode): boolean {
  try {
    fs.mkdirSync(path.join(dir, ".fabula", "coordinator"), { recursive: true })
    fs.writeFileSync(path.join(dir, TREE), JSON.stringify(tree, null, 2), "utf8")
    return true
  } catch {
    return false
  }
}

// Read a worker's receipt: an explicit path, or <workerDir>/.fabula/receipts/latest.json.
function readWorkerReceipt(coordDir: string, from?: string): { json: string; patch?: string; base: string } | { error: string } {
  const p = from && from.trim() ? path.resolve(coordDir, from.trim()) : path.join(coordDir, ".fabula", "receipts", "latest.json")
  const file = p.endsWith(".json") ? p : path.join(p, ".fabula", "receipts", "latest.json")
  if (!fs.existsSync(file)) return { error: `no receipt at ${file} — the worker must produce one (a green verify) before it joins the tree` }
  let json: string
  try {
    json = fs.readFileSync(file, "utf8")
  } catch (e) {
    return { error: `could not read ${file}: ${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = parseReceipt(json)
  if (!parsed.ok) return { error: `receipt at ${file} is invalid: ${parsed.error}` }
  let patch: string | undefined
  const rel = parsed.receipt.artifact?.patch
  if (rel) {
    const pa = path.resolve(path.dirname(file), "..", "..", rel)
    if (fs.existsSync(pa)) patch = fs.readFileSync(pa, "utf8")
  }
  return { json, patch, base: file }
}

export const FabulaCoordinator: Plugin = async (input: any) => {
  const dir: string = input?.directory || process.cwd()
  return gate("coordinator", {
    tool: {
      subreceipt_add: tool({
        description:
          "Attach a worker's Proof-of-Done receipt to the coordinated proof tree. Pass the worker's role and " +
          "the receipt source (a worker project directory, or a path to a receipt.json — defaults to this " +
          "project's latest). The tree's composite verdict is VERIFIED only if EVERY worker's receipt is " +
          "VERIFIED; a single NOT DONE makes the whole run NOT DONE. Proves every step, by every worker.",
        args: {
          role: z.string().describe("What this worker did, e.g. 'research', 'implement', 'verify'."),
          from: z.string().nullish().describe("Worker project dir or receipt.json path (default: this project's latest receipt)."),
          overall_task: z.string().nullish().describe("The coordinated run's overall task (set once, on the first add)."),
        },
        async execute(args: any) {
          const got = readWorkerReceipt(dir, args?.from ? String(args.from) : undefined)
          if ("error" in got) return `subreceipt_add: ${got.error}`
          const parsed = parseReceipt(got.json)
          if (!parsed.ok) return `subreceipt_add: ${parsed.error}`
          const r = parsed.receipt
          const verdict: Verdict = r.verification?.passed === true ? "VERIFIED" : "NOT DONE"
          const rid = got.patch && r.verification?.cmd ? receiptId(got.patch, r.verification.cmd) : createHash("sha256").update(got.json).digest("hex")
          const role = String(args?.role || "worker")
          const wtask = (r.task || "").replace(/^"+|"+$/g, "").slice(0, 120) || role
          const workerId = createHash("sha256").update(`${role}\n${wtask}\n${rid}`).digest("hex").slice(0, 12)

          let tree = loadTree(dir, args?.overall_task ? String(args.overall_task) : "coordinated run")
          tree = addChild(tree, "root", leaf(workerId, role, wtask, verdict, { receiptId: rid, model: r.model?.id }))
          if (!saveTree(dir, tree)) return "subreceipt_add: could not write .fabula/coordinator/tree.json (permissions?)"
          const c = countByVerdict(tree)
          const composite = treeVerdict(tree)
          return `${verdict === "VERIFIED" ? "✅" : "❌"} added ${role} (${verdict}) to the proof tree — now ${c.verified}/${c.leaves} verified. Composite: ${composite}.`
        },
      }),

      proof_tree: tool({
        description:
          "Show the coordinated proof tree: every worker's sub-receipt and the honest composite verdict " +
          "(VERIFIED only if every step is verified). This is supply-chain provenance for the whole run.",
        args: {},
        async execute() {
          const tree = loadTree(dir, "coordinated run")
          if (tree.children.length === 0) return "proof_tree: no sub-receipts yet — use subreceipt_add after each worker finishes."
          const c = countByVerdict(tree)
          return `Proof tree (${c.verified}✅ / ${c.notDone}❌ / ${c.pending}⏳ of ${c.leaves}):\n\n${renderTree(tree)}\n\nComposite verdict: ${treeVerdict(tree)}`
        },
      }),
    },
  })
}
