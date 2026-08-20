// Выбрали ускоренную модель в меню — нужный рантайм поднимается сам, к этому же запросу.
//
// Ничего не работает вхолостую: пока ⚡-модель не выбрана, ни один процесс не запущен. Обычные модели
// через LM Studio идут прежним путём и этого плагина не касаются вовсе.
//
// ПОЧЕМУ ЭТО ВЛЕЗАЕТ В ХОД. Хуку отпущено 5 секунд (`plugin/index.ts` HOOK_TIMEOUT_MS = 5000), а
// многомодельный oMLX ИЗМЕРЕНО поднимается за 2с (моделей он при старте не грузит — нужная приходит
// по первому запросу, ещё ~3с). Поэтому ожидание помещается прямо здесь, и раскладывать его по слоям
// не нужно. Если бы не помещалось — правильным местом был бы адаптер, у которого лимита нет.
//
// ЧТО ПОДНИМАЕТСЯ: oMLX на :1236 (сам движок со спекулятивным декодированием) и ОТДЕЛЬНЫЙ экземпляр
// адаптера на :1237. Боевой адаптер :1235 и LM Studio :1234 не трогаются ничем — у них свои порты и
// свой процесс, так что сломать их этот плагин не может по построению.
//
// ЗАМЕРЕНО 2026-08-19 (стенд dflash benchmark, 6 кодовых задач × 2 повтора, медиана):
//   Qwen3.6-35B-A3B-UD 1.45× · KAT-Coder 1.35× · Heretic 1.26× · длинный контекст 32k 1.55×
// Вывод побитово идентичен обычному декодированию — спекуляция верифицируемая, не приближение.

import { gate } from "./lib/manage"
import { spawn } from "child_process"
import { homedir } from "os"
import path from "path"

const OMLX_PORT = 1236
const ADAPTER_PORT = 1237
/** Провайдер, объявленный скриптом scripts/dflash.sh в личном конфиге пользователя. */
const PROVIDER_ID = "dflash"

/** Одновременный подъём из двух ходов — один раз. Ключ не нужен: сервер ровно один. */
let starting: Promise<void> | null = null

/**
 * Два рантайма не должны держать по большой модели одновременно.
 *
 * ИЗМЕРЕНО 2026-08-20 на этой машине: приложение при старте грузит СВОЮ модель по умолчанию через
 * LM Studio (это делает автоподбор окна), и если следом выбрать ускоренную, в памяти оказываются обе —
 * 15 ГБ + 22 ГБ на 48-гигабайтной машине. Своп ушёл на 22.6 ГБ, сторож памяти oMLX упёрся в порог и
 * задушил генерацию до 0.2 ток/с вместо 101: ход просто не заканчивался. Освобождать надо здесь, в
 * момент ВЫБОРА, а не при подъёме серверов — приложение стартует позже и грузит модель обратно.
 *
 * Ничего не теряется: LM Studio поднимает свою модель сам по первому же обычному запросу.
 */
async function freeOtherRuntime(): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const p = spawn("/bin/bash", ["-lc", "command -v lms >/dev/null 2>&1 && lms unload --all >/dev/null 2>&1 || true"], {
        detached: false,
        stdio: "ignore",
      })
      const t = setTimeout(() => resolve(), 2500)
      p.on("exit", () => { clearTimeout(t); resolve() })
      p.on("error", () => { clearTimeout(t); resolve() })
    } catch {
      resolve()
    }
  })
}

function enabled() {
  return process.env["FABULA_DFLASH_AUTOSTART"] !== "0"
}

async function answers(port: number, ms = 1500): Promise<boolean> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: ac.signal })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

async function waitUp(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await answers(port, 700)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/**
 * Поднимает то, чего не хватает. Отсоединённо, чтобы процессы пережили этот ход; ждём только их
 * готовности. Никогда не бросает: не поднялось — запрос уйдёт как обычно и упадёт своей ошибкой,
 * а не нашей.
 */
async function bringUp(): Promise<void> {
  const home = homedir()
  const script = path.join(home, "GitHub", "FABULA-LLM-5", "scripts", "dflash.sh")
  await new Promise<void>((resolve) => {
    try {
      const p = spawn("/bin/bash", [script, "start"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      })
      p.unref()
      p.on("error", () => resolve())
      resolve()
    } catch {
      resolve()
    }
  })
  // Измерено: oMLX отвечает за ~2с, адаптер меньше секунды. Бюджет с запасом, но внутри лимита хука.
  await waitUp(OMLX_PORT, 3200)
  await waitUp(ADAPTER_PORT, 800)
}

export const FabulaDFlash = async () =>
  gate("dflash", {
    "chat.params": async (input: any) => {
      if (!enabled()) return
      try {
        const provider = String(input?.provider?.id ?? input?.model?.providerID ?? "")
        if (provider !== PROVIDER_ID) return
        // Каждый раз, а не только при первом подъёме: между ходами автоподбор окна мог снова
        // загрузить модель LM Studio, и тогда обе окажутся в памяти. Вызов дешёвый и идемпотентный.
        await freeOtherRuntime()
        if (await answers(ADAPTER_PORT, 600)) return
        if (!starting) starting = bringUp().finally(() => (starting = null))
        await starting
      } catch {
        // Ускорение — удобство, а не условие работы: любой сбой здесь молча уступает обычному пути.
      }
    },
  })
