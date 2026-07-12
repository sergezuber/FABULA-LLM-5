# Verified-Autonomy Receipt — open specification, v0.2 (draft)

**Status:** draft for public review · **Editors:** the FABULA project · **Date:** 2026-07-16

A **receipt** is a machine-readable, third-party-replayable proof artifact for an
agent-produced code change. It replaces *trust in the model* ("the model is smart, believe
its claim of done") with *verification of the work* ("here is the exact change, the exact
check that passed, the exact context that produced it — replay it yourself").

The unit of exchange is not the model's output. It is the **proof**.

## 1. Why a receipt (and why context provenance)

Agent verification today splits into two camps: probabilistic verdicts with no artifact
(an LLM judge says "looks done"), or vendor-locked artifacts no external auditor can
replay. Protocol-layer treatments of claim attestation (Pramana, arXiv:2605.20312) and
trust-layer economics ("a real agent can describe itself with complete confidence and be
wrong" — arXiv:2606.03034) both converge on the same requirement: **consequential agent
output must carry an offline re-verifiable attestation.**

What no prior scheme records is the **context identity**: *which exact prompt prefix,
which exact serving build of which model, on which exact input* produced the verified
work. Supply-chain provenance (SLSA) captures the build, not the LLM context; observability
traces (OTel) capture debugging data, not replayable proof; tamper-evident prompt chains
(arXiv:2602.10481) protect context *integrity in flight*, not the fingerprint of a
verified work unit. The receipt's `provenance` block closes exactly that gap.

## 2. The artifact

A receipt is a JSON document (with a human-readable Markdown twin) written next to the
work it attests, plus the patch it proves:

```
.fabula/receipts/
  <timestamp>-<slug>.json      ← the receipt (this spec)
  <timestamp>-<slug>.md        ← same content, human-readable
  <timestamp>-<slug>.patch     ← the exact unified diff the receipt attests
```

### 2.1 Top-level fields

| Field | Meaning | Honesty rule |
|---|---|---|
| `version` | `fabula-receipt/v0` | — |
| `mintedAt` | epoch ms at mint | — |
| `model` | `{ id, host }` — the model in the socket and where it served from | any model: local or cloud |
| `task` | what the run claims to have done | recorded, not judged |
| `base` | git HEAD the patch applies to | absent outside a git repo — never invented |
| `gates` | which harness gates fired and what each forced | includes failures |
| `artifact` | `{ patch?, truncated? }` | a truncated diff ⇒ **no patch is written** and the receipt says the run is not independently replayable |
| `verification` | `{ cmd, exitCode, passed, outputTail, cwd? }` — the REAL check that ran | verbatim output tail; a manual mint records `passed:false`; `cwd` is the repo-root-relative directory the command ran in (absent = root) and replay MUST re-run it from there |
| `replay` | one command a third party runs to re-verify deterministically | — |
| `provenance` | context identity (§3) | optional: absent when nothing was published — never synthesized |

### 2.2 Verdict discipline

There are exactly two terminal states: **VERIFIED** (the recorded check really passed) and
**NOT DONE**. There is no third state. A receipt minted without a passing verification says
so on its face. "NOT DONE is a feature": an honest failure outranks a confident claim.

## 3. Context provenance (`provenance`)

The identity of the run, hashed at the single point every request passes through (the
stream boundary, after all transforms — what actually went on the wire).

```json
{
  "bundlePrefixHash": "sha256 — identity of the full request prefix",
  "systemHash":       "sha256 of the system-prompt parts (boundary-preserving)",
  "toolsHash":        "sha256 of the wire-form tool schemas (sorted by name)",
  "toolCount":        104,
  "engineVersion":    "…",
  "step":             12,
  "inputHash":        "sha256 of the user-turn input text (frozen at the first step)",
  "modelDescriptorHash": "sha256 of the serving descriptor (canonical JSON)",
  "modelDescriptor":  { "id": "…", "arch": "…", "quantization": "…", "publisher": "…" },
  "weightsDigest":    { "digest": "sha256", "files": 7, "bytes": 19452837120 },
  "routerProfile":    "coding",
  "midTurnBreaks":    0
}
```

Field semantics — each carries an explicit honesty rule:

- **`bundlePrefixHash`** = sha256(systemHash ‖ toolsHash). Two runs with the same hash saw
  byte-identical instructions and tool surfaces. System parts hash with boundaries
  preserved (`["ab","c"] ≠ ["a","bc"]`); tool schemas hash by content in sorted-name order,
  so map insertion order can never change the identity.
- **`inputHash`** — sha256 of the user-turn input text as the model saw it on the wire,
  **frozen at the first step of the turn**: later steps carry synthetic harness reminders
  as the trailing message, and the receipt must state what the *user* asked, never what
  the harness nudged.
- **`modelDescriptorHash`** — sha256 of the canonical (sorted-key) JSON of the serving
  descriptor reported by the model server's registry API: id, architecture, quantization,
  publisher, compatibility type. It pins **which build/quant served the run**. It is NOT a
  hash of the weights, and a conforming renderer must label it so.
- **`weightsDigest`** — sha256 over the model's actual weight files (per-file sha256 over
  sorted relative paths, rolled up). Present **only when the files were really hashed**;
  never synthesized from metadata. `files`/`bytes` state what was covered.
- **`midTurnBreaks`** — count of unplanned prefix changes *within* one user turn. `0`
  means byte-stability held for the whole run: the KV-cache-safe prefix the receipt
  fingerprints is the one every step actually used. Non-zero is reported loudly, not
  hidden.
- **`step`** — how many prefixes the session published (the run's length in model calls).

Rationale for making these part of the *proof* rather than debug telemetry: a verified
patch is only as reproducible as its context. Two receipts with equal `bundlePrefixHash`,
`modelDescriptorHash` and `inputHash` claim the same work under the same conditions — and
can be checked against each other by a third party with no trust in either producer.

## 4. Replay protocol

1. Check out `base` in a scratch worktree.
2. Apply the receipt's `patch` (byte-exact; `git apply`).
3. Run `verification.cmd`; require the recorded `exitCode`.
4. (Optional, context-level) Re-serve the recorded `modelDescriptor` and confirm the
   registry descriptor hashes to `modelDescriptorHash`; where the weights are available,
   re-hash and compare `weightsDigest.digest`.

Steps 1–3 verify the **work**. Step 4 verifies the **identity claim** — that the stated
model build really is the one on disk. A verifier MUST treat a hash mismatch as
NOT VERIFIED, and MUST NOT substitute a weaker check (e.g. trusting the id string).

## 5. Independent attestation (witness)

A receipt MAY be accompanied by witness records (side-car file; the receipt itself is
immutable): an **independent** model adversarially reviews the diff and records
CONFIRMED/DISPUTED. Independence is enforced at the model-**family** level (vendor /
training lineage), not by id-string comparison — an id mismatch between two builds of the
same line is not independence. Cross-family review catching correlated same-family blind
spots is established for defect discovery (arXiv:2604.19049); diff-level attestation of an
agent's own change is the setting this spec targets.

## 6. JSON Schema (normative, draft-07)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "fabula-receipt/v0 provenance",
  "type": "object",
  "required": ["bundlePrefixHash", "systemHash", "toolsHash", "toolCount", "engineVersion", "step"],
  "properties": {
    "bundlePrefixHash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "systemHash":       { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "toolsHash":        { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "toolCount":        { "type": "integer", "minimum": 0 },
    "engineVersion":    { "type": "string" },
    "step":             { "type": "integer", "minimum": 1 },
    "inputHash":        { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "modelDescriptorHash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "modelDescriptor": {
      "type": "object",
      "required": ["id"],
      "properties": {
        "id": { "type": "string" },
        "arch": { "type": "string" },
        "quantization": { "type": "string" },
        "publisher": { "type": "string" },
        "compatibilityType": { "type": "string" }
      }
    },
    "weightsDigest": {
      "type": "object",
      "required": ["digest", "files", "bytes"],
      "properties": {
        "digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "files":  { "type": "integer", "minimum": 1 },
        "bytes":  { "type": "integer", "minimum": 1 }
      }
    },
    "routerProfile":   { "type": "string" },
    "routerWatermark": { "type": "string" },
    "midTurnBreaks":   { "type": "integer", "minimum": 0 }
  }
}
```

## 7. Conformance

A producer conforms iff: (a) every hash covers exactly what this spec says it covers;
(b) optional fields are **omitted** when their data was not really obtained — never
defaulted, estimated, or synthesized; (c) the Markdown rendering labels
`modelDescriptorHash` as *not a weights hash*; (d) a failed or absent verification is
rendered as NOT DONE / unverified on the receipt's face.

## 8. Prior art & positioning

- **Pramana** (arXiv:2605.20312) — protocol-layer claim attestation with `verify()` and
  offline re-verifiability over A2A/MCP. The receipt is a concrete, shipped artifact of
  that shape for code changes; this spec adds the context-identity block Pramana does not
  model.
- **Capability advertisement as a market for lemons** (arXiv:2606.03034) — why
  faith-based capability claims settle into a low-trust equilibrium; receipts are the
  screening artifact.
- **Deterministic context security** (arXiv:2602.10481) — tamper-evident hash chains over
  prompts as *injection defense*; adjacent to, but distinct from, fingerprinting a
  verified work unit.
- **Refute-or-Promote** (arXiv:2604.19049) — cross-family review catches correlated
  same-family blind spots (defect discovery); the witness layer (§5) applies the result to
  diff-level attestation.
- **SLSA / Reproducible Builds** — the doctrine, shifted up the stack: from
  *source → binary* to *intent → diff*.

## 9. Versioning

`v0.2` adds `inputHash`, `modelDescriptorHash`/`modelDescriptor`, `weightsDigest` to the
`v0.1` provenance block (prefix/system/tools hashes, router fields, `midTurnBreaks`).
All additions are optional: every v0.1 receipt remains valid, and the provenance block
never participates in any content-addressed receipt id.
