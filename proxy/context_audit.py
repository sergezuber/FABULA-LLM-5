#!/usr/bin/env python3
"""FABULA Context OS — Phase 0 instrumentation (design section 9, Phase 0).

Offline, read-only tooling with two jobs:

1. `assert-layout <model_dir>` — render a synthetic conversation through the model's REAL
   `chat_template.jinja` and assert the physical layer order the Context OS design depends on:
       [tool schemas] -> [system content] -> [messages]
   (cache-key hierarchy: hash(toolset) -> hash(system) -> history). Exit 0 = order holds,
   exit 2 = template renders no tools block (tools unsupported), exit 1 = order violated.

2. `analyze <dump.json>` — split a captured request body (written by the adapter under
   `FABULA_DUMP_LAST_REQUEST`) into named layers with per-layer token estimates, and break
   tool schemas down per source (builtin/plugin vs each MCP server prefix).

Pure functions only in this module (unit-tested in test_context_audit.py); the CLI at the
bottom is a thin shell. Token counts are the same chars/4 estimate the adapter itself uses
for window fitting — an ESTIMATE, consistent across layers, good for relative budgets.
"""
import json
import os
import sys

# Layer sentinels = distinctive first bytes of each known FABULA system layer, gathered from
# the live engine source (2026-07-11). If an engine layer is reworded, update the marker here
# AND in the design doc §1 inventory — a missing marker silently merges that layer into the
# preceding span, which the tests guard against for the known set.
DEFAULT_LAYER_MARKERS = [
    ("env-header", "You are the FABULA agent"),  # system.ts environment() opener (Phase 2 renames to FABULA)
    ("prompt-default", "You are MiMoCode, an interactive CLI tool"),  # session/prompt/default.txt sentinel
    ("memory-instructions", "# Memory system"),  # llm.ts buildMemoryInstructions()
    ("system-prompt-md", "# LLM Fabula 5 — System Prompt"),  # the monolith (instructions[0])
    ("skills-l1", "Use the skill tool to load a skill when a task matches its description."),  # system.ts skills()
    ("posture", "[FABULA PROJECT CONTEXT]"),  # plugin/lib/projectcontext.ts formatProjectContext()
    ("operating-memory", "<operating-memory>"),  # plugin/fabula-context.ts memoryBlock()
]

# MCP tool keys are `sanitize(server)_sanitize(tool)` (engine mcp/index.ts). The default set
# mirrors the servers configured in this repo's fabula.config.json; override per run with
# --mcp-prefixes or FABULA_MCP_PREFIXES (comma-separated).
DEFAULT_MCP_PREFIXES = ["serena", "searxng", "ast_grep", "time"]

TOOLS_NEEDLE = "<tools>"  # Qwen-family template opens the schema block with this tag


def est_tokens(s):
    """chars/4 token estimate (ceil) — same convention as the adapter's window fitting."""
    return (len(s) + 3) // 4


def find_layers(text, markers=None):
    """Locate each known marker in `text`. Returns [(name, start)] sorted by position;
    markers not present are omitted. First occurrence wins (layers are prefixes-once)."""
    out = []
    for name, needle in (markers or DEFAULT_LAYER_MARKERS):
        i = text.find(needle)
        if i >= 0:
            out.append((name, i))
    out.sort(key=lambda t: t[1])
    return out


def split_layers(text, markers=None):
    """Split `text` into contiguous spans by marker positions. Text before the first marker
    is reported as layer "preamble" (dropped when empty). Each span: name/start/chars/tokens."""
    found = find_layers(text, markers)
    spans = []
    if not found:
        if text:
            spans.append({"name": "preamble", "start": 0, "chars": len(text), "tokens": est_tokens(text)})
        return spans
    if found[0][1] > 0:
        head = text[: found[0][1]]
        spans.append({"name": "preamble", "start": 0, "chars": len(head), "tokens": est_tokens(head)})
    for idx, (name, start) in enumerate(found):
        end = found[idx + 1][1] if idx + 1 < len(found) else len(text)
        seg = text[start:end]
        spans.append({"name": name, "start": start, "chars": len(seg), "tokens": est_tokens(seg)})
    return spans


def render_template(template_str, messages, tools):
    """Render a HF-style chat template with the same conveniences transformers provides
    (raise_exception, strftime_now, tojson filter is jinja2-builtin)."""
    import jinja2

    def raise_exception(msg):
        raise ValueError(msg)

    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, extensions=["jinja2.ext.loopcontrols"])
    env.globals["raise_exception"] = raise_exception
    env.globals["strftime_now"] = lambda fmt: "1970-01-01"
    tpl = env.from_string(template_str)
    return tpl.render(messages=messages, tools=tools, add_generation_prompt=True)


# Sentinels for the synthetic layout probe. Chosen to never collide with template text.
PROBE_TOOL = {
    "type": "function",
    "function": {
        "name": "fabula_probe_tool",
        "description": "FABULA-LAYOUT-PROBE-TOOL-SENTINEL",
        "parameters": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
    },
}
SYSTEM_SENTINEL = "FABULA-LAYOUT-PROBE-SYSTEM-SENTINEL"
USER_SENTINEL = "FABULA-LAYOUT-PROBE-USER-SENTINEL"


