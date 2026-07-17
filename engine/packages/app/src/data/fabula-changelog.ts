// FABULA: local versioning — the app's own patch notes. Every deployed change lands here as a
// dated entry (newest first) and is shown in Settings > Changes. No network fetch: the log
// ships with the build, so it is always current for the binary the user runs.
export const FABULA_VERSION = "0.1.5"

export type ChangelogEntry = {
  version: string
  date: string // ISO yyyy-mm-dd
  items: { ru: string; en: string }[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.1.5",
    date: "2026-07-17",
    items: [
      {
        ru: "Политика «нецензурированная модель не самоулучшается автономно» теперь закрывает ОБА фоновых прохода: к заблокированному ранее distill добавлен dream (консолидация памяти) — раньше он проходил мимо защиты и читал историю проекта на нецензурированной модели. Решение принимает один общий механизм, так что будущие проходы не смогут проскочить незамеченными.",
        en: "The \"an uncensored model never self-improves autonomously\" policy now covers BOTH background passes: dream (memory consolidation) joins the already-blocked distill — previously it slipped past the guard and read project history on an uncensored model. One shared decision point now covers every pass, so future passes cannot slip by unnoticed.",
      },
    ],
  },
  {
    version: "0.1.4",
    date: "2026-07-17",
    items: [
      {
        ru: "Движок больше не умирает на старте в свежем клоне: он писал .gitignore в конфиг-каталог проекта (.fabula/), которого в свежем клоне нет — NotFound убивал запуск, окно показывало UnknownError. Теперь движок сам создаёт каталог перед записью и переживает NotFound/PermissionDenied (деградация до «без .gitignore», не краш); setup.sh дополнительно создаёт .fabula/ заранее, чтобы движки, собранные до этого фикса, тоже запускались.",
        en: "The engine no longer dies at startup in a fresh clone: it wrote a .gitignore into the project config dir (.fabula/), which a fresh clone lacks — the NotFound killed startup and the window showed UnknownError. The engine now creates the directory before writing and survives NotFound/PermissionDenied (degrading to \"no .gitignore\", not a crash); setup.sh additionally pre-creates .fabula/ so engines built before this fix boot too.",
      },
    ],
  },
  {
    version: "0.1.3",
    date: "2026-07-17",
    items: [
      {
        ru: "Команда fabula больше не захватывается посторонним движком: setup.sh предпочитал уже стоящий на PATH mimo только что собранному движку репозитория — на машине с прежней установкой MiMoCode приложение открывало ЧУЖОЙ движок с его интерфейсом и конфигом внутри окна FABULA. Теперь репо-движок bin/fabula всегда в приоритете (mimo с PATH — только запасной вариант, когда репо-бинарь не собран), а существующий exec-шим fabula перенацеливается на правильный движок при повторном запуске setup.sh; настоящий бинарь fabula на PATH не трогается.",
        en: "The fabula command can no longer be hijacked by an unrelated engine: setup.sh preferred a mimo already on PATH over the repo engine it had just built — on a machine with a pre-existing MiMoCode install the app opened a FOREIGN engine with its own UI and config inside the FABULA window. The repo-local bin/fabula now always wins (a PATH mimo is only the fallback when the repo binary is absent), and an existing fabula exec-shim is repointed to the right engine on setup.sh re-runs; a real fabula binary on PATH is left alone.",
      },
    ],
  },
  {
    version: "0.1.2",
    date: "2026-07-17",
    items: [
      {
        ru: "Починен краш приложения при первом запуске на свежей машине (SIGABRT в UNUserNotificationCenter): app/build.sh собирал бандл без Info.plist — без CFBundleIdentifier macOS роняет процесс при инициализации системных уведомлений. Теперь build.sh пишет ПОЛНЫЙ бандл (Info.plist с версией из changelog, PkgInfo, иконка — источник app/icon.icns добавлен в репозиторий) и подписывает его после всех ресурсов, а Swift-код дополнительно гейтит все обращения к уведомлениям на резолвимый bundle identifier — сломанный бандл деградирует до «без системных уведомлений», а не падает.",
        en: "Fixed the app crashing on first launch on a fresh machine (SIGABRT inside UNUserNotificationCenter): app/build.sh produced a bundle without Info.plist — without CFBundleIdentifier macOS aborts the process when system notifications initialize. build.sh now writes the COMPLETE bundle (Info.plist versioned from the changelog, PkgInfo, icon — source app/icon.icns added to the repo) and signs it after all resources land, and the Swift code additionally gates every notification-framework touch on a resolvable bundle identifier — a broken bundle degrades to \"no system notifications\" instead of crashing.",
      },
    ],
  },
  {
    version: "0.1.1",
    date: "2026-07-17",
    items: [
      {
        ru: "Установщик зависимостей больше не пытается выполнить как shell-команду человеческие инструкции из манифеста («Install LM Studio (…)», «Run a SearXNG instance (…)» и т.п.) — раньше это падало с синтаксической ошибкой bash на скобках. Такие шаги теперь помечены manual и во всех трёх путях установки (setup.sh, CLI, инструмент install_plugin_deps в чате) печатаются как подсказка, а выполняются только настоящие команды. Добавлен тест, который парсит каждую исполняемую install-строку через bash -n.",
        en: "The dependency installer no longer tries to execute human guidance from the manifest (\"Install LM Studio (…)\", \"Run a SearXNG instance (…)\", etc.) as a shell command — it used to crash with a bash syntax error on the parentheses. Such steps are now flagged manual and all three install paths (setup.sh, the CLI, the in-chat install_plugin_deps tool) print them as guidance, executing only real commands. A new test bash -n-parses every runnable install string.",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-07-16",
    items: [
      {
        ru: "Первый публичный релиз FABULA — агентная обвязка, где доверие принадлежит доказательству, а не модели: любая модель ставится в сокет как чип, «готово» подтверждается тестами, а каждый полностью проверенный прогон чеканит воспроизводимый чек Proof-of-Done с полным отпечатком контекста — хэш промпта и схем инструментов, хэш текста запроса, дескриптор обслуживавшей модели и опциональный настоящий хэш файлов весов. Чек может перепроверить кто угодно одной командой.",
        en: "First public release of FABULA — an agent harness where trust belongs to the proof, not the model: any model slots into the socket as a chip, \"done\" is proven by tests, and every fully-gated run mints a replayable Proof-of-Done receipt carrying the full context identity — prompt and tool-schema fingerprints, a hash of the request text, the serving model's descriptor, and an optional real digest of the weight files. Anyone can re-verify a receipt with one command.",
      },
    ],
  },
]
