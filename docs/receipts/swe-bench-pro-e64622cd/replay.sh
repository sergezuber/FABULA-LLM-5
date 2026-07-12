#!/bin/bash
# FABULA Proof-of-Done replay — SWE-bench Pro instance e64622cd (qutebrowser: signal_name across PyQt versions).
# Re-verifies the ARTIFACT deterministically: the per-instance benchmark container, the model's patch,
# the benchmark's own hidden acceptance tests. The verdict comes from the parser at the bottom — it
# fails closed: missing apply-markers or missing test results read as NOT DONE, never as VERIFIED.
#
# Needs: Docker (public image, ~1 GB, linux/amd64 — runs under emulation on arm64).
# Usage: bash replay.sh          (from this directory)
set -euo pipefail
cd "$(dirname "$0")"

# Pinned by digest — the tag (the dataset's dockerhub_tag truncated to Docker's 128-char tag cap) is
# mutable on the registry; the digest is not.
IMG="jefzda/sweap-images@sha256:4cc7b7186f2b51d82ad7e5c11d8fe5d6d767420d611951a0478f7f1f9793423c"
BASE="09925f74817cf7a970f166342f81886a1d27ee35"
TESTS="tests/unit/utils/test_debug.py"

docker image inspect "$IMG" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$IMG"

CID=$(docker run -d --platform linux/amd64 --entrypoint sleep "$IMG" 3600)
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

docker cp model.patch "$CID:/tmp/model.patch"
docker cp test.patch "$CID:/tmp/test.patch"
docker cp run_script.sh "$CID:/tmp/run_script.sh"

# Start from a FRESH log every run: the receipt directory ships a green replay-output.log, and if this
# run's capture fails to write, the parser must not read stale evidence from the shipped copy.
: > replay-output.log

# Capture the container run to a temp file, tracking whether the write itself succeeded (a failed `tee`
# open, swallowed by a pipe, must never let the parser fall through to a stale log). The steps are
# &&-chained so nothing runs on a dirty tree, and each successful step prints a marker the parser
# REQUIRES; a failing test suite exits non-zero — that is DATA for the verdict, so `|| true` guards only
# the exec exit code, not the capture.
CAP_OK=1
docker exec "$CID" bash -c "
  cd /app \
  && git checkout -f $BASE >/dev/null 2>&1 && git clean -fd >/dev/null 2>&1 \
  && echo '== base checked out ==' \
  && git apply /tmp/model.patch && echo '== model patch applied ==' \
  && git apply /tmp/test.patch  && echo '== hidden acceptance tests applied ==' \
  && bash /tmp/run_script.sh $TESTS 2>&1
" > replay-output.log 2>&1 || CAP_OK=$?
cat replay-output.log
if [ ! -s replay-output.log ]; then
  echo "INCONCLUSIVE — the replay produced no captured output (could not run the container or write the log)."
  exit 1
fi

# Verdict: the setup markers must all be present, every fail_to_pass test must PASS, and pass_to_pass
# must not regress (xfail/xpass = expected). Anything missing → NOT DONE.
python3 - <<'EOF'
import json, re, sys
raw = open("replay-output.log").read()
out = re.sub(r"\s+", " ", raw)
meta = json.load(open("instance.json"))
missing = [m for m in ("== base checked out ==", "== model patch applied ==", "== hidden acceptance tests applied ==")
           if m not in raw]
if missing:
    print(f"NOT DONE — replay setup did not complete (missing: {', '.join(missing)}); no verdict can be minted.")
    sys.exit(1)
# The suite must have RUN TO COMPLETION. pytest ends with a summary line ('=== N passed ... ===').
# Without it the run died mid-suite (docker/OOM/disk) — an INFRASTRUCTURE failure, not the artifact's
# verdict. Reporting that as 'NOT DONE — replay failed' would blame the patch for a container death.
if not re.search(r"=+ .*\b(passed|failed|error)\b.* in [\d.]+s", raw):
    print("INCONCLUSIVE — the test suite did not run to completion (infrastructure failure, not an artifact verdict).")
    sys.exit(3)
def status(nid):
    hits = re.findall(re.escape(nid) + r" (PASSED|FAILED|ERROR|XFAIL|XPASS)", out)
    return hits[-1] if hits else "MISSING"
f2p = {t: status(t) for t in meta["fail_to_pass"]}
p2p = {t: status(t) for t in meta["pass_to_pass"]}
f2p_ok = all(v == "PASSED" for v in f2p.values())
p2p_ok = all(v in ("PASSED", "XFAIL", "XPASS") for v in p2p.values())
print(f"fail_to_pass: {sum(v=='PASSED' for v in f2p.values())}/{len(f2p)} PASSED")
print(f"pass_to_pass: {sum(v=='PASSED' for v in p2p.values())}/{len(p2p)} PASSED "
      f"(+{sum(v in ('XFAIL','XPASS') for v in p2p.values())} xfail/xpass — expected, not regressions)")
for t, v in {**f2p, **p2p}.items():
    if v not in ("PASSED", "XFAIL", "XPASS"):
        print(f"  PROBLEM {t}: {v}")
print("VERIFIED ✓ — the artifact replayed: base + patch passed the hidden acceptance suite."
      if f2p_ok and p2p_ok else "NOT DONE — replay failed.")
sys.exit(0 if f2p_ok and p2p_ok else 1)
EOF
