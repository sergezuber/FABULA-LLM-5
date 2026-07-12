import { test, expect } from "bun:test"
import {
  isImageMime, imageFileParts, messageModel, messageRole, messageParts,
  parseLMStudioTypes, isLocalBaseURL, lmStudioApiBase,
  resolveCapability, shouldGate, visionNotice, desiredVisionConfig,
} from "./vision"

// ── mime / part detection ──
test("isImageMime: only image/* mimes", () => {
  expect(isImageMime("image/png")).toBe(true)
  expect(isImageMime("image/jpeg")).toBe(true)
  expect(isImageMime("IMAGE/WEBP")).toBe(true)
  expect(isImageMime("application/pdf")).toBe(false)
  expect(isImageMime("text/plain")).toBe(false)
  expect(isImageMime(undefined)).toBe(false)
  expect(isImageMime(123 as any)).toBe(false)
})

test("imageFileParts: picks image file parts only", () => {
  const parts = [
    { type: "text", text: "hi" },
    { type: "file", mime: "image/png", filename: "a.png" },
    { type: "file", mime: "application/pdf", filename: "b.pdf" },
    { type: "file", mime: "image/jpeg", filename: "c.jpg" },
    null,
  ]
  const got = imageFileParts(parts)
  expect(got.length).toBe(2)
  expect(got.map((p) => p.filename)).toEqual(["a.png", "c.jpg"])
  expect(imageFileParts(undefined)).toEqual([])
  expect(imageFileParts("nope" as any)).toEqual([])
})

test("messageModel/role/parts: transformed and raw shapes", () => {
  const transformed = { info: { role: "user", model: { providerID: "lmstudio", modelID: "m1" } }, parts: [{ type: "text" }] }
  expect(messageModel(transformed)).toEqual({ providerID: "lmstudio", modelID: "m1" })
  expect(messageRole(transformed)).toBe("user")
  expect(messageParts(transformed).length).toBe(1)
  const raw = { role: "assistant", model: { providerID: "nvidia", modelID: "x" } }
  expect(messageModel(raw)).toEqual({ providerID: "nvidia", modelID: "x" })
  expect(messageRole(raw)).toBe("assistant")
  expect(messageParts({} as any)).toEqual([])
  expect(messageModel(null)).toEqual({ providerID: undefined, modelID: undefined })
})

// ── LM Studio type parsing ──
test("parseLMStudioTypes: maps id→type from /api/v0/models payload", () => {
  const json = { data: [
    { id: "qwen-vl-mlx", type: "vlm" },
    { id: "qwen-text", type: "llm" },
    { id: "nomic-embed", type: "embeddings" },
    { id: "bad" }, // missing type → skipped
    null,
  ] }
  const m = parseLMStudioTypes(json)
  expect(m.get("qwen-vl-mlx")).toBe("vlm")
  expect(m.get("qwen-text")).toBe("llm")
  expect(m.has("bad")).toBe(false)
  expect(m.size).toBe(3)
  // tolerates a bare array and junk
  expect(parseLMStudioTypes([{ id: "x", type: "vlm" }]).get("x")).toBe("vlm")
  expect(parseLMStudioTypes(null).size).toBe(0)
  expect(parseLMStudioTypes({}).size).toBe(0)
})

test("isLocalBaseURL / lmStudioApiBase", () => {
  expect(isLocalBaseURL("http://localhost:1234/v1")).toBe(true)
  expect(isLocalBaseURL("http://127.0.0.1:1234/v1")).toBe(true)
  expect(isLocalBaseURL("https://integrate.api.nvidia.com/v1")).toBe(false)
  expect(isLocalBaseURL(undefined)).toBe(false)
  expect(lmStudioApiBase("http://localhost:1234/v1")).toBe("http://localhost:1234")
  expect(lmStudioApiBase("http://localhost:1234/v1/")).toBe("http://localhost:1234")
  expect(lmStudioApiBase("http://localhost:1234")).toBe("http://localhost:1234")
})

