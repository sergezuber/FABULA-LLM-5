import { describe, expect, test } from "bun:test"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  drainPendingDeepLinks,
  parseDeepLink,
  parseNewSessionDeepLink,
} from "./deep-links"
import { type Session } from "@mimo-ai/sdk/v2/client"
import {
  childSessionOnPath,
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  groupSessions,
  hasProjectPermissions,
  isInternalSession,
  latestRootSession,
  workspaceKey,
} from "./helpers"

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
  }) as Session

describe("layout deep links", () => {
  test("parses open-project deep links", () => {
    expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
  })

  test("ignores non-project deep links", () => {
    expect(parseDeepLink("opencode://other?directory=/tmp/demo")).toBeUndefined()
    expect(parseDeepLink("https://example.com")).toBeUndefined()
  })

  test("ignores malformed deep links safely", () => {
    expect(() => parseDeepLink("opencode://open-project/%E0%A4%A%")).not.toThrow()
    expect(parseDeepLink("opencode://open-project/%E0%A4%A%")).toBeUndefined()
  })

  test("parses links when URL.canParse is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(URL, "canParse")
    Object.defineProperty(URL, "canParse", { configurable: true, value: undefined })
    try {
      expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
    } finally {
      if (original) Object.defineProperty(URL, "canParse", original)
      if (!original) Reflect.deleteProperty(URL, "canParse")
    }
  })

  test("ignores open-project deep links without directory", () => {
    expect(parseDeepLink("opencode://open-project")).toBeUndefined()
    expect(parseDeepLink("opencode://open-project?directory=")).toBeUndefined()
  })

  test("collects only valid open-project directories", () => {
    const result = collectOpenProjectDeepLinks([
      "opencode://open-project?directory=/a",
      "opencode://other?directory=/b",
      "opencode://open-project?directory=/c",
    ])
    expect(result).toEqual(["/a", "/c"])
  })

  test("parses new-session deep links with optional prompt", () => {
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo")).toEqual({ directory: "/tmp/demo" })
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo&prompt=hello%20world")).toEqual({
      directory: "/tmp/demo",
      prompt: "hello world",
    })
  })

  test("ignores new-session deep links without directory", () => {
    expect(parseNewSessionDeepLink("opencode://new-session")).toBeUndefined()
    expect(parseNewSessionDeepLink("opencode://new-session?directory=")).toBeUndefined()
  })

  test("collects only valid new-session deep links", () => {
    const result = collectNewSessionDeepLinks([
      "opencode://new-session?directory=/a",
      "opencode://open-project?directory=/b",
      "opencode://new-session?directory=/c&prompt=ship%20it",
    ])
    expect(result).toEqual([{ directory: "/a" }, { directory: "/c", prompt: "ship it" }])
  })

  test("drains global deep links once", () => {
    const target = {
      __OPENCODE__: {
        deepLinks: ["opencode://open-project?directory=/a"],
      },
    } as unknown as Window & { __OPENCODE__?: { deepLinks?: string[] } }

    expect(drainPendingDeepLinks(target)).toEqual(["opencode://open-project?directory=/a"])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })
})

