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

// The live defect, 2026-07-28: the verdict landed on a screenshots subfolder the agent had wandered into
// — 5 files, fat ones, first past the counter — while 52 chapters sat unread in the folder above it. The
// window is shared, so the overflow belongs to the turn; the target belongs to the biggest job left.
describe("traversalVerdict — which body of material, when several are in play", () => {
  const st = () => {
    const s = initTraversal()
    // The wrong answer FIRST, deliberately. Directories are held in insertion order, so seeding the
    // decoy ahead of the book is what makes these assertions bite: a version that simply took the first
    // candidate — or the fattest — would pass if the book happened to be seen first, and the whole point
    // is that neither of those rules is what decides.
    // A handful of very fat files out of a small folder: most bytes, small scope.
    for (let i = 0; i < 5; i++) observeRead(s, { dir: "/book/shots", path: `/book/shots/s${i}.md`, chars: 50_000 })
    // A few chapters out of a large book: modest bytes, large scope.
    for (let i = 0; i < 5; i++) observeRead(s, { dir: "/book", path: `/book/ch${i}.md`, chars: 8_000 })
    return s
  }
  const sizes = (d: string) => (d === "/book" ? 52 : 10)

  test("targets the largest unfinished body, not the folder with the fattest files", () => {
    const v = traversalVerdict(st(), { windowTokens: 100_000, filesInDir: sizes })
    expect(v.offload).toBe(true)
    expect(v.dir).toBe("/book")
    expect(v.filesRemaining).toBe(47)
  })

  test("the overflow is counted across the whole turn, not per folder", () => {
    // Neither folder alone passes a 35% budget of this window; together they do.
    const s = initTraversal()
    for (let i = 0; i < 5; i++) observeRead(s, { dir: "/a", path: `/a/${i}`, chars: 30_000 })
    for (let i = 0; i < 5; i++) observeRead(s, { dir: "/b", path: `/b/${i}`, chars: 30_000 })
    const v = traversalVerdict(s, { windowTokens: 200_000, filesInDir: () => 60 })
    expect(v.offload).toBe(true)
    expect(v.materialTokens).toBe(120_000)
  })

  test("a folder with nothing left is never the target even when it dominates the bytes", () => {
    const v = traversalVerdict(st(), { windowTokens: 100_000, filesInDir: (d) => (d === "/book" ? 52 : 5) })
    expect(v.dir).toBe("/book")
  })
})

// The live case, twice over: the agent walked into a screenshots subfolder and never reached the
// chapters, so that subfolder was the ONLY directory with reads in it — and naming it was correct by a
// per-folder rule and useless to the reader. The working directory is the body they pointed at.
describe("traversalVerdict — a subfolder walked into is part of the same job", () => {
  const walkedIntoSubfolder = () => {
    const s = initTraversal()
    for (let i = 0; i < 5; i++) observeRead(s, { dir: "/book/shots", path: `/book/shots/s${i}.md`, chars: 50_000 })
    return s
  }
  // The root holds everything beneath it; the subfolder holds ten.
  const sizes = (d: string) => (d === "/book" ? 62 : 10)

  test("names the working directory, not the subfolder the agent happened to enter", () => {
    const v = traversalVerdict(walkedIntoSubfolder(), { windowTokens: 100_000, filesInDir: sizes, taskRoot: "/book" })
    expect(v.offload).toBe(true)
    expect(v.dir).toBe("/book")
    expect(v.filesRemaining).toBe(57)
  })

  test("without a working directory it still answers, with what it has", () => {
    const v = traversalVerdict(walkedIntoSubfolder(), { windowTokens: 100_000, filesInDir: sizes })
    expect(v.offload).toBe(true)
    expect(v.dir).toBe("/book/shots")
  })

  test("a directory elsewhere on disk can still win on its own merits", () => {
    const s = walkedIntoSubfolder()
    for (let i = 0; i < 8; i++) observeRead(s, { dir: "/other", path: `/other/f${i}.md`, chars: 5_000 })
    const v = traversalVerdict(s, {
      windowTokens: 100_000,
      filesInDir: (d) => (d === "/other" ? 900 : d === "/book" ? 62 : 10),
      taskRoot: "/book",
    })
    expect(v.dir).toBe("/other")
  })

  test("the working directory is not conjured up when nothing under it was read", () => {
    const s = initTraversal()
    for (let i = 0; i < 6; i++) observeRead(s, { dir: "/elsewhere", path: `/elsewhere/f${i}`, chars: 40_000 })
    const v = traversalVerdict(s, { windowTokens: 100_000, filesInDir: () => 60, taskRoot: "/book" })
    expect(v.dir).toBe("/elsewhere")
  })
})
