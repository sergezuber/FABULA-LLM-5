"""Tests for context_audit.py — Phase 0 instrumentation (Context OS section 9, Phase 0).

360°: real on-disk model templates (the layout assertion the whole design §3 rests on),
layer splitting corner cases, per-source tool breakdown, request analysis, dump atomicity,
CLI exit codes. Hermetic where possible; the real-template tests skip cleanly on machines
without LM Studio models.
"""
# Text is read as UTF-8 EXPLICITLY, never in the locale's encoding. Python picks the platform default
# otherwise, which on one of the systems here is a single-byte code page: reading this project's own
# UTF-8 sources threw a decode error partway through a file, and the check failed for the file being
# unreadable rather than for what it says.
import glob
import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from context_audit import (
    DEFAULT_LAYER_MARKERS,
    PROBE_TOOL,
    SYSTEM_SENTINEL,
    USER_SENTINEL,
    analyze_request,
    assert_layout,
    breakdown_tools,
    est_tokens,
    find_layers,
    probe_layout,
    render_template,
    split_layers,
    tool_source,
)
from adapter_util import dump_last_request

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_GLOB = os.path.expanduser("~/.lmstudio/models/*/*/chat_template.jinja")


def _production_template():
    """The template of the model actually configured, RESOLVED rather than written down.

    This was a hardcoded path, and the model it named had been replaced — so the invariant this file
    itself calls design-critical was skipped in silence on the owner's own machine, for as long as that
    model had been gone. A fact about a moving thing, recorded once, stops being a fact, and nothing
    says when it stopped.

    Asked of the same file the engine reads. The directory carries a publisher and a quantisation suffix
    that the model id does not, so the match is on the stem, case-folded — the same tolerance the digest
    resolver already needs, for the same reason. Returns (path, reason-it-is-absent).
    """
    cfg = os.environ.get("MIMOCODE_CONFIG") or os.path.join(os.path.dirname(HERE), "fabula.config.json")
    if not os.path.exists(cfg):
        return None, f"no engine config at {cfg} — cannot tell which model is the production one"
    try:
        with open(cfg, encoding="utf-8") as f:
            model = (json.load(f) or {}).get("model") or ""
    except Exception as e:  # a malformed config is a reason to report, not a crash
        return None, f"engine config unreadable ({e})"
    if not model:
        return None, "the engine config names no default model"
    stem = model.split("/")[-1].lower()
    for path in sorted(glob.glob(MODELS_GLOB)):
        name = os.path.basename(os.path.dirname(path)).lower()
        if name == stem or name.startswith(stem):
            return path, None
    return None, f"the configured model {model!r} is not installed here"


PROD_TEMPLATE, PROD_ABSENT = _production_template()

# Minimal hermetic Qwen-style template: tools block FIRST inside the system turn, then the
# system content, then messages — the exact physical layout the design's §3 documents.
QWEN_STYLE_MIN = """{%- if tools %}
{{- '<|im_start|>system\\n' }}
{{- '# Tools\\n<tools>' }}
{%- for tool in tools %}
{{- '\\n' + (tool | tojson) }}
{%- endfor %}
{{- '\\n</tools>' }}
{%- if messages[0].role == 'system' %}
{{- '\\n\\n' + messages[0].content }}
{%- endif %}
{{- '<|im_end|>\\n' }}
{%- else %}
{%- if messages[0].role == 'system' %}
{{- '<|im_start|>system\\n' + messages[0].content + '<|im_end|>\\n' }}
{%- endif %}
{%- endif %}
{%- for m in messages %}
{%- if m.role != 'system' %}
{{- '<|im_start|>' + m.role + '\\n' + m.content + '<|im_end|>\\n' }}
{%- endif %}
{%- endfor %}"""

# A template that IGNORES tools entirely (gemma-style) — probe must degrade gracefully.
NO_TOOLS_TEMPLATE = """{%- for m in messages %}
{{- '<' + m.role + '>' + m.content + '</' + m.role + '>' }}
{%- endfor %}"""


# ---- est_tokens ----

def test_est_tokens_edges():
    assert est_tokens("") == 0
    assert est_tokens("a") == 1
    assert est_tokens("abcd") == 1
    assert est_tokens("abcde") == 2


