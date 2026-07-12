import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { readFileSync, writeFileSync, rmSync } from "fs"
import { Path as DbPath } from "../../storage/db"

// L3 single-instance guard. Two engines memory-mapping the same large SQLite DB is what page-
// thrashes the machine into unkillable (D/U-state) I/O, so refuse to start a SECOND `serve` for
// the same DB. This intentionally only serializes `serve` (a `mimo run` CLI still coexists — WAL
// + the 256MB mmap cap make that safe). Every branch fails OPEN: any unexpected error just lets
// the engine start, so this guard can never itself be the reason the sole engine won't boot.
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // ESRCH = no such process (dead); EPERM = alive but not ours (still alive).
    return e?.code === "EPERM"
  }
}

async function serverHealthy(hostname: string, port: number): Promise<boolean> {
  const host = hostname === "::1" ? "[::1]" : hostname
  try {
    const res = await fetch(`http://${host}:${port}/global/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureSingleServeInstance(hostname: string, port: number): Promise<void> {
  try {
    if (!DbPath || DbPath === ":memory:") return
    const lockPath = DbPath + ".serve.pid"
    const takeLock = () => writeFileSync(lockPath, String(process.pid), { flag: "wx" })
    try {
      takeLock()
    } catch (e: any) {
      if (e?.code !== "EEXIST") return // unexpected FS error -> fail open, start anyway
      const existing = Number((() => {
        try {
          return readFileSync(lockPath, "utf8").trim()
        } catch {
          return ""
        }
      })())
      if (existing && existing !== process.pid && pidAlive(existing)) {
        // A live engine already owns this DB. If it is already serving, exit cleanly so the
        // launcher attaches to it instead of the launcher spinning next to a duplicate.
        if (await serverHealthy(hostname, port)) {
          console.log(`FABULA engine already serving on :${port} (pid ${existing}); exiting.`)
          process.exit(0)
        }
        console.error(`Another FABULA engine (pid ${existing}) holds this database; refusing to start a second writer.`)
        process.exit(1)
      }
      // Stale lock (dead / reused pid) — reclaim it.
      try {
        rmSync(lockPath, { force: true })
        takeLock()
      } catch {
        return // could not reclaim -> fail open
      }
    }
    const cleanup = () => {
      try {
        if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath, { force: true })
      } catch {}
    }
    process.on("exit", cleanup)
    process.on("SIGINT", () => {
      cleanup()
      process.exit(130)
    })
    process.on("SIGTERM", () => {
      cleanup()
      process.exit(143)
    })
  } catch {
    // fail open: the guard must never prevent the sole engine from starting
  }
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless mimocode server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    const isLoopback = opts.hostname === "127.0.0.1" || opts.hostname === "localhost" || opts.hostname === "::1"

    if (!isLoopback && !Flag.MIMOCODE_SERVER_PASSWORD && !opts.noAuth) {
      console.error("ERROR: Binding to non-loopback address without MIMOCODE_SERVER_PASSWORD is not allowed.")
      console.error("Set MIMOCODE_SERVER_PASSWORD or pass --no-auth to override (DANGEROUS).")
      process.exit(1)
    }

    if (!Flag.MIMOCODE_SERVER_PASSWORD) {
      console.log("Warning: MIMOCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }

    // L3: refuse to start a second `serve` for the same DB (fail-open; may exit(0) to let the
    // launcher attach to an already-healthy server). Runs before we bind the port.
    await ensureSingleServeInstance(opts.hostname, opts.port)

    const server = await Server.listen(opts)
    console.log(`mimocode server listening on http://${server.hostname}:${server.port}`)

    // Deferred post-bind warm: the one-time Claude import opens the SQLite DB, which on a large DB
    // can be slow. Running it AFTER listen() means the port and the DB-free /global/health route
    // answer immediately, so the launcher never waits on DB work to leave "Starting the local
    // server". Best-effort and fully detached; a failure here must never affect the running server.
    if (!process.env.MIMOCODE_DISABLE_CLAUDE_IMPORT && !process.env.MIMOCODE_CLAUDE_IMPORTED) {
      process.env.MIMOCODE_CLAUDE_IMPORTED = "1"
      import("../../session/claude-import")
        .then(({ ClaudeImport }) => ClaudeImport.run())
        .catch((e) => console.error("claude-import (deferred) failed:", e))
    }

    await new Promise(() => {})
    await server.stop()
  },
})
