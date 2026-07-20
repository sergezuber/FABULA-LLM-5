# The hardest journey — what the machinery does on the worst day

The front page shows a **captured run** (a real recording, a real receipt). This page shows the
**full failure ladder** — the mechanisms that fire when a run goes worse than that: repeated red
verifies, an automatic file rewind, a steered cloud second opinion.

> This walkthrough is a **capability illustration**, not a captured run: every gate in it is real,
> shipped code you can read (linked below), but this exact sequence was composed to show the whole
> ladder in one story. The captured runs live on the [front page](../README.md) and in
> [`docs/receipts/`](receipts/).

![One hard task surviving failure — a baseline green verify captures the shadow-git checkpoint; reproduce-first demands a failing test before the fix counts; two fix attempts go red; the harness auto-rewinds the files to the last green checkpoint and steers a different approach; one cloud second opinion later the third attempt goes green, and change-quiz grades the agent on its own diff before done stands](assets/hero.svg)

## The ladder, mechanism by mechanism

| Rung | What fires | Where it lives |
|---|---|---|
| red → self-repair | `verify_done` reports the real failing output; the model iterates against it | [`plugin/fabula-tools.ts`](../plugin/fabula-tools.ts) |
| green without a test | reproduce-gate downgrades "done" until a test exercises the fix | [`plugin/fabula-reproduce-gate.ts`](../plugin/fabula-reproduce-gate.ts) |
| green without understanding | change-quiz grades the agent against its own diff | [`plugin/fabula-change-quiz.ts`](../plugin/fabula-change-quiz.ts) |
| red ×N | auto-rewind atomically restores the files to the last green shadow-git checkpoint and steers a different approach | [`plugin/fabula-rewind.ts`](../plugin/fabula-rewind.ts) |
| still stuck | the steer points at `escalate_to_cloud` — and since W6 the harness fires it directly, because a steer the model may ignore is a request, not a mechanism — one second opinion from a stronger model; the local model keeps driving | [`plugin/fabula-escalate.ts`](../plugin/fabula-escalate.ts) |
| fully-gated green | the Proof-of-Done receipt mints itself | [`plugin/fabula-receipt.ts`](../plugin/fabula-receipt.ts) |
