// FABULA: local versioning — the app's own patch notes. Every deployed change lands here as a
// dated entry (newest first) and is shown in Settings > Changes. No network fetch: the log
// ships with the build, so it is always current for the binary the user runs.
export const FABULA_VERSION = "0.1.3"

export type ChangelogEntry = {
  version: string
  date: string // ISO yyyy-mm-dd
  items: { ru: string; en: string }[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.1.3",
    date: "2026-07-15",
    items: [
      {
        ru: "Агент больше не зацикливается на разговорных ответах. Раньше на обычный вопрос без правок в коде обвязка могла снова и снова перезапускать модель (она отвечала, а затем крутилась и не могла остановиться). Теперь чистый ответ на вопрос считается завершённым сразу, а проверка «докажи, что сделано» остаётся включённой только для реальной работы с кодом. Явная цель (/goal) не затронута — она по-прежнему доводится до конца.",
        en: "The agent no longer loops on conversational answers. Previously a plain question with no code changes could make the harness re-run the model over and over (it answered, then spun and could not stop). Now a pure answer is treated as complete immediately, while the \"prove it's done\" check stays on only for real code work. Explicit goals (/goal) are unaffected — they still run to completion.",
      },
    ],
  },
  {
    version: "0.1.2",
    date: "2026-07-13",
    items: [
      {
        ru: "Список моделей на главном экране теперь показывает только включённые модели — тот же фильтр, что в выборе модели в чате и в Настройках ▸ Модели. Раньше на главной показывались все модели без фильтра, из-за чего можно было выбрать скрытую модель.",
        en: "The model list on the home screen now shows only enabled models — the same visibility filter as the in-chat model picker and Settings ▸ Models. Previously the home screen listed every model unfiltered, so a hidden model could be picked.",
      },
    ],
  },
  {
    version: "0.1.1",
    date: "2026-07-13",
    items: [
      {
        ru: "Файловые инструменты (create_file, view, str_replace, note_append) стали устойчивее к неполным вызовам модели: если путь не передан, теперь возвращается понятная ошибка вместо системного сбоя, и принимается алиас file_path. Раньше пропущенный путь ронял инструмент с непонятным сообщением.",
        en: "The file tools (create_file, view, str_replace, note_append) are now resilient to incomplete model calls: a missing path returns a clear, actionable error instead of a raw crash, and the file_path alias is accepted. Previously a missing path failed the tool with an opaque type error.",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-07-13",
    items: [
      {
        ru: "Первый публичный релиз FABULA — локальный агент, где надёжность даёт обвязка, а не сама модель: любую модель можно подставить как чип, а «готово» подтверждается тестами, а не уверенностью модели.",
        en: "First public release of FABULA — a local-first agent where reliability comes from the harness, not the model: any model slots in as a chip, and \"done\" is proven by tests, not the model's confidence.",
      },
    ],
  },
]
