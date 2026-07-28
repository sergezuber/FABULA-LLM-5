import { describe, expect, test } from "bun:test"
import { initTraversal, observeRead, traversalVerdict, MIN_FILES } from "./traversal"

const W = 100_000 // window in tokens; budget at the default share is 35_000 tokens ≈ 87_500 chars
const big = () => 40_000 // chars per file: 5 files ≈ 80_000 tokens, well past the budget
const small = () => 200

function readN(dir: string, n: number, chars: () => number) {
  const st = initTraversal()
  for (let i = 0; i < n; i++) observeRead(st, { dir, path: `${dir}/f${i}.md`, chars: chars() })
  return st
}

describe("traversalVerdict — the situation, measured, with no words anywhere", () => {
  test("a traversal still in progress that no longer fits", () => {
    const v = traversalVerdict(readN("/book", 6, big), { windowTokens: W, filesInDir: () => 52 })
    expect(v.offload).toBe(true)
    expect(v.dir).toBe("/book")
    expect(v.filesRemaining).toBe(46)
  })

  test("the same six files decide differently on a machine with room for them", () => {
    const v = traversalVerdict(readN("/book", 6, big), { windowTokens: 1_000_000, filesInDir: () => 52 })
    expect(v.offload).toBe(false)
  })

  test("a pair of files is somebody answering a question, not a traversal", () => {
    const v = traversalVerdict(readN("/src", 2, big), { windowTokens: W, filesInDir: () => 52 })
    expect(v.offload).toBe(false)
  })

  test("many small files are not a corpus however many there are", () => {
    const v = traversalVerdict(readN("/notes", 30, small), { windowTokens: W, filesInDir: () => 400 })
    expect(v.offload).toBe(false)
  })

  test("nothing left to read: changing shape now would only discard the work", () => {
    const v = traversalVerdict(readN("/book", 6, big), { windowTokens: W, filesInDir: () => 6 })
    expect(v.offload).toBe(false)
    expect(v.reason).toContain("nothing left")
  })

  test("an unknown directory size is read conservatively, never as a guess to fire on", () => {
    const v = traversalVerdict(readN("/book", 6, big), { windowTokens: W })
    expect(v.offload).toBe(false)
  })

  test("an unmeasured window decides nothing at all", () => {
    const v = traversalVerdict(readN("/book", 9, big), { windowTokens: 0, filesInDir: () => 52 })
    expect(v.offload).toBe(false)
    expect(v.reason).toContain("not measured")
  })

  test("reading the same file repeatedly never fakes a traversal", () => {
    const st = initTraversal()
    for (let i = 0; i < 20; i++) observeRead(st, { dir: "/x", path: "/x/one.md", chars: big() })
    const v = traversalVerdict(st, { windowTokens: W, filesInDir: () => 52 })
    expect(v.offload).toBe(false)
  })

  test("files spread across directories are separate traversals, not one big one", () => {
    const st = initTraversal()
    for (let i = 0; i < MIN_FILES - 1; i++) observeRead(st, { dir: "/a", path: `/a/${i}`, chars: big() })
    for (let i = 0; i < MIN_FILES - 1; i++) observeRead(st, { dir: "/b", path: `/b/${i}`, chars: big() })
    expect(traversalVerdict(st, { windowTokens: W, filesInDir: () => 52 }).offload).toBe(false)
  })

  test("the verdict carries its evidence, not just its conclusion", () => {
    const v = traversalVerdict(readN("/book", 6, big), { windowTokens: W, filesInDir: () => 52 })
    expect(v.filesRead).toBe(6)
    expect(v.materialTokens).toBeGreaterThan(v.budgetTokens!)
    expect(v.reason).toContain("still unread")
  })

  test("the decision is invariant to language: it never reads a word of the ask", () => {
    // Same trace, three imaginary asks. There is no parameter to pass one through, which IS the property.
    const a = traversalVerdict(readN("/книга", 6, big), { windowTokens: W, filesInDir: () => 52 })
    const b = traversalVerdict(readN("/book", 6, big), { windowTokens: W, filesInDir: () => 52 })
    expect(a.offload).toBe(b.offload)
    expect(a.offload).toBe(true)
  })

  test("malformed events are ignored rather than corrupting the count", () => {
    const st = initTraversal()
    observeRead(st, { dir: "", path: "/x", chars: 10 } as any)
    observeRead(st, { dir: "/x", path: "", chars: 10 } as any)
    observeRead(st, {} as any)
    expect(st.byDir.size).toBe(0)
  })
})
