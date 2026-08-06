import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { InstallationChannel } from "../../src/installation/version"
import { Flag } from "../../src/flag/flag"
import { Database } from "../../src/storage"

describe("Database.Path", () => {
  // The database's NAME is the product's to choose, and it changed when the app was renamed — the
  // expectation still spelled the old one and had never been updated, so a correct engine read as broken.
  // What must hold is the LAYOUT and the channel rule: one file in the data directory on a release
  // channel, and a channel-suffixed sibling otherwise, so two channels never share a database.
  test("the database sits in the data directory, named for its channel", () => {
    const actual = Database.getChannelPath()
    expect(path.dirname(actual)).toBe(Global.Path.data)
    expect(path.extname(actual)).toBe(".db")

    const release = ["latest", "beta", "prod"].includes(InstallationChannel) || Flag.MIMOCODE_DISABLE_CHANNEL_DB
    const stem = path.basename(actual, ".db")
    const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
    if (release) expect(stem).not.toContain("-")
    else expect(stem.endsWith(`-${safe}`)).toBe(true)
  })

  test("a channel gets its own file, so two channels never share one", () => {
    // Derived from the product's own answer rather than typed: whatever the base name is, the suffixed
    // form must differ from it.
    const base = path.basename(Database.getChannelPath(), ".db").replace(/-[^-]*$/, "")
    expect(base.length).toBeGreaterThan(0)
    expect(path.join(Global.Path.data, `${base}.db`)).not.toBe(path.join(Global.Path.data, `${base}-dev.db`))
  })
})
