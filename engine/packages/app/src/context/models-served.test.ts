import { describe, expect, test } from "bun:test"
import { emptyModelsMessage, servedModelFilter } from "./models-served"

// The picker's half of "offer only what a provider really serves". The route answers with a list,
// an EMPTY list, or null, and the three must mean three different things. Nothing tested this
// before: the distinction rested on an empty array being truthy in JavaScript, so a single
// defensive `ids?.length` would have erased it without a red line anywhere.

const apply = (ids: string[] | null | undefined, declared: string[]) => {
  const allow = servedModelFilter(ids)
  return declared.filter((m) => !allow || allow(m))
}

describe("a provider that answered", () => {
  test("offers exactly what it named, and nothing it did not", () => {
    // The live case this was built for: the config still declares a model the runtime no longer has.
    expect(apply(["kat", "qwen"], ["kat", "qwen", "ornith"])).toEqual(["kat", "qwen"])
  })

  test("a name it serves but the config never declared adds nothing", () => {
    expect(apply(["kat", "extra"], ["kat"])).toEqual(["kat"])
  })
})

describe("a provider that refused the connection", () => {
  test("an EMPTY list hides every model it declares", () => {
    // Not "we do not know" — nobody is listening on that port, so none of these can answer.
    expect(apply([], ["fuse-1-Lite", "something-else"])).toEqual([])
  })
})

describe("a provider we could not ask", () => {
  test("null keeps everything visible — a menu emptied by a blip is no product", () => {
    expect(apply(null, ["kat", "qwen", "ornith"])).toEqual(["kat", "qwen", "ornith"])
  })

  test("absent from the map keeps everything visible", () => {
    expect(apply(undefined, ["kat"])).toEqual(["kat"])
  })
})

describe("the three answers stay three", () => {
  test("empty and null are NOT the same decision", () => {
    // The single assertion the whole change exists for. If these ever agree, the feature is gone.
    expect(apply([], ["a"])).not.toEqual(apply(null, ["a"]))
  })

  test("a filter is returned for a list and withheld for an absence", () => {
    expect(typeof servedModelFilter([])).toBe("function")
    expect(typeof servedModelFilter(["a"])).toBe("function")
    expect(servedModelFilter(null)).toBeUndefined()
    expect(servedModelFilter(undefined)).toBeUndefined()
  })
})

describe("what an empty list says", () => {
  const t = (key: string, params?: Record<string, string>) =>
    params ? `${key}|${JSON.stringify(params)}` : key

  test("with nothing hidden it is the plain no-results line", () => {
    expect(emptyModelsMessage([], t)).toBe("dialog.model.empty")
  })

  test("with a runtime not running it NAMES it — a blank list with no sentence is the defect", () => {
    expect(emptyModelsMessage(["LM Studio"], t)).toBe(
      'dialog.model.empty.notRunning|{"provider":"LM Studio"}',
    )
  })

  test("several are listed together rather than one standing for all", () => {
    expect(emptyModelsMessage(["LM Studio", "Fuse (local)"], t)).toBe(
      'dialog.model.empty.notRunning|{"provider":"LM Studio, Fuse (local)"}',
    )
  })
})
