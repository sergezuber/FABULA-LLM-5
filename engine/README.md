<h1 align="center">FABULA engine</h1>

<p align="center"><sub>the local-first agent loop that powers <a href="../README.md"><b>FABULA-LLM-5</b></a></sub></p>

---

This directory is the **vendored FABULA engine** — a lean, rebranded fork of
[MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code) (itself an [OpenCode](https://opencode.ai) fork),
checked into this repo so the whole product builds from a single tree. Foreign service integrations
are disabled and the user-facing toolset is FABULA's own.

## → You almost certainly want the project README, not this one

### **[FABULA-LLM-5 README](../README.md)**

That is where the actual product lives: the concept (a model-agnostic harness — **67 real tools
across 22 FABULA plugins**, so a small local model ships verified work and a frontier model reaches
higher in the *same* system), the install steps, the full plugin table, privacy, and architecture.

**Important:** FABULA's capabilities are the `plugin/fabula-*.ts` plugins in the **repo root**, not
the engine's built-in tool set that the upstream MiMoCode docs described. If you came here looking
for "the plugins", they are one directory up.

## Building

The engine is built by the top-level [`build.sh`](../build.sh) (frontend → single-binary engine with
the web UI embedded → native macOS app). See the root README's **Install** section and
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

---

<sub>Upstream lineage &amp; credits: [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code),
[OpenCode](https://opencode.ai). FABULA vendors, rebrands, and re-tools it; see
[`docs/CREDITS.md`](../docs/CREDITS.md).</sub>
