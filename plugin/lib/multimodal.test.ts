import { test, expect } from "bun:test"
import { whichAny, resolveVision, visionBody, mimeFromPath, extractVision, whisperPythonCandidates } from "./multimodal"

test("whichAny finds a present binary, null for absent", async () => {
  expect(await whichAny(["definitely-not-a-real-bin-xyz", "ls"])).toContain("ls")
  expect(await whichAny(["definitely-not-a-real-bin-xyz"])).toBe(null)
})
test("resolveVision: env override, LM VLM, none", () => {
  expect(resolveVision({ FABULA_VISION_URL: "http://h/v1/chat/completions", FABULA_VISION_MODEL: "m", FABULA_VISION_KEY: "k" })?.headers.Authorization).toBe("Bearer k")
  expect(resolveVision({ LMSTUDIO_VLM_MODEL: "qwen-vl" })?.model).toBe("qwen-vl")
  expect(resolveVision({})).toBe(null)
})
test("visionBody is OpenAI vision-compatible", () => {
  const b = visionBody("m", "what is this", "data:image/png;base64,AAAA")
  expect(b.model).toBe("m")
  expect(b.messages[0].content[0]).toEqual({ type: "text", text: "what is this" })
  expect(b.messages[0].content[1].image_url.url).toContain("data:image/png")
})
test("mimeFromPath maps extensions", () => {
  expect(mimeFromPath("a.png")).toBe("image/png")
  expect(mimeFromPath("a.JPG")).toBe("image/jpeg")
  expect(mimeFromPath("a.webp")).toBe("image/webp")
})
test("extractVision: content, then reasoning fallback, then empty", () => {
  expect(extractVision({ choices: [{ message: { content: "  a cat  " } }] })).toBe("a cat")
  const r = extractVision({ choices: [{ message: { content: "", reasoning_content: "it is a dog" } }] })
  expect(r).toContain("it is a dog")
  expect(r).toContain("from model reasoning")
  expect(extractVision({ choices: [{ message: {} }] })).toBe("")
})
test("whisperPythonCandidates: env first, then system python", () => {
  const c = whisperPythonCandidates({ FABULA_WHISPER_PYTHON: "/x/py", HOME: "/home/u" })
  expect(c[0]).toBe("/x/py")
  expect(c[c.length - 1]).toBe("python3")
  expect(c.length).toBe(2)
})
