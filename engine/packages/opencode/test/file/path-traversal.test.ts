import { test, expect, describe } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../src/util"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { provideInstance, tmpdir, withTmpdirOutsideGit } from "../fixture/fixture"

const run = <A, E>(eff: Effect.Effect<A, E, File.Service>) =>
  Effect.runPromise(provideInstance(Instance.directory)(eff.pipe(Effect.provide(File.defaultLayer))))
const read = (file: string) => run(File.Service.use((svc) => svc.read(file)))
const list = (dir?: string) => run(File.Service.use((svc) => svc.list(dir)))

describe("Filesystem.contains", () => {
  test("allows paths within project", () => {
    expect(Filesystem.contains("/project", "/project/src")).toBe(true)
    expect(Filesystem.contains("/project", "/project/src/file.ts")).toBe(true)
    expect(Filesystem.contains("/project", "/project")).toBe(true)
  })

  test("blocks ../ traversal", () => {
    expect(Filesystem.contains("/project", "/project/../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/project/src/../../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
  })

  test("blocks absolute paths outside project", () => {
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
    expect(Filesystem.contains("/project", "/tmp/file")).toBe(false)
    expect(Filesystem.contains("/home/user/project", "/home/user/other")).toBe(false)
  })

  test("handles prefix collision edge cases", () => {
    expect(Filesystem.contains("/project", "/project-other/file")).toBe(false)
    expect(Filesystem.contains("/project", "/projectfile")).toBe(false)
  })
})

/*
 * Integration tests for read() and list() path traversal protection.
 *
 * These tests verify the HTTP API code path is protected. The HTTP endpoints
 * in server.ts (GET /file/content, GET /file) call read()/list()
 * directly - they do NOT go through ReadTool or the agent permission layer.
 *
 * This is a SEPARATE code path from ReadTool, which has its own checks.
 */
// These traversal tests need tmpdirs outside any git repo so project detection
// sets worktree="/" (the non-git sentinel). Otherwise containsPath falls through
// to the worktree check and allows paths within the parent repo.

describe("File.read path traversal protection", () => {
  test("rejects ../ traversal attempting to read /etc/passwd", () =>
    withTmpdirOutsideGit(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "allowed.txt"), "allowed content")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(read("../../../etc/passwd")).rejects.toThrow("Access denied: path escapes project directory")
        },
      })
    }))

  // The fixture directory must sit OUTSIDE any git worktree for this to test anything. Created inside
  // the repository — where the default fixture root lives — the project's worktree is the repository
  // root, seven levels of `..` land back INSIDE it, and the guard correctly answers "contained": the
  // assertion then measures how deep the fixture happens to sit, not whether traversal is refused.
  test("rejects deeply nested traversal", async () => {
    await withTmpdirOutsideGit(async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(read("src/nested/../../../../../../../etc/passwd")).rejects.toThrow(
            "Access denied: path escapes project directory",
          )
        },
      })
    })
  })

  test("allows valid paths within project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "valid.txt"), "valid content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await read("valid.txt")
        expect(result.content).toBe("valid content")
      },
    })
  })
})

describe("File.list path traversal protection", () => {
  test("rejects ../ traversal attempting to list /etc", () =>
    withTmpdirOutsideGit(async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(list("../../../etc")).rejects.toThrow("Access denied: path escapes project directory")
        },
      })
    }))

  test("allows valid subdirectory listing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "file.txt"), "content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await list("subdir")
        expect(Array.isArray(result)).toBe(true)
      },
    })
  })
})

describe("Instance.containsPath", () => {
  test("returns true for path inside directory", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath(path.join(tmp.path, "foo.txt"))).toBe(true)
        expect(Instance.containsPath(path.join(tmp.path, "src", "file.ts"))).toBe(true)
      },
    })
  })

  test("returns true for path inside worktree but outside directory (monorepo subdirectory scenario)", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "lib")
    await fs.mkdir(subdir, { recursive: true })

    await Instance.provide({
      directory: subdir,
      fn: () => {
        // .mimocode at worktree root, but we're running from packages/lib
        expect(Instance.containsPath(path.join(tmp.path, ".mimocode", "state"))).toBe(true)
        // sibling package should also be accessible
        expect(Instance.containsPath(path.join(tmp.path, "packages", "other", "file.ts"))).toBe(true)
        // worktree root itself
        expect(Instance.containsPath(tmp.path)).toBe(true)
      },
    })
  })

  test("returns false for path outside both directory and worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/other-project")).toBe(false)
      },
    })
  })

  test("returns false for path with .. escaping worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath(path.join(tmp.path, "..", "escape.txt"))).toBe(false)
      },
    })
  })

  test("handles directory === worktree (running from repo root)", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.directory).toBe(Instance.worktree)
        expect(Instance.containsPath(path.join(tmp.path, "file.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
      },
    })
  })

  test("non-git project does not allow arbitrary paths via worktree='/'", async () => {
    await using tmp = await tmpdir() // no git: true

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        // worktree is "/" for non-git projects, but containsPath should NOT allow all paths
        expect(Instance.containsPath(path.join(tmp.path, "file.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/other")).toBe(false)
      },
    })
  })
})

describe("Instance.provide directory safety", () => {
  // The list this asserts is per-platform, because the directories are: `/root` is the superuser's home
  // on Linux and was missing, so it was accepted as a project; and the whole list was gated behind
  // "not Windows", so on Windows nothing was protected at all and `C:\\Windows` opened as a project.
  //
  // Windows names its own in the environment, so they are read rather than written down — a machine with
  // Windows on another drive, or a localized Program Files, is covered by the same rule.
  test("refuses a directory that belongs to the operating system", async () => {
    const posixPaths = ["/etc", "/etc/nginx", "/etc/shadow", "/proc", "/sys", "/dev", "/root", "/boot"]
    const windowsPaths = [process.env["SystemRoot"], process.env["ProgramFiles"], process.env["ProgramData"]]
      .filter((v): v is string => !!v)
      .flatMap((v) => [v, path.join(v, "sub")])
    for (const dir of process.platform === "win32" ? windowsPaths : posixPaths) {
      await expect(Instance.provide({ directory: dir, fn: () => {} })).rejects.toThrow("Access denied")
    }
  })

  // A near-miss must NOT be refused: a prefix without a separator after it is a different directory.
  test("a directory whose name merely starts with a protected one is allowed", async () => {
    await using tmp = await tmpdir({ git: true })
    await expect(Instance.provide({ directory: tmp.path, fn: () => Instance.directory })).resolves.toBe(tmp.path)
  })

  test("rejects filesystem root", async () => {
    await expect(
      Instance.provide({ directory: "/", fn: () => {} }),
    ).rejects.toThrow("Access denied")
  })

  test("allows valid project directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await expect(
      Instance.provide({ directory: tmp.path, fn: () => Instance.directory }),
    ).resolves.toBe(tmp.path)
  })

  test("allows subdirectory of a valid project", async () => {
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "packages", "lib")
    await fs.mkdir(sub, { recursive: true })
    await expect(
      Instance.provide({ directory: sub, fn: () => Instance.directory }),
    ).resolves.toBe(sub)
  })
})
