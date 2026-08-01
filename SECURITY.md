# Security Policy

FABULA-LLM-5 executes model-directed actions on your machine (shell, files, browser). The security layer (`fabula-security.ts` + `plugin/lib/`) provides SSRF guards, secret redaction, untrusted-content wrapping (prompt-injection defense), and write/command guards — but an agent with shell access is inherently powerful. Run it with the same care as any tool that can execute code.

The write and fetch rules are enforced on **three doors**, from one set of rules:

- **tools** — every write verb, including patch-style edits whose targets are read out of the patch body rather than from an argument;
- **the shell** — a command's redirect, `tee`, `cp`/`mv`/`ln`, `sed -i` and fetcher targets are extracted and put to the same rules;
- **code** — `execute_code` without a container runs under the macOS kernel profile (`sandbox-exec`), because a path a program *computes* cannot be seen by anything that inspects arguments.

Two decisions are the owner's alone and cannot be taken from inside a run: the permission mode `bypass`, and any per-command allowance (`allow_command` records the request and reports that it is not in effect). An explicit `sandbox: true` is refused when isolation is unavailable rather than downgraded to host execution.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's **private vulnerability reporting** ("Report a vulnerability" under the Security tab) with:

- a description and impact assessment,
- reproduction steps or a proof of concept,
- affected file(s)/plugin(s) if known.

You will get an acknowledgement, typically within a few days. Please allow reasonable time for remediation before public disclosure.

## Scope notes

- Bypasses of the guards (SSRF filter, secret redaction, write/command guards, prompt-injection wrapping, the loop-guard) are in scope and very welcome — including reaching a guarded target through a door the rules do not yet ask on. The shell and code extractors are best-effort reads of arbitrary programs: a computed path, a glob, or a helper script is invisible to them, which is why the kernel profile sits underneath rather than beside them. A demonstration that gets past *both* layers is the most useful report you can send.
- The upstream projects FABULA's engine derives from (MiMoCode/OpenCode) and model providers have their own security processes; issues that reproduce without the FABULA plugin set belong upstream.
- Any model in the socket can be manipulated by adversarial content it reads (web pages, files). The untrusted-content wrapping (`fabula-security.ts`) narrows this surface by design; reports that demonstrate practical injection through a FABULA tool are in scope and prioritized.
