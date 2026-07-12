import { test, expect } from "bun:test"
import { buildDockerRun, interpreterCmd, sandboxNote, SANDBOX_IMAGES } from "./dockerbox"

test("buildDockerRun: locked-down flags present", () => {
  const a = buildDockerRun({ image: "python:3.12-slim", hostDir: "/h/dir", inner: ["python", "/work/c.py"] })
  const s = a.join(" ")
  expect(a[0]).toBe("run")
  expect(s).toContain("--rm")
  expect(s).toContain("--network none")
  expect(s).toContain("--memory 512m")
  expect(s).toContain("--pids-limit 256")
  expect(s).toContain("--read-only")
  expect(s).toContain("--cap-drop ALL")
  expect(s).toContain("no-new-privileges")
  expect(s).toContain("/h/dir:/work:ro")
  expect(a.slice(-3).join(" ")).toBe("python:3.12-slim python /work/c.py")
})
test("interpreterCmd maps language", () => {
  expect(interpreterCmd("python", "c.py")).toEqual(["python", "/work/c.py"])
  expect(interpreterCmd("node", "c.js")).toEqual(["node", "/work/c.js"])
})
test("sandboxNote + image defaults", () => {
  expect(sandboxNote("python:3.12-slim")).toContain("--network none")
  expect(SANDBOX_IMAGES.python).toContain("python")
  expect(SANDBOX_IMAGES.node).toContain("node")
})