# ---- layer finding / splitting ----

def _mk_system(*layer_texts):
    return "\n\n".join(layer_texts)


def test_find_layers_orders_by_position_not_list_order():
    # posture BEFORE env-header in the text — find_layers must sort by position
    text = "[FABULA PROJECT CONTEXT]\ngit stuff\n\nYou are the FABULA agent, etc."
    found = find_layers(text)
    assert [n for n, _ in found] == ["posture", "env-header"]


def test_split_layers_full_known_set():
    text = _mk_system(
        "You are the FABULA agent blah <env>...</env>",
        "You are MiMoCode, an interactive CLI tool that helps.",
        "# Memory system\nfour file types...",
        "# LLM Fabula 5 — System Prompt\nthe monolith body",
        "Use the skill tool to load a skill when a task matches its description.\n<skills/>",
        "[FABULA PROJECT CONTEXT]\nWorking directory: /x",
        "<operating-memory>\nrules\n</operating-memory>",
    )
    spans = split_layers(text)
    names = [s["name"] for s in spans]
    assert names == [
        "env-header", "prompt-default", "memory-instructions", "system-prompt-md",
        "skills-l1", "posture", "operating-memory",
    ]
    # spans must tile the text exactly: sum of chars == len(text), no overlap, no gap
    assert sum(s["chars"] for s in spans) == len(text)
    for s in spans:
        assert s["tokens"] == est_tokens(text[s["start"]: s["start"] + s["chars"]])


def test_split_layers_subset_and_preamble():
    text = "custom preamble here\n\n# Memory system\nstuff\n\n[FABULA PROJECT CONTEXT]\ncwd"
    spans = split_layers(text)
    assert [s["name"] for s in spans] == ["preamble", "memory-instructions", "posture"]
    assert sum(s["chars"] for s in spans) == len(text)


def test_split_layers_no_markers_is_single_preamble():
    spans = split_layers("nothing known in here")
    assert [s["name"] for s in spans] == ["preamble"]


def test_split_layers_empty_text():
    assert split_layers("") == []


def test_split_layers_marker_at_zero_has_no_preamble():
    spans = split_layers("# Memory system\nbody")
    assert spans[0]["name"] == "memory-instructions"
    assert spans[0]["start"] == 0


# ---- rendering + layout assertion (hermetic templates) ----

def test_probe_layout_qwen_style_tools_first():
    res = probe_layout(QWEN_STYLE_MIN)
    assert res["tools_supported"] is True
    assert res["order"] == ["tools", "system", "user"]
    assert res["ok"] is True


def test_probe_layout_no_tools_template_degrades():
    res = probe_layout(NO_TOOLS_TEMPLATE)
    assert res["tools_supported"] is False
    assert res["ok"] is True  # system before user still holds


def test_assert_layout_violation_detected():
    # synthetic render where system precedes tools — MUST be flagged not-ok
    rendered = SYSTEM_SENTINEL + " ... FABULA-LAYOUT-PROBE-TOOL-SENTINEL ... " + USER_SENTINEL
    res = assert_layout(rendered)
    assert res["tools_supported"] is True
    assert res["ok"] is False
    assert res["order"] == ["system", "tools", "user"]


def test_render_template_provides_hf_conveniences():
    # raise_exception must be callable from templates (transformers-compat)
    tpl = "{% if not messages %}{{ raise_exception('no') }}{% endif %}ok"
    assert render_template(tpl, [{"role": "user", "content": "x"}], None) == "ok"
    with pytest.raises(ValueError):
        render_template(tpl, [], None)


# ---- THE design-critical test: real on-disk production templates ----

