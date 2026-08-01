r"""The diagnostic log RULE 17 depends on is bounded — proven by rotating a real one.

MEASURED 2026-08-01: nothing bounded it. `grep -c "rotat\|RotatingFile\|maxBytes"` returned 0, the plist
uses a plain append-only StandardErrorPath, and the file stood at 568 KB and grew during the audit. Its
two siblings, adapter.err.log.old and adapter.err.log.pre25, are hand-made copies — the rotation existed,
performed by a person.

Two things have to be true and BOTH were wrong at first:
  1. the process can find the file launchd handed it (fcntl F_GETPATH RETURNS the buffer; passing a
     bytearray raises, so the first version resolved None and would have rotated nothing in production
     while every test of the surrounding logic passed);
  2. truncating in place keeps fd 2 usable — launchd opens with O_APPEND, so the next write lands at
     offset 0 of the same inode. Renaming would leave the process writing into a file nobody reads.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.join(HERE, "lmstudio-adapter.py")


def _load():
    spec = importlib.util.spec_from_file_location("lmadapter_rot", ADAPTER)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_stderr_path_resolves_the_file_launchd_opened():
    log = tempfile.mktemp(suffix=".log")
    code = (
        "import importlib.util,sys;"
        f"spec=importlib.util.spec_from_file_location('a', {ADAPTER!r});"
        "a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a);"
        "sys.stdout.write(str(a._stderr_path()))"
    )
    try:
        with open(log, "ab") as f:  # exactly how launchd opens StandardErrorPath
            out = subprocess.run([sys.executable, "-c", code], stderr=f, stdout=subprocess.PIPE).stdout.decode()
        assert os.path.realpath(out) == os.path.realpath(log), f"resolved {out!r}, expected {log!r}"
    finally:
        if os.path.exists(log):
            os.unlink(log)


def test_an_oversized_log_is_rotated_and_the_previous_generation_is_kept():
    m = _load()
    log = tempfile.mktemp(suffix=".log")
    try:
        with open(log, "wb") as f:
            f.write(b"x" * 5000)
        os.environ["FABULA_ADAPTER_LOG"] = log
        os.environ["FABULA_ADAPTER_LOG_MAX"] = "1000"
        import threading
        t = threading.Thread(target=m._rotate_log_forever, daemon=True)
        t.start()
        import time
        for _ in range(60):
            if os.path.getsize(log) <= 1000 and os.path.exists(log + ".1"):
                break
            time.sleep(0.1)
        assert os.path.getsize(log) <= 1000, f"log still {os.path.getsize(log)} bytes"
        assert os.path.getsize(log + ".1") == 5000, "the previous generation must be kept whole"
    finally:
        os.environ.pop("FABULA_ADAPTER_LOG", None)
        os.environ.pop("FABULA_ADAPTER_LOG_MAX", None)
        for p in (log, log + ".1"):
            if os.path.exists(p):
                os.unlink(p)


def test_a_log_under_the_limit_is_left_alone():
    m = _load()
    log = tempfile.mktemp(suffix=".log")
    try:
        with open(log, "wb") as f:
            f.write(b"y" * 100)
        os.environ["FABULA_ADAPTER_LOG"] = log
        os.environ["FABULA_ADAPTER_LOG_MAX"] = "1000"
        import threading, time
        threading.Thread(target=m._rotate_log_forever, daemon=True).start()
        time.sleep(1.0)
        assert os.path.getsize(log) == 100
        assert not os.path.exists(log + ".1")
    finally:
        os.environ.pop("FABULA_ADAPTER_LOG", None)
        os.environ.pop("FABULA_ADAPTER_LOG_MAX", None)
        for p in (log, log + ".1"):
            if os.path.exists(p):
                os.unlink(p)


def test_rotation_can_be_switched_off():
    m = _load()
    os.environ["FABULA_ADAPTER_LOG"] = "/tmp/never-touched.log"
    os.environ["FABULA_ADAPTER_LOG_MAX"] = "0"
    try:
        m._rotate_log_forever()  # returns immediately rather than looping — 0 means off
    finally:
        os.environ.pop("FABULA_ADAPTER_LOG", None)
        os.environ.pop("FABULA_ADAPTER_LOG_MAX", None)


if __name__ == "__main__":
    for fn in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        fn()
        print("ok", fn.__name__)
    print("all log-rotation tests passed")