describe("layout workspace helpers", () => {
  test("normalizes trailing slash in workspace key", () => {
    expect(workspaceKey("/tmp/demo///")).toBe("/tmp/demo")
    expect(workspaceKey("C:\\tmp\\demo\\\\")).toBe("C:/tmp/demo")
  })

  test("preserves posix and drive roots in workspace key", () => {
    expect(workspaceKey("/")).toBe("/")
    expect(workspaceKey("///")).toBe("/")
    expect(workspaceKey("C:\\")).toBe("C:/")
    expect(workspaceKey("C://")).toBe("C:/")
    expect(workspaceKey("C:///")).toBe("C:/")
  })

  test("keeps local first while preserving known order", () => {
    const result = effectiveWorkspaceOrder("/root", ["/root", "/b", "/c"], ["/root", "/c", "/a", "/b"])
    expect(result).toEqual(["/root", "/c", "/b"])
  })

  test("finds the latest root session across workspaces", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/root" },
          session: [session({ id: "root", directory: "/root", time: { created: 1, updated: 1, archived: undefined } })],
        },
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "workspace",
              directory: "/workspace",
              time: { created: 2, updated: 2, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("workspace")
  })

  test("detects project permissions with a filter", () => {
    const result = hasProjectPermissions(
      {
        root: [{ id: "perm-root" }, { id: "perm-hidden" }],
        child: [{ id: "perm-child" }],
      },
      (item) => item.id === "perm-child",
    )

    expect(result).toBe(true)
  })

  test("ignores project permissions filtered out", () => {
    const result = hasProjectPermissions(
      {
        root: [{ id: "perm-root" }],
      },
      () => false,
    )

    expect(result).toBe(false)
  })

  test("ignores archived and child sessions when finding latest root session", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "archived",
              directory: "/workspace",
              time: { created: 10, updated: 10, archived: 10 },
            }),
            session({
              id: "child",
              directory: "/workspace",
              parentID: "parent",
              time: { created: 20, updated: 20, archived: undefined },
            }),
            session({
              id: "root",
              directory: "/workspace",
              time: { created: 30, updated: 30, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("root")
  })

  test("finds the direct child on the active session path", () => {
    const list = [
      session({ id: "root", directory: "/workspace" }),
      session({ id: "child", directory: "/workspace", parentID: "root" }),
      session({ id: "leaf", directory: "/workspace", parentID: "child" }),
    ]

    expect(childSessionOnPath(list, "root", "leaf")?.id).toBe("child")
    expect(childSessionOnPath(list, "child", "leaf")?.id).toBe("leaf")
    expect(childSessionOnPath(list, "root", "root")).toBeUndefined()
    expect(childSessionOnPath(list, "root", "other")).toBeUndefined()
  })

  test("formats fallback project display name", () => {
    expect(displayName({ worktree: "/tmp/app" })).toBe("app")
    expect(displayName({ worktree: "/tmp/app", name: "My App" })).toBe("My App")
  })

  test("extracts api error message and fallback", () => {
    expect(errorMessage({ data: { message: "boom" } }, "fallback")).toBe("boom")
    expect(errorMessage(new Error("broken"), "fallback")).toBe("broken")
    expect(errorMessage("unknown", "fallback")).toBe("fallback")
  })
})

