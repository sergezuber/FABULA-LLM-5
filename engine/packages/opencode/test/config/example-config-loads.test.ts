import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import nodePath from "path"
import { ConfigParse } from "../../src/config/parse"
import { Info as ConfigInfo, normalizeLoadedConfig } from "../../src/config/config"

// The example config is the file this project tells people to copy — README and setup.sh both say
// `cp fabula.config.example.json fabula.config.json`. Nothing ever loaded it.
//
// MEASURED: it shipped four top-level keys the loader refuses. Three were pseudo-comments
// (`_comment_enhance`, `_comment_checkpoint`, `_comment_instructions`) written as KEYS in a file that
// is parsed as JSONC, where real `//` comments are legal. The fourth, `enhance`, was a genuine
// FABULA setting the enhance route consumes by reading this same file directly — while this loader
// parses it with `.strict()` and had never been told the key exists. So a fresh install died at
// startup with `unrecognized_keys` and pointed at a file the project had authored, and it was
// invisible to anyone whose own config predated the example.
//
// The check is deliberately the WHOLE parse, not a key allowlist: a list would have to be kept in
// step with the schema by hand, which is the failure that produced this defect in the first place.

const REPO = nodePath.resolve(import.meta.dir, "../../../../..")

const EXAMPLES = ["fabula.config.example.json"]

describe("the config this project ships as a starting point actually loads", () => {
  for (const rel of EXAMPLES) {
    test(`${rel} parses against the real schema`, () => {
      const text = readFileSync(nodePath.join(REPO, rel), "utf8")
      // Same two steps the loader performs: JSONC parse, then the strict schema.
      const parsed = ConfigParse.jsonc(text, rel)
      expect(() => ConfigParse.schema(ConfigInfo, parsed, rel)).not.toThrow()
    })

    test(`${rel} carries no pseudo-comment keys — this file is JSONC, so comments are comments`, () => {
      const parsed = ConfigParse.jsonc(readFileSync(nodePath.join(REPO, rel), "utf8"), rel) as Record<string, unknown>
      const pseudo = Object.keys(parsed).filter((k) => k.startsWith("_"))
      expect(pseudo).toEqual([])
    })
  }
})

describe("a config already copied from the broken example still loads", () => {
  // The example was corrected, but setup never overwrites an existing config — so every install made
  // while the example carried pseudo-comment keys keeps them forever. Those users' startup error was
  // exactly this shape (measured on a second machine): unrecognized_keys naming _comment_enhance,
  // enhance, _comment_checkpoint, _comment_instructions. The loader must carry them, not lecture them.
  test("top-level _comment keys are ignored, and the config parses", () => {
    const broken = {
      _comment_enhance: "prose that used to be a key",
      enhance: { _default: { max_tokens: 1024, timeout_ms: 45000 } },
      _comment_checkpoint: "more prose",
      checkpoint: { fork: true },
      _comment_instructions: "still more prose",
      model: "lmstudio/some-model",
    }
    const loaded = ConfigParse.schema(ConfigInfo, normalizeLoadedConfig(broken, "test"), "test") as Record<
      string,
      unknown
    >
    expect(Object.keys(loaded).some((k) => k.startsWith("_"))).toBe(false)
    // The REAL settings around the pseudo-comments must survive the stripping.
    expect(loaded["checkpoint"]).toEqual({ fork: true })
    expect((loaded["enhance"] as Record<string, unknown>)["_default"]).toEqual({ max_tokens: 1024, timeout_ms: 45000 })
  })

  test("below top level an underscore key is data and is NOT stripped", () => {
    // enhance._default is a live contract the enhance route reads; stripping recursively would
    // silently delete a working setting, which is the same defect wearing the opposite sign.
    const cfg = { enhance: { _default: { timeout_ms: 1000 } } }
    const loaded = ConfigParse.schema(ConfigInfo, normalizeLoadedConfig(cfg, "test"), "test") as Record<string, unknown>
    expect((loaded["enhance"] as Record<string, unknown>)["_default"]).toEqual({ timeout_ms: 1000 })
  })
})
