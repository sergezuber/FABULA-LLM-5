"""Where fd 2 lands, asked of each platform in its own way.

This is the log RULE #17 mandates reading FIRST when anything hangs, so a rotator that silently does
nothing is a diagnostic failure rather than a disk one. It asked only macOS (`fcntl F_GETPATH`), which
meant it was dead on both platforms being ported to while every test of the surrounding logic passed —
the same "green suite over a mechanism that never runs" shape this project keeps finding.

The case that matters most is the NEGATIVE one: a service manager that hands over a pipe or a journald
socket gives fd 2 no file at all, and the resolver must say so. Truncating the wrong thing is worse than
not rotating.
"""
import os
import re
import subprocess
import sys
import tempfile

ADAPTER = os.path.join(os.path.dirname(__file__), "lmstudio-adapter.py")


def _resolver_source():
    """Just the resolver, lifted out — importing the adapter would start its admission machinery."""
    src = open(ADAPTER, encoding="utf-8").read()
    m = re.search(r"def _stderr_path\(\):.*?(?=\ndef )", src, re.S)
    assert m, "the resolver moved; this test must follow it"
    return "import os, sys\n" + m.group(0)


def _ask(stderr_target, env=None):
    """Run the resolver in a CHILD whose fd 2 really is what we are testing — the only way to ask."""
    code = _resolver_source() + "\nimport sys; sys.stdout.write(repr(_stderr_path()))\n"
    e = dict(os.environ)
    e.pop("FABULA_ADAPTER_LOG", None)
    e.update(env or {})
    out = subprocess.run([sys.executable, "-c", code], stderr=stderr_target, stdout=subprocess.PIPE, env=e)
    return eval(out.stdout.decode())


def test_a_real_file_is_found():
    with tempfile.NamedTemporaryFile(suffix=".log") as f:
        got = _ask(f)
        if sys.platform.startswith(("linux", "darwin")):
            # Compared CANONICALLY: macOS serves /var, /tmp and /etc as symlinks into /private, so the
            # kernel answers the resolved spelling while tempfile hands back the link one. Both name the
            # same file, and a test that compared the strings would fail on a resolver that is right —
            # the same twin `lib/pathguard.ts` carries `stripPrivate` for.
            assert os.path.realpath(got) == os.path.realpath(f.name), f"fd 2 is {f.name}, resolver said {got}"
        else:
            # Windows has no fd-to-path call a service can rely on; it says None rather than guessing.
            assert got is None


def test_a_pipe_yields_NOTHING_rather_than_a_wrong_path():
    # journald and any piping supervisor land here. There is no file, so there is nothing to truncate,
    # and inventing one would truncate something that is not the log.
    assert _ask(subprocess.PIPE) is None


def test_an_explicitly_named_log_outranks_the_kernel():
    # The honest channel on a platform that cannot answer, and an override everywhere else.
    assert _ask(subprocess.PIPE, {"FABULA_ADAPTER_LOG": "/tmp/named-by-operator.log"}) == "/tmp/named-by-operator.log"
