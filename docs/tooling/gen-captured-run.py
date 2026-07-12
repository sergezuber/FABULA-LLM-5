#!/usr/bin/env python3
# Mechanical captured-run.svg generator: every beat comes from the cast file.
# Usage: python3 docs/tooling/gen-captured-run.py docs/assets/refusal.cast docs/assets/captured-run.svg demo/.fabula/receipts/latest.json
# No hand-authored timeline — rerun on a new cast and the SVG follows the recording.
import json, re, sys

CAST = sys.argv[1]
OUT = sys.argv[2]
RECEIPT = sys.argv[3]

events = []
with open(CAST) as f:
    f.readline()
    for line in f:
        e = json.loads(line)
        t, s = e[0], e[2]
        clean = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", s)
        events.append((t, clean))

def first(pred):
    for t, s in events:
        if pred(s):
            return t, s
    return None, ""

# Beats derived from the recording (None → beat absent → not drawn).
t_fix, _ = first(lambda s: ("str_replace" in s or "Edit " in s) and "export.ts" in s and "export.test" not in s)
t_test, _ = first(lambda s: ("str_replace" in s or "create_file" in s or "Edit " in s) and "export.test.ts" in s)
t_refuse, s_refuse = first(lambda s: "NOT YET DONE" in s)
gate_name = "change-quiz gate" if "change-quiz" in s_refuse else ("reproduce-first gate" if "reproduce" in s_refuse else "gate")
t_quiz, _ = first(lambda s: "CHANGE-QUIZ — answer these" in s)
t_pass, _ = first(lambda s: "change_quiz PASS" in s)
t_mint, _ = first(lambda s: "receipt minted" in s)

r = json.load(open(RECEIPT))
model_id = r["model"]["id"]
model_host = r["model"]["host"]
base = (r.get("base") or "")[:12]
files = r["artifact"]["files"]

beats = []
beats.append((0.0, "task", "TASK", "Fix the export bug: the nightly export silently drops rows dated exactly on the end date. Prove it.", None))
if t_fix is not None:
    beats.append((t_fix, "act", "the model fixes the source", "demo/src/export.ts — the boundary comparison", None))
if t_test is not None:
    beats.append((t_test, "act", "…and writes the boundary test", "demo/src/export.test.ts — the coverage the suite never had", None))
if t_refuse is not None:
    beats.append((t_refuse, "refuse", "verify_done → the suite is GREEN. REFUSED anyway.", f"⏳ NOT YET DONE ({gate_name}) — green is not enough; explain your own diff first", None))
if t_quiz is not None:
    beats.append((t_quiz, "gate", "change_quiz — 3 questions about its own diff", "graded strictly against the diff by a second model", None))
if t_pass is not None:
    sub = "📄 Proof-of-Done receipt minted in the same frame" if (t_mint is not None and abs(t_mint - t_pass) < 2) else "PASS"
    beats.append((t_pass, "green", "change_quiz PASS → receipt minted", sub, None))

W = 1200
CARD_X, CARD_W = 48, 1104
Y0 = 118
GAP = 24
H_CARD = 74
height = Y0 + len(beats) * (H_CARD + GAP) + 96

COL = {"task": "#1f6feb66", "act": "#30363d", "refuse": "#f85149", "gate": "#d29922", "green": "#3fb950"}
ICO = {"task": "◆", "act": "⚙", "refuse": "✋", "gate": "⚖", "green": "✓"}

svg = []
svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">')
svg.append(f'<rect width="{W}" height="{height}" rx="18" fill="#0d1117"/>')
svg.append(f'<rect x="1" y="1" width="{W-2}" height="{height-2}" rx="17" fill="none" stroke="#ffffff10"/>')
svg.append('<text x="48" y="46" font-size="16" fill="#6e7681" letter-spacing="1.5">CAPTURED RUN — the machine says no</text>')
svg.append(f'<text x="{W-48}" y="46" text-anchor="end" font-size="14" fill="#8b949e">every beat below is from the recording (docs/assets/refusal.cast)</text>')
svg.append(f'<line x1="48" y1="62" x2="{W-48}" y2="62" stroke="#30363d" stroke-dasharray="4 5"/>')
svg.append(f'<rect x="48" y="78" width="380" height="30" rx="8" fill="#1c2128" stroke="#58a6ff" stroke-width="1.5"/>')
svg.append(f'<text x="238" y="98" text-anchor="middle" font-size="13" fill="#e6edf3">{model_id} · {model_host}</text>')
svg.append(f'<text x="452" y="98" font-size="13" fill="#8b949e">base {base} · {files} file(s) in the artifact</text>')

y = Y0
for t, kind, title, sub, _ in beats:
    c = COL[kind]
    stroke = c if kind != "task" else "#1f6feb66"
    fill = "#0b1f30" if kind == "task" else ("#0c2417" if kind == "green" else "#161b22")
    svg.append(f'<rect x="{CARD_X}" y="{y}" width="{CARD_W}" height="{H_CARD}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    tcol = "#f85149" if kind == "refuse" else ("#3fb950" if kind == "green" else ("#d29922" if kind == "gate" else "#e6edf3"))
    svg.append(f'<text x="{CARD_X+22}" y="{y+30}" font-size="16" font-weight="600" fill="{tcol}">{ICO[kind]}  {title}</text>')
    svg.append(f'<text x="{CARD_X+22}" y="{y+54}" font-size="13" fill="#8b949e">{sub}</text>')
    if y > Y0:
        svg.append(f'<line x1="{CARD_X+40}" y1="{y-GAP}" x2="{CARD_X+40}" y2="{y}" stroke="#6e7681" stroke-width="2"/>')
    y += H_CARD + GAP

svg.append(f'<text x="48" y="{height-42}" font-size="13" fill="#6e7681">recorded live, headless · replay the artifact yourself:  cd demo &amp;&amp; fabula receipt verify</text>')
svg.append("</svg>")
open(OUT, "w").write("\n".join(svg) + "\n")
print(f"wrote {OUT} with {len(beats)} captured beats")
