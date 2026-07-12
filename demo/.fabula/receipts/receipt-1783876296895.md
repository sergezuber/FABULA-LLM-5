# FABULA receipt — VERIFIED

> Done is a proof, not a feeling. This receipt records what proved this run done — replay it to re-verify.

- **minted:** 2026-07-12T17:11:36.880Z
- **model:** `qwen3.6-35b-a3b-nvidia-nvfp4-512k` (local)
- **task:** "Fix the export bug: the nightly export silently drops rows dated exactly on the end date. Prove it."
- **base:** `91528cd73457` (the commit the patch applies to)

## Gates that fired
- **verify** — re-ran the project's checks after source edits — only a green run counts as done
- **comprehension** — graded the agent against its own diff before 'done' stood

## Artifact
- git diff · 2 file(s) · 1343 bytes · `.fabula/receipts/receipt-1783876296895.patch`

## Verification
- **command:** `cd "$(git rev-parse --show-toplevel)/demo" && bun test .`
- **exit code:** 0 · **passed:** yes

```
--- FABULA_VERIFY_CMD output (tail) ---
bun test v1.3.14 (0d9b296a)

 6 pass
 0 fail
 9 expect() calls
Ran 6 tests across 1 file. [55.00ms]
```

## Context provenance
- **prefix:** `2356eade555182c1` (system `6ed4ae19` · tools `6f62c87e` · 102 tools)
- **router profile:** coding
- **engine:** 0.0.0-prod-202607121102 · **steps:** 15
- **byte-stability:** held (0 mid-turn prefix changes)

## Replay
```bash
git worktree add --detach /tmp/fabula-replay-1783876296880 91528cd73457 && git -C /tmp/fabula-replay-1783876296880 apply "$(pwd)/.fabula/receipts/receipt-1783876296895.patch" && cd /tmp/fabula-replay-1783876296880 && cd "$(git rev-parse --show-toplevel)/demo" && bun test .
```

— Verified Autonomy · fabula-receipt/v0