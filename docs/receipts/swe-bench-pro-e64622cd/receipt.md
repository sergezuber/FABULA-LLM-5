# FABULA receipt — VERIFIED

> Done is a proof, not a feeling. This receipt records what proved this run done — replay it to re-verify.

- **minted:** 2026-07-10 (replayed live before publishing; run `bash replay.sh` to mint your own verdict)
- **model:** `qwen3.6-35b-a3b` (local — quantized, LM Studio on a MacBook; no cloud model anywhere in the loop)
- **task:** [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) instance
  `qutebrowser…e64622cd`: `signal_name` extraction is inconsistent across PyQt versions and signal types —
  unify it so debug output is stable on PyQt 5/6.
- **base:** `09925f74817c` (the qutebrowser commit the patch applies to, checked out inside the benchmark container)

## Gates that fired
- **verify** — the harness pressed the run back into `verify_done` after source edits; done was a test result,
  not the model's claim.

## Artifact
- git diff · 1 file (`qutebrowser/utils/debug.py`) · [`model.patch`](model.patch) — the exact diff the model
  produced, unedited.

## Verification
- **grading:** the benchmark's own hidden acceptance suite (`test.patch` + `run_script.sh`, from the public dataset)
- **result:** fail_to_pass **4/4 PASSED** · pass_to_pass **41/43 PASSED + 2 xfail** (expected outcomes, not
  regressions) → **RESOLVED**

```
======================== 45 passed, 2 xfailed in 0.88s =========================
fail_to_pass: 4/4 PASSED
pass_to_pass: 41/43 PASSED (+2 xfail/xpass — expected, not regressions)
VERIFIED ✓ — the artifact replayed: base + patch passed the hidden acceptance suite.
```

## Replay

```bash
bash replay.sh   # needs Docker; pulls the public per-instance image (~1 GB), exits 0 on VERIFIED
```

The replay checks the **artifact**, not the run: a throwaway container at the recorded base commit, the model's
patch applied, the benchmark's own acceptance tests run. The container image is pinned by digest. The test
assets ship in this directory for self-containment — they come from the public
[SWE-bench Pro dataset](https://github.com/scaleapi/SWE-bench_Pro-os), so you can fetch them independently and
diff against these copies before trusting the verdict.

## Provenance

The patch was produced on 2026-07-06 by the local model inside the FABULA harness (`fabula run`, verify gates on)
during the calibration described in [EVALS](../../EVALS.md). The verification above is a fresh replay of that
artifact executed on 2026-07-10, immediately before publishing — the same command you are invited to run.

— Verified Autonomy · fabula-receipt/v0
