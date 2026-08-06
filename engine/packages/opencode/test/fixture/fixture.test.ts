import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir, cleanupTmpdir } from "./fixture"
import os from "os"

describe("tmpdir", () => {
  test("disables fsmonitor for git fixtures", async () => {
    await using tmp = await tmpdir({ git: true })

    const value = (await $`git config core.fsmonitor`.cwd(tmp.path).quiet().text()).trim()
    expect(value).toBe("false")
  })

  test("removes directories on dispose", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path

    await tmp[Symbol.asyncDispose]()

    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("reports dispose failures after cleaning the directory", async () => {
    let dirpath = ""

    await expect(
      (async () => {
        await using tmp = await tmpdir({
          dispose: async (dir) => {
            dirpath = dir
            await fs.rm(path.join(dir, "missing", "child"))
          },
        })
      })(),
    ).rejects.toThrow()

    const exists = await fs
      .stat(dirpath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("reports cleanup failures", async () => {
    // The platform's own temp root, not a literal "/tmp": that path names a real directory on one family
    // of systems and, on the other, a directory on whatever drive happens to be current — where creating
    // the fixture fails before the assertion is ever reached.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-test-cleanup-failure-"))

    await expect(cleanupTmpdir(dir, () => Promise.reject(new Error("cleanup failed")))).rejects.toThrow(
      `Failed to cleanup temporary directory ${dir}: cleanup failed`,
    )

    await fs.rm(dir, { recursive: true, force: true })
  })

  // A directory still held at the end of a test means different things on different systems, and the
  // cleanup answers accordingly: on Windows the OS refuses removal until every handle is released, which
  // routinely lags past any retry window — the subject has passed and what is left is tidying, swept at
  // the end of the run. Elsewhere a busy directory means something the test started is still holding it,
  // which is worth failing on.
  test("a directory still held is deferred where that is ordinary, and reported where it is not", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-test-cleanup-busy-"))
    const held = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })

    const outcome = await cleanupTmpdir(dir, () => Promise.reject(held)).then(
      () => "deferred",
      (e) => `threw: ${String((e as Error).message)}`,
    )
    if (process.platform === "win32") expect(outcome).toBe("deferred")
    else expect(outcome).toContain("Failed to cleanup temporary directory")

    // A failure that is NOT a held handle is reported on every platform — the deferral is about one cause,
    // not about cleanup in general.
    await expect(cleanupTmpdir(dir, () => Promise.reject(new Error("disk went away")))).rejects.toThrow(
      "disk went away",
    )

    await fs.rm(dir, { recursive: true, force: true })
  })
})