def assert_layout(rendered):
    """Judge the physical order of the three segments in a rendered probe conversation.
    Returns {order, positions, tools_supported, ok}: ok means tools -> system -> user
    (the Context OS §3 invariant); when the template ignores tools entirely,
    tools_supported=False and ok reflects system -> user only."""
    p_tool = rendered.find("FABULA-LAYOUT-PROBE-TOOL-SENTINEL")
    p_sys = rendered.find(SYSTEM_SENTINEL)
    p_user = rendered.find(USER_SENTINEL)
    positions = {"tools": p_tool, "system": p_sys, "user": p_user}
    tools_supported = p_tool >= 0
    present = [(n, p) for n, p in positions.items() if p >= 0]
    present.sort(key=lambda t: t[1])
    order = [n for n, _ in present]
    if tools_supported:
        ok = order == ["tools", "system", "user"]
    else:
        ok = p_sys >= 0 and p_user >= 0 and p_sys < p_user
    return {"order": order, "positions": positions, "tools_supported": tools_supported, "ok": ok}


def probe_layout(template_str):
    """Render the synthetic probe through a template and assert the layout."""
    messages = [
        {"role": "system", "content": SYSTEM_SENTINEL + " kernel goes here."},
        {"role": "user", "content": USER_SENTINEL + " task goes here."},
    ]
    return assert_layout(render_template(template_str, messages, [PROBE_TOOL]))


def tool_source(name, mcp_prefixes=None):
    """Classify a tool key into its source bucket: 'mcp:<server>' or 'builtin/plugin'.
    Accepts both the engine-internal colon form (`server:tool`) and the sanitized
    underscore form some providers put on the wire (`server_tool`)."""
    for p in mcp_prefixes if mcp_prefixes is not None else DEFAULT_MCP_PREFIXES:
        if p and (name.startswith(p + "_") or name.startswith(p + ":")):
            return "mcp:" + p
    return "builtin/plugin"


def breakdown_tools(tools, mcp_prefixes=None):
    """Per-source schema weight for an OpenAI-compat `tools` array.
    Returns {source: {count, tokens}} plus a grand 'total'."""
    out = {}
    total = {"count": 0, "tokens": 0}
    for t in tools or []:
        name = (((t or {}).get("function") or {}).get("name")) or (t or {}).get("name") or "?"
        src = tool_source(str(name), mcp_prefixes)
        w = est_tokens(json.dumps(t, ensure_ascii=False))
        b = out.setdefault(src, {"count": 0, "tokens": 0})
        b["count"] += 1
        b["tokens"] += w
        total["count"] += 1
        total["tokens"] += w
    out["total"] = total
    return out


def analyze_request(body, markers=None, mcp_prefixes=None):
    """Full per-layer report for a captured request body (dict with messages+tools).
    system = concatenation of all system-role message contents (the engine may keep a
    2-part system for cache); history = every non-system message."""
    msgs = body.get("messages") or []
    system_text = "\n\n".join(
        m.get("content") for m in msgs if m.get("role") == "system" and isinstance(m.get("content"), str)
    )
    history = [m for m in msgs if m.get("role") != "system"]
    hist_chars = sum(len(json.dumps(m, ensure_ascii=False)) for m in history)
    layers = split_layers(system_text, markers)
    tools_bd = breakdown_tools(body.get("tools"), mcp_prefixes)
    return {
        "model": body.get("model"),
        "system": {"chars": len(system_text), "tokens": est_tokens(system_text), "layers": layers},
        "tools": tools_bd,
        "history": {"messages": len(history), "chars": hist_chars, "tokens": est_tokens("x" * hist_chars) if hist_chars else 0},
        "prefix_tokens_estimate": tools_bd["total"]["tokens"] + est_tokens(system_text),
    }


def _mcp_prefixes_from_env():
    raw = os.environ.get("FABULA_MCP_PREFIXES", "")
    return [p.strip() for p in raw.split(",") if p.strip()] or DEFAULT_MCP_PREFIXES


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        sys.stderr.write(__doc__ + "\nusage: context_audit.py assert-layout <model_dir_or_jinja> | analyze <dump.json>\n")
        return 1
    cmd = argv[1]
    if cmd == "assert-layout":
        path = argv[2]
        if os.path.isdir(path):
            path = os.path.join(path, "chat_template.jinja")
        with open(path, "r") as f:
            res = probe_layout(f.read())
        print(json.dumps(res, indent=2))
        if not res["tools_supported"]:
            return 2
        return 0 if res["ok"] else 1
    if cmd == "analyze":
        with open(argv[2], "r") as f:
            body = json.load(f)
        print(json.dumps(analyze_request(body, mcp_prefixes=_mcp_prefixes_from_env()), indent=2, ensure_ascii=False))
        return 0
    sys.stderr.write("unknown command: %s\n" % cmd)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
