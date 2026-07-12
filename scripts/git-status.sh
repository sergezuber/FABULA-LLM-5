#!/bin/bash
# Emit a compact JSON snapshot of a project's git state for the injected Git-tools panel.
# Usage: git-status.sh <project-dir>   ->  {"repo":true,"branch":"…","added":N,"removed":N,"files":N}
d="$1"
cd "$d" 2>/dev/null || { echo '{"repo":false}'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '{"repo":false}'; exit 0; }
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
# working tree (staged + unstaged) vs HEAD → matches the "+734 -7" line counters
nums=$(git diff --numstat HEAD 2>/dev/null)
added=$(printf '%s\n' "$nums" | awk '{a+=$1} END{print a+0}')
removed=$(printf '%s\n' "$nums" | awk '{r+=$2} END{print r+0}')
files=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
# JSON-escape the branch (basic)
branch=${branch//\\/\\\\}; branch=${branch//\"/\\\"}
printf '{"repo":true,"branch":"%s","added":%s,"removed":%s,"files":%s}\n' "$branch" "${added:-0}" "${removed:-0}" "${files:-0}"
