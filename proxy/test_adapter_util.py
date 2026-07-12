import sys, os, socket, threading
sys.path.insert(0, os.path.dirname(__file__))
from adapter_util import (
    stable_prefix, shared_prefix_len, classify_overflow, clamp_max_tokens, drain_with_idle_split,
    update_prefix_and_check,
)


def test_stable_prefix_excludes_last_message_includes_tools():
    body = {"tools": [{"a": 1}], "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "u1"}, {"role": "user", "content": "u2"}]}
    p = stable_prefix(body)
    assert '"a": 1' in p or '"a":1' in p
    assert "S" in p and "u1" in p
    assert "u2" not in p  # last message excluded (it legitimately grows)


def test_shared_prefix_len():
    assert shared_prefix_len("abcdef", "abcXYЗ") == 3
    assert shared_prefix_len("same", "same") == 4
    assert shared_prefix_len("", "x") == 0
    # a plugin reordering tools breaks the prefix early
    a = stable_prefix({"tools": [{"n": "view"}, {"n": "edit"}], "messages": [{"m": 1}, {"m": 2}]})
    b = stable_prefix({"tools": [{"n": "edit"}, {"n": "view"}], "messages": [{"m": 1}, {"m": 2}]})
    assert shared_prefix_len(a, b) < min(len(a), len(b))


def test_classify_overflow_explicit():
    assert classify_overflow(400, "Prompt has 5000 tokens but the configured context size is 4096") == "explicit-overflow-error"
    assert classify_overflow(400, "This model's maximum context length is 8192 tokens") == "explicit-overflow-error"
    assert classify_overflow(429, "Rate limit exceeded: too many tokens per minute") == ""  # throttling, not overflow
    assert classify_overflow(200, "all good") == ""


def test_classify_overflow_silent():
    # MiMo/llama.cpp: truncates prompt to fit -> length stop, 0 output, input ~ window
    assert classify_overflow(200, "", finish_reason="length", output_tokens=0, input_tokens=8100, context_window=8192) == "silent-truncation-length"
    # not silent-truncation if it produced output
    assert classify_overflow(200, "", finish_reason="length", output_tokens=50, input_tokens=8100, context_window=8192) == ""
    # z.ai: accepts overflow silently -> stop with input over window
    assert classify_overflow(200, "", finish_reason="stop", input_tokens=9000, context_window=8192) == "silent-overflow-accepted"


def test_clamp_max_tokens():
    assert clamp_max_tokens(4096, 8192, 6000, safety=1024) == min(4096, 8192 - 6000 - 1024)
    assert clamp_max_tokens(200, 8192, 6000, safety=1024) == 200            # requested fits, keep
    assert clamp_max_tokens(4096, 8192, 8000, safety=1024) == 1             # no room -> floor
    assert clamp_max_tokens(4096, 0, 6000) is None                          # unknown window -> untouched
    assert clamp_max_tokens(None, 8192, 6000, safety=1024) == 8192 - 6000 - 1024


def test_drain_idle_split_accumulates_and_splits_after_first_byte():
    # Fake body: three chunks then EOF. Record when the socket timeout gets retuned.
    chunks = iter([b"AB", b"CD", b"EF", b""])
    timeouts = []
    out = []
    total = drain_with_idle_split(lambda: next(chunks), timeouts.append, 120, out.append)
    assert b"".join(out) == b"ABCDEF"       # every chunk accumulated in order
    assert total == 6
    # the split fires EXACTLY once, right after the first byte, dropping to the inter-token idle
    assert timeouts == [120]


def test_drain_idle_split_empty_body_never_splits():
    # No bytes ever arrive (EOF immediately) -> we never lower the timeout (stays at first-token).
    timeouts = []
    out = []
    total = drain_with_idle_split(lambda: b"", timeouts.append, 120, out.append)
    assert total == 0 and out == [] and timeouts == []


def test_drain_idle_split_reraises_first_byte_timeout():
    # Stall BEFORE the first byte -> socket.timeout propagates; the split was never applied.
    timeouts = []

    def _read():
        raise socket.timeout("idle before first byte")

    try:
        drain_with_idle_split(_read, timeouts.append, 120, lambda _b: None)
        assert False, "expected socket.timeout to propagate"
    except socket.timeout:
        pass
    assert timeouts == []  # never got a byte -> never dropped to inter-token idle


def test_drain_idle_split_reraises_inter_token_timeout():
    # One byte, THEN a stall -> the split already fired (timeout dropped to idle), then it re-raises.
    seq = [b"X", socket.timeout("idle after first byte")]
    timeouts = []

    def _read():
        v = seq.pop(0)
        if isinstance(v, Exception):
            raise v
        return v

    try:
        drain_with_idle_split(_read, timeouts.append, 120, lambda _b: None)
        assert False, "expected socket.timeout to propagate"
    except socket.timeout:
        pass
    assert timeouts == [120]  # the inter-token split DID apply before the stall


def test_prefix_check_first_seen_and_stable():
    state, lock = {}, threading.Lock()
    # first sighting of a model -> nothing to compare, no break, but it IS stored
    assert update_prefix_and_check(state, lock, "m", "A" * 3000) is None
    assert state["m"] == "A" * 3000
    # an identical prefix next turn -> full reuse, no break
    assert update_prefix_and_check(state, lock, "m", "A" * 3000) is None


def test_prefix_check_detects_break():
    state, lock = {}, threading.Lock()
    update_prefix_and_check(state, lock, "m", "A" * 3000)
    # the stable block was mutated near the start -> shared prefix collapses -> CACHE-BREAK
    cb = update_prefix_and_check(state, lock, "m", "B" + "A" * 2999)
    assert cb is not None and cb[0] == 0          # zero shared leading chars
    assert cb[2] < 98.0                            # pct below threshold


def test_prefix_check_small_prefix_never_breaks():
    state, lock = {}, threading.Lock()
    update_prefix_and_check(state, lock, "m", "x" * 100)
    # below the floor (2000) -> never flagged even if totally different (noise suppression)
    assert update_prefix_and_check(state, lock, "m", "y" * 100) is None


def test_prefix_check_per_model_isolation():
    state, lock = {}, threading.Lock()
    update_prefix_and_check(state, lock, "m1", "A" * 3000)
    # a different model's first prefix must not be compared against m1's
    assert update_prefix_and_check(state, lock, "m2", "Z" * 3000) is None
    assert state["m1"] == "A" * 3000 and state["m2"] == "Z" * 3000


def test_prefix_check_thread_safe_no_corruption():
    # Hammer the SAME model key from many threads (the ThreadingHTTPServer race). The lock must keep
    # the compare-and-store atomic: no exception, and the final stored value is one of the values
    # actually written (never a torn/partial dict state).
    state, lock = {}, threading.Lock()
    written = [("v%04d" % i) * 500 for i in range(200)]  # each > floor
    errors = []

    def worker(vals):
        try:
            for v in vals:
                update_prefix_and_check(state, lock, "hot", v)
        except Exception as e:  # a race would surface as a dict mutation error / KeyError
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(written,)) for _ in range(8)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert not errors, f"concurrency errors: {errors[:3]}"
    assert state["hot"] in written  # final value is a real write, not corrupted


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    fails = 0
    for fn in fns:
        try:
            fn(); print("ok  ", fn.__name__)
        except Exception:
            fails += 1; print("FAIL", fn.__name__); traceback.print_exc()
    print(f"\n{len(fns)-fails}/{len(fns)} passed")
    sys.exit(1 if fails else 0)
