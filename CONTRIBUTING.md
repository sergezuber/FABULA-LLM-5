# Contributing to FABULA-LLM-5

Thanks for your interest! This project is a local-first agent stack, and contributions that keep it working **fully offline on ordinary hardware** are especially welcome.

## Ground rules

- **One plugin = one file = one export.** Each `plugin/fabula-*.ts` exports exactly one `Fabula*` factory and nothing else — the engine calls *every* export of a plugin file as a plugin, so a stray helper export breaks loading. Shared helpers live in `plugin/lib/`.
- **The manifest is law.** Every new tool, plugin, or external dependency must be declared in `plugin/lib/manifest.ts` (with a `check` and an `install` command) — then regenerate the summary: `bun scripts/install-deps.ts --md > DEPENDENCIES.md`. Add the plugin's localized name/description + capability tags to `plugin/lib/i18n.ts` (tags use the same vocabulary as the README plugins table).
- **Docs move with the code.** A capability that isn't reflected in `README.md` / `docs/` in the same PR is considered incomplete.
- **Secrets never enter the repo.** Keys live only in `.env` / `*.key` (gitignored). Templates (`.env.example`, `fabula.config.example.json`) contain placeholders only.

## Testing

Unit tests are necessary but not sufficient — a green `bun test` does not catch plugin-load failures in a live harness.

```bash
cd plugin && bun install && bun test        # unit + corner tests
```

Then verify against a **real, isolated engine**:

```bash
ISO=$(mktemp -d)
XDG_DATA_HOME="$ISO" fabula serve --port 5099 --hostname 127.0.0.1 &
# check the log for 0 ERROR / failed-to-load lines, and that models/providers appear
```

Exercise new tools through their real `execute()` against live backends. "Looks correct" is not a verification.

## Pull requests

- Keep PRs focused; explain *why*, not just *what*.
- Match the style of the surrounding code (comment density included).
- If a change affects the macOS app, rebuild with `app/build.sh` and note what you clicked to verify.

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, the tail of the engine log, and your setup (macOS version, model, local/cloud). For anything security-sensitive, see [SECURITY.md](SECURITY.md).
