# FABULA

![Prove it — the examiner demands the proof; the scribe keeps writing until it exists](docs/assets/prove-it.jpg)

### Frontier models sell confidence. FABULA ships proof.

**Any model in. Finished, verified work out.**

**Sovereign by default: your model, your data, your perimeter — and a receipt anyone can replay.**

> **Platform:** runs today on **macOS with Apple Silicon (M-series)** only. The engine is portable Bun/TypeScript — Linux is on the roadmap, not shipped yet.

![How FABULA works — any model slots into the socket; Context OS compiles the minimal byte-stable context; the work loop self-repairs on red, rewinds to the last green checkpoint after repeated failures, takes one cloud second opinion when stuck; even a green run is NOT YET DONE until the REPRODUCE and QUIZ gates pass, and the JUDGE refuses to end the turn until the request is fulfilled; only proven work exits, as a replayable, context-fingerprinted Proof-of-Done receipt](docs/assets/how-it-works.svg)

FABULA is an **agent harness** built on one bet: **trust belongs to the proof, not the model.** Any LLM — a small local model or a frontier cloud — is a swappable chip, and the autonomy lives in the machinery around it. **Done is a test result, not the model's confidence.** Every gate is open source you can read, and every fully-gated green run mints a replayable [Proof-of-Done receipt](docs/GREENPAPER.md) ([open spec draft](docs/spec/verified-autonomy-receipt-v0.2.md)). Run it fully local and nothing leaves your machine — not a cost argument, but sovereignty: the mode audited environments (on-prem, air-gapped) actually require, where a verified receipt from the model you own outranks an unverifiable claim from a model you rent.

## The loop doesn't give up — and is built not to end in a story

A red verify doesn't stop the run: the model iterates against the real failing output. Repeated reds don't stop it either — the harness rewinds the files to the last green checkpoint, atomically, and steers a different approach. A dead end pulls one second opinion from a stronger model, and the local model keeps driving. **NOT YET DONE is a transit state, not a verdict.**

And the run won't quietly end in a claim. If source changed but the tests never ran, the force-verify gate re-enters and makes the model run them; if the retry budget is spent with the change still unverified, the final message is stamped **NOT DONE (unverified)** over the real failing output. A finished run is built to land in one of two honest states — **VERIFIED**, with a replayable receipt, or an explicit **NOT DONE** — not a confident "done" you were meant to take on faith. It's a strong best-effort gate, not a proof of impossibility: heavy context compaction, or handing the whole task to a subagent, can still slip past it.

## The run can't even end early

Ending the turn is not the model's decision. Before any stop is honored, an independent judge reads the transcript — the real tool calls, not the model's summary — and refuses the stop until the request is fulfilled: **done, not planned, described, or promised.** The judge is fail-open (a broken judge can never trap you) and bounded (a low re-entry cap), and an explicit `/goal` condition makes it as strict as you want.

## The right context, not all the context

Most agents ship the same giant system prompt and every tool schema on every step. FABULA compiles the **minimal sufficient context per task**: a deterministic router picks the profile's tools (the committed demo receipt records 64 tools on the coding profile; a masked tool called by name still executes — a router miss costs one roundtrip, never a blocked task), the kernel prompt carries only load-bearing contracts (28.8k → 4.9k tokens), and verbose tool prose went on a measured diet. From the wire: the request prefix dropped **72.3k → 43.5k tokens (−40%)** — and it stays **byte-stable within a task**, so the local model's KV-cache survives across steps. That's why a 35B on a laptop keeps up. Every cut was gated: a tool-use golden-eval (right tool, right arguments) and behavioral gate probes ran before and after each step — zero regressions.

## Proof

The scheme above is not a promise — a real captured run walked that exact path: the model fixed the bug, the tests went green, and the machine still answered NOT YET DONE until the proof existed. The run left a receipt. It is committed verbatim — replay it:

```bash
cd demo && fabula receipt verify
```

```
VERIFIED ✓ — the artifact replayed deterministically:
base c660a02ab138 + patch → `bun test` passed.
```

**Don't trust it. Replay it.** The receipt records the model in the socket (a quantized 35B running locally in LM Studio), the gates that fired, the diff and the passing verification — and **the exact context that produced the work**: a sha256 fingerprint of the prompt-prefix (system + tool schemas), the router profile, and a byte-stability verdict; as of v0.2 also a hash of the user's request text, the serving model's descriptor (arch/quantization — honestly labeled *not a weights hash*), and an optional real digest of the weight files on disk ([spec](docs/spec/verified-autonomy-receipt-v0.2.md); the committed demo receipt carries all of them — including a real 20.4 GB weights digest). `fabula receipt verify` prints it next to the claim:

