"""A live client must never be mistaken for a gone one — on either family of socket error codes.

The relay probes the client socket before every chunk it forwards, and a "closed" verdict CLOSES the
upstream: the generation the user is waiting on dies mid-answer. So the cost of the two mistakes is not
symmetric. Missing a real disconnect wastes some GPU seconds; inventing one destroys work.

The probe used to decide by EXCEPTION CLASS — BlockingIOError meant alive, any other OSError meant gone.
On POSIX that is right. Windows sockets report the WSA family (10035 would-block, 10004 interrupted), and
whether CPython maps those onto the same classes is a platform detail this code must not depend on: if it
does not, every would-block lands in the "gone" branch and every Windows client is declared dead the first
time it has nothing to read. Deciding by NUMBER makes the two platforms answer identically.
"""
import errno
import re
import os

ADAPTER = os.path.join(os.path.dirname(__file__), "lmstudio-adapter.py")


def _alive_set():
    src = open(ADAPTER, encoding="utf-8").read()
    m = re.search(r"_CLIENT_ALIVE_ERRNOS = frozenset\(\{(.*?)\}\)", src, re.S)
    assert m, "the alive-errno set moved; this test must follow it"
    ns = {"errno": errno}
    exec("_CLIENT_ALIVE_ERRNOS = frozenset({" + m.group(1) + "})", ns)
    return ns["_CLIENT_ALIVE_ERRNOS"]


def test_posix_would_block_and_interrupt_mean_ALIVE():
    s = _alive_set()
    assert errno.EAGAIN in s
    assert errno.EWOULDBLOCK in s
    assert errno.EINTR in s


def test_the_windows_spellings_mean_ALIVE_TOO():
    # The whole point: these are the numbers a Windows socket reports, and on a POSIX host `errno` does
    # not even define the names — so they are carried as literals rather than assumed present.
    s = _alive_set()
    assert 10035 in s, "WSAEWOULDBLOCK must not read as a disconnect"
    assert 10004 in s, "WSAEINTR must not read as a disconnect"


def test_a_REAL_disconnect_is_still_a_disconnect():
    # The set must not swallow the errors that genuinely mean the peer is gone, or the guard stops
    # guarding and a vanished client keeps a generation running against a dead socket.
    s = _alive_set()
    for gone in (errno.ECONNRESET, errno.EPIPE, errno.EBADF, errno.ENOTCONN):
        assert gone not in s, f"{gone} means gone, not alive"


def test_the_probe_asks_the_number_rather_than_the_class():
    # Guards the shape itself: a future edit that goes back to catching OSError wholesale would reinstate
    # the Windows false-positive, and nothing else here would notice.
    src = open(ADAPTER, encoding="utf-8").read()
    assert "_CLIENT_ALIVE_ERRNOS" in src
    assert "closed = e.errno not in _CLIENT_ALIVE_ERRNOS" in src
    assert "except (OSError, ValueError):\n                closed = True" not in src
