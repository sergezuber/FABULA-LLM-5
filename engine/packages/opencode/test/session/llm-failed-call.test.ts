import { describe, expect, test } from "bun:test"
import { APICallError, RetryError } from "ai"
import { failedCall } from "../../src/session/llm"

// Real AI SDK error classes (no mocks) in the exact shape observed live 2026-07-10:
// a session running on lmstudio/qwen logged "stream error" whose real failing call was
// a nested request to https://api.z.ai with model glm-5.2 wrapped in a RetryError.
function zaiError() {
  return new APICallError({
    message: "Usage limit reached for 5 hour.",
    url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    requestBodyValues: { model: "glm-5.2" },
    statusCode: 429,
    responseHeaders: {},
    responseBody: "{}",
    isRetryable: true,
    data: {},
  })
}

describe("failedCall", () => {
  test("extracts url+model from a bare APICallError", () => {
    expect(failedCall(zaiError())).toEqual({
      url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      model: "glm-5.2",
    })
  })

  test("unwraps RetryError to the last attempt's real call (the live-observed shape)", () => {
    const retry = new RetryError({
      message: "maxRetriesExceeded",
      reason: "maxRetriesExceeded",
      errors: [zaiError(), zaiError()],
    })
    expect(failedCall(retry)).toEqual({
      url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      model: "glm-5.2",
    })
  })

  test("unwraps streamText's onError `{ error }` wrapper (the shape the callback actually receives)", () => {
    // Verified on a real run: the logged JSON is error={"error":{"name":"AI_APICallError",...}}.
    expect(failedCall({ error: zaiError() })).toEqual({
      url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      model: "glm-5.2",
    })
  })

  test("unwraps wrapper + RetryError combined", () => {
    const retry = new RetryError({ message: "maxRetriesExceeded", reason: "maxRetriesExceeded", errors: [zaiError()] })
    expect(failedCall({ error: retry })?.model).toBe("glm-5.2")
  })

  test("unwraps a cause chain", () => {
    const wrapped = new Error("stream failed", { cause: zaiError() })
    expect(failedCall(wrapped)?.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions")
  })

  test("omits model when the request body has none", () => {
    const e = new APICallError({
      message: "boom",
      url: "http://localhost:1235/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 500,
      responseHeaders: {},
      responseBody: "{}",
      isRetryable: false,
      data: {},
    })
    expect(failedCall(e)).toEqual({ url: "http://localhost:1235/v1/chat/completions" })
  })

  test("returns undefined for errors without an HTTP call", () => {
    expect(failedCall(new Error("plain"))).toBeUndefined()
    expect(failedCall(undefined)).toBeUndefined()
    expect(failedCall("string")).toBeUndefined()
  })

  test("survives circular cause chains", () => {
    const a = new Error("a")
    const b = new Error("b", { cause: a })
    ;(a as { cause?: unknown }).cause = b
    expect(failedCall(b)).toBeUndefined()
  })
})
