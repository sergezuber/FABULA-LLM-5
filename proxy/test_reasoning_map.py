#!/usr/bin/env python3
"""Unit tests for the declarative reasoning-level -> body-patch table in lmstudio-adapter.py.
Pure functions, no network. Run: python3 proxy/test_reasoning_map.py  (exit 0 = all pass)."""
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# The adapter filename has a hyphen -> load it via importlib.
_spec = importlib.util.spec_from_file_location("adapter", os.path.join(HERE, "lmstudio-adapter.py"))
adapter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(adapter)

MAP = {
    "*": {
        "enabled": {"openai-compatible": {"set": [{"path": ["extra_body", "thinking", "type"], "value": "enabled"}]}},
        "off": {"openai-compatible": {"set": [{"path": ["extra_body", "thinking", "type"], "value": "disabled"}]}},
        "strip": {"openai-compatible": {"unset": [{"path": ["extra_body", "thinking"]}]}},
    },
    "qwen3.5": {
        "high": {"openai-compatible": {"set": [
            {"path": ["extra_body", "thinking", "type"], "value": "enabled"},
            {"path": ["extra_body", "thinking", "budget_tokens"], "value": 8192},
        ]}},
    },
}

_fails = []


def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        _fails.append(name)


# (a) set adds a nested value at the right nesting
b = {"model": "kimi", "messages": []}
adapter.apply_reasoning(b, MAP, "enabled")
check("a: set creates extra_body.thinking.type=enabled",
      b.get("extra_body", {}).get("thinking", {}).get("type") == "enabled")

# (b) off sets disabled; strip removes the whole thinking object
b = {"model": "kimi", "extra_body": {"thinking": {"type": "enabled"}}}
adapter.apply_reasoning(b, MAP, "off")
check("b1: off flips to disabled", b["extra_body"]["thinking"]["type"] == "disabled")
b = {"model": "kimi", "extra_body": {"thinking": {"type": "enabled"}, "keep": 1}}
adapter.apply_reasoning(b, MAP, "strip")
check("b2: strip removes thinking, keeps siblings",
      "thinking" not in b["extra_body"] and b["extra_body"].get("keep") == 1)

# (c) unknown model falls through to '*'
b = {"model": "totally-unknown-model"}
adapter.apply_reasoning(b, MAP, "enabled")
check("c: unknown model uses '*' default", b.get("extra_body", {}).get("thinking", {}).get("type") == "enabled")

# (c2) a model-specific entry wins over '*' and can set multiple paths
b = {"model": "qwen3.5"}
adapter.apply_reasoning(b, MAP, "high")
check("c2: model-specific multi-set",
      b["extra_body"]["thinking"]["type"] == "enabled" and b["extra_body"]["thinking"]["budget_tokens"] == 8192)

# (d) missing level = body unchanged byte-for-byte
b = {"model": "kimi", "messages": [{"role": "user", "content": "hi"}]}
before = json.dumps(b, sort_keys=True)
adapter.apply_reasoning(b, MAP, None)
check("d: no level = unchanged", json.dumps(b, sort_keys=True) == before)

# (d2) level with no matching entry (unknown level) = unchanged
b = {"model": "kimi"}
before = json.dumps(b, sort_keys=True)
adapter.apply_reasoning(b, MAP, "no-such-level")
check("d2: unknown level = unchanged", json.dumps(b, sort_keys=True) == before)

# (e) the private marker is always stripped, even when applying a patch
b = {"model": "kimi", "extra_body": {"fabula_reasoning": "enabled"}}
adapter.apply_reasoning(b, MAP, "enabled")
check("e: fabula_reasoning marker stripped", "fabula_reasoning" not in b["extra_body"])

# (f) resolve_level precedence: header > body extra_body > env
os.environ.pop("FABULA_REASONING_LEVEL", None)
check("f1: header wins", adapter.resolve_level({"X-Fabula-Reasoning": "high"},
      {"extra_body": {"fabula_reasoning": "off"}}) == "high")
check("f2: body used when no header",
      adapter.resolve_level({}, {"extra_body": {"fabula_reasoning": "off"}}) == "off")
os.environ["FABULA_REASONING_LEVEL"] = "enabled"
check("f3: env default when neither", adapter.resolve_level({}, {"model": "x"}) == "enabled")
os.environ.pop("FABULA_REASONING_LEVEL", None)
check("f4: none when nothing set", adapter.resolve_level({}, {"model": "x"}) is None)

# (g) malformed map file -> load_reasoning_map returns {} (adapter still forwards, never crashes)
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
    tf.write("{ this is not valid json ]")
    bad = tf.name
check("g: malformed map -> {}", adapter.load_reasoning_map(bad) == {})
os.unlink(bad)

# (h) the shipped reasoning-map.json is valid JSON and loads
shipped = adapter.load_reasoning_map(os.path.join(HERE, "reasoning-map.json"))
check("h: shipped reasoning-map.json loads with '*'", isinstance(shipped, dict) and "*" in shipped)

print()
if _fails:
    print(f"{len(_fails)} FAILED: {_fails}")
    sys.exit(1)
print("all reasoning-map tests passed")