```
Claim:    VERIFIED ✓ · qwen3.6-35b-a3b-uncensored-heretic-mlx (local) · 2 file(s)
Context:  prefix a38cb5a6f018b9c0 · profile coding · byte-stability held
```

Two receipts with the same prefix hash were produced in byte-identical contexts — the work is reproducible not just by artifact, but by *context*. [Read the receipt](demo/.fabula/receipts/latest.md).

The harder one is public too: a **real [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) task**, solved by the same local 35B and graded by the benchmark's *hidden* acceptance suite — fail-to-pass **4/4**, **RESOLVED**. Its receipt ships with a one-command Docker replay: [`docs/receipts/`](docs/receipts/). A second captured bench run and methodology: [`docs/EVALS.md`](docs/EVALS.md).

The model didn't get smarter — the system around it refused to let "done" happen without proof.

## Why a receipt, not a bigger model

Every agent vendor answers the trust question the same way: *trust the model — it's smart.* A merge
gate here, a pass-rate dashboard there — but the unit they ship is still an unverified claim, and
the remedy they sell is a bigger model. FABULA changes the unit: what leaves the run is a
**content-addressed, third-party-replayable proof** with the *exact context that produced it* —
prompt-prefix fingerprint, request-text hash, serving-model descriptor, optional weights digest,
byte-stability verdict. To our knowledge no other shipped agent mints that artifact. The moment work
is judged by its receipt, the capability gap stops being a rent: **a verified receipt from a 35B you
own beats a confident claim from a frontier model you rent — everywhere someone audits** (regulated,
enterprise, government: the buyers who already demand on-prem and air-gapped, which FABULA runs by
default).

The receipt format is an **open specification** — [verified-autonomy receipt v0.2](docs/spec/verified-autonomy-receipt-v0.2.md):
JSON schema, field-by-field honesty rules, and a replay protocol any agent can implement. Mint
receipts from your own harness; verify ours with one command. The proof economy gets better the more
producers it has.

**Status:** verified end-to-end on macOS (Apple Silicon) today. The engine is portable Bun/TypeScript with a web UI — the native app is the macOS shell, not a dependency; Linux builds are on the roadmap. Every captured run is replayable.

## The raw evidence

For anyone who wants the unedited artifacts behind the scheme: the live recording of the refusal ([`docs/assets/refusal.cast`](docs/assets/refusal.cast), plays with asciinema) and its beat-by-beat render ([`docs/assets/captured-run.svg`](docs/assets/captured-run.svg)). The worst day — repeated red verifies, an automatic file rewind, a steered cloud second opinion — is the machinery's deeper ladder: [`docs/HARDEST-JOURNEY.md`](docs/HARDEST-JOURNEY.md).

## Try it

You need a **Mac with Apple Silicon (M1 or newer)** — that's the only shipped platform today — and
the **Xcode Command Line Tools** (the engine build compiles a few native modules):

```bash
# once per machine; skip if you already build C/C++ on this Mac
xcode-select --install
```

<sup>Toolchain sanity check: `printf '#include <functional>\nint main(){}\n' | clang++ -x c++ - -o /tmp/t && echo OK` — if this fails after a macOS update, reinstall the Command Line Tools.</sup>

```bash
git clone https://github.com/sergezuber/FABULA-LLM-5 && cd FABULA-LLM-5
./setup.sh
open FABULA-LLM-5.app
```

`./setup.sh` is idempotent — re-run it any time (after `git pull`, after installing a dependency); it
never overwrites your `.env` / `fabula.config.json`.

### Point it at your model

