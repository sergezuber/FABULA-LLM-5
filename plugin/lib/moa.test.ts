import { test, expect } from "bun:test"
import { resolveProviders, chatBody, extractText, synthesisPrompt, pickAggregator, cloudEndpointsAllowed } from "./moa"

test("resolveProviders: local always present; NVIDIA added with key", () => {
  const p = resolveProviders({ NVIDIA_API_KEY: "nv-x" })
  expect(p.find((x) => x.name === "local-qwen")).toBeTruthy()
  expect(p.filter((x) => x.cloud).length).toBe(2)          // glm + deepseek
  expect(p.find((x) => x.name === "nvidia-glm")?.headers.Authorization).toBe("Bearer nv-x")
})
test("resolveProviders: ZAI added with ZHIPU key", () => {
  const p = resolveProviders({ NVIDIA_API_KEY: "nv", ZHIPU_API_KEY: "z" })
  const zai = p.find((x) => x.name === "zai-glm")
  expect(zai?.cloud).toBe(true)
  expect(zai?.url).toContain("api.z.ai")
  expect(zai?.headers.Authorization).toBe("Bearer z")
  expect(p.filter((x) => x.cloud).length).toBe(3)          // nvidia-glm + nvidia-deepseek + zai
})
test("resolveProviders: no cloud key → only local", () => {
  const p = resolveProviders({})
  expect(p.length).toBe(1)
  expect(p[0].name).toBe("local-qwen")
})
// RULE #18: a cloud key present under a test runner must NOT produce a cloud endpoint (bun test
// auto-loads .env → the key is there; the choke-point guard drops it). Local stays as the test target.
test("resolveProviders: cloud key under a test runner → local only (no cloud emitted)", () => {
  const p = resolveProviders({ BUN_TEST: "1", NVIDIA_API_KEY: "nv", ZHIPU_API_KEY: "z" })
  expect(p.map((x) => x.name)).toEqual(["local-qwen"])
  expect(p.some((x) => x.cloud)).toBe(false)
})
test("resolveProviders: explicit FABULA_TEST_ALLOW_CLOUD re-enables cloud under a test runner", () => {
  const p = resolveProviders({ BUN_TEST: "1", FABULA_TEST_ALLOW_CLOUD: "1", ZHIPU_API_KEY: "z" })
  expect(p.find((x) => x.name === "zai-glm")?.cloud).toBe(true)
})
test("cloudEndpointsAllowed: off under a test runner, on when opted in or outside tests", () => {
  expect(cloudEndpointsAllowed({ BUN_TEST: "1" })).toBe(false)
  expect(cloudEndpointsAllowed({ NODE_ENV: "test" })).toBe(false)
  expect(cloudEndpointsAllowed({ BUN_TEST: "1", FABULA_TEST_ALLOW_CLOUD: "1" })).toBe(true)
  expect(cloudEndpointsAllowed({})).toBe(true)
})
test("resolveProviders: FABULA_MOA_ENDPOINTS override", () => {
  const p = resolveProviders({ FABULA_MOA_ENDPOINTS: JSON.stringify([{ name: "x", url: "http://h/v1/chat/completions", model: "m", key: "k", cloud: true }]) })
  expect(p.length).toBe(1)
  expect(p[0].name).toBe("x")
  expect(p[0].headers.Authorization).toBe("Bearer k")
})
test("chatBody is OpenAI-compatible", () => {
  const b = chatBody("m", "hi", 50)
  expect(b.model).toBe("m")
  expect(b.messages[0]).toEqual({ role: "user", content: "hi" })
  expect(b.max_tokens).toBe(50)
  expect(b.stream).toBe(false)
})
test("extractText handles chat + completion shapes + empty", () => {
  expect(extractText({ choices: [{ message: { content: " hello " } }] })).toBe("hello")
  expect(extractText({ choices: [{ text: "x" }] })).toBe("x")
  expect(extractText({})).toBe("")
})
test("synthesisPrompt includes question + all candidates + no-leak instruction", () => {
  const s = synthesisPrompt("Q?", [{ name: "a", text: "A1" }, { name: "b", text: "B1" }])
  expect(s).toContain("Q?")
  expect(s).toContain("A1"); expect(s).toContain("B1")
  expect(s).toContain("Do NOT mention the candidates")
})
test("pickAggregator prefers a cloud responder", () => {
  const ps = resolveProviders({ NVIDIA_API_KEY: "k" })
  const agg = pickAggregator(ps, new Set(["local-qwen", "nvidia-glm"]))
  expect(agg?.cloud).toBe(true)
  // only local answered → fall back to local
  expect(pickAggregator(ps, new Set(["local-qwen"]))?.name).toBe("local-qwen")
  // nobody answered → null
  expect(pickAggregator(ps, new Set())).toBe(null)
})
