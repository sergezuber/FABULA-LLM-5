// Live browser tests: real headless Chromium (installed via `bunx playwright install chromium`).
import { test, expect, afterAll } from "bun:test"
import { FabulaBrowser } from "../fabula-browser"

let B: any
const ctx = {} as any
const out = (r: any) => (typeof r === "string" ? r : r.output)
async function tools() { if (!B) B = (await FabulaBrowser({} as any)).tool; return B }
afterAll(async () => { try { (await tools()).browser_close.execute({ description: "x" }) } catch {} })

// The live-page tests need a real headless Chromium binary (`bunx playwright install chromium`), which
// CI does not download — so `chromium.launch()` throws there. Probe once by actually launching (the
// only reliable signal: `executablePath()` points at the full build even when just the headless shell
// is installed) and gate the live tests behind it, so they skip gracefully like every other
// external-dep suite instead of failing on a missing browser. The SSRF test below never launches, so
// it always runs.
const browserReady = await (async () => {
  try {
    const { chromium } = await import("playwright")
    const b = await chromium.launch({ headless: true })
    await b.close()
    return true
  } catch { return false }
})()
if (!browserReady) console.warn("[skip] headless Chromium unavailable (run: cd plugin && bunx playwright install chromium) — skipping live browser tests")

test("browser_navigate refuses SSRF / internal targets", async () => {
  const T = await tools()
  expect(out(await T.browser_navigate.execute({ url: "http://169.254.169.254/", description: "x" }))).toContain("BLOCKED")
  expect(out(await T.browser_navigate.execute({ url: "http://localhost:1/", description: "x" }))).toContain("BLOCKED")
})

test.if(browserReady)("browser_navigate loads a real public page + snapshot works", async () => {
  const T = await tools()
  const r = await T.browser_navigate.execute({ url: "https://example.com/", description: "x" })
  expect(out(r)).toContain("Example Domain")
  const s = await T.browser_snapshot.execute({ description: "x" })
  expect(out(s)).toContain("Example Domain")
}, 60000)

test.if(browserReady)("browser console eval, get_images, press, dialog, cdp, back", async () => {
  const T = await tools()
  await T.browser_navigate.execute({ url: "https://example.com/", description: "x" })
  // console eval
  expect(out(await T.browser_console.execute({ eval: "1+1", description: "x" }))).toContain("2")
  // get_images (example.com has none → graceful string, no error)
  expect(out(await T.browser_get_images.execute({ description: "x" }))).toMatch(/image|No images/i)
  // press a key (no crash)
  expect(out(await T.browser_press.execute({ key: "End", description: "x" }))).toContain("Pressed End")
  // dialog policy
  expect(out(await T.browser_dialog.execute({ accept: true, prompt_text: "hi", description: "x" }))).toContain("accepted")
  // cdp escape hatch
  expect(out(await T.browser_cdp.execute({ method: "Browser.getVersion", description: "x" }))).toContain("product")
  // back: go to a 2nd page then back to example.com
  await T.browser_navigate.execute({ url: "https://www.iana.org/", description: "x" })
  const b = await T.browser_back.execute({ description: "x" })
  expect(out(b)).toContain("example.com")
}, 90000)
