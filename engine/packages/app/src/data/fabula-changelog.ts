// FABULA: local versioning — the app's own patch notes. Every deployed change lands here as a
// dated entry (newest first) and is shown in Settings > Changes. No network fetch: the log
// ships with the build, so it is always current for the binary the user runs.
export const FABULA_VERSION = "0.3.4"

export type ChangelogEntry = {
  version: string
  date: string // ISO yyyy-mm-dd
  items: { ru: string; en: string }[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.3.4",
    date: "2026-07-21",
    items: [
      {
        ru: "Длинная задача перестала ходить по кругу, перечитывая одни и те же главы. По логам: сохранитель состояния, лишённый доступа к файлам проекта, сжигал свои попытки об отказы и завершался БЕЗ записи — но каждое его завершение всё равно сдвигало отметку «этот кусок разговора уже сохранён», навсегда выбрасывая несохранённый кусок; чекпоинт замирал на первом состоянии («следующий шаг: прочитать все 29 глав»), и каждое восстановление командовало агенту начать чтение заново — главы 1-10 были прочитаны по 3-4 раза. Закрыто тремя правками. (1) Отметка сдвигается ТОЛЬКО если файл чекпоинта реально изменился — сигнал берётся у файловой системы, не у модели. (2) В восстановление добавлен ИЗМЕРЕННЫЙ список уже прочитанных файлов — из журнала выполненных вызовов, которому нельзя не верить, с прямым указанием продолжать с непрочитанных. (3) Сохранителю прямо сказано: файлы проекта заблокированы, не пробуй ни разу, пиши из переданного разговора; частичная запись лучше отсутствующей.",
        en: "A long task no longer circles re-reading the same chapters. From the logs: the state writer, blocked from project files, burned its attempts on refusals and finished WITHOUT writing — yet every finish still advanced the \"this slice is saved\" watermark, discarding the unsaved slice forever; the checkpoint froze at its first state (\"next step: read all 29 chapters\"), and every rebuild commanded the agent to start reading over — chapters 1-10 were read 3-4 times each. Closed with three repairs. (1) The watermark advances ONLY if the checkpoint file actually changed — the signal comes from the filesystem, not the model. (2) The rebuild now carries a MEASURED list of files already read — from the ledger of executed calls, which cannot be disbelieved, with a direct instruction to continue with unread ones. (3) The writer is told outright: project files are blocked, do not try even once, write from the transcript you were handed; a partial checkpoint beats an unwritten one.",
      },
    ],
  },
  {
    version: "0.3.3",
    date: "2026-07-21",
    items: [
      {
        ru: "Сжатие длинного разговора перестало тихо убивать сессию. Найден точный механизм по живым данным: модель-сводчик, получив транскрипт, полный вызовов инструментов, ПРОДОЛЖАЛА разговор вместо суммирования — печатала вызовы инструментов текстом («Продолжаю чтение глав 7-12» + разметка вызовов), обвязка расценивала это как зацикленный текст и молча завершала сессию, записав этот мусор как сводку. Закрыто с трёх сторон: (1) движок помечает сборку сводчика, и все направляющие подсказки обвязки на ней замолкают — команда «читай дальше порциями» больше не попадает сводчику; (2) детерминированная проверка распознаёт «сводку», содержащую разметку вызовов, и повторяет суммирование один раз с прямой поправкой; (3) если и повтор сорвался — сессия показывает ЯВНУЮ ошибку сжатия вместо тихого конца с мусорной сводкой. Проверка распознавания воспроизводит оба живых случая байт-в-байт.",
        en: "Compacting a long conversation no longer kills the session silently. The exact mechanism was found from live data: the summarizer model, given a transcript full of tool calls, CONTINUED the conversation instead of summarizing — it printed tool calls as text (\"continuing chapters 7-12\" plus call markup), the harness classified that as looping text and silently ended the session, recording the garbage as its summary. Closed from three sides: (1) the engine marks the summarizer build and every steering hint of the harness stands down on it — the \"keep reading in batches\" directive no longer reaches the summarizer; (2) a deterministic check recognizes a \"summary\" containing call markup and retries the summarization once with a direct correction; (3) if the retry fails too, the session shows an EXPLICIT compaction error instead of a quiet ending with a garbage summary. The recognition check reproduces both live cases byte-for-byte.",
      },
    ],
  },
  {
    version: "0.3.2",
    date: "2026-07-21",
    items: [
      {
        ru: "Защита от зацикливания теперь покрывает КАЖДЫЙ инструмент, а не только перечисленные. На живом прогоне инструмент, отсутствовавший во всех списках, был вызван 148 раз подряд с одинаковым ответом «No handoffs.» — по старому правилу «неизвестный = без защиты» его никто не останавливал. Правило перевёрнуто: по умолчанию защищён любой инструмент, списки объявляют только исключения (изменяющие и ожидающие). И второй слой той же починки: раньше заблокированный вызов отвечал модели одинаковым текстом ошибки, и модель залипала на нём — 55 повторов подряд; теперь подавление возвращается как завершённый результат с меняющимся счётчиком попыток, так что одинакового стимула для залипания больше не существует. Проверено сквозным прогоном: разбор шести глав дошёл до конца — все главы прочитаны и разобраны в финальном ответе.",
        en: "Loop protection now covers EVERY tool, not only the listed ones. In a live run, a tool absent from every list was called 148 times in a row against the identical reply \"No handoffs.\" — under the old \"unknown = unprotected\" rule nothing stopped it. The rule is flipped: any tool is protected by default and the lists declare only exceptions (mutating and waiting ones). And a second layer of the same repair: a blocked call used to answer the model with the identical error text, and the model latched onto it — 55 retries in a row; suppression now returns as a completed result with a changing attempt counter, so an identical stimulus to latch onto no longer exists. Verified end-to-end: a six-chapter analysis ran to completion — every chapter read and covered in the final answer.",
      },
      {
        ru: "Длинная задача больше не может «закончиться», отчитавшись о прогрессе. Три сессии подряд разбор книги останавливался на «главы 2-4 прочитаны, продолжаю батчами» — и это считалось финишем. Причина найдена в страже «не заканчивать, пока не сделано»: два его предохранителя от старой петли на разговорных сессиях в сумме выключали его именно там, где живут длинные задачи. Во-первых, страж вообще не взводился в папке без тестов — а книга, исследование, архив документов как раз такие. Во-вторых, даже взведённый, он пропускал любой текстовый стоп без проверки судьёй, потому что чтение не оставляет правок кода. Теперь различие проведено структурно: ход, который вызывал инструменты, — это задача, и её стоп обязан пройти судью («достаточен ли уже ответ?», с жёсткими лимитами повторов); ход без единого вызова — разговор, и он завершается сразу, как и раньше. Никаких разборов формулировок и подкрученных чисел: только факт «были вызовы инструментов или нет».",
        en: "A long task can no longer \"finish\" by reporting progress. Three sessions in a row, a book analysis stopped at \"chapters 2-4 read, continuing in batches\" — and that counted as done. The cause was found in the finish-the-job gate: two of its safeguards against an old loop on conversational sessions jointly disabled it exactly where long tasks live. First, the gate never armed at all in a folder without tests — and a book, a research corpus, an archive of documents are exactly that. Second, even armed, it honored any text stop without consulting the judge, because reading leaves no code edits. The distinction is now structural: a turn that was calling tools is a task, and its stop must pass the judge (\"is the answer already sufficient?\", hard-capped on repeats); a turn without a single call is a conversation and still ends immediately. No wording analysis and no tuned numbers: only the fact of tool calls.",
      },
    ],
  },
  {
    version: "0.3.1",
    date: "2026-07-21",
    items: [
      {
        ru: "Задача больше не «завершается», объявив планы вместо работы. После сжатия длинного разговора первый же ход мог ответить только текстом — «теперь перехожу к главам, начну с первых пяти» — и на этом сессия заканчивалась: в папке без тестов страж цели сознательно не взводится, а остальные продолжатели ловят только правки кода или сломанный вывод. Теперь обвязка ловит именно этот случай структурно, без разбора формулировок: до сжатия шла работа инструментами, после — ход без единого вызова; такой стоп получает один принудительный ход-продолжение с указанием продолжить с места сводки. Повторный текст-без-работы уже не трогается — ограничение одним повтором заложено конструкцией. Новая грань зарегистрирована в реестре циклов с капом, выключатель FABULA_POST_COMPACTION_CONTINUE=0.",
        en: "A task no longer \"finishes\" by announcing plans instead of doing the work. After a long conversation was compacted, the very next turn could reply with text only — \"now I'll move on to the chapters, starting with the first five\" — and the session ended there: in a folder with no tests the goal gate deliberately never arms, and the other continuation contracts only catch code edits or malformed output. The harness now catches exactly this case structurally, with no wording analysis: tools were running before the compaction, and the turn after it made not a single call; such a stop gets one forced continuation turn told to pick up where the summary left off. A second text-only stop is left alone — the one-repeat bound is built into the construction. The new edge is registered in the loop registry with its cap; kill-switch FABULA_POST_COMPACTION_CONTINUE=0.",
      },
      {
        ru: "Свернув боковую панель в окне уже 1280 пикселей, её снова можно развернуть. Сама панель существует с ширины 768, а кнопка разворота в шапке появлялась только с 1280 — в этом диапазоне свернуть было можно, а вернуть нельзя. Теперь кнопка живёт на тех же ширинах, что и панель; проверено живым кликом на окне 1100.",
        en: "Collapsing the sidebar in a window narrower than 1280 pixels no longer traps it collapsed. The panel itself exists from 768 wide, but its expand button in the header only appeared from 1280 — in that range you could collapse and never restore. The button now lives on the same widths as the panel; verified by a live click in a 1100-wide window.",
      },
      {
        ru: "Долгие ходы перестали заново пересчитывать сотни килобайт промпта. Замер на живой сессии: переиспользование кэша застыло на 34-37%, около 430 КБ пересчитывались на каждом шаге, и холодные пересчёты затягивались настолько, что сторож обрывал здоровые ответы. Корень: два служебных напоминания («контекст заполняется» и «шаги повторяются») подмешивались к раннему сообщению истории только в памяти — на одних ходах они есть, на других нет, — и каждое мигание меняло байты в начале истории, обесценивая кэш всего, что после. Теперь напоминание записывается в историю насовсем: один сдвиг кэша при появлении и ноль после; его текст больше не меняется от хода к ходу. Попутно закрыт второй способ того же класса: адаптер читал часть настроек до загрузки .env, из-за чего эти настройки молча игнорировались; порядок исправлен. Проверено на стенде: последовательные ходы теперь переиспользуют 100% префикса.",
        en: "Long turns stopped recomputing hundreds of kilobytes of prompt. Measured live: cache reuse was frozen at 34-37%, about 430 KB re-computed on every step, and cold recomputes ran long enough that the watchdog cut healthy responses. Root cause: two service reminders (\"context is filling up\" and \"steps are repeating\") were attached to an EARLY message of the history in memory only — present on some turns, absent on others — and every flicker changed bytes near the start of history, invalidating the cache of everything after. The reminder is now written into history permanently: one cache shift when it appears and none after; its wording no longer varies between turns. A second door of the same class was closed alongside: the adapter read some settings before loading .env, so those settings were silently ignored; the order is corrected. Verified on the rig: consecutive turns now reuse 100% of the prefix.",
      },
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-21",
    items: [
      {
        ru: "Каждая сессия больше не тратит один полный прогон модели впустую. Чтобы длинный разговор не терялся, обвязка периодически сохраняет его состояние, и моменты сохранения назначались в процентах от объёма памяти модели. Но в этот объём каждый запрос заново входит постоянная часть — описание агента и всех инструментов, — и на этой сборке она одна занимает 40 291 единиц из 131 072, то есть 31%, тогда как первое сохранение назначено на 20%. Порог оказывался пройден ещё до того, как вы что-либо попросили: сохранялся разговор из одного сообщения, и на это уходил целый прогон модели. Теперь проценты отсчитываются от места, реально доступного разговору, а постоянная часть измеряется у самой сессии — поэтому ничего не подкручено под конкретную сборку: смените модель, промпт или набор инструментов, и отсчёт перестроится сам. Последнее сохранение при этом по-прежнему происходит ДО переполнения — простое вычитание сдвинуло бы его за границу памяти и лишило смысла, поэтому сделано иначе.",
        en: "Every session no longer wastes one full model run on nothing. To keep a long conversation from being lost, the harness periodically saves its state, and the moments to save were set as percentages of the model's memory. But every request re-includes a constant part — the description of the agent and of every tool — and on this build that alone takes 40,291 units out of 131,072, i.e. 31%, while the first save is set at 20%. The threshold was therefore crossed before you had asked for anything: a conversation of one message was saved, and a whole model run went into it. The percentages now count from the room actually available to the conversation, and the constant part is measured from the session itself — so nothing is tuned to one build: change the model, the prompt or the tool set and the count re-derives itself. The final save still happens BEFORE an overflow: plain subtraction would have pushed it past the memory limit and defeated its purpose, so it is done differently.",
      },
    ],
  },
  {
    version: "0.2.9",
    date: "2026-07-21",
    items: [
      {
        ru: "Работа больше не ползёт из-за фонового агента, который крутится вхолостую. Замер на живой сессии: один сохраняющий агент сделал 476 ходов, повторив один и тот же вызов 456 раз, и забрал 62,6 млн входных токенов против 2,1 млн у агента, который реально делал вашу задачу — то есть около 97% машины. Отсюда и «семь глав за два часа». Причин было три, и все закрыты. Во-первых, обвязка уничтожала аргументы вызова: модель присылает их в плоском виде, а обвязка вырезала их как посторонние, и до инструмента доходила пустота с ответом «неверные аргументы» — повторять было бессмысленно, но и добиться успеха невозможно; теперь плоская форма приводится к правильной, и вызов срабатывает с первого раза. Во-вторых, защита от зацикливания судила по ИМЕНИ инструмента: инструмент задач считался «изменяющим» целиком, хотя его операция «перечислить» только читает, — и его повторы не проверялись вовсе; теперь решает сама операция, поэтому под защиту попадают и инструменты, которых ещё не существует. В-третьих, проверка до вызова и запись после вызова считали одну и ту же операцию разными вызовами, так что повтор никогда не накапливался. Порогов и подкрученных чисел не добавлено: признак остаётся строгим — одинаковые аргументы дали побайтово одинаковый ответ, значит новых сведений ноль. Повтор, который приносит новый результат, не ограничивается никогда, а ожидание остаётся ожиданием.",
        en: "Work no longer crawls because a background agent is spinning on nothing. Measured on a live session: one saving agent took 476 turns, repeating a single identical call 456 times, and consumed 62.6M input tokens against 2.1M for the agent actually doing your task — about 97% of the machine. That is where \"seven chapters in two hours\" came from. There were three causes and all are closed. First, the harness was destroying the call's arguments: the model sends them flat, the harness stripped them as foreign, and the tool received nothing and answered \"invalid arguments\" — retrying was pointless, yet succeeding was impossible; the flat form is now reshaped into the valid one and the call works first time. Second, loop protection judged by the tool's NAME: the task tool counted as \"mutating\" as a whole even though its \"list\" operation only reads, so its repeats were never checked at all; the operation itself now decides, which also covers tools that do not exist yet. Third, the check before a call and the record after it treated one operation as two different calls, so a repeat never accumulated. No thresholds or tuned numbers were added: the criterion stays strict — identical arguments produced a byte-identical answer, so there is nothing new. A repeat that produces a new result is never restricted, and waiting stays waiting.",
      },
    ],
  },
  {
    version: "0.2.8",
    date: "2026-07-21",
    items: [
      {
        ru: "Долгая задача больше не начинается заново после того, как часть работы уже сделана. Когда разговор упирается в предел, обвязка сохраняет состояние сессии и продолжает с него — сохранением занят отдельный фоновый агент. Оказалось, что на задаче «прочти все главы» этот агент вместо записи сводки уходил читать сам проект: сначала папку, потом файл за файлом — и на большой книге исчерпывал свой предел, так и не дойдя до записи. Сводка оставалась пустым бланком, разговор обнулялся на этой пустоте, и агент честно начинал задачу с нуля, потеряв всё сделанное. За одну сессию так отработали восемь сохранений подряд, и ни одно ничего не записало. Теперь фоновому агенту доступны только его собственные рабочие файлы: он составляет сводку по разговору, который ему передан, а не восстанавливает её, вычитывая ваш проект. Проверено сквозным прогоном на том же стенде: раньше текст глав попадал в его контекст, теперь не попадает ни разу, при этом сводка пишется. Остальных агентов правка не касается — чтение файлов у них прежнее.",
        en: "A long task no longer starts over after part of the work is already done. When a conversation reaches its limit, the harness saves the session's state and continues from it, and a separate background agent does that saving. On a \"read all the chapters\" task that agent turned out to be reading the project instead of writing the summary: first the folder, then file after file — and on a large book it exhausted its own limit without ever reaching the write. The summary stayed an empty form, the conversation was reset onto that emptiness, and the agent honestly began the task from zero, losing everything already done. Eight saves ran in a single session and not one recorded anything. The background agent can now reach only its own working files: it writes the summary from the conversation it was handed rather than reconstructing it by reading your project. Verified end-to-end on the same rig: chapter text used to enter its context and now never does, while the summary is still written. No other agent is affected — file reading is unchanged for them.",
      },
    ],
  },
  {
    version: "0.2.7",
    date: "2026-07-20",
    items: [
      {
        ru: "Долгая задача «прочти все главы и разбери» больше не роняет модель. Раньше такое чтение набивало в один контекст целую книгу, и за пределом памяти видеокарты сервер модели падал посреди ответа — красное «модель упала … Exit code: null» после многих минут работы. Причины было две, закрыты обе. (1) Модель грузилась с окном 256K и 4 параллельными слотами — это учетверяло память под кэш; теперь окно 128K и 2 слота (для одиночной работы скорость та же, память вчетверо меньше), и этот безопасный дефолт прописан в самой LM Studio, так что переживает перезапуск. (2) Новый страж бюджета контекста: у границы окна он велит агенту сжать прочитанное в сводку и выкинуть сырой текст, а на запрос «прочитать всё» — читать порциями с накопительной сводкой, чтобы переполнение вообще не начиналось. На обычных ходах страж бездействует и оставляет сообщение байт-в-байт — обычная работа не платит ничего. Отключается FABULA_CTX_GUARD=0.",
        en: "A long \"read all the chapters and analyse them\" task no longer crashes the model. That kind of reading used to load a whole book into one context, and past the GPU's memory budget the model server died mid-answer — the red \"the model has crashed … Exit code: null\" after many minutes of work. There were two causes; both are closed. (1) The model was loaded with a 256K window and 4 parallel slots, which quadrupled the memory reserved for the cache; it is now a 128K window with 2 slots (for single-user work the speed is identical and the memory is a quarter), and that safe default is written into LM Studio itself so it survives a restart. (2) A new context-budget guard: near the edge of the window it tells the agent to summarise what it has read and drop the raw text, and on a \"read everything\" request it steers to reading in batches with a running summary, so the overflow never begins. On ordinary turns the guard does nothing and leaves the message byte-for-byte — normal work pays nothing. Kill-switch FABULA_CTX_GUARD=0.",
      },
    ],
  },
  {
    version: "0.2.6",
    date: "2026-07-20",
    items: [
      {
        ru: "Модель больше не думает, что сегодня другой день. В системном промте была ЗАШИТА дата, и модель верила ей — поэтому «новости за сегодня» она привязывала к дате недельной давности (и, не имея доступа к сети без веб-поиска, попросту их выдумывала). Теперь актуальная дата вычисляется на КАЖДОМ ходу и подаётся модели как единственно верная, а зашитая дата из промта убрана. Плюс: список плагинов в статус-панели теперь прокручивается, а при наведении показывает имя и назначение плагина, а не путь к файлу. И самое важное для новостей: если вопрос про свежее (сегодня, последние, курс, кто выиграл), обвязка теперь ЗАСТАВЛЯЕТ модель сначала сходить в веб-поиск и ответить по найденному со ссылками — раньше модель отвечала из памяти и выдумывала новости; проверено живым прогоном (реальные ссылки вместо галлюцинаций).",
        en: "The model no longer thinks today is a different day. The system prompt had a HARDCODED date and the model believed it — so \"today's news\" was anchored to a date weeks in the past (and, with no network access short of web search, it simply made the news up). The current date is now computed on EVERY turn and given to the model as authoritative, and the baked-in date is removed from the prompt. Also: the plugin list in the status panel now scrolls, and hovering a plugin shows its name and what it does rather than a file path. And most important for news: when a question is about fresh information (today, latest, a price, who won), the harness now FORCES the model to web-search first and answer from what it found WITH links — the model used to answer from memory and fabricate; verified by a live run (real links instead of hallucinations).",
      },
    ],
  },
  {
    version: "0.2.5",
    date: "2026-07-20",
    items: [
      {
        ru: "Чек о выполненной работе перестал утверждать больше, чем проверяет. Он всегда делал два очень разных заявления: «код проходит свои тесты» — это ДОРОГО подделать, и это всегда по-настоящему перепроверялось прогоном патча в одноразовом дереве; и «работала вот эта модель, вот эти веса, вот такой контекст» — это ПОДДЕЛАТЬ ДЁШЕВО, и это просто печаталось обратно из того же файла, который проверка должна была проверять. То есть проверялась трудная половина, а лёгкая возвращалась эхом, и в выводе они выглядели одинаково. Теперь каждое утверждение о личности попадает ровно в одно из трёх состояний и называет его: перепроверено здесь, здесь непроверяемо, либо НЕСОВПАДЕНИЕ. Несовпадение валит утверждение о личности, но никогда — о работе: пересчёт доказывает, что стоит на ЭТОЙ машине сейчас, поэтому проверяющий на другой машине честно говорит «здесь проверить нельзя», а не «твоя работа не доказана». Самое дешёвое противоречие — когда хеш дескриптора не совпадает с дескриптором, напечатанным рядом, — ловится вообще без сети, кем угодно и навсегда. Плюс: если строгая проверка воспроизводимости не отработала и деградировала до мягкой, чек теперь ОБ ЭТОМ ГОВОРИТ, а отсутствие вердикта печатается как «неизвестно», а не как зелёный. Отключается переменной FABULA_RECHECK=0, возвращающей прежний вывод байт-в-байт.",
        en: "The Proof-of-Done receipt stopped asserting more than it checks. It always made two very different claims: 'the code passes its tests' — EXPENSIVE to forge, and always genuinely re-run by replaying the patch in a throwaway worktree; and 'this model, these weights, this context' — CHEAP to forge, and simply printed back out of the very file the verification was meant to be checking. The hard half was verified and the easy half was echoed, and in the output they looked the same. Now every identity claim lands in exactly one of three states and names it: re-verified here, not checkable here, or MISMATCH. A mismatch fails the identity claim and never the work claim: recomputing proves what THIS machine serves now, so a verifier elsewhere honestly says 'I cannot check this here' rather than 'your work is unproven'. The cheapest contradiction of all — a descriptor hash that does not match the descriptor printed beside it — is detectable with no network, by anyone, forever. Also: when the strict reproduce probe could not run and degraded to the permissive fallback, the receipt now SAYS SO, and an absent verdict prints as unknown rather than as a pass. FABULA_RECHECK=0 restores the previous output byte-for-byte.",
      },
    ],
  },
  {
    version: "0.2.4",
    date: "2026-07-20",
    items: [
      {
        ru: "Память, которую можно ПРОВЕРИТЬ, а не принять на веру (новый плагин, по умолчанию ВЫКЛЮЧЕН). (1) Память, рождённая из проверенного хода, привязывается в момент записи к коду, о котором она, и перед выдачей привязка перепроверяется по реальному дереву — обычным хешированием файлов, без модели и без сети. Код ушёл вперёд — память не отдаётся вовсе либо вместо неё отдаётся ТЕКУЩИЙ исходник; она никогда не выдаётся с пометкой «возможно устарело», потому что оговорка рядом с памятью измеримо ухудшает решение, а не смягчает его. (2) Сырые записи больше не уничтожаются: консолидация дописывает новую запись и сначала дословно архивирует то, что поглощает; вытеснение объявляет, сколько записей ушло, а не молча урезает. Проходы движка, которые раньше перезаписывали заметки шаблоном и удаляли «устаревшее», теперь сначала архивируют и уводят в раздел «Заменено». (3) Жёсткие ограничения больше не режутся по длине: раньше попадёт ли правило к модели зависело от того, на какой строке файла его набрали. (4) Повышение памяти решается по исходу вашей же проверки — не по повторяемости и не по мнению модели — и стартует в тени: решение пишется в журнал и ни на что не влияет, пока вы это не включите. Честно: помогает ли эта память — ещё никто не измерил. Побочно: панель плагинов перестала показывать выключенные плагины включёнными, а юнит-тесты перестали ходить к живому модельному серверу (сьют стал быстрее на четверть).",
        en: "Memory you can CHECK rather than trust (new plugin, ships OFF). (1) A memory formed from a verified turn is bound at write time to the code it is about, and that binding is re-checked against the real tree before the memory is ever served — plain file hashing, no model, no network. If the code moved on, the memory is withheld or the CURRENT source is served in its place; it is never handed over with a 'possibly stale' label, because a hedge beside a memory measurably worsens the decision rather than softening it. (2) Raw records are no longer destroyed: consolidation appends a new record and archives what it consumes verbatim first, and shedding declares how many records it dropped instead of quietly truncating. The engine passes that used to overwrite notes with a template and delete 'obsolete' entries now archive first and retire into a Superseded section. (3) Hard constraints are no longer cut by length: whether a rule reached the model used to depend on which line of the file someone typed it on. (4) Promotion is decided from your own verifier's outcome — not repetition, not the model's opinion — and starts in shadow: the decision is journalled and acts on nothing until you enable it. Honestly: nobody has yet measured whether this memory helps. Alongside: the plugins panel stopped reporting disabled plugins as enabled, and unit tests stopped calling a live model server (the suite got a quarter faster).",
      },
    ],
  },
  {
    version: "0.2.3",
    date: "2026-07-20",
    items: [
      {
        ru: "Обвязка теперь САМА зовёт второе мнение и САМА себя не разоружает. (1) Когда проверки падают подряд, решение «просить ли помощи» больше не сводится к счётчику: складываются наблюдаемые улики — сколько раз проверка была красной, возвращается ли агент правкой в один и тот же файл, сколько времени уже сожжено на этой серии. Если несколько независимых сигналов сходятся, второе мнение запрашивается РАНЬШЕ, чем счётчик дошёл бы до порога; при этом ни одна улика не может пронести прогон МИМО прежних порогов — старые константы остались полом. И запрос уходит сам: раньше обвязка лишь советовала модели позвать помощь, а совет модель вольна проигнорировать. (2) Каждое такое решение пишется в журнал вместе с исходом, так что впервые можно измерить, вовремя ли обвязка просит помощи, а не только что она это умеет. (3) Надзорный слой больше не выключается изнутри прогона: режим «полный доступ» действует, только если его включили ВЫ (в настройках или переменной окружения) — выставленный самим агентом он записывается, показывается и не действует; ключевые плагины защиты нельзя отключить изнутри прогона; файлы, где всё это хранится, закрыты и от файловых инструментов, и от шелла, в том числе через символическую ссылку. (4) Плагин, который агент пишет сам себе, проверяется не только на форму, но и на возможности: запуск процессов, выполнение кода на лету, чтение учётных данных — отказ на этапе записи. Это экран, а не песочница, и так и написано в его описании. Всё перечисленное отключается переменными окружения.",
        en: "The harness now asks for a second opinion ITSELF, and can no longer disarm itself. (1) When verifications keep failing, the decision to ask for help is no longer a bare counter: observable evidence adds up — how many verifications went red, whether attempts keep returning to the same file, how much time the streak has burned. When several independent signals agree, the second opinion is requested EARLIER than the counter would have; and no evidence can carry a run PAST the old thresholds, which remain a floor. The request also fires by itself: previously the harness only advised the model to ask, and advice is something a model may ignore. (2) Every such decision is recorded with its outcome, so for the first time it is possible to measure whether the harness asks for help at the right moments rather than merely that it can. (3) The supervision layer can no longer be switched off from inside a run: full-access mode counts only when YOU set it (in settings or an environment variable) — set by the agent it is recorded, surfaced and ignored; the core protective plugins cannot be disabled from inside a run; and the files holding all of this are closed to the file tools and to the shell alike, including via a symlink. (4) A plugin the agent writes for itself is now checked for capabilities as well as shape: spawning processes, evaluating code at runtime, reading credential material are refused at write time. It is a screen, not a sandbox, and its own description says so. Everything above can be disabled via environment variables.",
      },
    ],
  },
  {
    version: "0.2.2",
    date: "2026-07-19",
    items: [
      {
        ru: "Адаптер локальных моделей стал диспетчером, а не трубой. (1) Тяжёлые запросы к модели теперь СЕРИАЛИЗУЮТСЯ: параллельные сессии, фоновые проходы и проверки больше не давят префилл одновременно (на потребительском железе это роняло скорость всем сразу) — лишние запросы честно ждут в очереди, стриминговый клиент получает keepalive-сигналы, а health-проверка приложения и эмбеддинги идут мимо очереди без задержки. Очередь никогда не блокирует намертво: по таймауту запрос проходит в любом случае. (2) Сторожевой таймер простоя больше не одна константа на всех: адаптер измеряет реальные паузы между токенами по каждой модели и размеру запроса и выставляет порог по фактам — залипший поток режется быстрее, а легитимно медленный больше не убивается. (3) Телеметрия разрыва кэша теперь называет ПРИЧИНУ: контент сдвинулся (наша инъекция выше стабильного блока — и виновник называется поимённо) или контент реально изменился. Все три механизма отключаемы переменными окружения.",
        en: "The local-model adapter became a dispatcher, not a pipe. (1) Heavy model requests are now SERIALIZED: parallel sessions, background passes and checks no longer hammer prefill at once (on consumer hardware that collapsed speed for everyone) — excess requests genuinely queue, a streaming client gets keepalive signals, and the app's health probe and embeddings bypass the queue with no delay. The queue can never block for good: past a timeout the request proceeds regardless. (2) The idle watchdog is no longer one constant for everyone: the adapter measures the real inter-token pauses per model and request size and sets the threshold from evidence — a wedged stream is cut sooner, a legitimately slow one is no longer killed. (3) Cache-break telemetry now names the CAUSE: content merely shifted (our own injection above a stable block — and the offender is named) versus content that really changed. All three mechanisms can be disabled via environment variables.",
      },
    ],
  },
  {
    version: "0.2.1",
    date: "2026-07-19",
    items: [
      {
        ru: "Один из внутренних гейтов мог продлевать ход почти без предела — исправлено. Гейт незакрытых фоновых задач имеет лимит: не больше 3 подталкиваний «доделай задачу» за ход. Но свой счётчик он обнулял сам — и когда упирался в лимит, и когда доска задач разгребалась. Из-за этого лимит взводился заново: другой гейт продлевал ход, задачи появлялись снова, и гейт получал ещё 3 подталкивания. Ограничения переставали складываться и начинали ПЕРЕМНОЖАТЬСЯ, а каждое лишнее подталкивание — это полный вызов модели. Теперь счётчик обнуляется только на настоящей границе хода (новое сообщение от вас), так что за один ход гейт не превысит свои 3, а следующий ход по-прежнему начинается с чистого листа. Правило вынесено в общую функцию, которую исполняет и движок, и его проверка, — разъехаться они не могут. Заодно объявлен полный список всех мест, откуда ход может продлиться: добавить новое, не объявив его, теперь нельзя — падает тест.",
        en: "One internal gate could stretch a turn almost without limit — now it cannot. The gate for unfinished background tasks has a cap: at most 3 'please finish the task' nudges per turn. But it reset its own counter — both when it hit the cap and when the task board emptied. That re-armed the cap: another gate would carry the turn forward, tasks would appear again, and the gate earned another 3. The bounds stopped adding up and started MULTIPLYING, and every extra nudge is a full model call. The counter is now reset only at a real turn boundary (a new message from you), so within one turn the gate can never exceed its 3, while the next turn still starts fresh. The rule now lives in one shared function that both the engine and its guard execute, so the two cannot drift apart. Alongside it, every place a turn can be extended from is now declared in one registry: adding a new one without declaring it fails a test.",
      },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-07-19",
    items: [
      {
        ru: "Судья, решающий «закончен ли ход», больше не имеет последнего слова в одиночку. Раньше это был ОДИН вызов той же модели, что и работала, — худшая из возможных калибровок: уверенное «готово» завершало ход, даже если динамика прогона кричала обратное. Теперь харнесс передаёт судье траекторию, которую измерил САМ (сколько проверок прошло и провалилось и какая была последней, сколько раз откатывались файлы, были ли правки, которые ни разу не проверялись), — и вдобавок ОТКЛОНЯЕТ вердикт «готово», если динамика самоочевидно говорит «не готово»: последняя проверка красная, несколько красных без единой зелёной, выставлен терминальный вердикт NOT DONE, или код правился и ни разу не проверялся. Это не новая петля: отказ уходит в тот же ограниченный путь повторного захода — счётчик по-прежнему завершает ход, а зелёная проверка снимает отказ. Детерминированно и одинаково для любой модели в сокете. Выключатель: FABULA_JUDGE_HARD_VETO=0.",
        en: "The judge that decides whether a turn is finished no longer gets the last word alone. It used to be ONE call on the SAME model that did the work — the worst possible calibration: a confident 'done' ended the turn even when the run's dynamics said otherwise. Now the harness hands the judge the trajectory it measured ITSELF (how many verifies passed and failed and which came last, how many times files were rolled back, whether code was edited and never verified) — and on top of that OVERRIDES a 'done' verdict when the dynamics are self-evidently not-done: the last verify was red, several reds with never a green, a terminal NOT DONE verdict was stamped, or source was edited and never verified. This is not a new loop: the refusal falls into the same bounded re-entry path — the cap still ends the turn, and a green verify clears the veto. Deterministic and identical for any model in the socket. Kill-switch: FABULA_JUDGE_HARD_VETO=0.",
      },
    ],
  },
  {
    version: "0.1.9",
    date: "2026-07-19",
    items: [
      {
        ru: "Авто-откат при повторном провале стал умнее по трём осям. (1) Проваленные попытки теперь убираются из контекста модели: когда обвязка откатывает файлы к последнему зелёному состоянию, транскрипт неудачных правок больше не тянется в следующий шаг — повтор идёт «с чистого листа», а не по замусоренному (повтор в загрязнённом контексте многократно повышает вероятность ошибки). (2) Вместо generic «попробуй другой подход» — обоснованный диагноз: обвязка вытаскивает КОНКРЕТНУЮ строку ошибки (а не общую сводку вроде «FAILED»), называет повторяющуюся первопричину по всей серии красных и указывает файл, который правили. (3) Леджер побочных эффектов: откат возвращает только файлы, поэтому неидемпотентные команды из откачённых попыток (установки пакетов, миграции БД, сетевые POST'ы, git push, запуск контейнеров) НЕ отменяются и могут сработать дважды — теперь стир об этом честно предупреждает.",
        en: "Auto-rewind on repeated failure got smarter on three axes. (1) The failed attempts now leave the model's context: when the harness reverts the files to the last green state, the transcript of the failed edits no longer carries into the next step — the retry starts from a clean slate instead of a contaminated one (retrying with the failed attempt still in context multiplies the error rate). (2) Instead of a generic 'try a different approach', the steer is a grounded diagnosis: the harness extracts the SPECIFIC error line (not a generic 'FAILED' summary), names the recurring root-cause signature across the whole red streak, and points at the edited file. (3) Side-effect ledger: the revert restores files only, so non-idempotent commands from the reverted attempts (package installs, DB migrations, network POSTs, git push, container starts) are NOT undone and may double-apply — the steer now warns about them honestly.",
      },
    ],
  },
  {
    version: "0.1.8",
    date: "2026-07-19",
    items: [
      {
        ru: "Гейт «сначала репродукция» теперь ВАЛИДИРУЕТ репро-тест, а не только проверяет его наличие. Прежде хватало любого добавленного теста, чтобы зелёный verify устоял. Теперь харнесс прогоняет новый тест против до-патчевого дерева (восстановленного из теневого леджера во временную копию — рабочее дерево не трогается): тест, зелёный И с фиксом, И без него, — фейковый, гейт остаётся закрыт; фикс, ломающий соседний тест, — регрессия (pass-to-pass), тоже не проходит; провалидированный тест «замораживается» по хэшу — правка после зелёного пере-взводит гейт; а репро, зелёный на неизменённом дереве без правок кода, засчитывается как проверенное «изменений не требуется». Где проверку прогнать нельзя (нет базы, verify только в контейнере, неизвестный раннер) — честная деградация к прежнему поведению с пометкой not-validated; гейт никогда не запирает верный фикс.",
        en: "The reproduce-first gate now VALIDATES the reproduction test instead of only checking that one exists. Before, any added test let a green verify stand. Now the harness runs the new test against the pre-patch tree (rebuilt from the shadow ledger into a temp copy — the working tree is never touched): a test that is green both WITH and WITHOUT the change is fake and the gate stays closed; a fix that breaks a sibling test is a regression (pass-to-pass) and is also held; a validated test is frozen by hash so editing it after green re-arms the gate; and a repro that passes on the unmodified tree with no source change is honored as a verified no-change done. Where the check cannot run (no base, a container-only verify, an unknown runner) it degrades honestly to the prior behavior with a not-validated marker — the gate never traps a correct fix.",
      },
    ],
  },
  {
    version: "0.1.7",
    date: "2026-07-17",
    items: [
      {
        ru: "Защита от зацикливания теперь ловит повторные веб-поиски с перефразированным запросом. Раньше агент мог десятки раз подряд искать одно и то же, чуть меняя формулировку (одинаковый набор слов в другом порядке), и защита этого не видела — она сравнивала вызовы побайтово и знала только кодовый поиск по списку имён. Теперь любой поисковый инструмент (включая MCP с любым префиксом) распознаётся по имени, запросы сравниваются по набору слов, повтор блокируется со второго раза с подсказкой «используй уже найденное или ищи принципиально другое», а бюджет различных поисков за ход принуждает к синтезу ответа.",
        en: "The loop guard now catches repeated web searches with paraphrased queries. Previously the agent could search for the same thing dozens of times in a row with slightly reworded queries (the same word set in a different order) and the guard was blind to it — it compared calls byte-for-byte and only knew code-search tools by a name list. Now any search tool (including MCP tools with any prefix) is recognized by name pattern, queries are compared by their word set, a repeat is blocked from the second occurrence with guidance to use what was already found or search for something materially different, and a per-turn budget of distinct searches forces answer synthesis.",
      },
    ],
  },
  {
    version: "0.1.6",
    date: "2026-07-17",
    items: [
      {
        ru: "Экран «сервер не запустился» стал полезным: теперь на английском (как всё приложение по умолчанию), кнопка «Copy diagnostics» реально копирует диагностику с хвостом лога движка (через системный буфер обмена — раньше не работала вовсе), и главное — экран сам продолжает следить за движком и автоматически загружает интерфейс, как только тот дозреет. Медленный первый старт больше не оставляет пользователя на мёртвой странице ошибки.",
        en: "The \"server didn't start\" screen is now useful: English by default (like the whole app), the Copy diagnostics button actually copies — including the engine log tail — via the system clipboard (it previously did nothing), and most importantly the screen keeps watching the engine and loads the UI automatically the moment it comes up. A slow first boot no longer strands you on a dead error page.",
      },
    ],
  },
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
