import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import type { Tool } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { assertExternalDirectory } from "../../src/tool/external-directory"
import { Filesystem } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Global } from "../../src/global"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  test("no-ops for empty target", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: "/tmp",
      fn: async () => {
        await assertExternalDirectory(ctx)
      },
    })

    expect(requests.length).toBe(0)
  })

  test("no-ops for paths inside Instance.directory", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: path.join(path.sep, "tmp", "project"),
      fn: async () => {
        await assertExternalDirectory(ctx, path.join(path.sep, "tmp", "project", "file.txt"))
      },
    })

    expect(requests.length).toBe(0)
  })

  test("asks with a single canonical glob", async () => {
    const { requests, ctx } = makeCtx()

    const directory = path.join(path.sep, "tmp", "project")
    const target = path.join(path.sep, "tmp", "outside", "file.txt")
    const expected = glob(path.join(path.dirname(target), "*"))

    await Instance.provide({
      directory,
      fn: async () => {
        await assertExternalDirectory(ctx, target)
      },
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("uses target directory when kind=directory", async () => {
    const { requests, ctx } = makeCtx()

    const directory = path.join(path.sep, "tmp", "project")
    const target = path.join(path.sep, "tmp", "outside")
    const expected = glob(path.join(target, "*"))

    await Instance.provide({
      directory,
      fn: async () => {
        await assertExternalDirectory(ctx, target, { kind: "directory" })
      },
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("skips prompting when bypass=true", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: path.join(path.sep, "tmp", "project"),
      fn: async () => {
        await assertExternalDirectory(ctx, path.join(path.sep, "tmp", "outside", "file.txt"), { bypass: true })
      },
    })

    expect(requests.length).toBe(0)
  })

  test("does NOT ask for paths under the memory root (defers to memory-path-guard)", async () => {
    const { requests, ctx } = makeCtx()

    const memTarget = path.join(
      Global.Path.data,
      "memory",
      "sessions",
      "ses_test",
      "tasks",
      "T3",
      "progress.md",
    )

    await Instance.provide({
      directory: path.join(path.sep, "tmp", "project"), // memTarget is OUTSIDE the project dir on purpose
      fn: async () => {
        await assertExternalDirectory(ctx, memTarget)
      },
    })

    // memory region is governed by memory-path-guard, not external_directory
    expect(requests.length).toBe(0)
  })

  test("still asks for non-memory paths outside the project (regression)", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: path.join(path.sep, "tmp", "project"),
      fn: async () => {
        await assertExternalDirectory(ctx, path.join(path.sep, "tmp", "outside", "file.txt"))
      },
    })

    expect(requests.find((r) => r.permission === "external_directory")).toBeDefined()
  })

  if (process.platform === "win32") {
    test("normalizes Windows path variants to one glob", async () => {
      const { requests, ctx } = makeCtx()

      // OUTSIDE any checkout: the project below makes its own worktree, but this "outer" directory must
      // not sit inside the SAME repository the fixtures default to, or it is not outside anything.
      await using outerTmp = await tmpdir({
        outsideGit: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "outside.txt"), "x")
        },
      })
      await using tmp = await tmpdir({ git: true })

      const target = path.join(outerTmp.path, "outside.txt")
// A drive-relative form of the SAME path — lowercased and with the other separator, which is what
      // "path variants" means here. The drive letter is KEPT: stripping it turns `D:\a\...` into
      // `/a/...`, whose first segment is a single letter — and a leading `/<letter>/` is the Git Bash
      // spelling of a DRIVE. The product read it as drive A, correctly by that convention, and the
      // check reported a defect where the fixture had manufactured an ambiguity.
      const alt = target.replaceAll("\\", "/").toLowerCase()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await assertExternalDirectory(ctx, alt)
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      const expected = glob(path.join(outerTmp.path, "*"))
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    })

    test("uses drive root glob for root files", async () => {
      const { requests, ctx } = makeCtx()

      await using tmp = await tmpdir({ git: true })
      const root = path.parse(tmp.path).root
      const target = path.join(root, "boot.ini")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await assertExternalDirectory(ctx, target)
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      const expected = path.join(root, "*")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    })
  }
})
