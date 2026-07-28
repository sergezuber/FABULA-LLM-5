"""A client that finished sending is not a client that left.

MEASURED 2026-07-28, in production. A watcher was added to notice a caller who hangs up during prefill,
and it judged departure with `select` + a zero-length peek. On real sockets that is not the question it
appears to be: an HTTP client normally shuts down its write side once the request is out and then waits
for the response. The peek returns nothing, the watcher called it gone, and it closed the upstream — so
the answer the caller was waiting for was thrown away and the app sat in silence. The model server logged
"Finished streaming response" into a connection nobody was reading.

This pins the distinction, so the same shortcut cannot be reintroduced by a later reading of the same
symptom.
"""
import socket
import select
import threading
import time


def peek_says_gone(sock):
    """The check that was wrong: readable + empty peek."""
    try:
        r, _, _ = select.select([sock], [], [], 0)
        return bool(r) and not sock.recv(1, socket.MSG_PEEK)
    except (BlockingIOError, InterruptedError):
        return False
    except (OSError, ValueError):
        return True


def _serve_once(srv, out, hold):
    conn, _ = srv.accept()
    conn.recv(4096)
    time.sleep(0.2)
    out.append(peek_says_gone(conn))
    time.sleep(hold)
    conn.close()


def test_half_closed_write_side_is_not_a_departure():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    out = []
    t = threading.Thread(target=_serve_once, args=(srv, out, 0.2), daemon=True)
    t.start()

    c = socket.create_connection(("127.0.0.1", port))
    c.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n\r\n")
    c.shutdown(socket.SHUT_WR)          # request fully sent; the response is still awaited
    t.join(timeout=5)
    c.close()
    srv.close()

    assert out, "the server thread never reached the check"
    assert out[0] is True, (
        "the peek check reports a LIVE, waiting client as gone — this is why it must not be used to "
        "decide whether to abort a generation"
    )


def test_the_adapter_does_not_use_that_check_to_abort_a_generation():
    """The guard that matters: no watcher may close an upstream on this signal alone."""
    import os
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")).read()
    assert "_watch_client" not in src, (
        "a prefill watcher deciding departure by peek was reverted after it silently discarded real "
        "answers; reintroducing it needs a signal that distinguishes a half-close from a hang-up"
    )
