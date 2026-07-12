// FABULA-LLM-5 — agentic browser (separate plugin per the one-plugin-per-file rule so a Playwright load
// failure can't break the core tools). Playwright is imported DYNAMICALLY inside execute(), so the
// plugin loads even when Playwright isn't installed — the tools just report that cleanly.
//
//   navigate / snapshot / click / type / scroll / vision / back / press / get_images / console / dialog / cdp / close
// SSRF: navigation is checked with the same floor as web_fetch (no internal/metadata hosts). Page text
// is attacker-controlled → fabula-security wraps browser_* output as <untrusted_tool_result> (see untrusted.ts).

import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import type { Plugin } from "@mimo-ai/plugin"
import { checkUrl, ssrfBlockedMessage } from "./lib/ssrf"
import { resolveVision, visionBody, extractVision } from "./lib/multimodal"
import { redactSecrets } from "./lib/redact"

const z = tool.schema
const PAGE_CAP = 8000

let _pw: any = null      // chromium browser instance (lazy, shared)
let _page: any = null
let _console: string[] = []                                   // captured console/page errors
let _dialog: { action: "accept" | "dismiss"; text?: string } = { action: "dismiss" }
let _cdp: any = null                                          // cached CDP session

async function getPage(): Promise<any> {
  let chromium: any
  try { ({ chromium } = await import("playwright")) }
  catch { throw new Error("Playwright is not installed. Run: cd plugin && bun add playwright && bunx playwright install chromium") }
  if (!_pw || !_pw.isConnected?.()) _pw = await chromium.launch({ headless: true })
  if (!_page || _page.isClosed?.()) {
    _page = await _pw.newPage({ userAgent: "FABULA-LLM-5/1.0 (research agent)" })
    _page.setDefaultTimeout(20000)
    _console = []; _cdp = null
    _page.on("console", (m: any) => { if (_console.length < 300) _console.push(`[${m.type()}] ${m.text()}`.slice(0, 500)) })
    _page.on("pageerror", (e: any) => { if (_console.length < 300) _console.push(`[pageerror] ${e.message}`.slice(0, 500)) })
    // dialogs (alert/confirm/prompt) are handled per the current policy (default: dismiss)
    _page.on("dialog", async (d: any) => { try { _dialog.action === "accept" ? await d.accept(_dialog.text) : await d.dismiss() } catch {} })
  }
  return _page
}

async function pageText(page: any): Promise<string> {
  const txt = await page.evaluate(() => (document.body ? (document.body as any).innerText : "")).catch(() => "")
  const t = String(txt || "").replace(/\n{3,}/g, "\n\n").trim()
  return t.length > PAGE_CAP ? t.slice(0, PAGE_CAP) + `\n…[truncated ${t.length - PAGE_CAP} chars — scroll or ask for a section]` : t
}

async function describe(page: any, note = ""): Promise<string> {
  const url = page.url()
  const title = await page.title().catch(() => "")
  return `${note ? note + "\n" : ""}URL: ${url}\nTitle: ${title}\n\n${await pageText(page)}`
}

