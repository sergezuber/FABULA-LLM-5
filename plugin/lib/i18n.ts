// Human-readable, localized names + "what it's for" descriptions for each plugin, keyed by plugin id.
// Kept OUT of manifest.ts so the manifest stays a pure dependency/tooling source of truth. Consumed by
// scripts/manage-cli.ts (→ the in-app Plugins panel and the menu-bar Plugins menu), which picks the
// language from the app's current locale. `descEn` intentionally explains the PURPOSE in plain language
// (not tool names), because users asked "what is this plugin FOR?".
//
// `tags` are the SAME capability tags used in the session timeline and the README plugins table
// (graph/web/code/files/…): one vocabulary everywhere — timeline, panel, README, list_plugins.

export interface PluginI18n {
  nameRu: string
  descEn: string
  descRu: string
  tags: string[]
}

export const PLUGIN_I18N: Record<string, PluginI18n> = {
  tools: {
    tags: ["web", "code", "files", "moa"],
    nameRu: "Базовые инструменты",
    descEn: "The agent's everyday toolkit — fetch and search the web, run shell commands and code, read and edit files, look up weather and places, and poll several models at once.",
    descRu: "Повседневный набор агента — доступ в интернет и поиск, запуск команд и кода, чтение и правка файлов, погода и места, опрос нескольких моделей сразу.",
  },
  graph: {
    tags: ["graph"],
    nameRu: "Граф рабочего процесса",
    descEn: "Breaks a big task into up to 5 isolated sub-steps, runs the independent ones in parallel, then merges the results. Can optionally escalate heavy steps to a cloud model.",
    descRu: "Разбивает крупную задачу на ≤5 изолированных под-шагов, независимые выполняет параллельно и собирает результат. Опционально отправляет тяжёлые шаги в облако.",
  },
  handoff: {
    tags: ["handoff"],
    nameRu: "Передача контекста",
    descEn: "Saves durable, safety-scanned hand-off notes so context survives between steps and sessions.",
    descRu: "Сохраняет надёжные проверенные «эстафетные» заметки, чтобы контекст не терялся между шагами и сессиями.",
  },
  checkpoint: {
    tags: ["checkpoint"],
    nameRu: "Контрольные точки и откат",
    descEn: "Auto-snapshots each file before the agent edits it, into a private store separate from your git — so you can undo the agent's changes or diff them, even in a non-git project.",
    descRu: "Автоматически снимает состояние файла перед правкой в отдельное хранилище (не ваш git) — можно откатить изменения агента или сравнить их, даже вне git-проекта.",
  },
  reliability: {
    tags: ["reliability"],
    nameRu: "Надёжность",
    descEn: "Keeps runs healthy — stops repeat-loops, repairs malformed tool calls, can nudge an agent stuck in endless exploration to start implementing (opt-in budget), and can push notifications when a run finishes or gets stuck.",
    descRu: "Держит работу стабильной — гасит зацикливания, чинит некорректные вызовы инструментов, подталкивает агента, застрявшего в бесконечном исследовании, начать реализацию (опциональный бюджет) и шлёт уведомления о завершении или зависании.",
  },
  security: {
    tags: ["security"],
    nameRu: "Безопасность",
    descEn: "Safety layer — blocks requests to internal addresses (SSRF), hides secrets in output, and isolates untrusted text so it can't hijack the agent (prompt-injection defense).",
    descRu: "Слой защиты — блокирует запросы к внутренним адресам (SSRF), прячет секреты в выводе и изолирует недоверенный текст от перехвата агента (защита от prompt-injection).",
  },
  context: {
    tags: ["memory"],
    nameRu: "Контекст и память",
    descEn: "Injects your curated memory into the agent, and merges multiple system messages into one for providers that reject more than one.",
    descRu: "Подмешивает вашу память в контекст агента и склеивает несколько системных сообщений в одно для строгих провайдеров.",
  },
  ctxguard: {
    tags: ["reliability", "context"],
    nameRu: "Защита бюджета контекста",
    descEn: "Stops a single turn from outgrowing the model's context window. A 'read every chapter / all files' task loads the whole corpus into one context, and past the device's memory budget the model server crashes mid-answer ('the model has crashed … Exit code: null'). Near the window it tells the agent to summarise what it has read and drop the raw text; on a bulk-read request it steers to reading in batches with a running summary. Idle on normal turns, so it costs nothing until the context is genuinely large.",
    descRu: "Не даёт одному ходу перерасти контекстное окно модели. Задача «прочти все главы / все файлы» грузит весь корпус в один контекст, и за пределом памяти устройства сервер модели падает посреди ответа («модель упала … Exit code: null»). У границы окна велит агенту сжать прочитанное в сводку и выкинуть сырой текст; на запрос «прочитать всё» направляет читать порциями с накопительной сводкой. На обычных ходах бездействует — ничего не стоит, пока контекст не стал по-настоящему большим.",
  },
  ops: {
    tags: ["ops"],
    nameRu: "Планировщик и операции",
    descEn: "Schedule recurring or one-off jobs (via launchd), track them with overdue detection, and send notifications.",
    descRu: "Планирование повторяющихся и разовых задач (через launchd), учёт с детекцией просрочки и уведомления.",
  },
  multimodal: {
    tags: ["voice"],
    nameRu: "Мультимодальность (зрение/TTS/STT)",
    descEn: "Adds senses — analyze images, speak replies aloud (text-to-speech), and transcribe audio to text (speech-to-text).",
    descRu: "Добавляет «органы чувств» — анализ изображений, озвучивание ответов (TTS) и распознавание речи в текст (STT).",
  },
  vision: {
    tags: ["vision"],
    nameRu: "Синхронизация зрения моделей",
    descEn: "Auto-detects which of your loaded models can actually see images (LM Studio vision models) and flags them accordingly.",
    descRu: "Автоматически определяет, какие из загруженных моделей умеют «видеть» изображения (vision-модели LM Studio), и помечает их.",
  },
  browser: {
    tags: ["browser"],
    nameRu: "Управление браузером",
    descEn: "Lets the agent drive a real web browser — open pages, click, type, screenshot, and read them.",
    descRu: "Позволяет агенту управлять настоящим браузером — открывать страницы, кликать, вводить текст, делать скриншоты и читать содержимое.",
  },
  readfloor: {
    tags: ["housekeeping"],
    nameRu: "Порог чтения файлов",
    descEn: "Raises the default read limit so the agent reads whole files at once (this build has a large context window).",
    descRu: "Поднимает лимит чтения, чтобы агент читал файлы целиком (у сборки большое контекстное окно).",
  },
  unknowns: {
    tags: ["code", "memory"],
    nameRu: "Поиск неизвестного",
    descEn: "Closes the gap between your ask and the real codebase before coding: finds existing working code to copy the contract from (reference_hunt), surfaces what the task doesn't say grounded in the real code (surface_unknowns), and nudges you to do that before editing source in an unfamiliar area.",
    descRu: "Закрывает разрыв между запросом и реальным кодом ДО написания: находит существующий рабочий код, с которого копировать контракт (reference_hunt), вскрывает то, что не сказано в задаче, опираясь на реальный код (surface_unknowns), и подсказывает сделать это перед правкой исходника в незнакомой области.",
  },
  brainstorm: {
    tags: ["code"],
    nameRu: "Мозговой штурм прототипов",
    descEn: "When you know the feel but can't describe it, gives you 3-5 wildly different throwaway options to react to — each labeled with the bet it makes — so you find what you want by choosing, not by explaining.",
    descRu: "Когда чувствуешь, чего хочешь, но не можешь описать — даёт 3-5 совсем разных черновых вариантов, каждый со своей ставкой, чтобы ты нашёл нужное выбором, а не объяснением.",
  },
  shipnotes: {
    tags: ["code", "handoff"],
    nameRu: "Заметки и питч",
    descEn: "Keeps a running log of what you changed and why while you build, then packages the change into a demo-first document a reviewer can approve quickly (what it does, why, decisions, risks).",
    descRu: "Ведёт журнал того, что и зачем ты менял по ходу работы, затем собирает изменение в demo-first документ, который ревьюер быстро одобрит (что делает, зачем, решения, риски).",
  },
  interview: {
    tags: ["code", "memory"],
    nameRu: "Интервью (триаж неизвестного)",
    descEn: "For an underspecified task, separates what the codebase can answer (resolve by reading) from the one decision only you can make, and asks you just that one question — instead of the agent silently guessing an architecture.",
    descRu: "Для недосказанной задачи отделяет то, что может ответить код (резолвится чтением), от единственного решения, которое можешь принять только ты, и задаёт ровно этот один вопрос — вместо того чтобы агент молча угадал архитектуру.",
  },
  "change-quiz": {
    tags: ["reliability", "code"],
    nameRu: "Гейт-квиз изменения",
    descEn: "Before a change is called done, makes the agent pass a 3-question quiz about its own diff, graded against the actual diff — so a change that only looks right but isn't understood doesn't slip through.",
    descRu: "Перед тем как изменение объявят готовым, заставляет агента пройти квиз из 3 вопросов о собственном дифе, оцениваемый по реальному дифу — чтобы изменение, которое лишь выглядит верным, но не понято, не проскочило.",
  },
  "attest": {
    tags: ["reliability"],
    nameRu: "Универсальный гейт проверки",
    descEn: "Verifies the deliverable of ANY task, not just code. It breaks a written analysis, plan or summary into typed atomic claims and independently re-derives each: a quote must match its cited source verbatim (checked in the RIGHT source, so mis-attribution is caught), a number must appear in the source, a 'read all N files' claim is checked against the run ledger. Only the claims that fail the free deterministic check reach a quarantined language model that separates a faithful paraphrase from a fabrication. Load-bearing claims that don't hold come back with a specific fix. It stays silent on chat and opinion turns, and lives entirely in a plugin hook — never the stop logic. Experimental, off by default until benchmarked.",
    descRu: "Проверяет результат ЛЮБОЙ задачи, не только кода. Разбирает написанный анализ, план или свод на типизированные атомарные утверждения и независимо пере-выводит каждое: цитата обязана дословно совпасть с указанным источником (сверяется в ПРАВИЛЬНОМ источнике — ловится мис-атрибуция), число обязано быть в источнике, заявление «прочитаны все N файлов» сверяется с журналом прогона. До дорогой модели доходит только остаток, не прошедший бесплатную детерминированную проверку — она отделяет верный перефраз от фабрикации, читая источник в карантине. Несущие утверждения, что не устояли, возвращаются с конкретной правкой. Молчит на разговорных и оценочных ходах, живёт целиком в плагинном хуке — не в стоп-логике. Экспериментальный, по умолчанию выключен до бенча.",
  },
  "reproduce-gate": {
    tags: ["reliability", "code"],
    nameRu: "Гейт «сначала репродукция»",
    descEn: "Won't let a green verify stand on a reproduction test it can't trust. It runs the new test against the pre-patch tree: a test that passes with AND without the change is fake (gate stays closed), a fix that breaks a sibling test is a regression (held), and a validated test is frozen so it can't be loosened after going green. When it can't run the check it degrades honestly and never traps a correct fix.",
    descRu: "Не даёт зелёному verify устоять на репро-тесте, которому нельзя доверять. Прогоняет новый тест против до-патчевого дерева: тест, зелёный И с фиксом, И без него — фейковый (гейт закрыт), фикс, ломающий соседний тест — регрессия (не пропускает), а провалидированный тест «заморожен» и его нельзя ослабить после зелёного. Если проверку прогнать нельзя — честно деградирует и никогда не запирает верный фикс.",
  },
  learn: {
    tags: ["memory", "code"],
    nameRu: "Обучение (нудж упаковки скила)",
    descEn: "After you finish and verify a real multi-step change, nudges you to package that fresh trajectory into a reusable skill (/distill) — so next time it's one command, not a new trajectory. Never runs distill for you.",
    descRu: "После того как ты закончил и проверил реальное многошаговое изменение, подсказывает упаковать свежую траекторию в переиспользуемый скил (/distill) — чтобы в следующий раз это была одна команда, а не новая траектория. Сам distill не запускает.",
  },
  selfextend: {
    tags: ["code"],
    nameRu: "Саморасширение (пишет тулы)",
    descEn: "Lets the model author a NEW tool/plugin for itself when a capability is missing (create_plugin). The harness scaffolds it, enforces the one-plugin-per-file contract before writing, and refuses a body that spawns processes, evaluates code at runtime, reads credential material or edits the supervision layer's own state — a self-written plugin runs with full privileges ahead of every guard. It is a screen, not a sandbox. Callable after the next engine start. The supervised model grows its own supervised tool belt.",
    descRu: "Позволяет модели написать себе НОВЫЙ тул/плагин, когда возможности не хватает (create_plugin). Обвязка генерирует каркас, детерминированно проверяет контракт «один плагин — один файл» до записи и отказывает телу, которое запускает процессы, выполняет код на лету, читает учётные данные или правит состояние самого надзорного слоя — самописный плагин работает с полными правами раньше всех гвардов. Это экран, а не песочница. Тул доступен после следующего старта движка. Поднадзорная модель наращивает свой поднадзорный пояс инструментов.",
  },
  memory: {
    tags: ["memory", "code"],
    nameRu: "Заякоренная память (из проверенной работы)",
    descEn: "Memory that can be CHECKED instead of trusted. A memory formed from a verified turn is bound at write time to the code it is about — today the file and its exact bytes (symbol-span scope exists and is used where a symbol is known, but the writer for a verified turn records a path only, so such a memory invalidates on any edit to that file) — and re-checked against the real tree before it is ever served back. If the code moved on, the memory is withheld or the CURRENT source is served instead; it is never handed over with a 'possibly stale' label, because a hedge beside a memory measurably worsens the decision rather than softening it. Raw episodes are append-only and never destroyed by consolidation. Promotion is decided from the project's own verifier — an outcome produced outside the model — and starts in shadow: journalled, acting on nothing, until someone has read the record.",
    descRu: "Память, которую можно ПРОВЕРИТЬ, а не принять на веру. Память, рождённая из проверенного хода, привязывается в момент записи к коду, о котором она — сегодня это файл и его точные байты (привязка к диапазону символа реализована и работает там, где символ известен, но писатель проверенного хода передаёт только путь, поэтому такая память протухает при ЛЮБОЙ правке этого файла) — и перед выдачей привязка перепроверяется по реальному дереву. Код ушёл вперёд? Память не отдаётся вовсе либо вместо неё отдаётся ТЕКУЩИЙ исходник; она никогда не выдаётся с пометкой «возможно устарело», потому что оговорка рядом с памятью измеримо ухудшает решение, а не смягчает его. Сырые эпизоды дописываются и никогда не уничтожаются консолидацией. Повышение решается по исходу проверки самого проекта — то есть снаружи модели — и стартует в тени: решение пишется в журнал и ни на что не влияет, пока запись не прочли.",
  },
  escalate: {
    tags: ["code", "graph"],
    nameRu: "Эскалация в облако (второе мнение)",
    descEn: "When you're stuck — the same fix keeps failing verification, or you can't find the root cause — escalate_to_cloud asks a stronger cloud model for a second opinion on the same problem and returns a concrete root cause + next step, so you stop looping on a dead-end approach. The harness also fires it ITSELF when the measured evidence agrees another local attempt is not worth its cost — advice a model may ignore is not a mechanism. Bounded per task and disableable. Needs a cloud provider in the config.",
    descRu: "Когда ты застрял — одна и та же правка снова не проходит проверку, или не находится корневая причина — escalate_to_cloud запрашивает у более сильной облачной модели второе мнение по той же задаче и возвращает конкретную причину + следующий шаг, чтобы ты перестал крутиться на тупиковом подходе. Обвязка вызывает его и САМА, когда измеренные улики сходятся на том, что ещё одна локальная попытка не окупится — совет, который модель вольна проигнорировать, механизмом не является. Ограничено по числу на задачу и отключается. Нужен облачный провайдер в конфиге.",
  },
  rewind: {
    tags: ["code", "housekeeping"],
    nameRu: "Авто-откат при повторном провале",
    descEn: "When each of your edits keeps the verify RED, the harness reverts for you: it snapshots the state on a green verify, and after a couple of consecutive red verifies it atomically rolls the files back to that last good checkpoint (its own shadow-git — your real repo is untouched). It also drops the failed attempts from your context so the retry starts clean instead of contaminated, names the recurring root-cause failure signature (not a generic 'try again'), and — if the reverted attempts ran non-idempotent commands (installs, migrations, network calls) — warns you those side effects were NOT undone and may double-apply.",
    descRu: "Когда каждая твоя правка оставляет проверку КРАСНОЙ, обвязка откатывает за тебя: на зелёной проверке делает снимок, а после пары подряд красных атомарно возвращает файлы к последнему хорошему чекпоинту (свой теневой git — твой настоящий репозиторий не трогается). А ещё убирает проваленные попытки из твоего контекста, чтобы повтор шёл с чистого листа, а не по замусоренному; называет повторяющуюся первопричину провала (а не generic «попробуй ещё»); и — если откачённые попытки запускали неидемпотентные команды (установки, миграции, сетевые вызовы) — предупреждает, что эти побочные эффекты НЕ отменены и могут сработать дважды.",
  },
  // ── Disrupt layer — proof economy on top of the receipt (all defaultEnabled:false) ──
  registry: {
    tags: ["code", "web"],
    nameRu: "Реестр доказательств (публикация/проверка)",
    descEn: "Turns a local Proof-of-Done receipt into something the world can find and re-verify: publish it to a content-addressed store (keyed by the patch + its test command, so it can't be forged), replay any receipt by id or URL in a throwaway checkout, or search what you've published. Off by default.",
    descRu: "Превращает локальный чек Proof-of-Done в то, что мир может найти и перепроверить: публикует в контент-адресуемое хранилище (ключ = патч + его тест-команда, подделать нельзя), проигрывает любой чек по id или URL в одноразовой копии, ищет опубликованное. По умолчанию выключен.",
  },
  witness: {
    tags: ["code", "moa"],
    nameRu: "Свидетель другой модели (независимая проверка диффа)",
    descEn: "Has a model of a DIFFERENT family (vendor/lineage — enforced, not just a different id) adversarially review your diff and record CONFIRMED or DISPUTED next to the receipt (the receipt itself is never touched). A green build says your own tests pass; a witness says someone independent, who can't rubber-stamp, agrees. Off by default.",
    descRu: "Заставляет модель ДРУГОГО семейства (вендор/линейка — проверяется жёстко, а не просто другой id) критически отревьюить твой дифф и записывает CONFIRMED/DISPUTED рядом с чеком (сам чек не трогается). Зелёная сборка говорит «мои тесты прошли»; свидетель говорит «независимый, кто не может подмахнуть, согласен». По умолчанию выключен.",
  },
  daemon: {
    tags: ["code", "ops"],
    nameRu: "Автономный демон (посыл KAIROS + темп + опрос PR)",
    descEn: "An always-on autonomous posture (enabled with FABULA_DAEMON=1): the session paces itself, acts on its own judgment, and honestly polls a GitHub PR for new activity — and its background 'done' still runs the same gates and mints a replayable receipt, so overnight autonomy can't lie. Off by default.",
    descRu: "Постоянно-включённый автономный режим (при FABULA_DAEMON=1): сессия сама задаёт темп, действует по своему суждению и честно опрашивает GitHub-PR на новую активность — а фоновое «готово» всё равно гоняет те же гейты и минтит воспроизводимый чек, так что ночная автономия не соврёт. По умолчанию выключен.",
  },
  relay: {
    tags: ["code", "graph"],
    nameRu: "Облачное реле (лестница эскалации → облако пишет патч)",
    descEn: "When the local model is truly stuck, a stronger cloud model writes the fix as a diff — which is NEVER trusted: the local model applies it and re-runs the same gates. An escalation ladder bounded by attempt/cost/time budgets, so a run reaches VERIFIED or asks you a precise question — it never quietly gives up. Off by default.",
    descRu: "Когда локальная модель реально застряла, более сильная облачная пишет фикс диффом — которому НИКОГДА не доверяют: локальная применяет его и заново гоняет те же гейты. Лестница эскалации с бюджетами по попыткам/стоимости/времени, так что прогон доходит до VERIFIED или задаёт точный вопрос — но не сдаётся молча. По умолчанию выключен.",
  },
  coordinator: {
    tags: ["code", "graph"],
    nameRu: "Координатор (дерево суб-чеков)",
    descEn: "When work is split across workers, each leaves its own Proof-of-Done receipt; this joins them into a proof tree whose composite verdict is honest — VERIFIED only if EVERY worker's receipt is VERIFIED, one NOT DONE anywhere fails the whole run. Supply-chain provenance for a team of agents. Off by default.",
    descRu: "Когда работа разделена между воркерами, каждый оставляет свой чек Proof-of-Done; плагин собирает их в дерево доказательств с честным сводным вердиктом — VERIFIED только если чек КАЖДОГО воркера VERIFIED, один NOT DONE где угодно валит весь прогон. Провенанс цепочки поставок для команды агентов. По умолчанию выключен.",
  },
  "tool-router": {
    tags: ["code", "housekeeping"],
    nameRu: "Роутер инструментов (профили на задачу)",
    descEn: "Per-task tool selection (Context OS): each real user message is deterministically classified into a closed profile — coding / web-research / full — and only that profile's tool schemas reach the model. Cuts the #1 prefill cost while keeping the tool set byte-stable within a task (the local model's KV-cache survives) and per-session (parallel chats never clash). Gate tools are never masked; a masked tool called by name still runs via shadow dispatch. Needs FABULA_TOOL_ROUTER=1. Off by default.",
    descRu: "Выбор инструментов под задачу (Context OS): каждое настоящее сообщение пользователя детерминированно классифицируется в закрытый профиль — coding / web-research / full — и до модели доходят только схемы инструментов профиля. Режет главный prefill-кост, при этом набор байт-стабилен внутри задачи (KV-кэш локальной модели живёт) и хранится пер-сессионно (параллельные чаты не конфликтуют). Гейт-инструменты не маскируются никогда; замаскированный инструмент, вызванный по имени, всё равно исполнится через shadow-dispatch. Требует FABULA_TOOL_ROUTER=1. По умолчанию выключен.",
  },
  buddy: {
    tags: ["housekeeping"],
    nameRu: "Питомец (растёт только от проверенной работы)",
    descEn: "A small companion whose look is fixed by your user id but whose level and stats are EARNED only from verified work — a passed receipt grows it, a NOT DONE receipt grows nothing, and three publicly-witnessed proofs upgrade it to legendary. A reward you can't fake. Off by default.",
    descRu: "Маленький питомец, чей вид задан твоим id, но чей уровень и статы ЗАРАБОТАНЫ только проверенной работой — пройденный чек растит его, чек NOT DONE не растит ничего, а три публично засвидетельствованных доказательства повышают до легендарного. Награда, которую нельзя подделать. По умолчанию выключен.",
  },
  receipt: {
    tags: ["code"],
    nameRu: "Чек Proof-of-Done",
    descEn: "On a green verify, mints a machine-readable Proof-of-Done receipt — the backing model, the gates that fired, the diff, the exact verification command, and a one-command replay — so anyone can re-verify your work without trusting you. Written next to the project in .fabula/receipts/.",
    descRu: "На зелёном verify выписывает машиночитаемый чек Proof-of-Done — модель, сработавшие гейты, дифф, точную команду проверки и команду переигровки — чтобы любой мог перепроверить работу, не доверяя на слово. Пишется рядом с проектом в .fabula/receipts/.",
  },
  "distill-guard": {
    tags: ["housekeeping"],
    nameRu: "Защита от авто-обучения",
    descEn: "Blocks the harness's automatic self-improvement passes — distill and dream memory consolidation — on uncensored models, where they would clash with policy.",
    descRu: "Блокирует автоматические само-улучшающие проходы движка — distill и dream-консолидацию памяти — на нецензурированных моделях, где они конфликтуют с политикой.",
  },
  "purge-hook": {
    tags: ["housekeeping"],
    nameRu: "Полное удаление чатов",
    descEn: "When you delete a chat, wipes all of its artifacts completely — no recoverable trace (privacy).",
    descRu: "При удалении чата полностью стирает все его следы — без возможности восстановления (приватность).",
  },
  manage: {
    tags: ["manage"],
    nameRu: "Менеджер плагинов",
    descEn: "This panel — list plugins with dependency health, turn them on/off, and install a plugin's missing dependencies. Cannot be turned off.",
    descRu: "Эта панель — список плагинов со статусом зависимостей, включение/выключение и доустановка недостающих зависимостей. Выключить нельзя.",
  },
}
