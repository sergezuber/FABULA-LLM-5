# FABULA receipt — VERIFIED

> Done is a proof, not a feeling. This receipt records what proved this run done — replay it to re-verify.

- **minted:** 2026-07-16T16:13:29.775Z
- **model:** `qwen3.6-35b-a3b-uncensored-heretic-mlx` (local)
- **task:** "Fix the export bug: the nightly export silently drops rows dated exactly on the end date. Prove it."
- **base:** `c660a02ab138` (the commit the patch applies to)

## Gates that fired
- **verify** — re-ran the project's checks after source edits — only a green run counts as done
- **comprehension** — graded the agent against its own diff before 'done' stood

## Artifact
- git diff · 2 file(s) · 1551 bytes · `.fabula/receipts/receipt-1784218409798.patch`

## Verification
- **command:** `bun test`
- **exit code:** 0 · **passed:** yes

```
--- package test script output (tail) ---
bun test v1.3.14 (0d9b296a)

 6 pass
 0 fail
 9 expect() calls
Ran 6 tests across 1 file. [7.00ms]
```

## Context provenance
- **prefix:** `a38cb5a6f018b9c0` (system `51e73b06` · tools `3ad0a6ba` · 64 tools)
- **input:** `a4f1fe05052d521f` (sha256 of the user-turn request text)
- **model descriptor:** `c741e6747595deed` (qwen3_5_moe · 4bit · froggeric) — serving build/quant, not a weights hash
- **weights digest:** `1d4e997c45fc5d30` (16 files, 20.42 GB actually hashed)
- **router profile:** coding
- **engine:** 0.0.0-prod-202607161549 · **steps:** 13
- **byte-stability:** held (0 mid-turn prefix changes)

## Replay
```bash
git worktree add --detach /tmp/fabula-replay-1784218409775 c660a02ab138 && git -C /tmp/fabula-replay-1784218409775 apply "$(pwd)/.fabula/receipts/receipt-1784218409798.patch" && cd /tmp/fabula-replay-1784218409775/demo && bun test
```

— Verified Autonomy · fabula-receipt/v0