import { test, expect } from "bun:test"
import { resolveProviders, chatBody, extractText, synthesisPrompt, pickAggregator } from "./moa"

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
