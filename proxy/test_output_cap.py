"""A window holds the request and the answer together.

MEASURED 2026-07-28. An input of 133 385 tokens fit comfortably inside a 135 168 window, and the request
still asked for a quarter of that window on top — 33 792 more — so 167 177 was demanded of a 135 168
machine. The serving runtime reserves both at once, so it died allocating, and the reader saw "the model
has crashed". Every part was individually reasonable: the input fit, the share was modest, nobody added
them up.
"""
import os


def _cap_fn(window):
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")).read()
    st = src.index("OUTPUT_SHARE_OF_EMPTY_WINDOW")
    en = src.index("# Phase-0 context audit tap")
    ns = {"os": os, "MAX_OUTPUT_TOKENS": 0, "effective_window": lambda m: window}
    exec(src[st:en], ns)
    return ns["derived_output_cap"]


W = 135168


def test_the_measured_case_now_fits():
    cap = _cap_fn(W)("m", 133385)
    assert 133385 + cap <= W, f"input {133385} + cap {cap} must fit {W}"


def test_a_small_request_still_gets_a_generous_share():
    assert _cap_fn(W)("m", 50000) == max(1024, int(W * 0.25))


def test_an_unknown_input_falls_back_to_the_share_it_always_had():
    assert _cap_fn(W)("m", 0) == max(1024, int(W * 0.25))


def test_the_sum_fits_across_the_whole_range():
    cap = _cap_fn(W)
    for used in range(1000, W, 4000):
        assert used + cap("m", used) <= W, f"{used} + {cap('m', used)} > {W}"


def test_a_margin_is_left_unclaimed_because_the_estimate_is_never_exact():
    # At 90% occupied there is 10% of the window left on paper; the cap must not claim all of it.
    cap = _cap_fn(W)("m", int(W * 0.9))
    assert cap <= W * 0.05, f"cap {cap} leaves no margin for an inexact estimate"


def test_something_is_always_generatable():
    # A turn that cannot emit a single token cannot even report why it failed.
    assert _cap_fn(W)("m", W * 2) >= 256


def test_no_window_means_no_clamp_exactly_as_before():
    assert _cap_fn(0)("m", 99999) == 0


def test_an_explicit_override_still_wins():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")).read()
    st = src.index("OUTPUT_SHARE_OF_EMPTY_WINDOW")
    en = src.index("# Phase-0 context audit tap")
    ns = {"os": os, "MAX_OUTPUT_TOKENS": 4242, "effective_window": lambda m: W}
    exec(src[st:en], ns)
    assert ns["derived_output_cap"]("m", 130000) == 4242


def test_the_adapter_passes_the_input_size_in():
    """The wiring. A ceiling that never learns what the request occupies is the bug, not the fix."""
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")).read()
    i = src.index("_cap = derived_output_cap(")
    call = src[i:i + 120]
    assert "_est_in" in call, "the cap is computed without knowing what the request already occupies"
