// MCP supply-chain audit. Before enabling/adding an MCP server, check its npm packages
// against OSV.dev (known vulnerabilities + malware). Pure parser (unit-tested) + async OSV query.
// Consumer = MCP-add flow and a manual `audit` run over the configured servers.

export interface McpServerSpec { name: string; command: string[]; enabled?: boolean }
export interface OsvFinding { pkg: string; ids: string[]; malicious: boolean }

/**
 * Extract npm package names from fabula.config.json MCP `command` arrays.
 * Recognizes node_modules paths and `npx <pkg>` / `npm exec <pkg>` invocations.
 */
export function packagesFromMcp(servers: Record<string, McpServerSpec> | McpServerSpec[]): string[] {
  const list = Array.isArray(servers) ? servers : Object.values(servers || {})
  const pkgs = new Set<string>()
  for (const s of list) {
    const cmd = (s?.command || []).join(" ")
    // .../node_modules/<pkg or @scope/pkg>/...
    for (const m of cmd.matchAll(/node_modules\/(@[^/]+\/[^/]+|[^/@][^/]*)/g)) pkgs.add(m[1])
    // npx / npm exec <pkg>
    const ex = cmd.match(/\b(?:npx|npm\s+exec)\s+(?:-y\s+)?(@?[\w./-]+)/)
    if (ex) pkgs.add(ex[1])
  }
  return [...pkgs]
}

/** Query OSV.dev batch API for npm packages. Network; returns findings (empty = clean/unknown). */
export async function auditNpmPackages(pkgs: string[], timeoutMs = 12000): Promise<OsvFinding[]> {
  if (!pkgs.length) return []
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const body = { queries: pkgs.map((p) => ({ package: { ecosystem: "npm", name: p } })) }
    const res = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal: ctl.signal,
    })
    if (!res.ok) return []
    const data: any = await res.json()
    const out: OsvFinding[] = []
    ;(data.results || []).forEach((r: any, i: number) => {
      const vulns = r?.vulns || []
      if (vulns.length) {
        const ids = vulns.map((v: any) => v.id).filter(Boolean)
        out.push({ pkg: pkgs[i], ids, malicious: ids.some((id: string) => /MAL/i.test(id)) })
      }
    })
    return out
  } catch {
    return []   // fail-open on network error (audit is advisory; don't block startup)
  } finally { clearTimeout(t) }
}

export function auditReport(findings: OsvFinding[]): string {
  if (!findings.length) return "MCP audit: no known OSV advisories for configured packages."
  return "MCP audit findings:\n" + findings.map((f) =>
    `  - ${f.pkg}: ${f.malicious ? "⚠️ MALWARE " : ""}${f.ids.join(", ")}`).join("\n")
}
