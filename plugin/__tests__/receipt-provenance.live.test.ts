// LIVE end-to-end integration — the REAL app, REAL requests, no mocks anywhere:
// the deployed engine binary drives the real model (through the :1235 adapter) on a real
// coding task in a throwaway git project; the real verify command goes green; the receipt
// plugin mints a Proof-of-Done receipt — and this test asserts the context-provenance v0.2
// identity fields landed in it (inputHash frozen by the engine, model descriptor from the
// live registry API, and a REAL weights digest over the model files on disk).
//
// Guarded: runs only with FABULA_LIVE=1 (needs ./bin/fabula, LM Studio + the :1235 adapter).
//   FABULA_LIVE=1 bun test __tests__/receipt-provenance.live.test.ts
// The first run hashes the model weights once (minutes for a big model); later runs hit the
// size+mtime cache and are instant.

import { describe, test, expect } from "bun:test"
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"

const LIVE = process.env.FABULA_LIVE === "1"
const REPO = resolve(import.meta.dir, "..", "..")
const ENGINE = join(REPO, "bin", "fabula")
const MODEL = process.env.FABULA_LIVE_MODEL || "qwen3.6-35b-a3b-uncensored-heretic-mlx"

describe.skipIf(!LIVE)("context-provenance v0.2 — LIVE end-to-end on the deployed binary", () => {
  test(
    "real task → real green verify → receipt carries inputHash + modelDescriptor + weightsDigest",
    async () => {
      // ── a real, verifiable throwaway project ──
      const proj = mkdtempSync(join(tmpdir(), "fab-live-proj-"))
      const iso = mkdtempSync(join(tmpdir(), "fab-live-iso-"))
      try {
        writeFileSync(join(proj, "greet.js"), 'module.exports = () => "goodbye";\n')
        writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "live-prov", version: "1.0.0" }))
        execSync("git init -q && git add -A && git commit -qm base", { cwd: proj })

        // ── isolated engine home; plugins loaded from THIS repo via the real symlink contract ──
        const xdgConfig = join(iso, "config")
        const xdgData = join(iso, "data")
        mkdirSync(join(xdgConfig, "fabula"), { recursive: true })
        mkdirSync(xdgData, { recursive: true })
        symlinkSync(join(REPO, "plugin"), join(xdgConfig, "fabula", "plugin"))
        const cfg = join(iso, "config.json")
        writeFileSync(
          cfg,
          JSON.stringify({
            share: "disabled",
            model: `lmstudio/${MODEL}`,
            provider: {
              lmstudio: {
                name: "LM Studio (live test)",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: "http://localhost:1235/v1" },
                models: { [MODEL]: { name: "live", tools: true, limit: { context: 131072, output: 32768 } } },
              },
            },
          }),
        )

        // A REAL verify: green only if the model actually made the edit.
        const verifyCmd = `node -e "const s=require('fs').readFileSync('greet.js','utf8'); if(!s.includes('hello world'))process.exit(1)"`

        const run = spawn(
          ENGINE,
          ["run", "--model", `lmstudio/${MODEL}`, "--print-logs", "--dangerously-skip-permissions",
            'Open greet.js and change the returned string "goodbye" to "hello world". Keep everything else identical. Then call verify_done.'],
          {
            cwd: proj,
            env: {
              ...process.env,
              XDG_CONFIG_HOME: xdgConfig,
              XDG_DATA_HOME: xdgData,
              MIMOCODE_CONFIG: cfg,
              MIMOCODE_DISABLE_CLAUDE_IMPORT: "1",
              FABULA_VERIFY_CMD: verifyCmd,
              FABULA_WEIGHTS_DIGEST: "1",
              // gates not under test here have their own suites; keep the run single-purpose
              FABULA_CHANGE_QUIZ: "0",
              FABULA_REPRODUCE_GATE: "0",
              FABULA_AUTO_GOAL: "0",
              FABULA_LEARN_NUDGE: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
        let log = ""
        run.stdout.on("data", (d) => (log += d))
        run.stderr.on("data", (d) => (log += d))

        // Wait for the receipt (the green-verify hook mints it), hard cap 5 minutes.
        const receiptsDir = join(proj, ".fabula", "receipts")
        const deadline = Date.now() + 300_000
        let receiptFile: string | undefined
        while (Date.now() < deadline && !receiptFile) {
          if (existsSync(receiptsDir)) receiptFile = readdirSync(receiptsDir).find((f) => f.endsWith(".json"))
          if (!receiptFile) await new Promise((r) => setTimeout(r, 2000))
        }
        run.kill("SIGKILL")
        if (!receiptFile) throw new Error(`no receipt minted within the cap; last engine output:\n${log.slice(-3000)}`)

        const receipt = JSON.parse(readFileSync(join(receiptsDir, receiptFile), "utf8"))
        // the artifact is real: the verification that passed is the REAL command on the REAL edit
        expect(receipt.verification.passed).toBe(true)
        const p = receipt.provenance
        expect(p, `receipt has no provenance block; engine output:\n${log.slice(-2000)}`).toBeDefined()
        // context identity from the engine (published at the real stream boundary)
        expect(p.bundlePrefixHash).toMatch(/^[0-9a-f]{64}$/)
        expect(p.inputHash).toMatch(/^[0-9a-f]{64}$/)
        // model identity from the LIVE registry API
        expect(p.modelDescriptorHash).toMatch(/^[0-9a-f]{64}$/)
        expect(p.modelDescriptor?.id?.toLowerCase()).toBe(MODEL.toLowerCase())
        expect(typeof p.modelDescriptor?.arch).toBe("string")
        // REAL weights digest — files actually hashed on disk
        expect(p.weightsDigest?.digest).toMatch(/^[0-9a-f]{64}$/)
        expect(p.weightsDigest.files).toBeGreaterThan(0)
        expect(p.weightsDigest.bytes).toBeGreaterThan(1e9) // a real model, not a stub
      } finally {
        rmSync(proj, { recursive: true, force: true })
        rmSync(iso, { recursive: true, force: true })
      }
    },
    330_000,
  )
})
