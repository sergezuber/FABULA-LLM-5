import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

const log = Global.Path.log

afterEach(() => {
  Global.Path.log = log
})

async function files(dir: string) {
  let last = ""
  let same = 0

  for (let i = 0; i < 50; i++) {
    const list = (await fs.readdir(dir)).sort()
    const next = JSON.stringify(list)
    same = next === last ? same + 1 : 0
    if (same >= 2 && list.length === 11) return list
    last = next
    await Bun.sleep(10)
  }

  return (await fs.readdir(dir)).sort()
}

test("init cleanup keeps the newest timestamped logs", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path

  const list = Array.from({ length: 12 }, (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000.log`)

  await Promise.all(list.map((file) => fs.writeFile(path.join(tmp.path, file), file)))

  await Log.init({ print: false, dev: false })

  const next = await files(tmp.path)

  expect(next).not.toContain(list[0]!)
  expect(next).toContain(list.at(-1)!)
})

test.skipIf(process.platform === "win32")(
  "init cleanup never deletes a session log whose owner process is still alive",
  async () => {
    await using tmp = await tmpdir()
    Global.Path.log = tmp.path

    // Real liveness, no mocks: one child still running (live owner), one reaped (dead owner).
    const alive = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    const dead = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    dead.kill()
    await dead.exited

    try {
      // The live-owner log is the OLDEST, so without the liveness guard it is exactly the
      // file cleanup would prune first. 12 dead-owner logs push the count past keep=10.
      const liveLog = `2000-01-01T000000-${alive.pid}.log`
      const deadLogs = Array.from(
        { length: 12 },
        (_, i) => `2000-02-${String(i + 1).padStart(2, "0")}T000000-${dead.pid}.log`,
      )
      await Promise.all([liveLog, ...deadLogs].map((f) => fs.writeFile(path.join(tmp.path, f), f)))

      await Log.init({ print: false, dev: false })

      let final: string[] = []
      for (let i = 0; i < 50; i++) {
        final = (await fs.readdir(tmp.path)).sort()
        if (!final.includes(deadLogs[0]!)) break
        await Bun.sleep(10)
      }

      expect(final).toContain(liveLog) // live owner survives despite being the oldest
      expect(final).not.toContain(deadLogs[0]!) // dead owner beyond keep is pruned
    } finally {
      alive.kill()
      await alive.exited
    }
  },
)

test("init cleanup prunes rotated dev.log archives", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path

  // dev.log rotations and size-rotation archives must also be pruned, not just
  // bare <iso>.log session logs.
  const list = Array.from({ length: 12 }, (_, i) => `dev.log.2000-01-${String(i + 1).padStart(2, "0")}T000000`)
  await Promise.all(list.map((file) => fs.writeFile(path.join(tmp.path, file), file)))

  await Log.init({ print: false, dev: false })

  for (let i = 0; i < 50; i++) {
    const current = await fs.readdir(tmp.path)
    const archives = current.filter((f) => f.startsWith("dev.log."))
    if (archives.length <= 10) break
    await Bun.sleep(10)
  }

  const final = await fs.readdir(tmp.path)
  const archives = final.filter((f) => f.startsWith("dev.log.")).sort()
  expect(archives.length).toBeLessThanOrEqual(10)
  expect(archives).not.toContain(list[0]!)
  expect(archives).toContain(list.at(-1)!)
})
