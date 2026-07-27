"""A live turn does not queue behind background work.

MEASURED 2026-07-27: checkpoint writers produced ten messages against the user's three over fifteen
minutes, and every request through this gate averaged 72 seconds of waiting, the worst pinned at the
ceiling. A request as small as translating a paragraph was not slow to compute — it was not being
computed. A plain FIFO serves whoever asked first, which is the wrong question when the asker is
background work and a person is waiting.
"""
import threading
import time

from adapter_util import AdmissionGate


def _hold(gate, order, label, priority, started=None, delay=0.0):
    def run():
        if delay:
            time.sleep(delay)
        with gate.acquire(timeout=10, priority=priority):
            order.append(label)
            time.sleep(0.05)
    t = threading.Thread(target=run)
    t.start()
    return t


def test_live_turn_overtakes_background_that_asked_first():
    gate = AdmissionGate(limit=1, wait_timeout=10)
    order = []
    blocker = gate.acquire(timeout=10, priority=0)      # someone is generating
    threads = [
        _hold(gate, order, "background", priority=5),
        _hold(gate, order, "background2", priority=5, delay=0.05),
    ]
    time.sleep(0.15)                                     # both background waiters are queued FIRST
    threads.append(_hold(gate, order, "user", priority=0, delay=0.0))
    time.sleep(0.15)
    blocker.release()
    for t in threads:
        t.join(timeout=10)
    assert order[0] == "user", f"the live turn must go first, got {order}"
    assert set(order) == {"user", "background", "background2"}, order


def test_equal_priority_keeps_arrival_order():
    gate = AdmissionGate(limit=1, wait_timeout=10)
    order = []
    blocker = gate.acquire(timeout=10, priority=0)
    threads = []
    for i in range(3):
        threads.append(_hold(gate, order, f"n{i}", priority=5, delay=i * 0.06))
        time.sleep(0.06)
    blocker.release()
    for t in threads:
        t.join(timeout=10)
    assert order == ["n0", "n1", "n2"], order


def test_background_still_runs_and_nothing_starves():
    gate = AdmissionGate(limit=1, wait_timeout=10)
    order = []
    threads = [_hold(gate, order, "bg", priority=9), _hold(gate, order, "fg", priority=0, delay=0.02)]
    for t in threads:
        t.join(timeout=10)
    assert set(order) == {"bg", "fg"}, order


def test_default_priority_is_the_live_turn():
    # A caller that says nothing is treated as a person waiting, never as background. Getting this
    # backwards would silently demote every existing caller in the adapter.
    gate = AdmissionGate(limit=1, wait_timeout=10)
    order = []
    blocker = gate.acquire(timeout=10, priority=0)
    threads = [_hold(gate, order, "explicit-bg", priority=5)]
    time.sleep(0.1)
    def unspecified():
        with gate.acquire(timeout=10):        # no priority argument at all
            order.append("unspecified")
    t = threading.Thread(target=unspecified)
    t.start()
    threads.append(t)
    time.sleep(0.1)
    blocker.release()
    for t in threads:
        t.join(timeout=10)
    assert order[0] == "unspecified", order


def test_a_bad_priority_never_breaks_admission():
    gate = AdmissionGate(limit=1, wait_timeout=5)
    with gate.acquire(timeout=5, priority="nonsense"):
        pass
    with gate.acquire(timeout=5, priority=None):
        pass


def test_the_queue_empties_so_the_gate_keeps_admitting():
    # A waiter left behind at the head is a ghost nobody can be, and the gate would stop admitting.
    gate = AdmissionGate(limit=1, wait_timeout=5)
    for i in range(6):
        with gate.acquire(timeout=5, priority=i % 3):
            pass
    assert gate._queue == [], gate._queue
