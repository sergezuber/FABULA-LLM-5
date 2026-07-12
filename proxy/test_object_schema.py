#!/usr/bin/env python3
"""Unit tests for the json_object -> json_schema rewrite selector in lmstudio-adapter.py.

LM Studio rejects the bare `json_object` response_format (HTTP 400), so the adapter rewrites it to a
`json_schema`. The bug this guards against: rewriting EVERY caller to the strict verdict grammar
({ok,impossible,reason}) silently broke subagent-creation (agent.ts) and voice (voice.ts) for all
local models, because the AI SDK sends bare `json_object` for every generateObject (the caller's real
Zod schema lives in the PROMPT, not response_format). Fix: default to a permissive object grammar; the
goal judge alone opts into the verdict grammar via the `X-Fabula-Schema: verdict` header.

Pure function, no network. Run: python3 proxy/test_object_schema.py  (exit 0 = all pass)."""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("adapter", os.path.join(HERE, "lmstudio-adapter.py"))
adapter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(adapter)

_fails = []


def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        _fails.append(name)


def schema_name(s):
    return s.get("json_schema", {}).get("name")


# (a) no header -> permissive generic object grammar (the default every non-goal caller gets)
check("a: no header -> generic object schema", schema_name(adapter.pick_object_schema(None)) == "object")

# (b) the generic grammar is genuinely permissive: any-shape object, additionalProperties allowed,
#     NOT locked to the verdict keys (that was the regression)
gen = adapter.pick_object_schema(None)["json_schema"]["schema"]
check("b1: generic is a plain object type", gen.get("type") == "object")
check("b2: generic allows additional properties", gen.get("additionalProperties") is True)
check("b3: generic does NOT force verdict keys", "required" not in gen and "properties" not in gen)

# (c) the goal-judge opt-in header -> the strict verdict grammar
verdict = adapter.pick_object_schema("verdict")
check("c1: header 'verdict' -> verdict schema", schema_name(verdict) == "verdict")
check("c2: verdict schema requires ok+reason",
      set(verdict["json_schema"]["schema"].get("required", [])) == {"ok", "reason"})

# (d) header match is case/space tolerant
check("d1: 'Verdict' (case) -> verdict", schema_name(adapter.pick_object_schema("Verdict")) == "verdict")
check("d2: '  verdict ' (spaces) -> verdict", schema_name(adapter.pick_object_schema("  verdict ")) == "verdict")

# (e) any OTHER header value falls back to the permissive default (never leaks the verdict shape)
check("e1: unknown header -> generic", schema_name(adapter.pick_object_schema("banana")) == "object")
check("e2: empty header -> generic", schema_name(adapter.pick_object_schema("")) == "object")
check("e3: non-string -> generic", schema_name(adapter.pick_object_schema(123)) == "object")

# (f) the two schemas are distinct objects (a caller can't be accidentally handed the wrong one)
check("f: generic and verdict are different grammars",
      adapter.GENERIC_OBJECT_SCHEMA is not adapter.VERDICT_SCHEMA
      and schema_name(adapter.GENERIC_OBJECT_SCHEMA) != schema_name(adapter.VERDICT_SCHEMA))

print()
if _fails:
    print(f"{len(_fails)} FAILED: {_fails}")
    sys.exit(1)
print("all object-schema tests passed")
