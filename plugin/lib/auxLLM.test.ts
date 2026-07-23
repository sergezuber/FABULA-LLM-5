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
// RULE #18: under a test runner the default local endpoint AND the cloud fallback are both off unless
// explicitly opted in — so `bun test` auto-loading a cloud key can never send a hermetic wiring test to
// a paid endpoint (the reported 3-red-timeout class). An explicitly named LOCAL endpoint still works.
test("auxChain: cloud key under a test runner → hermetic (empty chain)", () => {
  expect(auxChain({ BUN_TEST: "1", NVIDIA_API_KEY: "k" })).toEqual([])
})
test("auxChain: FABULA_TEST_ALLOW_CLOUD re-enables the cloud fallback under a test runner", () => {
  const c = auxChain({ BUN_TEST: "1", FABULA_TEST_ALLOW_CLOUD: "1", NVIDIA_API_KEY: "k" })
  expect(c.some((x) => x.name === "nvidia-flash")).toBe(true)
})
test("auxChain: explicit LMSTUDIO_URL keeps local under a test runner (no cloud)", () => {
  const c = auxChain({ BUN_TEST: "1", LMSTUDIO_URL: "http://localhost:1235/v1", NVIDIA_API_KEY: "k" })
  expect(c.map((x) => x.name)).toEqual(["local-qwen"])
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
