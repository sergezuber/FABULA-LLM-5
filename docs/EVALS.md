# Evals & run notes

**Done is a proof, not a feeling.** Honest, per-task evidence — captured runs, not marketing numbers. Receipts (`fabula receipt`, per the
[Greenpaper](GREENPAPER.md)) will supersede this page; until then, run notes live here.

## The capstone run — a 35B local model resolves a real SWE-bench Pro task

**Setup.** [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) task on the qutebrowser codebase
(instance `479aa075…`): a real upstream bug, graded by *hidden* acceptance tests (`fail_to_pass` must flip
to green, `pass_to_pass` must not regress). Model: **Qwen3.6-35B-A3B (quantized), running locally in
LM Studio on a MacBook Pro** — no cloud, no frontier model anywhere in the loop. FABULA harness with the
verification gates on.

**What the system forced, step by step:**

1. **Reproduce first.** The harness required a reproducing test before any fix. The model wrote its own
   reproduction *from the issue text alone*. The reproduction was accepted only after a double validation:
   it **fails on the broken code** and **passes on the reference fix** — and the reference fix was never
   shown to the agent (it exists only in the grader).
2. **Fix under a live verify loop.** Every `verify` call ran the repo's real test suite; the model iterated
   against genuine red output — not its own opinion of the diff.
3. **Done only on green.** The run concluded when the verification passed.

**Result against the hidden acceptance suite:**

| Check | Score |
|---|---|
| fail_to_pass | **2/2** |
| pass_to_pass | **9/9** |
| Verdict | **RESOLVED** |

The model didn't get smarter. The system refused to let "done" happen without proof.

## What we do and don't claim

- We **don't** publish an aggregate resolve-rate as a promise. Agent throughput varies wildly by task,
  model and budget; a single percentage without a replayable receipt is exactly the kind of unverified
  claim this project exists to end.
- We **do** claim the mechanism, which is grep-able in this repository: verification is forced by the
  system ([engine verify-gate](../engine/packages/opencode/src/session/verify-gate.ts), default-on;
  [reproduce-gate](../plugin/fabula-reproduce-gate.ts); [change-quiz](../plugin/fabula-change-quiz.ts);
  loop hard-stop), and a run that hasn't passed its check is *not done*.
- Benchmark tooling (task runners, Docker-in-the-loop verification, eval scripts) currently lives in a
  private bench workspace; it is being productized into replayable receipts so that any third party can
  re-verify shipped artifacts with one command. That milestone — not a bigger number — is the roadmap.

## A published, replayable receipt

The first public Proof of Done lives in [`docs/receipts/`](receipts/): SWE-bench Pro instance
`e64622cd` (qutebrowser, `signal_name` across PyQt versions) — solved by the same local 35B model inside the
harness, graded by the benchmark's hidden acceptance suite: **fail_to_pass 4/4, pass_to_pass 41/43 + 2 xfail
(expected) — RESOLVED**. One command replays it on your machine:
[`bash replay.sh`](receipts/swe-bench-pro-e64622cd/replay.sh) (Docker; the artifact, the tests and the verdict
are all yours to re-run).

**An honest note on the capstone above:** the `479aa075` run predates automatic receipt minting, and its patch
was overwritten by a later batch run before we preserved it — so it stays a run note, not a replayable receipt.
That loss is exactly the argument for receipts: evidence not minted at the moment of green is evidence you
eventually lose. Every green run now mints one automatically.

## Roadmap for this page

1. ~~`fabula receipt` — machine-readable Proof of Done for every completed run.~~ **Shipped:** the
   [receipt plugin](../plugin/fabula-receipt.ts) mints one on every green verify to `.fabula/receipts/`,
   the [rewind plugin](../plugin/fabula-rewind.ts) surfaces the explicit terminal `NOT DONE` verdict
   when the self-repair ladder is exhausted, and `fabula receipt verify` replays any receipt deterministically.
2. ~~Public receipts for new runs.~~ **First one shipped:** [`docs/receipts/`](receipts/) — model, task, gates,
   patch, and a one-command deterministic replay. More runs land here as they complete.
3. Bare-model vs in-harness comparisons on identical tasks, both sides captured and replayable.
