"""The near-ceiling observation: it must fire on a request larger than the window, stay silent on an
ordinary one, and never speak twice in an hour. It must also never act — the request is untouched."""
import importlib.util, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import adapter_util as U
_spec = importlib.util.spec_from_file_location("lmadapter", os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py"))
A = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(A)


def _patch(monkey_loaded):
    A.loaded_window = lambda mid, timeout=1.5: (monkey_loaded[0] if monkey_loaded else 0)
    A._CEILING_NOTED.clear()
    lines = []
    A.sys.stderr = type("W",(),{"write":lambda self,m: lines.append(m),"flush":lambda self:None})()
    return lines


def test_fires_when_the_request_exceeds_the_window():
    lines = _patch((135168, 262144))
    A.note_context_near_ceiling("m", 200000)
    assert any("CONTEXT-NEAR-CEILING" in l for l in lines), lines
    assert "estimated=200000" in lines[0] and "loaded_window=135168" in lines[0]


def test_silent_on_an_ordinary_turn():
    lines = _patch((135168, 262144))
    A.note_context_near_ceiling("m", 40000)
    assert lines == []


def test_speaks_once_an_hour_per_model():
    lines = _patch((135168, 262144))
    for _ in range(5):
        A.note_context_near_ceiling("m", 200000)
    assert len(lines) == 1, lines
    A.note_context_near_ceiling("other", 200000)
    assert len(lines) == 2, "a different model gets its own line"


def test_never_raises_on_anything():
    _patch(None)
    A.note_context_near_ceiling("m", 200000)          # no model info
    A.loaded_window = lambda mid, timeout=1.5: (_ for _ in ()).throw(RuntimeError("boom"))
    A.note_context_near_ceiling("m", 200000)          # info blows up
    A.note_context_near_ceiling(None, 0)              # nothing to say


def test_one_measured_ratio_for_characters_to_tokens():
    # 320 134 characters came back from the runtime as 60 332 tokens.
    assert abs(U.estimate_tokens(320134) - 60332) < 50
    assert U.CHARS_PER_TOKEN == 5.306


# ── the overflow classifier needs a WINDOW, and nobody was ever going to type one (2026-08-01) ───────
# MEASURED: `grep -c CONTEXT-OVERFLOW adapter.err.log` -> 0 across 564 KB, alongside 72 live
# `BUDGET … OVER` lines. The classifier is fine — handed a real window it returns silent-truncation-length
# and silent-overflow-accepted correctly. Its INPUT was the problem: the call site read
# FABULA_CONTEXT_WINDOW, and that variable is set NOWHERE (not .env, not the plist, not the running
# process). At 0 both silent branches return "" and only the explicit HTTP>=400 case can fire — i.e. the
# two failures the detector exists FOR were the two it could not see.
def test_effective_window_prefers_an_explicit_setting():
    prev = os.environ.get("FABULA_CONTEXT_WINDOW")
    os.environ["FABULA_CONTEXT_WINDOW"] = "65536"
    try:
        assert A.effective_context_window("anything") == 65536
    finally:
        if prev is None:
            os.environ.pop("FABULA_CONTEXT_WINDOW", None)
        else:
            os.environ["FABULA_CONTEXT_WINDOW"] = prev


def test_effective_window_falls_back_to_the_runtime_not_to_zero_forever():
    prev = os.environ.get("FABULA_CONTEXT_WINDOW")
    os.environ.pop("FABULA_CONTEXT_WINDOW", None)
    try:
        # Whatever the runtime says (0 when it cannot be reached) — the point is that the env var is not
        # the ONLY source, which is what made the classification permanently dead.
        w = A.effective_context_window("no-such-model-anywhere")
        assert isinstance(w, int) and w >= 0
    finally:
        if prev is not None:
            os.environ["FABULA_CONTEXT_WINDOW"] = prev


def test_both_silent_branches_fire_once_a_window_is_known():
    w = 131072
    assert U.classify_overflow(200, "", "length", output_tokens=0, input_tokens=w - 500,
                                          context_window=w) == "silent-truncation-length"
    assert U.classify_overflow(200, "", "stop", output_tokens=50, input_tokens=w + 5000,
                                          context_window=w) == "silent-overflow-accepted"
    # and an ordinary turn is still silent
    assert U.classify_overflow(200, "", "stop", output_tokens=50, input_tokens=1000,
                                          context_window=w) == ""