**Local (default):** install [LM Studio](https://lmstudio.ai), load a tool-calling model — setup
already installed the localhost adapter the config points at. Nothing else to do.

**Any OpenAI-compatible endpoint** — a cloud provider or a corporate gateway: put the key in `.env`
(gitignored) and describe the provider in `fabula.config.json`:

```jsonc
// .env
MY_API_KEY=sk-...

// fabula.config.json
{
  "model": "myapi/my-model-id",
  "provider": {
    "myapi": {
      "name": "My endpoint",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://llm.example.com/v1", "apiKey": "{env:MY_API_KEY}" },
      "models": {
        "my-model-id": { "tools": true, "limit": { "context": 131072, "output": 32768 } }
      }
    }
  }
}
```

The model must support **tool calling**, and `limit` needs both `context` and `output`. Check the
endpoint and the exact model id with `curl -s https://llm.example.com/v1/models -H "Authorization: Bearer $MY_API_KEY"`.
If the gateway lives behind a corporate VPN, the VPN has to be up while you work.

### The two-minute proof

A planted bug is waiting in [`demo/`](demo/) — every test is green anyway. Open `demo/` as the project and paste:

> Fix the export bug: the nightly export silently drops rows dated exactly on the end date. Prove it.

Then watch the machine refuse to finish until the proof exists — on your machine, with your model.

## What's inside

| The gate | What it refuses |
|---|---|
| **verify** | "Done" without a green run of the project's own tests — the engine presses the run back into verification after source edits, by itself. |
| **reproduce** | A green suite proves nothing on its own. The harness runs your new test against the pre-patch code: passes with *and* without the fix → fake, no done; breaks a sibling → regression, no done. |
| **quiz** | A change the agent can't explain — it is graded against its own diff before done stands. |
| **judge** | A turn that ends before the request is fulfilled — an independent judge reads the transcript and refuses the stop until it's done, not planned or promised. |
| **provenance** | Work of unknown origin — every receipt carries a sha256 of the exact context (system prompt + tool schemas + router profile), a byte-stability verdict, and (v0.2) the request-text hash + the serving model's descriptor, with an optional real weights digest. |
| **rewind** | Digging the hole deeper — repeated red verifies roll the files back to the last green checkpoint, atomically, from the harness's own shadow-git. The failed attempts leave your context so the retry starts clean; the steer names the recurring root cause; and any non-idempotent side effect (an install, a migration, a POST) is flagged as not-undone. |
| **escalate** | Looping on a dead end — the auto-rewind steers the model to fetch one cloud second opinion, then it keeps driving. |

Around the gates: web, shell, sandboxed code execution, drift-proof file edits, a real Chromium, memory and hand-off notes, checkpoints and undo, SSRF/redaction/injection defense on every call. The full map of every plugin and tool: [`docs/PLUGINS.md`](docs/PLUGINS.md).

And an optional **proof economy** builds on the receipt — publish it to a content-addressed registry, have an independent cross-model witness attest the diff, escalate a stuck run to a cloud model that writes the patch *you* then re-verify, or compose a team's sub-receipts into one all-or-nothing proof tree. Six plugins, all off by default: [the disrupt layer](docs/PLUGINS.md#the-disrupt-layer--turning-a-proof-of-done-into-a-proof-economy-experimental-off-by-default).

## The protocol

The receipt format — *which model sat in the socket, which gates fired, what patch shipped, how to replay it* — is specified as a small open protocol, **Verified Autonomy**; FABULA is its reference implementation: [`docs/GREENPAPER.md`](docs/GREENPAPER.md).

## Privacy

- Local models mean local data: nothing leaves the machine unless *you* configure a cloud provider.
- Deleting a chat purges its messages, artifacts, and caches — nothing is retained by the app.
- The app wipes WebKit caches on quit; secrets live only in gitignored `.env` / `*.key` files.
- No telemetry, no account, no phone-home.

## Docs

| Topic | Where |
|---|---|
| Every plugin and tool | [`docs/PLUGINS.md`](docs/PLUGINS.md) |
| The protocol (draft) | [`docs/GREENPAPER.md`](docs/GREENPAPER.md) |
| **The receipt spec — an open standard any agent can implement** | [`docs/spec/verified-autonomy-receipt-v0.2.md`](docs/spec/verified-autonomy-receipt-v0.2.md) |
| Public replayable receipts | [`docs/receipts/`](docs/receipts/) |
| Evals & run notes | [`docs/EVALS.md`](docs/EVALS.md) |
| The hardest journey (capability walkthrough) | [`docs/HARDEST-JOURNEY.md`](docs/HARDEST-JOURNEY.md) |
| Architecture deep-dive | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Every dependency + install command | [`DEPENDENCIES.md`](DEPENDENCIES.md) |
| Configuration templates | [`fabula.config.example.json`](fabula.config.example.json) · [`.env.example`](.env.example) |
| Contributing & testing rules | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Security policy | [`SECURITY.md`](SECURITY.md) |
| Credits | [`docs/CREDITS.md`](docs/CREDITS.md) |

## Acknowledgements

Built on and grateful to: [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code) (the engine FABULA builds on, an [OpenCode](https://opencode.ai) fork), [LM Studio](https://lmstudio.ai), [SearXNG](https://docs.searxng.org), [Playwright](https://playwright.dev), [Bun](https://bun.sh), piper, and faster-whisper. Several supervision mechanisms — cross-provider conversation replay, silent context-overflow detection, prefix-cache telemetry, bounded tool output, drift-tolerant edits, and the conversation-rewind idea FABULA extends into a file-atomic rewind — were adapted from the mechanism designs of [pi](https://github.com/earendil-works/pi) (Mario Zechner, MIT), reimplemented and tested here. The toolset follows naming and schema conventions that state-of-the-art assistants have made publicly familiar, implemented here independently for any model you choose to run. More: [`docs/CREDITS.md`](docs/CREDITS.md).

## License

MIT — see [LICENSE](LICENSE).
