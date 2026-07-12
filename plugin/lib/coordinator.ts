// FABULA coordinator — pure core of the sub-receipt PROOF TREE (no IO). When work is split across
// workers, each worker's run leaves its own Proof-of-Done receipt; this composes them into a tree whose
// COMPOSITE verdict is honest: the whole is VERIFIED only if every leaf is VERIFIED, and a single NOT DONE
// anywhere makes the whole NOT DONE. That is supply-chain provenance for AI work — an SBOM for an agent
// trajectory: you prove not just "the result is right" but "every step, by every worker, was verified."
//
// The plugin (fabula-coordinator.ts) does the fs + reads real receipts. Spawning the workers themselves is
// the engine's task/AgentTool — this plugin turns their receipts into the verified tree. Logic is here.

export type Verdict = "VERIFIED" | "NOT DONE" | "pending"

export type ProofNode = {
  id: string
  role: string
  task: string
  verdict: Verdict // this node's OWN step verdict; "pending" for a pure aggregator (the coordinator root)
  receiptId?: string
  model?: string
  children: ProofNode[]
}

export function proofRoot(id: string, task: string): ProofNode {
  return { id, role: "coordinator", task, verdict: "pending", children: [] }
}

export function leaf(id: string, role: string, task: string, verdict: Verdict, opts?: { receiptId?: string; model?: string }): ProofNode {
  return { id, role, task, verdict, receiptId: opts?.receiptId, model: opts?.model, children: [] }
}

// The COMPOSITE verdict. Any NOT DONE (own or descendant) → NOT DONE. Otherwise VERIFIED only when the
// node's own step isn't failing AND every child is VERIFIED. A leaf's composite is simply its own verdict.
export function treeVerdict(n: ProofNode): Verdict {
  if (n.children.length === 0) return n.verdict
  const childs = n.children.map(treeVerdict)
  if (n.verdict === "NOT DONE" || childs.includes("NOT DONE")) return "NOT DONE"
  // n.verdict is now "VERIFIED" | "pending"; the whole is VERIFIED only if every child is too.
  if (childs.every((c) => c === "VERIFIED")) return "VERIFIED"
  return "pending"
}

// Immutable insert of `child` under the node whose id === parentId (deep). Returns a new tree; a
// re-add of the same child id REPLACES it (a worker re-running its step updates, not duplicates).
export function addChild(tree: ProofNode, parentId: string, child: ProofNode): ProofNode {
  const clone = (n: ProofNode): ProofNode => {
    if (n.id === parentId) {
      const kept = n.children.filter((c) => c.id !== child.id).map(clone)
      return { ...n, children: [...kept, child] }
    }
    return { ...n, children: n.children.map(clone) }
  }
  return clone(tree)
}

export function flatten(n: ProofNode): ProofNode[] {
  return [n, ...n.children.flatMap(flatten)]
}

export function countByVerdict(n: ProofNode): { verified: number; notDone: number; pending: number; leaves: number } {
  const leaves = flatten(n).filter((x) => x.children.length === 0)
  return {
    verified: leaves.filter((x) => x.verdict === "VERIFIED").length,
    notDone: leaves.filter((x) => x.verdict === "NOT DONE").length,
    pending: leaves.filter((x) => x.verdict === "pending").length,
    leaves: leaves.length,
  }
}

const MARK: Record<Verdict, string> = { VERIFIED: "✅", "NOT DONE": "❌", pending: "⏳" }

export function renderTree(n: ProofNode, indent = 0): string {
  const pad = "  ".repeat(indent)
  const v = indent === 0 ? treeVerdict(n) : n.children.length ? treeVerdict(n) : n.verdict
  const rid = n.receiptId ? ` · ${n.receiptId.slice(0, 10)}…` : ""
  const who = n.model ? ` (${n.model})` : ""
  const head = `${pad}${MARK[v]} ${n.role}: ${n.task.slice(0, 70)}${who}${rid}`
  return [head, ...n.children.map((c) => renderTree(c, indent + 1))].join("\n")
}