@pytest.mark.parametrize("path", sorted(glob.glob(MODELS_GLOB)) or [pytest.param(None, marks=pytest.mark.skip(reason="no LM Studio models on this machine"))])
def test_real_templates_layout(path):
    """Every real template on this machine PARSES, and its layout is REPORTED.

    What the layout IS, for a model this project neither writes nor ships, is that vendor's decision
    and not a defect here. The invariant FABULA depends on is asserted separately, against the model
    actually in the socket — see test_production_model_is_tools_first below. What IS ours, and what is
    asserted here, is that the audit can READ every real template and answer with a well-formed order.

    MEASURED, and it is why this changed: with the `{% generation %}` extension unimplemented the audit
    could not compile one template at all, and this check reported it as a layout violation — a
    statement about our parser wearing the clothes of a statement about the model. Once it could be
    read, the honest answer was ["system", "tools", "user"]: that model is NOT tools-first. Three of
    the four models on this disk are; one is not. That is a fact worth printing — the cache-key
    hierarchy the design assumes (tool-set outermost) is inverted on such a model — and not a failure
    to raise against a vendor who never agreed to it.
    """
    if path is None:
        return
    with open(path, encoding="utf-8") as f:
        res = probe_layout(f.read())
    print(f"  {os.path.basename(os.path.dirname(path))}: {res['order']} tools={res['tools_supported']}")
    # OURS: the template was readable and the probe answered about it.
    assert isinstance(res.get("order"), list) and res["order"], f"{path}: the audit could not read this template"
    assert "user" in res["order"], f"{path}: no user block found — the probe did not understand this template"
    # And the one ordering rule that holds regardless of tools: a system block precedes the user turn.
    if "system" in res["order"]:
        assert res["order"].index("system") < res["order"].index("user"), f"{path}: system after user"


def test_the_sweep_says_what_it_examined():
    """A sweep over nothing must SAY so, because it reads exactly like a sweep that found no fault.

    The parametrize above enumerates the models on this disk. On a machine with none — every continuous
    check runs on one — it collapses to a single skipped case among two dozen passes, and the row goes
    green having verified nothing about the one invariant this file calls design-critical. That is the
    same defect as a guard that quietly disappears: absence and success look identical in the count.

    This does not fail: a machine legitimately may have no models. It states the coverage plainly, so a
    reader of the log is told what was and was not examined rather than left to infer it from a number.
    """
    found = sorted(glob.glob(MODELS_GLOB))
    print(f"  templates examined on this machine: {len(found)}")
    for f in found:
        print(f"    {os.path.basename(os.path.dirname(f))}")
    if not found:
        print("  NOTHING WAS EXAMINED — the layout invariant was not checked on this machine.")
    if PROD_TEMPLATE is None:
        print(f"  the production invariant was NOT checked: {PROD_ABSENT}")
    else:
        print(f"  production model resolved to {os.path.basename(os.path.dirname(PROD_TEMPLATE))}")


@pytest.mark.skipif(PROD_TEMPLATE is None, reason=PROD_ABSENT or "production model not resolvable")
def test_production_model_is_tools_first():
    """The exact invariant the design doc §3 documents for the ACTIVE production model."""
    with open(PROD_TEMPLATE, encoding="utf-8") as f:
        res = probe_layout(f.read())
    assert res["tools_supported"] is True
    assert res["order"] == ["tools", "system", "user"]


# ---- tool source classification + breakdown ----

def test_tool_source_buckets():
    assert tool_source("serena_find_symbol") == "mcp:serena"
    assert tool_source("searxng_web_search") == "mcp:searxng"
    assert tool_source("ast_grep_find_code") == "mcp:ast_grep"
    assert tool_source("bash_tool") == "builtin/plugin"
    assert tool_source("serena") == "builtin/plugin"  # bare prefix without _tool is NOT mcp
    assert tool_source("verify_done", mcp_prefixes=[]) == "builtin/plugin"


def test_tool_source_engine_colon_form():
    # engine-internal keys are `server:tool` (mcp/index.ts sanitize + ':' join)
    assert tool_source("serena:find_symbol") == "mcp:serena"
    assert tool_source("time:now") == "mcp:time"
    assert tool_source("timer:now") == "builtin/plugin"  # prefix must match exactly before separator


def test_breakdown_tools_counts_and_tokens():
    tools = [
        {"type": "function", "function": {"name": "bash_tool", "description": "run", "parameters": {}}},
        {"type": "function", "function": {"name": "serena_find_symbol", "description": "x" * 400, "parameters": {}}},
        {"type": "function", "function": {"name": "serena_read_file", "description": "y" * 400, "parameters": {}}},
    ]
    bd = breakdown_tools(tools)
    assert bd["builtin/plugin"]["count"] == 1
    assert bd["mcp:serena"]["count"] == 2
    assert bd["total"]["count"] == 3
    # the fat MCP schemas must dominate the token weight
    assert bd["mcp:serena"]["tokens"] > bd["builtin/plugin"]["tokens"]
    assert bd["total"]["tokens"] == bd["mcp:serena"]["tokens"] + bd["builtin/plugin"]["tokens"]


