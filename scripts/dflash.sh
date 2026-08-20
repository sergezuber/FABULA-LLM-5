#!/bin/bash
# DFlash — ускоренное декодирование для локальных моделей. ЛИЧНЫЙ переключатель, по умолчанию выключен.
#
# Поднимает МНОГОМОДЕЛЬНЫЙ oMLX: все модели видны в меню приложения сразу, нужная грузится по выбору —
# как это делает LM Studio, только со спекулятивным декодированием. LM Studio при этом не нужен.
#
#   приложение → адаптер :1235 → LM Studio :1234   ← остаётся как было, НЕ ТРОГАЕТСЯ
#   приложение → адаптер :1237 → oMLX+DFlash :1236 ← эта кнопка
#
# ЗАМЕРЕНО 2026-08-19 (стенд dflash benchmark, 6 кодовых задач × 2 повтора, медиана):
#   Qwen3.6-35B-A3B-UD        1.45×    76.9 → 111.7 ток/с    приёмка 0.691
#   KAT-Coder-V2.5-Dev-OptiQ  1.35×    75.6 → 101.2 ток/с    приёмка 0.666
#   Qwen3.6-35B-A3B-Heretic   1.26×   102.4 → 126.8 ток/с    приёмка 0.699
#   длинный контекст 32k      1.55×    58.5 →  90.5 ток/с    штрафа на префилл нет
# Вывод побитово идентичен обычному декодированию: спекуляция верифицируемая, не приближение.
#
# ⚠ ЗАМЕРЕНО: без квантованного черновика механизм работал СЕБЕ В УБЫТОК — 0.65×, на треть медленнее.
#   Поэтому настройки пишутся принудительно, а не оставляются на умолчания.
# ⚠ ОКНО 65536 — это ВЫБОР, а не замер: oMLX не резервирует контекст заранее. Меняется DFLASH_CTX.
set -uo pipefail

OMLX_BIN="${OMLX_BIN:-$HOME/.cache/omlx-venv/bin/omlx}"
OMLX_PY="${OMLX_PY:-$HOME/.cache/omlx-venv/bin/python}"
REPO="${REPO:-$HOME/GitHub/FABULA-LLM-5}"
GLOBAL_CFG="$HOME/.config/fabula/mimocode.jsonc"
MODEL_DIR="$HOME/.local/share/fabula/dflash-models"
DRAFT="${DFLASH_DRAFT:-z-lab/Qwen3.6-35B-A3B-DFlash}"
OMLX_PORT=1236
ADAPTER_PORT=1237
CTX="${DFLASH_CTX:-65536}"
RUN="$HOME/.local/share/fabula/dflash"; mkdir -p "$RUN"

# id → откуда брать. Имена СОВПАДАЮТ с теми, что уже в меню, чтобы ничего визуально не менялось.
MODELS="kat-coder-v2.5-dev-optiq:$HOME/.lmstudio/models/mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit
qwen3.6-35b-a3b-ud-mlx:$HOME/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-UD-MLX-4bit
qwen3.6-35b-a3b-uncensored-heretic-mlx:$HOME/.lmstudio/models/froggeric/Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-4bit"

up() { curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$1/v1/models" 2>/dev/null; }

case "${1:-status}" in
start)
  [ -x "$OMLX_BIN" ] || { echo "нет oMLX: $OMLX_BIN"; exit 1; }
  echo "== DFlash: поднимаю все модели =="

  mkdir -p "$MODEL_DIR"
  while IFS=: read -r id path; do
    [ -z "$id" ] && continue
    [ -d "$path" ] && ln -sfn "$path" "$MODEL_DIR/$id" || echo "  ! нет модели: $path"
  done <<< "$MODELS"

  # ПОТОЛОК ПАМЯТИ РАНТАЙМА. Его сторож сравнивает «занято ВСЕЙ машиной + модель» с этим числом, а не
  # со своим собственным расходом — процесс сервера при этом держит десятые доли гигабайта. Пришпиленные
  # по умолчанию 32 ГБ ниже того, что машина реально может заплатить: на 48-гигабайтной 20-гигабайтная
  # модель не влезала, стоило открыть браузер (живой отказ 2026-08-20: «projected 36.47GB would exceed
  # the dynamic memory ceiling 32.00GB, current: 16.52GB»). Число берётся НЕ с потолка, а из той же
  # политики, которой FABULA считает окно модели (plugin/lib/windowplan.ts DEFAULT_POLICY): всего минус
  # системный резерв, умножить на долю, которую машине можно закоммитить. Одно определение — один ответ.
  echo "-- потолок памяти рантайма по политике FABULA"
  "$OMLX_PY" - "$(sysctl -n hw.memsize)" <<'CEIL'
import json, os, sys
tot = int(sys.argv[1])
SYSTEM_RESERVE = 6 * 1024 ** 3   # windowplan.ts DEFAULT_POLICY.systemReserveBytes
COMMIT_FRACTION = 0.90           # windowplan.ts DEFAULT_POLICY.commitFraction
ceiling = round((tot - SYSTEM_RESERVE) * COMMIT_FRACTION / 2 ** 30, 1)
p = os.path.expanduser("~/.omlx/settings.json")
if os.path.exists(p):
    d = json.load(open(p)); m = d.setdefault("memory", {})
    old = m.get("memory_guard_custom_ceiling_gb")
    if old != ceiling:
        m["memory_guard_custom_ceiling_gb"] = ceiling
        m.setdefault("memory_guard_tier", "custom")
        json.dump(d, open(p, "w"), indent=2)
        print(f"   потолок {old} -> {ceiling} ГиБ (машина {tot / 2 ** 30:.0f} ГиБ)")
    else:
        print(f"   потолок уже {ceiling} ГиБ")
else:
    print("   ! ~/.omlx/settings.json нет — пропускаю")
CEIL

  echo "-- настройки DFlash для каждой модели"
  "$OMLX_PY" - "$CTX" "$DRAFT" <<'PY'
import json, os, sys, shutil
ctx, draft = int(sys.argv[1]), sys.argv[2]
p = os.path.expanduser("~/.omlx/model_settings.json")
os.makedirs(os.path.dirname(p), exist_ok=True)
d = {"version": 1, "models": {}}
if os.path.exists(p):
    shutil.copy2(p, p + ".before-dflash"); d = json.load(open(p))
d.setdefault("models", {})
for mid in ("kat-coder-v2.5-dev-optiq", "qwen3.6-35b-a3b-ud-mlx", "qwen3.6-35b-a3b-uncensored-heretic-mlx"):
    d["models"].setdefault(mid, {}).update({
        "dflash_enabled": True, "dflash_draft_model": draft,
        "dflash_draft_quant_enabled": True, "dflash_draft_quant_weight_bits": 4,
        "dflash_draft_quant_group_size": 64, "dflash_verify_mode": "adaptive",
        "dflash_max_ctx": ctx,
    })
