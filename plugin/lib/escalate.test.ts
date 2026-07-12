import { test, expect } from "bun:test"
import { pickCloudProvider, resolveApiKey, buildEscalationMessages } from "./escalate"

const CONFIG = {
  model: "cloudx/DeepSeek-V4-Pro",
  provider: {
    lmstudio: { options: { baseURL: "http://localhost:1235/v1" }, models: { "qwen-local": {} } },
    nvidia: { options: { baseURL: "https://integrate.api.nvidia.com/v1", apiKey: "{file:/x/.nvidia.key}" }, models: { "deepseek-ai/deepseek-v4-pro": {}, "z-ai/glm-5.1": {} } },
    cloudx: { options: { baseURL: "https://cloud.example.com/v1", apiKey: "{env:CLOUDX_API_KEY}" }, models: { "Qwen3.6-35B-A3B": {}, "glm-5.2": {} } },
  },
}

test("pickCloudProvider: explicit provider/model wins", () => {
  const t = pickCloudProvider(CONFIG, "nvidia/z-ai/glm-5.1")
  expect(t?.providerId).toBe("nvidia")
  expect(t?.model).toBe("z-ai/glm-5.1")
  expect(t?.baseURL).toContain("nvidia")
})

test("pickCloudProvider: provider id only → first model", () => {
  const t = pickCloudProvider(CONFIG, "cloudx")
  expect(t?.providerId).toBe("cloudx")
  expect(t?.model).toBe("Qwen3.6-35B-A3B")
})

test("pickCloudProvider: never returns a local provider", () => {
  const t = pickCloudProvider(CONFIG, "lmstudio")
  // lmstudio is local → falls through to a cloud provider (default model's = cloudx)
  expect(t?.providerId).not.toBe("lmstudio")
  expect(t?.providerId).toBe("cloudx")
})

test("pickCloudProvider: no pref → config default model's provider (cloudx)", () => {
  const t = pickCloudProvider(CONFIG)
  expect(t?.providerId).toBe("cloudx")
})

test("pickCloudProvider: null when no cloud provider exists", () => {
  const localOnly = { provider: { lmstudio: { options: { baseURL: "http://localhost:1235/v1" }, models: { m: {} } } } }
  expect(pickCloudProvider(localOnly)).toBeNull()
})

test("resolveApiKey: env / file / literal", () => {
  expect(resolveApiKey("{env:CLOUDX_API_KEY}", { env: { CLOUDX_API_KEY: "sk-abc " }, readFile: () => "" })).toBe("sk-abc")
  expect(resolveApiKey("{file:/x/.k}", { env: {}, readFile: (p) => (p === "/x/.k" ? "filekey\n" : "") })).toBe("filekey")
  expect(resolveApiKey("literal-key", { env: {}, readFile: () => "" })).toBe("literal-key")
  expect(resolveApiKey("{env:MISSING}", { env: {}, readFile: () => "" })).toBeNull()
})

test("buildEscalationMessages: system + structured user message", () => {
  const msgs = buildEscalationMessages({ task: "fix the parser", tried: "regex approach broke on nested quotes", context: "file.py line 40" })
  expect(msgs[0].role).toBe("system")
  expect(msgs[0].content).toContain("SECOND OPINION")
  expect(msgs[1].role).toBe("user")
  expect(msgs[1].content).toContain("fix the parser")
  expect(msgs[1].content).toContain("ALREADY TRIED")
  expect(msgs[1].content).toContain("nested quotes")
  expect(msgs[1].content).toContain("file.py line 40")
})
