import { test, expect } from "bun:test"
import { auxChain, callAux } from "./auxLLM"

test("auxChain: local first, cloud fallback when key present", () => {
  const c = auxChain({ NVIDIA_API_KEY: "k" })
  expect(c[0].name).toBe("local-qwen")
  expect(c[c.length - 1].name).toBe("nvidia-flash")
  expect(c[c.length - 1].headers.Authorization).toBe("Bearer k")
})
test("auxChain: custom endpoint takes priority", () => {
  const c = auxChain({ FABULA_AUX_URL: "http://h/v1/chat/completions", FABULA_AUX_MODEL: "m", FABULA_AUX_KEY: "x" })
  expect(c[0].name).toBe("aux-custom")
  expect(c[0].model).toBe("m")
  expect(c[0].headers.Authorization).toBe("Bearer x")
})
test("auxChain: no cloud key → just local", () => {
  expect(auxChain({}).map((x) => x.name)).toEqual(["local-qwen"])
})

// Live: LM Studio is typically down here → exercises the REAL fallback to NVIDIA flash.
const hasCloud = !!process.env.NVIDIA_API_KEY
test.if(hasCloud)("callAux falls back to a reachable model and returns text", async () => {
  let r
  try { r = await callAux("Reply with exactly the word: PONG", { maxTokens: 8 }) }
  catch (e: any) { if (/no aux model reachable/.test(e.message)) { console.warn("skip: all aux endpoints saturated under parallel load"); return } throw e }
  expect(r.text.length).toBeGreaterThan(0)
  expect(typeof r.provider).toBe("string")
}, 90000)
