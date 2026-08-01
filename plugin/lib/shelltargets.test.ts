import { describe, expect, test } from "bun:test"
import { shellWriteTargets, shellUrls } from "./shelltargets"

// MEASURED 2026-08-01 through the LIVE app: the write guard refused `create_file` on
// ~/Library/LaunchAgents/com.example.hourly.plist and the SSRF guard refused `web_fetch` on
// http://[::ffff:127.0.0.1]:4096/… — and the model then did BOTH ANYWAY through bash_tool, with a shell
// redirect and with curl, reporting each as completed. Not an attack: an agent routing around a refusal
// to finish its task. The rules were right; the shell never asked them.
describe("what a shell command writes to", () => {
  const cases: [string, string[]][] = [
    ["echo '<plist/>' > ~/Library/LaunchAgents/x.plist", ["~/Library/LaunchAgents/x.plist"]],
    ["cat x >> /etc/sudoers", ["/etc/sudoers"]],
    ["cat x | tee /root/.ssh/authorized_keys", ["/root/.ssh/authorized_keys"]],
    ["tee -a /var/log/out.log", ["/var/log/out.log"]],
    ["dd if=/dev/zero of=/tmp/blob bs=1M", ["/tmp/blob"]],
    ["cp evil.plist \"/Users/x/Library/LaunchAgents/y.plist\"", ["/Users/x/Library/LaunchAgents/y.plist"]],
    ["mv a b", ["b"]],
    ["ln -s /secret ./notes.txt", ["./notes.txt"]],
    ["sed -i '' 's/a/b/' /etc/sudoers", ["/etc/sudoers"]],
    ["touch /tmp/a /tmp/b", ["/tmp/a", "/tmp/b"]],
    ["sudo install -m 0644 x /etc/passwd", ["/etc/passwd"]],
  ]
  for (const [cmd, want] of cases) {
    test(cmd.slice(0, 52), () => {
      for (const w of want) expect(shellWriteTargets(cmd)).toContain(w)
    })
  }

  test("a command that writes nothing yields nothing — no false targets to check", () => {
    for (const cmd of ["npm run build && git status", "ls -la", "grep -rn foo src/", "cat package.json | jq .name"]) {
      expect(`${cmd}:${shellWriteTargets(cmd).length}`).toBe(`${cmd}:0`)
    }
  })

  test("flags and URLs are not paths", () => {
    expect(shellWriteTargets("cp -r --preserve=all src dst")).toEqual(["dst"])
    expect(shellWriteTargets("curl -o out.txt https://example.com")).not.toContain("https://example.com")
  })
})

describe("what a shell command dials", () => {
  test("a fetcher's URL is found, in every spelling the guard was blind to", () => {
    expect(shellUrls("curl -s 'http://[::ffff:127.0.0.1]:4096/global/health'")).toContain("http://[::ffff:127.0.0.1]:4096/global/health")
    expect(shellUrls("curl http://169.254.169.254/latest/meta-data/")).toContain("http://169.254.169.254/latest/meta-data/")
    expect(shellUrls("wget https://example.com/a.tar.gz -O -")).toContain("https://example.com/a.tar.gz")
    expect(shellUrls("sudo curl https://example.com/x")).toContain("https://example.com/x")
  })

  // PRINTING an address is not dialling it. Gating on the scheme matched the URL itself, so an `echo`
  // was refused as if it were a request — and a guard that cannot tell those apart gets switched off.
  test("a URL that is merely mentioned is not a request", () => {
    expect(shellUrls('echo "http://169.254.169.254 is the metadata address"')).toEqual([])
    expect(shellUrls("grep -rn 'http://localhost:4096' src/")).toEqual([])
    expect(shellUrls("cat notes.md # see http://169.254.169.254")).toEqual([])
  })

  test("no fetcher, no URLs", () => {
    expect(shellUrls("npm run build")).toEqual([])
    expect(shellUrls("")).toEqual([])
  })
})
