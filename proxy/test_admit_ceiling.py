# Durable guards for the per-caller admission ceiling.
#
# One ceiling for every caller was wrong, and measurably so. A STREAMING caller receives
# `: fabula-adapter queued Ns` keepalives while it waits, so a long wait is visible and survivable. A
# SILENT caller (the goal judge, embeddings, /v1/models) has no such channel: every second it waits is a
# second it cannot distinguish from a hang. With a single 60s ceiling and ~30s generations, 3 of 5
# parallel workflow-graph steps failed open and hit the model together — the gate degrading precisely
# under the load it exists for.
#
# The property that matters most is the DIRECTION: the split may only ever raise the ceiling for a caller
# that can survive a longer wait. The silent caller's ceiling must never rise above where it already was,
# because raising it is how a judge call becomes indistinguishable from a hung one.
#
# Run: python3 -m pytest test_admit_ceiling.py -q -p no:docker
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _adapter():
    spec = importlib.util.spec_from_file_location("adapter_ceiling_under_test", HERE / "lmstudio-adapter.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["adapter_ceiling_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


A = _adapter()


def test_streaming_caller_waits_longer_than_a_silent_one():
    assert A.admit_wait_max(is_stream=True, env={}) > A.admit_wait_max(is_stream=False, env={})


def test_silent_ceiling_is_unchanged_by_the_split():
    # 60s is where it was before the ceiling split, and a silent caller has no way to tell waiting from a
    # hang, so this number may not drift upward by accident.
    assert A.admit_wait_max(is_stream=False, env={}) == 60.0


def test_each_ceiling_is_configurable():
    env = {"FABULA_ADMIT_WAIT_MAX": "5", "FABULA_ADMIT_WAIT_MAX_STREAM": "50"}
    assert A.admit_wait_max(is_stream=False, env=env) == 5.0
    assert A.admit_wait_max(is_stream=True, env=env) == 50.0


def test_a_streaming_caller_never_waits_less_than_a_silent_one():
    # A configuration that inverted the two would make the keepalive channel a liability: the caller that
    # can see it is waiting would give up first.
    env = {"FABULA_ADMIT_WAIT_MAX": "300", "FABULA_ADMIT_WAIT_MAX_STREAM": "10"}
    assert A.admit_wait_max(is_stream=True, env=env) >= A.admit_wait_max(is_stream=False, env=env)


def test_garbage_falls_back_instead_of_disabling_or_wedging_the_gate():
    # A ceiling of 0, NaN or infinity is not a configuration, it is a broken one. Zero would fail open on
    # every request (no gate at all); infinity would block forever, which is worse than no gate because it
    # would wedge the live app.
    for bad in ("", "abc", "0", "-5", "nan", "inf", None):
        env = {"FABULA_ADMIT_WAIT_MAX": bad, "FABULA_ADMIT_WAIT_MAX_STREAM": bad}
        silent = A.admit_wait_max(is_stream=False, env=env)
        stream = A.admit_wait_max(is_stream=True, env=env)
        assert silent == 60.0, bad
        assert stream == 300.0, bad


def test_the_module_level_ceilings_agree_with_the_function():
    # The request path reads the function; the gate is constructed from the module constants. If the two
    # disagreed, the documented knob would govern one and not the other.
    assert A.ADMIT_WAIT_MAX == A.admit_wait_max(is_stream=False)
    assert A.ADMIT_WAIT_MAX_STREAM == A.admit_wait_max(is_stream=True)
