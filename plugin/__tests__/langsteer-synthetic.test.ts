// The language pin anchors on the reader's own words, never on the harness's.
//
// Measured live (2026-07-28): after a media-overflow compaction the engine appends a SYNTHETIC user
// message — written in English — telling the model how to continue. The language steer took "the last
// user message" as the current ask, anchored on that English note, and pinned English onto a Russian
// conversation: «о чем книга?» came back answered in English. The ask is the last user message the
// USER wrote; synthetic turns are the harness talking to the model.
import { test, expect, describe } from "bun:test"
import { FabulaContext } from "../fabula-context"

const realMsg = (text: string) => ({ info: { role: "user" }, parts: [{ type: "text", text }] })
const syntheticMsg = (text: string) => ({ info: { role: "user" }, parts: [{ type: "text", text, synthetic: true }] })

describe("language steer vs synthetic turns", () => {
  test("anchors on the reader's Russian ask, not the harness's English note", async () => {
    const plugin: any = await (FabulaContext as any)({ directory: "/tmp" })
    const h = plugin["experimental.chat.messages.transform"]
    if (!h) return
    const ask = realMsg("о чем книга? прочти полностью и дай развёрнутый ответ по-русски со всеми деталями")
    const note = syntheticMsg(
      "Some oversized attachments were dropped from context. Continue the task if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    )
    const messages = [ask, note]
    await h({}, { messages })
    const noteText = String((note.parts[0] as any).text)
    const askText = String((ask.parts[0] as any).text)
    // the pin must not land on the synthetic note, and if it landed at all it must name Russian
    expect(noteText.includes("[Write the entire answer in ")).toBe(false)
    if (askText.includes("[Write the entire answer in ")) {
      expect(askText).toContain("Russian")
    }
  })

  test("control: with no synthetic turn the same ask still gets its Russian pin", async () => {
    const plugin: any = await (FabulaContext as any)({ directory: "/tmp" })
    const h = plugin["experimental.chat.messages.transform"]
    if (!h) return
    const ask = realMsg("о чем книга? прочти полностью и дай развёрнутый ответ по-русски со всеми деталями")
    const messages = [ask]
    await h({}, { messages })
    expect(String((ask.parts[0] as any).text)).toContain("[Write the entire answer in ")
    expect(String((ask.parts[0] as any).text)).toContain("Russian")
  })

  test("a conversation of only synthetic turns steers nothing at all", async () => {
    const plugin: any = await (FabulaContext as any)({ directory: "/tmp" })
    const h = plugin["experimental.chat.messages.transform"]
    if (!h) return
    const note = syntheticMsg("Continue the task if you have next steps.")
    const messages = [note]
    const before = JSON.stringify(messages)
    await h({}, { messages })
    expect(JSON.stringify(messages)).toBe(before)
  })
})
