import { test, expect, describe } from "bun:test"
import { proofRoot, leaf, treeVerdict, addChild, flatten, countByVerdict, renderTree, type ProofNode } from "./coordinator"

function sample(): ProofNode {
  let t = proofRoot("root", "ship the feature")
  t = addChild(t, "root", leaf("w1", "research", "map the export path", "VERIFIED", { receiptId: "aaaaaaaaaaaa", model: "qwen" }))
  t = addChild(t, "root", leaf("w2", "implement", "fix the boundary", "VERIFIED", { receiptId: "bbbbbbbbbbbb" }))
  return t
}

describe("treeVerdict — the composite is honest", () => {
  test("all leaves VERIFIED → whole VERIFIED", () => {
    expect(treeVerdict(sample())).toBe("VERIFIED")
  })
  test("one NOT DONE anywhere → whole NOT DONE", () => {
    let t = sample()
    t = addChild(t, "root", leaf("w3", "verify", "prove edge case", "NOT DONE"))
    expect(treeVerdict(t)).toBe("NOT DONE")
  })
  test("a pending leaf → whole pending (not yet proven)", () => {
    let t = sample()
    t = addChild(t, "root", leaf("w4", "verify", "still running", "pending"))
    expect(treeVerdict(t)).toBe("pending")
  })
  test("a leaf's composite is its own verdict", () => {
    expect(treeVerdict(leaf("x", "r", "t", "NOT DONE"))).toBe("NOT DONE")
    expect(treeVerdict(leaf("x", "r", "t", "VERIFIED"))).toBe("VERIFIED")
  })
  test("nested subtree — NOT DONE bubbles up", () => {
    let t = proofRoot("root", "top")
    let mid = leaf("mid", "coordinator", "subteam", "pending")
    mid = addChild(mid, "mid", leaf("g1", "impl", "a", "VERIFIED"))
    mid = addChild(mid, "mid", leaf("g2", "impl", "b", "NOT DONE"))
    t = addChild(t, "root", mid)
    expect(treeVerdict(t)).toBe("NOT DONE")
  })
})

describe("addChild — immutable + replace-by-id", () => {
  test("does not mutate the input tree", () => {
    const t = proofRoot("root", "x")
    const t2 = addChild(t, "root", leaf("a", "r", "t", "VERIFIED"))
    expect(t.children).toHaveLength(0)
    expect(t2.children).toHaveLength(1)
  })
  test("re-adding the same id replaces (worker re-run updates, not duplicates)", () => {
    let t = proofRoot("root", "x")
    t = addChild(t, "root", leaf("a", "impl", "t", "NOT DONE"))
    t = addChild(t, "root", leaf("a", "impl", "t", "VERIFIED"))
    expect(t.children).toHaveLength(1)
    expect(t.children[0].verdict).toBe("VERIFIED")
  })
  test("inserts deep under a matching parent id", () => {
    let t = proofRoot("root", "x")
    t = addChild(t, "root", proofRoot("sub", "subteam"))
    t = addChild(t, "sub", leaf("g", "impl", "t", "VERIFIED"))
    expect(flatten(t).map((n) => n.id)).toContain("g")
  })
})

describe("countByVerdict + renderTree", () => {
  test("counts leaves by verdict", () => {
    let t = sample()
    t = addChild(t, "root", leaf("w3", "verify", "x", "NOT DONE"))
    expect(countByVerdict(t)).toEqual({ verified: 2, notDone: 1, pending: 0, leaves: 3 })
  })
  test("render shows ✅/❌ and the composite at the root", () => {
    let t = sample()
    t = addChild(t, "root", leaf("w3", "verify", "x", "NOT DONE"))
    const out = renderTree(t)
    expect(out.split("\n")[0]).toContain("❌") // root composite is NOT DONE
    expect(out).toContain("research")
    expect(out).toContain("✅") // the verified leaves
  })
})
