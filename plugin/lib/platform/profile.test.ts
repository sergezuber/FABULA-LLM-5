// The machine profile: a READING, never a judgement.
//
// The property under test is not "the numbers are right on this machine" — that is a fact about
// whoever runs it. It is that a DIFFERENT machine produces a different reading, that an accelerator
// nobody can name is reported as unnamed rather than as absent, and that a cached reading about
// another machine is never served for this one. Those are the three ways a profile can be wrong
// while looking correct.

import { test, expect, describe } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  gpuReading,
  containerReading,
  fingerprintOf,
  readMachineProfile,
  machineProfile,
  forgetProfile,
  profilePath,
  describeProfile,
  type MachineProfile,
} from "./profile"

/** A stand-in for the vendor tools, so a machine's own hardware never decides the answer. */
const answers = (map: Record<string, string>) => (cmd: string) => {
  for (const [k, v] of Object.entries(map)) if (cmd.includes(k)) return v
  return null
}

describe("the accelerator is asked of each vendor, and 'none' is a claim", () => {
  test("nvidia is summed across devices", () => {
    const g = gpuReading("linux", {}, answers({ "nvidia-smi": "8192\n8192\n" }))
    expect(g.vendor).toBe("nvidia")
    expect(g.totalBytes).toBe(2 * 8192 * 1024 * 1024)
  })

  test("a machine with an AMD card is not reported as having no accelerator", () => {
    // The whole reason this file exists: only one vendor was ever asked, so every other machine
    // answered "none" — and "none" is what tells the planner to size against system memory.
    const g = gpuReading("linux", {}, answers({ "rocm-smi": "card0, 17163091968, 1000\n" }))
    expect(g.vendor).toBe("amd")
    expect(g.totalBytes).toBe(17163091968)
  })

  test("an AMD tool that answers without a total says so instead of reporting zero silently", () => {
    const g = gpuReading("linux", {}, answers({ "rocm-smi": "no data\n" }))
    expect(g.vendor).toBe("amd")
    expect(g.totalBytes).toBe(0)
    expect(g.detail).toContain("no memory total")
  })

  test("an Intel device is named even though its memory is not read", () => {
    const g = gpuReading("linux", {}, answers({ "xpu-smi": "Device 0: GPU\n" }))
    expect(g.vendor).toBe("intel")
    expect(g.detail).toContain("not read")
  })

  test("nothing answering is 'none', which is a statement and not an absence of one", () => {
    const g = gpuReading("linux", {}, () => null)
    expect(g.vendor).toBe("none")
    expect(g.detail).toContain("no accelerator tool")
  })

  test("macOS is answered without asking any vendor: there is no second pool to find", () => {
    const g = gpuReading("darwin", {}, () => {
      throw new Error("no vendor tool may be spawned on a machine with unified memory")
    })
    expect(g.vendor).toBe("apple")
    expect(g.totalBytes).toBe(0)
  })
})

describe("the container question is the one the tool itself asks", () => {
  test("a runtime serving linux images is available", () => {
    expect(containerReading({}, answers({ docker: "linux\n" })).available).toBe(true)
  })

  test("a runtime serving something else is NOT available, and says which", () => {
    const r = containerReading({}, answers({ docker: "windows\n" }))
    expect(r.available).toBe(false)
    expect(r.detail).toContain("windows")
  })

  test("no runtime at all is reported as absent rather than as wrong", () => {
    expect(containerReading({}, () => null).detail).toContain("no container runtime")
  })
})

describe("the fingerprint identifies the HARDWARE, not the moment", () => {
  const base: Omit<MachineProfile, "fingerprint"> = {
    platform: "linux",
    memory: { kind: "discrete-vram", totalBytes: 24 * 1024 ** 3, usedBytes: 1024 ** 3, detail: "x" },
    cpu: { cores: 16, model: "CPU" },
    gpu: { vendor: "nvidia", totalBytes: 24 * 1024 ** 3, detail: "nvidia-smi" },
    confinement: { mechanism: "bubblewrap", available: true, note: "" },
    container: { available: true, detail: "" },
  }

  test("memory IN USE does not change it — otherwise every reading invalidates the last", () => {
    const busy = { ...base, memory: { ...base.memory, usedBytes: 20 * 1024 ** 3 } }
    expect(fingerprintOf(busy)).toBe(fingerprintOf(base))
  })

  test("a card added, or memory changed, DOES change it", () => {
    expect(fingerprintOf({ ...base, gpu: { ...base.gpu, totalBytes: 48 * 1024 ** 3 } })).not.toBe(fingerprintOf(base))
    expect(fingerprintOf({ ...base, cpu: { ...base.cpu, cores: 32 } })).not.toBe(fingerprintOf(base))
    expect(fingerprintOf({ ...base, memory: { ...base.memory, totalBytes: 48 * 1024 ** 3 } })).not.toBe(fingerprintOf(base))
  })

  test("a container runtime appearing changes it — what the machine can do is part of what it is", () => {
    expect(fingerprintOf({ ...base, container: { available: false, detail: "" } })).not.toBe(fingerprintOf(base))
  })
})

