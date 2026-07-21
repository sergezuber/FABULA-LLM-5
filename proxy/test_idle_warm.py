"""Cold and warm turns must not share an idle-budget bucket.

Measured on the live adapter: 48 of 96 terminated streams fired at exactly the 30.0s floor. A bucket
keyed only by (model, prompt size) filled with fast WARM gaps — the prefix was reused, so tokens
streamed from cache — and `observed_max * margin` fell under the floor. The first COLD turn of the same
size, which waits behind a full re-prefill, was then cut by that floor although nothing was wrong with
it. Buckets already separate prompt SIZE for this exact reason; cache state is the same kind of split.
"""
from adapter_util import IdleBaseline


def test_warm_evidence_does_not_bound_a_cold_turn():
    b = IdleBaseline(flat=120.0, min_samples=5, floor=30.0, margin=4.0)
    for _ in range(10):
        b.observe("m", 200_000, 0.5, True)          # warm turns: half-second gaps
    warm = b.budget("m", 200_000, True)
    cold = b.budget("m", 200_000, False)
    assert warm == 30.0, warm                        # floor, as before — warm evidence is tight
    assert cold == 120.0, cold                       # cold has NO evidence yet → honest flat constant
    assert cold > warm


def test_cold_turns_build_their_own_evidence():
    b = IdleBaseline(flat=120.0, min_samples=5, floor=30.0, margin=4.0, ceiling=600.0)
    for _ in range(10):
        b.observe("m", 200_000, 45.0, False)         # cold turns really do gap for ~45s
    assert b.budget("m", 200_000, False) == 180.0    # 45 * 4, its own bucket
    assert b.budget("m", 200_000, True) == 120.0     # warm side untouched by cold evidence


def test_the_two_never_contaminate_each_other():
    b = IdleBaseline(flat=120.0, min_samples=5, floor=30.0, margin=4.0)
    for _ in range(10):
        b.observe("m", 200_000, 0.5, True)
        b.observe("m", 200_000, 40.0, False)
    assert b.budget("m", 200_000, True) == 30.0      # warm stays tight: a spiral is still cut fast
    assert b.budget("m", 200_000, False) == 160.0    # cold gets room it demonstrably needs


def test_default_is_backward_compatible():
    # Callers that never pass warmth keep exactly the previous behaviour.
    b = IdleBaseline(flat=120.0, min_samples=5, floor=30.0, margin=4.0)
    for _ in range(10):
        b.observe("m", 1000, 2.0)
    assert b.budget("m", 1000) == b.budget("m", 1000, True)


def test_evidence_still_wins_over_the_clamps():
    # The pre-existing invariant: never tighter than what was actually observed.
    b = IdleBaseline(flat=120.0, min_samples=5, floor=30.0, margin=4.0, ceiling=50.0)
    for _ in range(10):
        b.observe("m", 200_000, 90.0, False)
    assert b.budget("m", 200_000, False) == 90.0