json.dump(d, open(p, "w"), indent=2)
print(f"   включено у {len(d['models'])} моделей, окно {ctx}")
PY

  # ДВА рантайма не должны держать по большой модели одновременно. ИЗМЕРЕНО 2026-08-20: LM Studio
  # держал 27B (15 ГБ), oMLX — KAT Coder (22 ГБ); 37 ГБ на 48-гигабайтной машине увели её в своп на
  # 22.6 ГБ, сторож памяти oMLX упёрся в свой порог и задушил генерацию до 0.2 ток/с вместо 101.
  # LM Studio грузит модель обратно по первому запросу, так что освободить её здесь ничего не ломает.
  if command -v lms >/dev/null 2>&1; then
    LOADED=$(lms ps 2>/dev/null | tail -n +2 | grep -c . || echo 0)
    [ "${LOADED:-0}" -gt 0 ] && { echo "-- освобождаю память: выгружаю модели LM Studio"; lms unload --all >/dev/null 2>&1; sleep 2; }
  fi
  pkill -f "omlx-server" 2>/dev/null; pkill -f "omlx serve" 2>/dev/null; [ -f "$RUN/adapter.pid" ] && kill "$(cat "$RUN/adapter.pid")" 2>/dev/null
  for i in $(seq 1 15); do [ "$(up $OMLX_PORT)" = "000" ] && break; sleep 1; done

  echo "-- oMLX (многомодельный) на :$OMLX_PORT"
  # ПРЕФИКС-КЭШ. По умолчанию у oMLX он ВЫКЛЮЧЕН (hot_cache_max_size=0, ssd_cache_dir=null), и это
  # ИЗМЕРЕНО стоило 83 секунды на ход: агентский запрос несёт ~50 000 токенов неизменного начала, и без
  # кэша они перечитывались заново каждый раз. Считаем, сколько нужно: лог модели говорит "40 layers
  # (10 KVCache), 2 KV heads, 256 head_dim" — KV лежит лишь на 10 слоях из 40, это ~20 КБ на токен,
  # то есть 50 000 токенов ≈ 1 ГБ. 8 ГБ держат несколько таких начал разом.
  # У движка DFlash СВОЙ префикс-кэш, отдельный от страничного кэша oMLX: последний остаётся пустым,
  # и ИЗМЕРЕНО префилл не падал (86с → 83с → 91с на одинаковых 51k запросах). В CLI-пути dflash он
  # включён по умолчанию (`dflash doctor`: prefix_cache=True l2=True), под omlx serve — нет.
  # НАЙДЕННАЯ ПРИЧИНА 83-секундного префилла на каждом ходу: снимок префикса НЕ ВСТАВЛЯЕТСЯ, если
  # промпт больше max_snapshot_tokens, а умолчание — 32 000 (dflash_mlx/runtime/config.py:89). Агентский
  # запрос несёт ~51 000, то есть в кэш не попадал НИКОГДА. Порог по токенам здесь лишний: объём кэша и
  # так ограничен отдельно (prefix_cache_max_bytes 8 ГБ, max_entries 8), поэтому 0 = без порога.
  DFLASH_MAX_SNAPSHOT_TOKENS="${DFLASH_MAX_SNAPSHOT:-0}" \
  DFLASH_PREFIX_CACHE=1 DFLASH_PREFIX_CACHE_L2=1 \
  DFLASH_PREFIX_CACHE_MAX_BYTES="${DFLASH_PREFIX_BYTES:-8589934592}" \
  DFLASH_COPYSPEC_MODE=auto nohup "$OMLX_BIN" serve --model-dir "$MODEL_DIR" \
    --hot-cache-max-size "${DFLASH_HOT_CACHE:-8GB}" \
    --paged-ssd-cache-dir "$RUN/prefix-cache" \
    --host 127.0.0.1 --port "$OMLX_PORT" --log-level info > "$RUN/omlx.log" 2>&1 &
  echo $! > "$RUN/omlx.pid"

  echo "-- адаптер на :$ADAPTER_PORT (боевой :1235 не тронут)"
  ADAPTER_PORT="$ADAPTER_PORT" UPSTREAM="http://localhost:$OMLX_PORT" \
  FABULA_DUMP_LAST_REQUEST="${FABULA_DUMP_LAST_REQUEST:-}" \
  FABULA_MODEL_API="http://localhost:$OMLX_PORT/v1/models" \
    nohup "$OMLX_PY" "$REPO/proxy/lmstudio-adapter.py" > "$RUN/adapter.log" 2>&1 &
  echo $! > "$RUN/adapter.pid"

  for i in $(seq 1 60); do [ "$(up $OMLX_PORT)" = "200" ] && break; sleep 1; done
  for i in $(seq 1 20); do [ "$(up $ADAPTER_PORT)" = "200" ] && break; sleep 1; done

  "$OMLX_PY" - "$GLOBAL_CFG" "$ADAPTER_PORT" "$CTX" <<'PY'