describe("a cached reading is served only for the machine it is about", () => {
  const withStore = <T>(fn: (file: string) => T): T => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fab-profile-"))
    const file = path.join(dir, "machine-profile.json")
    const prevFile = process.env.FABULA_PROFILE_FILE
    process.env.FABULA_PROFILE_FILE = file
    forgetProfile()
    try {
      return fn(file)
    } finally {
      if (prevFile === undefined) delete process.env.FABULA_PROFILE_FILE
      else process.env.FABULA_PROFILE_FILE = prevFile
      forgetProfile()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test("the first reading is written down, and the second comes back identical", () => {
    withStore((file) => {
      const first = machineProfile()
      expect(fs.existsSync(file)).toBe(true)
      forgetProfile()
      expect(machineProfile().fingerprint).toBe(first.fingerprint)
    })
  })

  test("a stored reading about ANOTHER machine is discarded, not served", () => {
    withStore((file) => {
      // A profile from a machine with a graphics card, left behind on one without.
      fs.writeFileSync(file, JSON.stringify({
        platform: "linux",
        memory: { kind: "discrete-vram", totalBytes: 999, usedBytes: 0, detail: "stale" },
        cpu: { cores: 999, model: "someone else's" },
        gpu: { vendor: "nvidia", totalBytes: 999, detail: "stale" },
        confinement: { mechanism: "bubblewrap", available: true, note: "" },
        container: { available: true, detail: "" },
        fingerprint: "0000000000000000",
      }))
      forgetProfile()
      const p = machineProfile()
      expect(p.cpu.cores).not.toBe(999)
      expect(p.fingerprint).not.toBe("0000000000000000")
      // …and the store now holds THIS machine, so the next process does not repeat the probe.
      expect(JSON.parse(fs.readFileSync(file, "utf8")).fingerprint).toBe(p.fingerprint)
    })
  })

  test("an unreadable store is replaced rather than trusted", () => {
    withStore((file) => {
      fs.writeFileSync(file, "{ not json")
      forgetProfile()
      expect(() => machineProfile()).not.toThrow()
      expect(JSON.parse(fs.readFileSync(file, "utf8")).platform).toBeDefined()
    })
  })
})

describe("the reading is about this machine, and says so in one line", () => {
  test("every field is populated for whatever machine runs this", () => {
    const p = readMachineProfile()
    expect(["darwin", "linux", "win32"]).toContain(p.platform)
    expect(p.cpu.cores).toBeGreaterThan(0)
    expect(["unified", "discrete-vram", "cpu-only", "unknown"]).toContain(p.memory.kind)
    expect(p.fingerprint).toHaveLength(16)
  })

  test("the description names what was FOUND, since it is read when something is refused", () => {
    const line = describeProfile({
      platform: "linux",
      memory: { kind: "discrete-vram", totalBytes: 24 * 1024 ** 3, usedBytes: 0, detail: "" },
      cpu: { cores: 16, model: "CPU" },
      gpu: { vendor: "nvidia", totalBytes: 24 * 1024 ** 3, detail: "" },
      confinement: { mechanism: "none", available: false, note: "" },
      container: { available: false, detail: "" },
      fingerprint: "x",
    })
    expect(line).toContain("16 cores")
    expect(line).toContain("discrete-vram")
    expect(line).toContain("nvidia 24.0 GiB")
    expect(line).toContain("no kernel confinement")
    expect(line).toContain("no containers")
  })
})

// ── The planner and the description ask ONE probe ─────────────────────────────────────────────────
//
// Sizing the window and describing the machine are the same question about the same hardware, and they
// were two probes. They had already drifted: the one the planner used asked `nvidia-smi` and nothing
// else, so a machine with an AMD or Intel card answered "no discrete GPU found" and was sized against
// SYSTEM memory — a 64 GiB plan for a cache that lives in 12 GiB of VRAM. Over-committing a card is not
// a slow machine, it is a machine that swaps.
describe("every accelerator is visible to the thing that sizes the window", () => {
  const answers = (map: Record<string, string>) => (cmd: string) => {
    for (const [k, v] of Object.entries(map)) if (cmd.includes(k)) return v
    return null
  }

  test("an AMD card is a discrete pool, not 'no GPU found'", () => {
    const g = gpuReading("linux", {}, answers({ "rocm-smi": "card0, 17163091968, 2000000000\n" }))
    expect(g.vendor).toBe("amd")
    expect(g.totalBytes).toBe(17163091968)
    expect(g.usedBytes).toBe(2000000000)
  })

  test("what the card already holds is read, so the reserve is measured rather than guessed", () => {
    const g = gpuReading("linux", {}, answers({ "nvidia-smi": "24576, 2048\n" }))
    expect(g.vendor).toBe("nvidia")
    expect(g.totalBytes).toBe(24576 * 1024 * 1024)
    expect(g.usedBytes).toBe(2048 * 1024 * 1024)
  })

  test("several cards are one pool, because a runtime given several draws on all of them", () => {
    const g = gpuReading("linux", {}, answers({ "nvidia-smi": "24576, 1024\n24576, 512\n" }))
    expect(g.totalBytes).toBe(2 * 24576 * 1024 * 1024)
    expect(g.usedBytes).toBe(1536 * 1024 * 1024)
  })

  test("a tool that answers without a total is still a card, not an absence", () => {
    const g = gpuReading("linux", {}, answers({ "xpu-smi": "Device 0: GPU\n" }))
    expect(g.vendor).toBe("intel")
    expect(g.vendor).not.toBe("none")
  })

  test("no tool answering is a claim of its own, and stays distinguishable", () => {
    const g = gpuReading("linux", {}, answers({}))
    expect(g.vendor).toBe("none")
    expect(g.detail).toContain("no accelerator tool answered")
  })

  // The binding: the module that SIZES must reach the same probe. Verified by name — `vramBytes` and
  // `gpuReading` are one module apart and must not become two probes again.
  test("the pool reader and the machine description are the same probe", async () => {
    const src = await Bun.file(new URL("./memory.ts", import.meta.url)).text()
    expect(src).toContain("return g.totalBytes > 0 ? { total: g.totalBytes, used: g.usedBytes } : null")
    const prof = await Bun.file(new URL("./profile.ts", import.meta.url)).text()
    expect(prof).not.toMatch(/^\s*(export\s+)?function gpuReading/m)
  })
})