export const FabulaBrowser: Plugin = async () => gate("browser", ({
  tool: {
    browser_navigate: tool({
      description: "Open a URL in a headless browser and return the page title + visible text. Use for JS-heavy " +
        "pages where web_fetch (static fetch) is insufficient. Internal/metadata hosts are refused (SSRF).",
      args: { url: z.string().describe("URL to open (https://…)"), description: z.string().describe("Why") },
      async execute(args: any) {
        const v = await checkUrl(args.url)
        if (v.blocked) return ssrfBlockedMessage(v, args.url)
        try {
          const page = await getPage()
          await page.goto(args.url, { waitUntil: "domcontentloaded" })
          return { output: await describe(page), metadata: { url: page.url() } }
        } catch (e: any) { return `browser_navigate error: ${e.message}` }
      },
    }),
    browser_snapshot: tool({
      description: "Return the current browser page's title + visible text (after clicks/typing/scrolling).",
      args: { description: z.string().describe("Why") },
      async execute() {
        if (!_page || _page.isClosed?.()) return "browser_snapshot: no page open — call browser_navigate first."
        try { return { output: await describe(_page) } } catch (e: any) { return `browser_snapshot error: ${e.message}` }
      },
    }),
    browser_click: tool({
      description: "Click an element on the current page by CSS selector or visible text.",
      args: { target: z.string().describe("CSS selector or exact visible text"), description: z.string().describe("Why") },
      async execute(args: any) {
        if (!_page || _page.isClosed?.()) return "browser_click: no page open — call browser_navigate first."
        try {
          const loc = /^[.#\[]/.test(args.target) ? _page.locator(args.target) : _page.getByText(args.target, { exact: false }).first()
          await loc.click({ timeout: 10000 })
          await _page.waitForLoadState("domcontentloaded").catch(() => {})
          return { output: await describe(_page, `Clicked ${args.target}.`) }
        } catch (e: any) { return `browser_click error: ${e.message}` }
      },
    }),
    browser_type: tool({
      description: "Type text into an input on the current page (CSS selector), optionally submitting with Enter.",
      args: { selector: z.string().describe("CSS selector of the input"), text: z.string().describe("Text to type"),
        submit: z.boolean().nullish().describe("Press Enter after"), description: z.string().describe("Why") },
      async execute(args: any) {
        if (!_page || _page.isClosed?.()) return "browser_type: no page open — call browser_navigate first."
        try {
          await _page.fill(args.selector, args.text, { timeout: 10000 })
          if (args.submit) { await _page.press(args.selector, "Enter"); await _page.waitForLoadState("domcontentloaded").catch(() => {}) }
          return { output: await describe(_page, `Typed into ${args.selector}.`) }
        } catch (e: any) { return `browser_type error: ${e.message}` }
      },
    }),
    browser_scroll: tool({
      description: "Scroll the current page up or down by roughly one viewport.",
      args: { direction: z.string().nullish().describe("'down' (default) or 'up'"), description: z.string().describe("Why") },
      async execute(args: any) {
        if (!_page || _page.isClosed?.()) return "browser_scroll: no page open — call browser_navigate first."
        try {
          const dir = args.direction === "up" ? -1 : 1
          await _page.evaluate((d: number) => window.scrollBy(0, d * Math.round(window.innerHeight * 0.9)), dir)
          return { output: await describe(_page, `Scrolled ${dir < 0 ? "up" : "down"}.`) }
        } catch (e: any) { return `browser_scroll error: ${e.message}` }
      },
    }),
    browser_vision: tool({
      description: "Screenshot the current page and analyze it visually with a vision model (for layout/images/" +
        "charts that text extraction misses). Requires a vision endpoint (FABULA_VISION_URL+MODEL or LMSTUDIO_VLM_MODEL).",
      args: { prompt: z.string().describe("What to look for in the page screenshot"), description: z.string().describe("Why") },
      async execute(args: any) {
        if (!_page || _page.isClosed?.()) return "browser_vision: no page open — call browser_navigate first."
        const ep = resolveVision(process.env)
        if (!ep) return "browser_vision: no vision endpoint configured. Set FABULA_VISION_URL+FABULA_VISION_MODEL (+KEY) or LMSTUDIO_VLM_MODEL."
        try {
          const png = await _page.screenshot({ type: "png", fullPage: false })
          const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`
          const r = await fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json", ...ep.headers }, body: JSON.stringify(visionBody(ep.model, args.prompt, dataUrl)) })
          if (!r.ok) return `browser_vision error: HTTP ${r.status} from vision endpoint.`
          return { output: redactSecrets(extractVision(await r.json()) || "(empty)").text, metadata: { model: ep.model } }
        } catch (e: any) { return `browser_vision error: ${e.message}` }
      },
    }),
    browser_back: tool({
      description: "Navigate back in the browser history.",
      args: { description: z.string().describe("Why") },
      async execute() {
        if (!_page || _page.isClosed?.()) return "browser_back: no page open — call browser_navigate first."
        try { await _page.goBack({ waitUntil: "domcontentloaded" }); return { output: await describe(_page, "Navigated back.") } }
        catch (e: any) { return `browser_back error: ${e.message}` }
      },
    }),
    browser_press: tool({
      description: "Press a keyboard key on the current page (e.g. Enter, Tab, Escape, ArrowDown, PageDown, 'Control+a').",
      args: { key: z.string().describe("Key or combo, Playwright syntax (e.g. 'Enter', 'Control+a')"), description: z.string().describe("Why") },
      async execute(args: any) {
        if (!_page || _page.isClosed?.()) return "browser_press: no page open — call browser_navigate first."
        try { await _page.keyboard.press(args.key); await _page.waitForLoadState("domcontentloaded").catch(() => {}); return { output: await describe(_page, `Pressed ${args.key}.`) } }
        catch (e: any) { return `browser_press error: ${e.message}` }
      },
    }),
    browser_get_images: tool({
      description: "List the images on the current page (src URL + alt text). Use to find figures/charts to fetch or analyze.",
      args: { description: z.string().describe("Why") },
      async execute() {
        if (!_page || _page.isClosed?.()) return "browser_get_images: no page open — call browser_navigate first."
        try {
          const imgs = await _page.evaluate(() => Array.from(document.images).slice(0, 60).map((i: any) => ({ src: i.currentSrc || i.src, alt: i.alt || "", w: i.naturalWidth, h: i.naturalHeight })))
          if (!imgs.length) return { output: "No images on the page." }
          return { output: `${imgs.length} image(s):\n` + imgs.map((i: any, n: number) => `  ${n + 1}. ${i.w}×${i.h} ${i.alt ? `“${i.alt}” ` : ""}${i.src}`).join("\n"), metadata: { count: imgs.length } }
        } catch (e: any) { return `browser_get_images error: ${e.message}` }
      },
    }),
    browser_console: tool({
      description: "Read recent browser console/JS-error messages, or evaluate a JavaScript expression in the page.",
      args: { eval: z.string().nullish().describe("Optional JS expression to evaluate in the page"), description: z.string().describe("Why") },
      async execute(args: any) {
        if (!_page || _page.isClosed?.()) return "browser_console: no page open — call browser_navigate first."
        try {
          if (args.eval) {
            const res = await _page.evaluate((e: string) => { try { return JSON.stringify((0, eval)(e)) } catch (err: any) { return "eval error: " + err.message } }, args.eval)
            return { output: `eval → ${String(res).slice(0, PAGE_CAP)}` }
          }
          return { output: _console.length ? "Console:\n" + _console.slice(-50).join("\n") : "(no console messages)" }
        } catch (e: any) { return `browser_console error: ${e.message}` }
      },
    }),
    browser_dialog: tool({
      description: "Set how the NEXT native JS dialog (alert/confirm/prompt) is handled: accept (optionally with text) or dismiss.",
      args: { accept: z.boolean().describe("true=accept/OK, false=dismiss/Cancel"), prompt_text: z.string().nullish().describe("Text for a prompt() dialog"), description: z.string().describe("Why") },
      async execute(args: any) {
        await getPage().catch(() => {})
        _dialog = { action: args.accept ? "accept" : "dismiss", text: args.prompt_text || undefined }
        return `Next dialog will be ${args.accept ? "accepted" : "dismissed"}${args.prompt_text ? ` with "${args.prompt_text}"` : ""}.`
      },
    }),
    browser_cdp: tool({
      description: "Escape hatch: send a raw Chrome DevTools Protocol command (e.g. 'Network.enable', 'Page.captureScreenshot'). Advanced.",
      args: { method: z.string().describe("CDP method, e.g. 'Runtime.evaluate'"), params: z.any().nullish().describe("CDP params object"), description: z.string().describe("Why") },
      async execute(args: any) {
        if (!_page || _page.isClosed?.()) return "browser_cdp: no page open — call browser_navigate first."
        try {
          if (!_cdp) _cdp = await _page.context().newCDPSession(_page)
          const res = await _cdp.send(args.method, args.params || {})
          return { output: `CDP ${args.method} →\n${JSON.stringify(res).slice(0, PAGE_CAP)}`, metadata: { method: args.method } }
        } catch (e: any) { return `browser_cdp error: ${e.message}` }
      },
    }),
    browser_close: tool({
      description: "Close the headless browser to free resources.",
      args: { description: z.string().describe("Why") },
      async execute() {
        try { await _pw?.close?.() } catch {}
        _pw = null; _page = null; _cdp = null; _console = []
        return "Browser closed."
      },
    }),
  },
}))