describe("groupSessions — internal maintenance routing", () => {
  // The engine's own maintenance runs are identified by the EXACT fixed title it stamps on them
  // (Auto Dream / Auto Distill). Detection must never be a loose substring: ordinary chats get
  // auto-generated titles, so "Distill the meeting notes" is a normal chat and must stay in the list.
  // groupSessions pulls the real maintenance sessions into a collapsed group, without ever deleting or
  // hiding them from search.
  test("flags the exact engine auto-run titles (case/space-insensitive)", () => {
    expect(isInternalSession(session({ id: "1", directory: "/d", title: "Auto Dream" }))).toBe(true)
    expect(isInternalSession(session({ id: "2", directory: "/d", title: "Auto Distill" }))).toBe(true)
    expect(isInternalSession(session({ id: "3", directory: "/d", title: "  auto dream  " }))).toBe(true)
    expect(isInternalSession(session({ id: "4", directory: "/d", title: "AUTO DISTILL" }))).toBe(true)
  })

  test("leaves ordinary chats untouched", () => {
    expect(isInternalSession(session({ id: "1", directory: "/d", title: "Fix export bug" }))).toBe(false)
    expect(isInternalSession(session({ id: "2", directory: "/d", title: "Auth refactor" }))).toBe(false)
    expect(isInternalSession(session({ id: "3", directory: "/d", title: "" }))).toBe(false)
  })

  // REGRESSION: the earlier /\bdream\b/ /\bdistill\b/ patterns swept ordinary chats whose auto-generated
  // title merely CONTAINS the word into the collapsed group — the user "lost" real chats. A normal chat
  // whose title merely contains (or begins with) the word must never be internal.
  test("does NOT flag ordinary chats that merely contain dream/distill", () => {
    expect(isInternalSession(session({ id: "1", directory: "/d", title: "Distill the meeting notes into action items" }))).toBe(false)
    expect(isInternalSession(session({ id: "2", directory: "/d", title: "Fix the dream-journal UI component" }))).toBe(false)
    expect(isInternalSession(session({ id: "3", directory: "/d", title: "daydream planner" }))).toBe(false)
    expect(isInternalSession(session({ id: "4", directory: "/d", title: "distillery inventory app" }))).toBe(false)
    // near-misses of the exact titles are still ordinary chats
    expect(isInternalSession(session({ id: "5", directory: "/d", title: "Auto Dreaming feature" }))).toBe(false)
    expect(isInternalSession(session({ id: "6", directory: "/d", title: "redistill" }))).toBe(false)
  })

  test("routes maintenance sessions to a last, internal-marked group", () => {
    const now = Date.now()
    const groups = groupSessions(
      [
        session({ id: "chat", directory: "/d", title: "Fix export bug", time: { created: now, updated: now, archived: undefined } }),
        session({ id: "dream", directory: "/d", title: "Auto Dream", time: { created: now, updated: now, archived: undefined } }),
      ],
      now,
      new Set(),
    )
    const last = groups[groups.length - 1]
    expect(last.internal).toBe(true)
    expect(last.sessions.map((s) => s.id)).toEqual(["dream"])
    // The ordinary chat stays out of the maintenance group.
    expect(last.sessions.find((s) => s.id === "chat")).toBeUndefined()
  })

  test("keeps a pinned maintenance session pinned (user explicitly asked)", () => {
    const now = Date.now()
    const groups = groupSessions(
      [
        session({ id: "dream", directory: "/d", title: "Auto Dream", time: { created: now, updated: now, archived: undefined } }),
      ],
      now,
      new Set(["dream"]),
    )
    const pinned = groups.find((g) => g.pinned)
    const internal = groups.find((g) => g.internal)
    expect(pinned?.sessions.map((s) => s.id)).toEqual(["dream"])
    // No separate maintenance group when the only maintenance session is pinned.
    expect(internal).toBeUndefined()
  })

  test("omits the maintenance group entirely when there are none", () => {
    const now = Date.now()
    const groups = groupSessions(
      [session({ id: "chat", directory: "/d", title: "Fix export bug", time: { created: now, updated: now, archived: undefined } })],
      now,
      new Set(),
    )
    expect(groups.find((g) => g.internal)).toBeUndefined()
  })

  test("collects multiple maintenance sessions into the single last group", () => {
    const now = Date.now()
    const groups = groupSessions(
      [
        session({ id: "chat", directory: "/d", title: "Ship feature", time: { created: now, updated: now, archived: undefined } }),
        session({ id: "d1", directory: "/d", title: "Auto Dream", time: { created: now, updated: now, archived: undefined } }),
        session({ id: "d2", directory: "/d", title: "Auto Distill", time: { created: now, updated: now, archived: undefined } }),
      ],
      now,
      new Set(),
    )
    const last = groups[groups.length - 1]
    expect(last.internal).toBe(true)
    expect(last.sessions.map((s) => s.id).sort()).toEqual(["d1", "d2"])
    // exactly one internal group, and the ordinary chat lives in a non-internal group
    expect(groups.filter((g) => g.internal)).toHaveLength(1)
    expect(groups.some((g) => !g.internal && g.sessions.some((s) => s.id === "chat"))).toBe(true)
  })

  test("an ordinary chat titled like maintenance stays in a date group, not swept away", () => {
    const now = Date.now()
    const groups = groupSessions(
      [session({ id: "notes", directory: "/d", title: "Distill the requirements doc", time: { created: now, updated: now, archived: undefined } })],
      now,
      new Set(),
    )
    // No maintenance group appears, and the chat is present in a normal (non-internal) group.
    expect(groups.find((g) => g.internal)).toBeUndefined()
    expect(groups.some((g) => g.sessions.some((s) => s.id === "notes"))).toBe(true)
  })
})
