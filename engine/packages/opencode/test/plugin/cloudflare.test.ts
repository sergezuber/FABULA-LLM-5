import { expect, test } from "bun:test"
import { CloudflareAIGatewayAuthPlugin } from "@/plugin/cloudflare"
import { ProviderTransform } from "@/provider"

const pluginInput = {
  client: {} as never,
  project: {} as never,
  directory: "",
  worktree: "",
  experimental_workspace: {
    register() {},
  },
  serverUrl: new URL("https://example.com"),
  $: {} as never,
}

function makeHookInput(overrides: { providerID?: string; apiId?: string; reasoning?: boolean }) {
  return {
    sessionID: "s",
    agent: "a",
    provider: {} as never,
    message: {} as never,
    model: {
      providerID: overrides.providerID ?? "cloudflare-ai-gateway",
      api: { id: overrides.apiId ?? "openai/gpt-5.2-codex", url: "", npm: "ai-gateway-provider" },
      capabilities: {
        reasoning: overrides.reasoning ?? true,
        temperature: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
    } as never,
  }
}

// A non-zero marker that the plugin either clears (reasoning on cloudflare) or leaves.
// Drawn from the live default so the test tracks the real value rather than a stale 32K.
const KEPT = ProviderTransform.OUTPUT_TOKEN_MAX

function makeHookOutput() {
  return { temperature: 0, topP: 1, topK: 0, maxOutputTokens: KEPT as number | undefined, options: {} }
}

test("omits maxOutputTokens for openai reasoning models on cloudflare-ai-gateway", async () => {
  const hooks = await CloudflareAIGatewayAuthPlugin(pluginInput)
  const out = makeHookOutput()
  await hooks["chat.params"]!(makeHookInput({ apiId: "openai/gpt-5.2-codex", reasoning: true }), out)
  expect(out.maxOutputTokens).toBeUndefined()
})

test("keeps maxOutputTokens for openai non-reasoning models", async () => {
  const hooks = await CloudflareAIGatewayAuthPlugin(pluginInput)
  const out = makeHookOutput()
  await hooks["chat.params"]!(makeHookInput({ apiId: "openai/gpt-4-turbo", reasoning: false }), out)
  expect(out.maxOutputTokens).toBe(KEPT)
})

test("keeps maxOutputTokens for non-openai reasoning models on cloudflare-ai-gateway", async () => {
  const hooks = await CloudflareAIGatewayAuthPlugin(pluginInput)
  const out = makeHookOutput()
  await hooks["chat.params"]!(makeHookInput({ apiId: "anthropic/claude-sonnet-4-5", reasoning: true }), out)
  expect(out.maxOutputTokens).toBe(KEPT)
})

test("ignores non-cloudflare-ai-gateway providers", async () => {
  const hooks = await CloudflareAIGatewayAuthPlugin(pluginInput)
  const out = makeHookOutput()
  await hooks["chat.params"]!(makeHookInput({ providerID: "openai", apiId: "gpt-5.2-codex", reasoning: true }), out)
  expect(out.maxOutputTokens).toBe(KEPT)
})