def test_breakdown_tools_empty_and_malformed():
    assert breakdown_tools(None)["total"] == {"count": 0, "tokens": 0}
    bd = breakdown_tools([{}, {"function": {}}])
    assert bd["total"]["count"] == 2  # malformed still counted (as builtin/plugin '?')


# ---- analyze_request ----

def test_analyze_request_full_report():
    body = {
        "model": "m",
        "messages": [
            {"role": "system", "content": "# Memory system\nmem...\n\n[FABULA PROJECT CONTEXT]\ncwd"},
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ],
        "tools": [{"type": "function", "function": {"name": "bash_tool", "parameters": {}}}],
    }
    rep = analyze_request(body)
    assert [l["name"] for l in rep["system"]["layers"]] == ["memory-instructions", "posture"]
    assert rep["history"]["messages"] == 2
    assert rep["tools"]["total"]["count"] == 1
    assert rep["prefix_tokens_estimate"] == rep["tools"]["total"]["tokens"] + rep["system"]["tokens"]


def test_analyze_request_two_part_system_is_joined():
    # the engine keeps a 2-part system for caching — both parts must be analyzed as one
    body = {
        "messages": [
            {"role": "system", "content": "You are the FABULA agent ..."},
            {"role": "system", "content": "# LLM Fabula 5 — System Prompt\n..."},
            {"role": "user", "content": "task"},
        ],
    }
    rep = analyze_request(body)
    names = [l["name"] for l in rep["system"]["layers"]]
    assert "env-header" in names and "system-prompt-md" in names
    assert rep["history"]["messages"] == 1


def test_analyze_request_no_system_no_tools():
    rep = analyze_request({"messages": [{"role": "user", "content": "x"}]})
    assert rep["system"]["tokens"] == 0
    assert rep["system"]["layers"] == []
    assert rep["tools"]["total"]["count"] == 0


# ---- dump_last_request (adapter tap) ----

def test_dump_last_request_atomic_write(tmp_path):
    p = str(tmp_path / "last.json")
    assert dump_last_request({"a": 1}, p) is True
    assert json.load(open(p, encoding="utf-8")) == {"a": 1}
    # second write replaces content fully (no append/tear)
    assert dump_last_request({"b": [1, 2]}, p) is True
    assert json.load(open(p, encoding="utf-8")) == {"b": [1, 2]}
    assert not os.path.exists(p + ".tmp")


def test_dump_last_request_never_raises():
    assert dump_last_request({"a": 1}, "") is False
    assert dump_last_request({"a": 1}, "/nonexistent-dir-xyz/f.json") is False
    # unserializable object → False, no raise
    assert dump_last_request({"f": object()}, "/tmp/x.json") in (False,)


# ---- CLI ----

def test_cli_assert_layout_exit_codes(tmp_path):
    good = tmp_path / "good.jinja"
    good.write_text(QWEN_STYLE_MIN)
    r = subprocess.run([sys.executable, os.path.join(HERE, "context_audit.py"), "assert-layout", str(good)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["order"] == ["tools", "system", "user"]

    notools = tmp_path / "nt.jinja"
    notools.write_text(NO_TOOLS_TEMPLATE)
    r2 = subprocess.run([sys.executable, os.path.join(HERE, "context_audit.py"), "assert-layout", str(notools)],
                        capture_output=True, text=True)
    assert r2.returncode == 2  # tools unsupported → distinct exit code


def test_cli_analyze(tmp_path):
    dump = tmp_path / "dump.json"
    dump.write_text(json.dumps({
        "model": "m",
        "messages": [{"role": "system", "content": "# Memory system\nx"}, {"role": "user", "content": "u"}],
        "tools": [{"type": "function", "function": {"name": "serena_find_symbol", "parameters": {}}}],
    }))
    r = subprocess.run([sys.executable, os.path.join(HERE, "context_audit.py"), "analyze", str(dump)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    rep = json.loads(r.stdout)
    assert rep["tools"]["mcp:serena"]["count"] == 1
