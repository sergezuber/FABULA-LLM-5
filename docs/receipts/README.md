# Public receipts

**Don't trust AI. Verify it.** A receipt is a machine-readable Proof of Done (see [the Greenpaper](../GREENPAPER.md)):
which model sat in the socket, which gates fired, what artifact shipped, the verification that passed — and one
command that replays it deterministically on your machine. Replays check the **artifact**, not the run: model runs
are nondeterministic, patches are not.

Inside FABULA every green `verify_done` mints a receipt automatically (`.fabula/receipts/`, plugin
[`receipt`](../../plugin/fabula-receipt.ts)); `fabula receipt verify` replays any of them. This directory holds the
receipts we publish for **real benchmark runs**, packaged so a third party needs nothing but Docker.

## Receipts

| Run | Model in the socket | Verification | Replay |
|---|---|---|---|
| [swe-bench-pro-e64622cd](swe-bench-pro-e64622cd/) — qutebrowser: `signal_name` across PyQt versions ([SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os)) | Qwen3.6-35B-A3B, quantized, **local** (LM Studio, MacBook) | hidden acceptance suite: fail_to_pass **4/4**, pass_to_pass 41/43 PASSED + 2 xfail (expected) — **RESOLVED** | `bash replay.sh` |

## How a replay works

Each receipt directory is self-contained:

- `receipt.json` / `receipt.md` — the Proof of Done (fabula-receipt/v0).
- `model.patch` — the artifact: the exact diff the model produced, unedited.
- `test.patch`, `run_script.sh`, `instance.json` — the benchmark's own hidden acceptance tests and runner,
  from the public [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) dataset (Scale AI), included for
  self-containment with attribution.
- `replay.sh` — one command: pulls the public per-instance Docker image, checks out the recorded base commit,
  applies `model.patch`, applies the acceptance tests, runs them, and prints **VERIFIED** or **NOT DONE** with a
  matching exit code.

The grading is the benchmark's own: every `fail_to_pass` test must pass, and no `pass_to_pass` test may regress
(`xfail`/`xpass` are expected outcomes, not regressions).

## Why some earlier runs have no receipt here

Our first resolved run (instance `479aa075…`, the capstone in [EVALS](../EVALS.md)) predates automatic receipt
minting, and its patch was overwritten by a later batch run before we thought to preserve it. That loss is exactly
why receipts exist: **evidence that isn't minted at the moment of green is evidence you eventually lose.** Every
green run now mints one automatically.