import json, os, sys, shutil
cfg, port, ctx = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
os.makedirs(os.path.dirname(cfg), exist_ok=True)
d = {}
if os.path.exists(cfg):
    shutil.copy2(cfg, cfg + ".before-dflash"); d = json.load(open(cfg))
names = {"kat-coder-v2.5-dev-optiq": "KAT Coder v2.5 Dev OptiQ ⚡",
         "qwen3.6-35b-a3b-ud-mlx": "Qwen3.6 35B A3B UD ⚡",
         "qwen3.6-35b-a3b-uncensored-heretic-mlx": "Qwen3.6 35B A3B Uncensored ⚡"}
d.setdefault("provider", {})["dflash"] = {
    "npm": "@ai-sdk/openai-compatible",
    "name": "DFlash · ускоренные (без LM Studio)",
    "options": {"baseURL": f"http://localhost:{port}/v1"},
    "models": {k: {"name": v, "limit": {"context": ctx, "output": 32768}} for k, v in names.items()},
}
json.dump(d, open(cfg, "w"), indent=2, ensure_ascii=False)
print(f"   провайдер dflash: {len(names)} модели через :{port}")
PY
  echo "-- oMLX :$OMLX_PORT → $(up $OMLX_PORT) | адаптер :$ADAPTER_PORT → $(up $ADAPTER_PORT) | боевой :1235 → $(up 1235)"
  echo "== готово. Перезапустите приложение и выберите модель с ⚡ =="
  ;;
stop)
  # Гасим ТОЛЬКО процессы. Провайдер остаётся объявленным, иначе ⚡-модели пропадут из меню и
  # выбрать их, чтобы плагин поднял движок по требованию, будет уже нечем. Полностью убрать: uninstall.
  echo "== DFlash: гашу процессы (провайдер остаётся в меню) =="
  pkill -f "omlx-server" 2>/dev/null; pkill -f "omlx serve" 2>/dev/null
  [ -f "$RUN/adapter.pid" ] && kill "$(cat "$RUN/adapter.pid")" 2>/dev/null
  rm -f "$RUN/omlx.pid" "$RUN/adapter.pid"
  echo "-- боевой адаптер :1235 → $(up 1235) (должен быть 200)"
  ;;
uninstall)
  echo "== DFlash: убираю полностью =="
  pkill -f "omlx-server" 2>/dev/null; pkill -f "omlx serve" 2>/dev/null
  [ -f "$RUN/adapter.pid" ] && kill "$(cat "$RUN/adapter.pid")" 2>/dev/null
  "$OMLX_PY" - "$GLOBAL_CFG" <<'PY2'
import json, os, sys
cfg = sys.argv[1]
if os.path.exists(cfg):
    d = json.load(open(cfg))
    if (d.get("provider") or {}).pop("dflash", None) is not None:
        json.dump(d, open(cfg, "w"), indent=2, ensure_ascii=False); print("   провайдер убран из меню")
PY2
  echo "-- боевой адаптер :1235 → $(up 1235)"
  ;;
status)
  echo "oMLX :$OMLX_PORT      → $(up $OMLX_PORT)"
  echo "адаптер :$ADAPTER_PORT   → $(up $ADAPTER_PORT)"
  echo "боевой :1235       → $(up 1235)"
  echo "LM Studio :1234    → $(up 1234)"
  curl -s --max-time 5 "http://127.0.0.1:$OMLX_PORT/v1/models" 2>/dev/null | "$OMLX_PY" -c "
import json,sys
try:
    for m in json.load(sys.stdin).get('data',[]): print('  модель:', m['id'])
except Exception: print('  (сервер не отвечает)')
"
  ;;
*) echo "использование: $0 {start | stop | uninstall | status}"; exit 1 ;;
esac