// ── capability resolution (the no-false-positive heart) ──
test("resolveCapability: engineCap is authoritative", () => {
  expect(resolveCapability({ engineCap: true })).toBe(true)
  expect(resolveCapability({ engineCap: false })).toBe(false)
  // engineCap wins over everything else
  expect(resolveCapability({ engineCap: false, modalitiesInput: ["text", "image"], lmStudioType: "vlm" })).toBe(false)
})

test("resolveCapability: config modalities used when no engineCap", () => {
  expect(resolveCapability({ modalitiesInput: ["text", "image"] })).toBe(true)
  expect(resolveCapability({ modalitiesInput: ["text"] })).toBe(false)
  expect(resolveCapability({ modalitiesInput: [] })).toBe(false)
})

test("resolveCapability: malformed (non-array) modalities.input → null, never a false positive", () => {
  // the engine computes capability via `modalities?.input?.includes("image")` on the RAW config value.
  // A string "image" satisfies String.prototype.includes → engine TRUE → it forwards the image.
  // So a non-array-but-present modalities.input must resolve to UNKNOWN (null), NOT false — else we
  // would strip+notice an image the model actually received (the forbidden false positive).
  expect(resolveCapability({ modalitiesInput: "image" })).toBe(null)
  expect(resolveCapability({ modalitiesInput: "text" })).toBe(null)
  expect(resolveCapability({ modalitiesInput: { input: ["image"] } })).toBe(null)
  // even with a cold cache + a (possibly stale) llm type, malformed modalities must NOT gate:
  expect(resolveCapability({ engineCap: undefined, modalitiesInput: "image", lmStudioType: "llm" })).toBe(null)
  // a real array still decides normally:
  expect(resolveCapability({ modalitiesInput: ["text", "image"] })).toBe(true)
  expect(resolveCapability({ modalitiesInput: ["text"] })).toBe(false)
})

test("resolveCapability: non-vlm LM Studio type → false; bare vlm/unknown → null (no false positive)", () => {
  expect(resolveCapability({ lmStudioType: "llm" })).toBe(false)
  expect(resolveCapability({ lmStudioType: "embeddings" })).toBe(false)
  // a bare VLM with NO config/engine confirmation must NOT assert capability → null (don't gate)
  expect(resolveCapability({ lmStudioType: "vlm" })).toBe(null)
  expect(resolveCapability({})).toBe(null)
  expect(resolveCapability({ lmStudioType: "" })).toBe(null)
})

test("shouldGate: fires only on (image present) AND (known incapable)", () => {
  expect(shouldGate(false, true)).toBe(true)
  expect(shouldGate(true, true)).toBe(false)   // capable → never gate
  expect(shouldGate(null, true)).toBe(false)   // unknown → never gate (no false positive)
  expect(shouldGate(false, false)).toBe(false) // no image → nothing to gate
})

// ── notice wording ──
test("visionNotice: text-only vs vision-but-not-enabled wording", () => {
  const textOnly = visionNotice("m-text", ["a.png"], false)
  expect(textOnly).toContain("text-only")
  expect(textOnly).toContain("a.png")
  expect(textOnly).toContain("vision_analyze")
  expect(textOnly).not.toContain("sync_model_vision")
  const notEnabled = visionNotice("m-vlm", [], true)
  expect(notEnabled).toContain("vision-capable")
  expect(notEnabled).toContain("sync_model_vision")
})

// ── sync desired config ──
test("desiredVisionConfig: vlm→image, llm→text-only, embeddings→null", () => {
  expect(desiredVisionConfig("vlm")).toEqual({ modalities: { input: ["text", "image"], output: ["text"] }, attachment: true })
  expect(desiredVisionConfig("VLM")).toEqual({ modalities: { input: ["text", "image"], output: ["text"] }, attachment: true })
  expect(desiredVisionConfig("llm")).toEqual({ modalities: { input: ["text"], output: ["text"] }, attachment: false })
  expect(desiredVisionConfig("embeddings")).toBe(null)
  expect(desiredVisionConfig(undefined)).toEqual({ modalities: { input: ["text"], output: ["text"] }, attachment: false })
})
