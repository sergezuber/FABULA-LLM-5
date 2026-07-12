# The Greenpaper — Verified Autonomy, v0.1 (draft)

**Done is a proof, not a feeling.**

## The problem

Every AI agent on the market reports its own completion. The agent says "done"; the human checks. As models
get more capable, their unverified "done" gets more *convincing* — not more *true* — and the user silently
becomes the quality-assurance department for their own tools. Capability has scaled; accountability hasn't.

## The principle

**Completion must be an event the system can prove, not a claim the model can make.**

An agent run is *done* when — and only when — an independent check passes: a test suite goes green, a
reproduction stops reproducing, a build that must fail fails. The model's confidence is not a completion
signal. If no check can pass, the honest terminal state is *not done* — and saying so is a feature.

## The protocol

Verified Autonomy is a small, implementation-agnostic contract in four parts:

### 1. Gates
Verification is enforced by the **system**, not requested from the model. A conforming harness ships gates
that fire *themselves*:

- **Verify gate** — after source edits, the run is pressed back into a verification pass (bounded re-entries; a run that stops past the cap is explicitly *unverified*).
- **Reproduce gate** — "the build is green but no test exercises the change" downgrades to *not done*.
- **Comprehension gate** — the agent is graded against its own diff (not its self-assessment) before "done" stands.
- **Loop guard** — repeated no-progress action is hard-stopped, forcing a new hypothesis instead of wheel-spinning.
- **Stop judge** *(v0.1)* — ending the turn is not the model's decision: before any stop is honored, an independent judge reads the transcript (the real tool calls, not the model's summary) and refuses the stop until the request is fulfilled — done, not planned, described, or promised. Bounded re-entries; fail-open on judge error so a broken judge can never trap the user.

### 2. Verdicts
Every run terminates in one of two explicit states: **VERIFIED** (the check passed; the proof is attached)
or **NOT DONE** (the check didn't pass or couldn't run; the reason is attached). There is no third state.
Silent stops and unproven "done" are protocol violations. This is the protocol's terminal contract; the
shipped enforcement is a strong best-effort gate, not a mathematical guarantee — heavy context compaction
or fully delegating the work to a subagent can still slip past it (see the README's honest framing).

### 3. The receipt (Proof of Done) — v0.1
A completed run mints a machine-readable receipt:

```
model:        which weights sat in the socket (id + host, local or cloud)
task:         what was asked
gates:        which gates fired, and what each one forced
artifact:     the diff/patch that shipped
verification: the check that passed (tests, reproduction, build) + its output
replay:       one command that re-verifies the artifact deterministically
provenance:   sha256 of the exact context the model ran with              ← new in v0.1
              (system prompt + wire tool schemas), router profile, and a
              byte-stability verdict — 0 unplanned mid-turn prefix changes
              means the whole run executed on one stable context
```

The `provenance` block is optional and lives in metadata only — v0 receipts remain valid, and
it never enters any content-addressed identity. Two receipts with the same prefix hash were
produced in byte-identical contexts: the work is reproducible not just by artifact, but by
*context*.

### 4. Replay
Claims are checked by **replaying the artifact, not the run**. LLM runs are nondeterministic; patches are
not. A conforming receipt lets any third party apply the artifact and re-run the verification (e.g., the
patch against the task's test suite in a container) — bit-for-bit, with no trust in the publisher.
As of v0.1 the receipt also *names the exact context* that produced the work: the verify surfaces print
the prefix fingerprint next to the claim, so "what ran" is part of the proof, not folklore.

## Why this matters

If outcomes are produced by the *system* and proven by *replay*, then the intelligence of the model stops
being the ceiling of the result — and stops being a rent you must pay. A small local model inside a
conforming harness ships work you can check. **Your laptop is enough.**

## Status

- **v0 — draft.** This document specifies intent and shape; the receipt format will be versioned as it stabilizes.
- **Reference implementation:** [FABULA](https://github.com/sergezuber/FABULA-LLM-5). The gates exist in code today:
  engine [verify-gate](../engine/packages/opencode/src/session/verify-gate.ts) (default-on),
  [reproduce-gate](../plugin/fabula-reproduce-gate.ts), [change-quiz](../plugin/fabula-change-quiz.ts),
  loop hard-stop in [reliability](../plugin/fabula-reliability.ts). **Receipt minting ships now** as the
  [receipt](../plugin/fabula-receipt.ts) plugin (default-on): a green verify_done that no other gate
  downgraded mints a machine-readable Proof-of-Done — model, gates fired, diff, verification, and a
  deterministic replay command — to `.fabula/receipts/` (`mint_receipt` to mint by hand). **The terminal
  NOT DONE verdict ships now** in [rewind](../plugin/fabula-rewind.ts): when the self-repair ladder is
  exhausted (a red streak with no green state ever reached, or the rewind budget spent), the run surfaces
  an explicit `❌ NOT DONE` with the reason and the attempts — no silent third state. **The CLI surface
  ships now**: `fabula receipt` shows/lists receipts and `fabula receipt verify` replays the artifact
  deterministically — a throwaway worktree at the recorded base commit, the shipped patch applied, the
  same verification run — reporting VERIFIED or NOT DONE with a matching exit code. Public receipts for
  new runs are the next milestone; run evidence lives in [EVALS.md](EVALS.md) until they land.
- Implementations of this protocol by other agents are welcome — that is the point.

**Don't trust AI. Verify it.**
