# Security Policy

FABULA-LLM-5 executes model-directed actions on your machine (shell, files, browser). The security layer (`fabula-security.ts` + `plugin/lib/`) provides SSRF guards, secret redaction, untrusted-content wrapping (prompt-injection defense), and command/approval guards — but an agent with shell access is inherently powerful. Run it with the same care as any tool that can execute code.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's **private vulnerability reporting** ("Report a vulnerability" under the Security tab) with:

- a description and impact assessment,
- reproduction steps or a proof of concept,
- affected file(s)/plugin(s) if known.

You will get an acknowledgement as quickly as possible, typically within a few days. Please allow reasonable time for a fix before public disclosure.

## Scope notes

- Bypasses of the guards (SSRF filter, secret redaction, command guard, prompt-injection wrapping, the loop-guard) are in scope and very welcome.
- The upstream projects FABULA's engine derives from (MiMoCode/OpenCode) and model providers have their own security processes; issues that reproduce without the FABULA plugin set belong upstream.
- Local models can be manipulated by adversarial content they read (web pages, files). The wrapping defense reduces this; reports that demonstrate practical injection through a FABULA tool are in scope.
