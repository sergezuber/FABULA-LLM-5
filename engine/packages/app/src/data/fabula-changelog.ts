// FABULA: local versioning — the app's own patch notes. Every deployed change lands here as a
// dated entry (newest first) and is shown in Settings > Changes. No network fetch: the log
// ships with the build, so it is always current for the binary the user runs.
export const FABULA_VERSION = "0.48.0"

export type ChangelogEntry = {
  version: string
  date: string // ISO yyyy-mm-dd
  items: { ru: string; en: string }[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.48.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Очередь к модели научилась различать, кто в ней стоит. Раньше она обслуживала строго по порядку прихода — а это неверный вопрос, когда первым попросила служебная работа, а ждёт человек. Теперь запрос живого хода проходит вперёд, служебный по-прежнему выполняется и по-прежнему в своём порядке, но никогда впереди вас. Тот, кто не назвал себя, считается живым ходом: ошибиться в эту сторону безопасно.",
        en: "The queue to the model can now tell who is standing in it. It used to serve strictly by order of arrival — the wrong question when background work asked first and a person is waiting. A live turn now goes ahead; background work still runs, still in its own order, but never in front of you. A caller that does not identify itself counts as a live turn: that is the safe way to be wrong.",
      },
    ],
  },
  {
    version: "0.47.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Служебная запись состояния больше не отнимает у вас модель. Она запускалась прямо посреди вашего хода и вставала с ним в одну очередь: за пятнадцать минут такие записи выдали десять сообщений против ваших трёх, а каждый запрос к модели простаивал в очереди в среднем 72 секунды, худший — пять минут. Просьба вроде «переведи это» была не медленной — она просто не считалась. Теперь запись ждёт, пока вы освободитесь, и пропускается совсем, если тишины так и не наступило: она описывает разговор до этого момента, поэтому более поздний срез несёт больше, а не меньше.",
        en: "The background state record no longer takes the model away from you. It started in the middle of your own turn and joined the same queue: over fifteen minutes such records produced ten messages against your three, while every request to the model spent an average of 72 seconds waiting, the worst of them five minutes. A request like 'translate this' was not slow — it simply was not being computed. It now waits until you are free, and is skipped altogether if quiet never comes: it describes the conversation up to that point, so a later cut carries more of it, never less.",
      },
    ],
  },
  {
    version: "0.46.0",
    date: "2026-07-27",
    items: [
      {
        ru: "Публичная страница проекта теперь обновляется вместе с кодом, а не когда-нибудь. Выпуск на GitHub отставал от готового приложения на пять версий, а README обещал 64 инструмента при реальных 80: работа была сделана и выложена, но человеку, открывшему страницу, её не было видно. Теперь каждая отправка кода обязана в тот же заход обновить выпуск, заметки к нему и числа в описании — с проверкой, что после последней метки не осталось неописанных изменений.",
        en: "The project's public page is now updated together with the code, rather than eventually. The GitHub release trailed the working app by five versions, and the README promised 64 tools where there are 80: the work was done and shipped, yet invisible to anyone opening the page. Every push must now refresh the release, its notes and the figures in the description in the same pass — checked by confirming nothing undescribed remains after the latest tag.",
      },
    ],
  },
  {
    version: "0.45.0",
    date: "2026-07-27",
    items: [
      {
        ru: "Ничто из запущенного FABULA больше не переживает FABULA. Долгую работу над книгой запускают отдельным процессом нарочно — иначе она погибнет вместе с ходом, который её попросил. Но такой процесс усыновляется системой и не попадал под уборку при выходе, которая доставала только прямых потомков: один такой, оставшийся от закрытой сессии, часами продолжал обращаться к модели и пережил несколько перезапусков. В ответ на его запросы поднималась вторая копия модели, две копии не поместились в память, и та, что обслуживала ваш ход, была убита — восемь с половиной минут работы пропали. Теперь каждый такой процесс записывается в момент рождения, гасится при выходе из приложения, а при старте гасятся те, чей движок уже мёртв. Признак — хозяин, а не возраст: книга законно читается долго.",
        en: "Nothing FABULA starts outlives FABULA any more. Long work over a book runs as a separate process on purpose — otherwise it dies with the turn that asked for it. But such a process is adopted by the system and was missed by the shutdown, which reached only direct descendants: one left over from a closed session went on calling the model for hours and survived several restarts. A second copy of the model was loaded to answer it, two copies did not fit in memory, and the one serving your own turn was killed — eight and a half minutes of work lost. Every such process is now written down at birth, stopped when the app quits, and any whose engine is already gone are stopped at startup. The test is ownership, not age: a book legitimately takes a long time to read.",
      },
    ],
  },
  {
    version: "0.44.0",
    date: "2026-07-27",
    items: [
      {
        ru: "Проверка утверждений в готовом тексте теперь оставляет след, который переживает сам разговор: рядом со свидетельством появляется запись о том, что именно проверялось — отпечаток текста, отпечатки источников, перечень утверждений и исход дешёвой проверки по каждому. Само свидетельство при этом не изменяется ни на байт.",
        en: "The check on claims in finished text now leaves a trace that outlives the conversation: beside the proof appears a record of what was checked — a fingerprint of the text, fingerprints of the sources, the list of claims and the outcome of the cheap check for each. The proof itself is not altered by a single byte.",
      },
      {
        ru: "Записывается только то, что читатель может перепроверить сам. Часть выводов делает модель, и повторить их нельзя — ни настройки, ни то, какая именно модель отвечала, не сохраняются. Такие выводы отмечаются как непроверяемые здесь, а не выдаются за установленный факт: запись, которую нельзя оспорить, ничего не доказывает.",
        en: "Only what a reader can re-check is written down. Some conclusions are reached by a model and cannot be repeated — neither the settings nor which model answered are preserved. Those are marked as not verifiable here rather than presented as established fact: a record nobody can dispute proves nothing.",
      },
    ],
  },
  {
    version: "0.43.0",
    date: "2026-07-27",
    items: [
      {
        ru: "Две внутренние заметки о состоянии памяти не могли быть записаны вообще: они обращались к средству вывода, которого в этом файле нет, и ошибка тут же поглощалась. Одна из них считалась работающей с момента выпуска и не выдала ни одной строки — наблюдение, неспособное заговорить, выглядит точно как спокойная машина.",
        en: "Two internal notes about memory state could not be written at all: they called an output helper that does not exist in that file, and the error was swallowed on the spot. One of them had counted as working since release and had never produced a single line — an observation that cannot speak looks exactly like a quiet machine.",
      },
      {
        ru: "Добавлено предупреждение о запросе, который просит больше контекста, чем модель загружена держать. Раньше такой запрос уходил без единой проверки, а отказ приходил не сообщением, а гибелью процесса на середине ответа. Это наблюдение, а не запрет: оценка идёт от символов, и отказ с такой погрешностью срабатывал бы на длинных текстах, ради которых всё и делается.",
        en: "Added a warning for a request asking for more context than the model was loaded to hold. Such a request used to go through unchecked, and the refusal arrived not as a message but as the process dying mid-answer. It observes rather than blocks: the estimate comes from characters, and a refusal with that margin would fire on exactly the long texts this exists to support.",
      },
      {
        ru: "Одна измеренная величина вместо трёх расходящихся: сколько символов приходится на единицу текста при подсчёте. Три места хранили три разных числа для одного и того же, расходясь между собой в полтора раза, и одно из них заставляло сжимать контекст раньше необходимого.",
        en: "One measured figure instead of three that disagreed: how many characters a unit of text holds when counting. Three places held three different numbers for the same thing, half again apart, and one of them made the context be compacted earlier than needed.",
      },
    ],
  },
  {
    version: "0.42.0",
    date: "2026-07-27",
    items: [
      {
        ru: "Проверка утверждений в готовом тексте обращалась к модели по адресу, который не принимает нужную ей форму запроса — на чистой установке она была направлена туда, где не могла получить ответ. Теперь обращение идёт через тот же переходник, что и вся остальная работа с моделью.",
        en: "The check that verifies claims in finished text was pointed at an address that does not accept the request form it needs — on a clean install it was aimed where it could not be answered. It now goes through the same adapter as every other call to the model.",
      },
      {
        ru: "Шестьдесят настроек читались кодом и не были названы ни в одном примере конфигурации, включая те, что задают модель для этой проверки. Настроить то, чего файл не называет, невозможно. Все они описаны, и добавлена проверка в обе стороны: нельзя читать неописанное и нельзя описывать то, что не читается.",
        en: "Sixty settings were read by the code and named in no example configuration, including the ones that point the check above at a model. What a file does not name cannot be configured. All are now described, with a check in both directions: nothing may be read undocumented, and nothing documented may go unread.",
      },
    ],
  },
  {
    version: "0.41.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Обвязка сама измеряет, во что ей обходится память под контекст, вместо того чтобы ждать повторной загрузки ради этого замера. Раньше единственный путь узнать эту величину стоил выгрузки и загрузки модели заново; теперь достаточно одного обычного запроса, и рабочий кэш остаётся тёплым. Под тестами замер не производится — иначе набор, обязанный быть замкнутым, обращался бы к настоящей модели.",
        en: "The harness now measures what context memory costs it from an ordinary request, instead of paying for a reload to find out. The only way to learn that figure used to be unloading and loading the model again; one real request is enough, and the working cache stays warm. Under a test run the measurement is skipped — otherwise a suite that must be self-contained would reach a real model.",
      },
      {
        ru: "Убран список инструментов, который ничего не делал и вводил в заблуждение: его пояснение описывало правило, противоположное действующему. Ни один читатель кода не должен узнавать политику из комментария, который её искажает.",
        en: "Removed a tool list that did nothing and misled: its comment described the opposite of the rule actually in force. No reader should learn a policy from a comment that misstates it.",
      },
    ],
  },
  {
    version: "0.40.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Добавлена проверка, которая ищет написанный, но никем не вызываемый код. Это самый частый способ, которым правка выглядит сделанной и не работает: механизм есть, тесты на него зелёные, а из рабочего пути его никто не зовёт. Проверка требует, чтобы у каждого исключения была причина, которую человек может взвесить, — иначе список исключений становится местом, куда прячут ту же проблему.",
        en: "Added a check that hunts for code which was written but is called from nowhere. That is the most common way a change looks finished and is not: the mechanism exists, its own tests pass, and no working path ever reaches it. The check insists every exception carry a reason a reader can weigh — otherwise the exception list becomes the place the same problem hides.",
      },
    ],
  },
  {
    version: "0.39.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Ограничение на обращения наружу считает и загрузки страниц, а не только поиски. Предел, названный именем одного инструмента, ограничивал этот инструмент и ничего больше: поиск отказывали, а страницу загружали, и так по кругу мимо всякой границы. Теперь поиск и загрузка тратят один общий счёт, а замечание называет то действие, которое вы правда сделали.",
        en: "The limit on reaching outside now counts page fetches as well as searches. A limit named after one tool bounded that tool and nothing else: a search would be refused, a page fetched instead, and round it went past any boundary at all. Search and fetch now spend one shared budget, and the note names the action actually taken.",
      },
    ],
  },
  {
    version: "0.38.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Свидетельство о выполненной работе больше не выдаётся, когда работы не было. Автоматическая выдача не проверяла, есть ли что заверять, — и фоновый служебный проход выписал документ со словом «ПРОВЕРЕНО» поверх показательного примера в самом хранилище, не изменив ни одного файла. Теперь оба пути спрашивают одно правило, а фоновые проходы не выписывают свидетельств вовсе.",
        en: "A proof of completed work is no longer issued when there was no work. The automatic path never asked whether anything was there to attest, and a background housekeeping pass wrote a document reading VERIFIED over the showcase example in the repository itself, without changing a single file. Both paths now ask the same rule, and background passes issue nothing at all.",
      },
      {
        ru: "Две проверки одного свидетельства перестали расходиться. На документе без изменений одна печатала «проверено», другая — «заплатка не применяется»; обе теперь отказывают по одной названной причине: заверять нечего.",
        en: "Two checks of the same proof no longer disagree. On a document recording no change, one printed VERIFIED while the other reported a broken patch; both now refuse for the same stated reason — there is nothing to attest.",
      },
    ],
  },
  {
    version: "0.37.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Документация приведена в соответствие с тем, что код делает на самом деле. Число установленных расширений было записано устаревшим в трёх разных местах, настройки окна и памяти отсутствовали в примере конфигурации, а описания рабочего процесса не упоминали ни договор между шагами, ни то, что для настоящей многоагентной работы есть более сильный инструмент.",
        en: "Documentation now matches what the code actually does. The number of installed extensions was recorded out of date in three separate places, the window and memory settings were missing from the example configuration, and the workflow descriptions mentioned neither the contract between steps nor the stronger tool available for genuinely multi-agent work.",
      },
    ],
  },
  {
    version: "0.36.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Проверяющий выбирается из моделей другого происхождения, и выбор объявляется. Две сборки одной модели — это одна и та же слепая зона в двух экземплярах, а не второе мнение, поэтому такой проверяющий отклоняется. Если происхождение автора неизвестно, независимость подтвердить нечем — и выбор не делается вовсе.",
        en: "A reviewer is chosen from a different model lineage, and the choice is stated out loud. Two builds of one model are the same blind spot twice over rather than a second opinion, so such a reviewer is refused. When the author's lineage is unknown there is nothing to establish independence against, and no choice is made at all.",
      },
      {
        ru: "Память под второго проверяющего считается тем же решателем, что и окно. На этой машине ответ — не помещается: обвязка узнаёт это заранее и не пытается загрузить, вместо того чтобы загрузить и утопить систему.",
        en: "Memory for a second reviewer is priced by the same solver that sizes the window. On this machine the answer is that it does not fit: the harness learns this in advance and does not attempt the load, rather than loading and drowning the system.",
      },
      {
        ru: "Вердикт опирается на то, что действительно исполнялось — прогнанные тесты, скомпилированный код. Если ничего не исполнялось, вердикт помечается как мнение о правке, а не вывод о ней.",
        en: "A verdict rests on what was actually executed — tests that ran, code that compiled. When nothing was executed the verdict is labelled an opinion about the change rather than a finding about it.",
      },
    ],
  },
  {
    version: "0.35.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Шаги рабочего процесса и разбора корпуса перестали начинаться каждый по-своему. Раньше первым в запросе шёл текст роли, а он у каждого шага свой — расхождение с самого начала обесценивало всё, что за ним, и модели приходилось заново перечитывать почти весь запрос на каждом шаге. Теперь неизменная часть идёт первой, а меняющееся — в хвосте: после правки шаги делят не менее 98% начала запроса.",
        en: "Workflow steps and corpus batches no longer each begin differently. The role text used to come first and it differs per step, so the divergence started at the very beginning and made everything after it worthless — the model re-read almost the whole request on every step. The unchanging part now comes first and what varies goes at the tail: after the change, steps share at least 98% of the request's opening.",
      },
    ],
  },
  {
    version: "0.34.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Модель узнала про настоящую многоагентную оркестрацию. Схемы этих инструментов уходили в каждый запрос и оплачивались, а подсказка вела к более слабому однопроходному варианту — теперь описаны оба, с правилом «начинай одним проходом, разделяй только когда работа этого требует»: шаг, который можно было сделать внутри, никогда не был отдельным шагом.",
        en: "The model now knows about real multi-agent orchestration. The schemas for those tools were sent and paid for on every request while the guidance pointed at a weaker single-pass one — both are now described, with the rule \"start in one pass, split only when the work demands it\": a step you could have done inline was never a separate step.",
      },
      {
        ru: "Вызов оркестратора теперь чинится так же, как вызовы двух его соседей. Замерено: получив задачу на разделение, модель выбрала верный инструмент четыре раза подряд и все четыре раза не смогла попасть в форму аргументов. Инструмент, в который никто не может попасть, — это инструмент, которого нет.",
        en: "A call to the orchestrator is now repaired the same way calls to its two neighbours already were. Measured: given work that splits, the model picked the right tool four times running and missed the argument shape all four times. A tool nobody can call is a tool nobody has.",
      },
    ],
  },
  {
    version: "0.33.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Шаг рабочего процесса, который ничего не выдал, больше не превращается в текст, похожий на результат. Раньше сбой записывался строкой вида «(шаг упал: таймаут)», она передавалась следующим шагам как их входные данные и попадала в итоговую сводку — и отчёт писался вокруг неё. Теперь отсутствие названо отсутствием, а тот, кто собирает итог, получает указание не выдумывать пропущенное. То же правило применено к разбору корпуса текстов.",
        en: "A workflow step that produced nothing no longer turns into text that reads like a result. A failure used to be recorded as a string like \"(step failed: timeout)\", which was then handed to later steps as their input and reached the final synthesis — and the report was written around it. An absence is now named as one, and whoever assembles the result is told not to invent what is missing. The same rule now applies to corpus analysis.",
      },
      {
        ru: "Обрезка на передаче между шагами объявляется. Шаг пишет до ~3200 символов, а на вход следующему проходило 2000 — около 40% исчезало молча, и короткий ответ было не отличить от урезанного. Теперь на месте среза стоит пометка, сколько символов снято и сколько было.",
        en: "Truncation between steps is now declared. A step writes up to ~3,200 characters while 2,000 were passed on — roughly 40% used to disappear silently, and a short answer was indistinguishable from a cut one. The cut now carries a note saying how much was removed and of what.",
      },
      {
        ru: "Проверка результата шага получила последствия. Её вердикт раньше уходил только в служебную строку, а вывод шёл дальше в любом случае. Теперь неудачная проверка даёт одну повторную попытку, после чего шаг честно помечается как не давший результата. Сам критерий больше не ищет слова «проверил», «тест», «прошло» в собственном тексте шага — фраза «я ничего не проверял» проходила эту проверку, потому что содержит слово «проверял».",
        en: "The per-step check now has consequences. Its verdict used to go only into a trace line while the output flowed on regardless. A failed check now gets one retry, after which the step is honestly marked as having produced no result. The criterion no longer searches the step's own text for words like \"checked\", \"test\" or \"passed\" — the sentence \"I did not check anything\" passed that check, because it contains the word \"check\".",
      },
    ],
  },
  {
    version: "0.32.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Сколько запросов пускать к модели одновременно — теперь решение по замеру, а не значение по умолчанию. На этой машине открытие ворот с одного до двух замедлило работу на 15%: конкурентный разбор промптов тормозит оба запроса сразу, а не ускоряет второй. Вдобавок второй слот стоит половины контекста. Ворота остаются на единице, и число слотов при загрузке следует за ними само.",
        en: "How many requests reach the model at once is now a decision from measurement rather than a default. On this machine opening the gate from one to two made the work 15% slower: concurrent prompt processing slows both requests instead of speeding up the second. A second slot also costs half the context. The gate stays at one, and the slot count at load time follows it on its own.",
      },
      {
        ru: "Потолок одновременных агентов в рабочих процессах приведён к той же величине. Шестнадцать агентов в ворота на один — это очередь, а не параллельная работа.",
        en: "The concurrent-agent ceiling for workflows now matches the same figure. Sixteen agents through a gate of one is a queue, not parallel work.",
      },
    ],
  },
  {
    version: "0.31.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Ширина окна теперь считается на цене, снятой во время запроса, а не после загрузки. Три источника — размер в lms ps, память после загрузки и собственная оценка рантайма — не меняются с окном, потому что кэш возникает только когда приходят токены; расчёт на них не сходился и молча отказывал. Замер берётся там, где кэш действительно появляется.",
        en: "The context window is now sized from a cost measured during a request, not after a load. Three sources — the size in lms ps, machine memory after a load, and the runtime's own estimate — do not move with the window at all, because the cache only appears when tokens do; a fit built on them could not converge and quietly refused. The reading is taken where the cache actually exists.",
      },
      {
        ru: "Число одновременных слотов вошло в расчёт памяти. Один запрос на 131 021 токен прошёл через модель, загруженную на 262144 с четырьмя слотами — значит слот не делит окно, а способен занять его целиком, и провизия стоит вчетверо. Раньше это число доставалось от предыдущей сессии и в расчёт не входило; теперь оно следует за пропускной способностью очереди и передаётся команде загрузки явно.",
        en: "Concurrent slots are now part of the memory arithmetic. A single 131,021-token request went through a model loaded at 262144 with four slots — so a slot does not divide the window, it can fill the whole of it, and provisioning four costs four times the cache. That count used to be inherited from an earlier session and left out of the sum; it now follows the admission ceiling and is passed to the load command explicitly.",
      },
      {
        ru: "Замер цены отвергается, когда он взят на слишком коротком контексте или на непрогретой модели: в первом случае дрейф памяти перекрывает полезный сигнал, во втором возврат весов из сжатия читается как рост кэша. Оба случая давали число вчетверо больше настоящего.",
        en: "A cost reading is refused when it was taken over too short a context or against a cold model: in the first case memory drift outweighs the signal, in the second the weights coming back from compression read as cache growth. Both produced a figure four times the truth.",
      },
    ],
  },
  {
    version: "0.30.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Проверено замером: полное окно модели ничего не стоит на коротких задачах. Была причина сомневаться — большое окно у этого класса моделей достигается растяжкой позиций, и авторы советуют включать её только когда длина действительно нужна, так что дефолт мог незаметно вредить обычным коротким запросам. Шесть задач по три повтора на каждом окне: верных 18 из 18 в обоих случаях, чистота языка одинаковая, задержка в пределах шума. Дефолт «грузить на максимум модели» остаётся — теперь по данным, а не по вкусу.",
        en: "Measured: a model's full window costs nothing on short work. There was reason to doubt it — long context on this class of model is reached by interpolating positions, and the authors advise turning that on only when the length is genuinely needed, so the default could have been quietly hurting ordinary short requests. Six tasks, three repetitions at each window: 18 correct out of 18 in both, identical language purity, latency within noise. The default of loading at the model's maximum stands, now on evidence rather than taste.",
      },
    ],
  },
  {
    version: "0.29.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Модель сама доходит до своего полного окна, шаг за шагом. Раньше размер приходилось называть: кто-то печатал число в команду загрузки. Теперь FABULA удваивает окно от того, что есть, пока не упрётся либо в предел самой модели, либо в отказ LM Studio — у него есть собственная защита, он не даст перегрузить компьютер. На этой машине путь занял три шага: 32768, 65536, 131072 и полные 262144. Ни одного вписанного числа: предел прочитан у модели, а границу назвал тот, кто знает её точно, — сам загрузчик.",
        en: "The model climbs to its own full window, one step at a time. The size used to be something you had to name: somebody typed a number into the load command. FABULA now doubles the window from wherever it is until it meets either the model's own limit or a refusal from LM Studio, which has its own protection and will not let the computer be overloaded. On this machine the climb took three steps: 32768, 65536, 131072 and the full 262144. No number is written anywhere: the limit is read from the model, and the boundary is named by the one thing that knows it exactly — the loader itself.",
      },
    ],
  },
  {
    version: "0.28.0",
    date: "2026-07-26",
    items: [
      {
        ru: "FABULA больше не выбрасывает половину разговора раньше времени. В настройках отдельно хранилось её собственное представление о размере контекста, и оно тоже было вписано руками — на этой машине там стояло 131072, пока модель работала на 262144. То есть разговор сокращался на середине окна, которое было в наличии, и ни одно из двух чисел по отдельности не выглядело подозрительно. Теперь эта цифра приводится к измеренному окну при смене модели и применяется со следующего запуска.",
        en: "FABULA no longer throws half a conversation away ahead of time. Its own idea of the context size was kept separately in the settings and was typed by hand as well — on this machine it said 131072 while the model was serving 262144. Conversations were being cut at the midpoint of a window that was actually there, and neither number looked wrong on its own. That figure is now brought into line with the measured window when you switch models, and applies from the next start.",
      },
    ],
  },
  {
    version: "0.27.0",
    date: "2026-07-26",
    items: [
      {
        ru: "Размер контекста больше никто не вписывает руками — он вычисляется при смене модели. Раньше это было число, которое кто-то однажды напечатал: модель, умеющая 262144, была загружена на 65536, и каждый запрос приходил вшестеро больше, чем помещалось в вызов, — половина работы переделывалась на каждом шаге, а приложение выглядело зависшим, хотя просто стояло в очереди. Теперь предел читается у самой модели, цена памяти за один токен окна измеряется на вашей машине по настоящим загрузкам, и берётся то из двух, что помещается рядом с системой и другими загруженными моделями. Незнакомая модель сначала поднимается маленькой, замеряется и поднимается заново — вслепую на максимум никогда, потому что на Mac такая загрузка не падает, а утаскивает в своп весь компьютер.",
        en: "Nobody types the context size by hand any more — it is worked out when you switch models. It used to be a number someone entered once: a model capable of 262144 was loaded at 65536, so every request arrived six times larger than the call could hold, half the work was redone on every step, and the app looked frozen when it was only queueing. Now the limit is read from the model itself, the memory price of one token of window is measured on your machine from real loads, and whichever of the two fits alongside the system and any other loaded model is the one used. An unfamiliar model is brought up small, measured, and raised — never straight to the maximum, because on a Mac a load like that does not fail, it drags the whole computer into swap.",
      },
    ],
  },
  {
    version: "0.26.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Название чата не может быть машинным вызовом. Прошлая правка отбрасывала строку, целиком состоящую из тега, — и модель тут же выдала тег с полезной нагрузкой следом, который прошёл насквозь. Теперь отбрасывается сочетание углового тега и фигурных скобок: так выглядит машинный вывод и никогда — название, которое дал бы человек. Одно без другого не трогаем, поэтому «Как работает <div> в вёрстке» остаётся названием.",
        en: "A chat name cannot be a machine call. The previous change discarded a line that was entirely a tag — and the model promptly produced a tag with a payload after it, which sailed straight through. What is discarded now is an angle-bracket token together with braces: that is what machine output looks like and never what a person would name a chat. Either one alone is left alone, so 'Как работает <div> в вёрстке' stays a name.",
      },
    ],
  },
  {
    version: "0.25.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Перезагрузили модель с другим окном — FABULA заметит это сама, в течение минуты. Запомненное значение теперь имеет срок годности. Без него получалось ровно то, от чего мы уходили: модель перезагрузили с 64K на 256K, а обвязка продолжала работать по старому числу, пока её не перезапустили руками. Запомнить навсегда — это та же записанная константа, только спрятанная в памяти процесса.",
        en: "Reload the model with a different window and FABULA notices by itself, within a minute. A learned figure now expires. Without that you got exactly what we were moving away from: the model was reloaded from 64K to 256K and the harness kept working off the old number until it was restarted by hand. Remembering forever is the same written-down constant, just hidden in process memory.",
      },
    ],
  },
  {
    version: "0.24.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Сброс накопленного теперь срабатывает вовремя, потому что FABULA спрашивает у сервера, сколько помещается в один запрос, вместо того чтобы читать записанное однажды число. Записанное число устаревает в тот же миг, когда вы меняете модель или её настройку загрузки, — и дальше управляет тем, что уже не описывает. Именно так и вышло: считалось, что помещается вдвое больше реального, накопленное перерастало запрос, и сервер модели умирал на генерации. Длина вашей задачи этим не ограничена ничуть: ровно наоборот, своевременный сброс и есть то, чем длинная работа проходит через короткий запрос.",
        en: "Shedding the accumulated context now happens in time, because FABULA asks the server how much fits in one request instead of reading a number written down once. A written-down number goes stale the moment you change the model or its load settings — and then governs traffic it no longer describes. That is exactly what happened: twice the real amount was assumed to fit, the accumulated context outgrew the request, and the model server died mid-generation. None of this limits how long your task can be: timely shedding is precisely what carries long work through a short request.",
      },
    ],
  },
  {
    version: "0.23.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Правило «ходу некуда идти — закрываем» наконец получает нужные ему сведения. Оно было написано верно и не работало: признак запрета клался в соседнее поле, не то, из которого правило читает. Всё сходилось по типам, ошибок не было, а на живом ходу с двадцатью двумя запретами решение всё равно принималось как будто запретов нет. Теперь признак лежит там, где его читают.",
        en: "The rule that closes a turn with nowhere left to go finally gets the fact it needs. It was written correctly and did nothing: the refusal flag was placed in the field next to the one the rule reads. It type-checked, raised no error, and on a live turn with twenty-two refusals the decision was still made as though there had been none. The flag now sits where it is read.",
      },
    ],
  },
  {
    version: "0.22.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Ход, которому больше некуда идти, завершается сразу. Проверяющий слой возвращал агента к работе даже после готового ответа — по записи решений видно, как он срабатывал. Теперь так: если обвязка сама запретила агенту продолжать и он всё-таки написал ответ, значит сказано всё, что он в состоянии сказать, и ход закрывается. Задача, где инструменты отработали успешно и работа правда осталась, по-прежнему проверяется как раньше.",
        en: "A turn with nowhere left to go now ends at once. The checking layer sent the agent back to work even after a delivered answer — the decision record shows it firing. Now: if the harness itself refused the agent further calls and it still wrote an answer, everything it is able to say has been said, and the turn closes. A task whose tools succeeded and whose work genuinely remains is still checked as before.",
      },
      {
        ru: "Название чата не может быть разметкой. Одна сессия получила имя «<tool_calls>» — модель выдала служебный токен там, где просили обычные слова, и он был слишком коротким, чтобы прежняя проверка его заметила. Теперь имя, состоящее из тега или скобок либо вовсе без букв, отбрасывается.",
        en: "A chat name cannot be markup. One session was named '<tool_calls>' — the model emitted a control token where plain words were asked for, and it was too short for the previous check to notice. A name that is a tag, a bracketed marker, or carries no letters at all is now discarded.",
      },
    ],
  },
  {
    version: "0.21.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Требование писать на языке вопроса теперь стоит в двух местах сразу — и в самом обращении, и в постоянных указаниях. С одним каналом оно выполнялось почти полностью: на ответе в 1929 символов проскочило три иероглифа. Один канал — одна точка отказа; так же продублированы все прочие постоянные указания.",
        en: "The requirement to write in the language of the question is now stated in two places at once — in the request itself and in the standing instructions. With one channel it was followed almost completely: three foreign characters slipped into a 1929-character answer. One channel is one point of failure; every other standing instruction is stated twice for the same reason.",
      },
    ],
  },
  {
    version: "0.20.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Поиск, который некуда продолжать, больше не может тянуться бесконечно. Ограничение стояло на поиске в интернете — и агент обходил его соседним инструментом: поиск запрещён, страница загружена, ещё одна, снова поиск, снова запрет, и так за тридцать третий шаг и сорок два отказа. Дверь заперли, а соседняя осталась открытой. Теперь ограничение считает не вызовы одного инструмента, а обращения наружу вообще: загруженная страница расходует тот же лимит, что и запрос. Поиск по вашему коду сюда не входит.",
        en: "A search with nowhere left to go can no longer run on forever. The limit was set on web search — and the agent walked around it with the tool next to it: search refused, page fetched, another fetched, search again, refused again, on past step thirty-three and forty-two refusals. One door was locked and the one beside it stood open. The limit now counts reaching outside at all, not calls to one tool: a fetched page spends the same budget as a query. Searching your own code is not counted.",
      },
    ],
  },
  {
    version: "0.19.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Работа больше не продолжается после готового ответа. Проверяющий слой видел «инструменты вызывались, потом текст» и не мог отличить готовый ответ от отчёта о незаконченной работе — обе картины выглядят одинаково, поэтому один раз он убивал задачу посередине, а другой раз гонял агента дальше уже после того, как вы прочли ответ. Различие не в тексте: если обвязка сама запретила агенту продолжать (исчерпан бюджет поиска), делать больше нечего — и теперь она об этом прямо сообщает. Ход, где все инструменты отработали успешно, оценивается ровно как раньше.",
        en: "Work no longer continues after a finished answer. The checking layer saw 'tools were called, then text' and could not tell a delivered answer from a report of unfinished work — the two look identical, so it once killed a task midway and another time sent the agent back after you had already read the answer. The difference is not in the wording: when the harness itself has refused the agent further calls (a search budget spent), there is nothing more to try — and that is now stated outright. A turn whose tools all succeeded is judged exactly as before.",
      },
    ],
  },
  {
    version: "0.18.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Ответ теперь пишется целиком на языке вопроса. На живом прогоне русский ответ приехал с китайскими вставками прямо посреди собственных предложений — «Откуда, скорее всего, 这个故事», «看似 абсурдную инструкцию». Смысл был верным, но такой текст некому показать. Обвязка сама определяет язык вопроса по буквам и на каждом ходу требует держаться его; названия, термины и код остаются как есть, а если язык непонятен — она молчит и ничего не выдумывает.",
        en: "An answer is now written entirely in the language of the question. On a live run a Russian answer arrived with Chinese spliced into the middle of its own sentences — 'Откуда, скорее всего, 这个故事', '看似 абсурдную инструкцию'. The meaning was right, but there is nobody you can show text like that to. The harness works out the language of the question from its letters and asks for it on every turn; names, technical terms and code are left alone, and when the language is unclear it stays silent rather than guessing.",
      },
    ],
  },
  {
    version: "0.17.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Фоновые проходы самообучения больше не отнимают модель у вас. Они запускались на первом шаге вашего же хода и потом работали всё время рядом с ним: на разобранном прогоне два прохода выдали 22 сообщения, пока вы ждали, а каждый запрос к модели простаивал в очереди в среднем 44 секунды (до 5 минут, очередь доходила до семи). Ничего не висело — всё стояло в очереди. Теперь такой проход ждёт, пока машина освободится, и пропускается совсем, если тишины так и не наступило.",
        en: "Background self-improvement passes no longer take the model away from you. They were started at the first step of your own turn and then ran alongside it the whole time: on the run we traced, two passes produced 22 messages while you waited, and every request to the model spent an average of 44 seconds queueing (up to five minutes, with the queue reaching seven deep). Nothing was hung — everything was queued. Such a pass now waits for the machine to go quiet, and is skipped entirely if quiet never comes.",
      },
      {
        ru: "Название чата больше не может оказаться строкой из служебных инструкций. Модель, которую просят придумать название, получает вместе с просьбой собственные инструкции — и однажды процитировала строку оттуда: чат про притчу Ошо назывался «Status: success | partial | failed | blocked». Прошлая правка сняла звёздочки и на этом остановилась. Теперь название, дословно повторяющее то, что мы отправили, отбрасывается, а если подходящего не нашлось — берутся первые слова вашего сообщения.",
        en: "A chat name can no longer turn out to be a line of internal instructions. The model asked to invent a name is handed its own instructions along with the request, and once quoted a line straight back: a chat about an Osho parable was called 'Status: success | partial | failed | blocked'. The previous change removed the asterisks and stopped there. A name that repeats what we sent word-for-word is now discarded, and if nothing suitable is left, the opening words of your message are used.",
      },
      {
        ru: "Служебные замечания надзора больше не выглядят как поломка. Когда обвязка останавливает бесконечный поиск, она пишет указание модели — и это указание показывалось вам красной карточкой ошибки, хотя всё работало правильно. Теперь такие замечания сложены под спойлер «Служебная заметка».",
        en: "Supervision notes no longer look like breakage. When the harness stops a runaway search it writes an instruction to the model — and that instruction was shown to you as a red error card, although everything was working correctly. Such notes now sit folded under a 'Harness note' spoiler.",
      },
      {
        ru: "Поиск в интернете без запроса больше не отчитывается успехом. Модель однажды передала поиску адрес страницы вместо слов — поиск отправил в запрос слово «undefined», ничего не нашёл и доложил, что всё прошло хорошо. Теперь он прямо говорит, чего не хватает, и подсказывает нужный инструмент.",
        en: "A web search with no query no longer reports success. The model once handed the search a page address instead of words — the search sent the literal word 'undefined', found nothing, and reported that all was well. It now says plainly what is missing and names the right tool.",
      },
    ],
  },
  {
    version: "0.16.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Честный ответ «не нашёл» теперь перечисляет запросы так, как вы бы их прочитали. Внутри для сравнения запросы приводятся к нормальному виду со сортировкой слов, и в первой версии сообщения показывались именно они — «exact osho parable text woodcutter» вместо «osho woodcutter parable exact text». Теперь запоминается исходная формулировка.",
        en: "The honest 'could not find it' answer now lists the queries the way you would read them. Internally queries are normalised and token-sorted for matching, and the first version of the message showed exactly that — 'exact osho parable text woodcutter' instead of 'osho woodcutter parable exact text'. The original wording is now kept.",
      },
    ],
  },
  {
    version: "0.15.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Если найти ответ не удалось, вы теперь об этом узнаёте. Раньше в такой ситуации агент перебирал почти одинаковые запросы, натыкался на защиту от повторов и умолкал — оставался пустой ход без объяснений, и выглядело это как зависание. Теперь ход завершается честным ответом: что именно искалось, что не нашлось, и что от вас поможет — название, автор, книга или ссылка.",
        en: "If an answer could not be found, you are now told so. The agent used to cycle through near-identical queries, hit the repeat guard and fall silent — leaving an empty turn with no explanation, which looked like a hang. The turn now ends with an honest answer: what was searched for, that it was not found, and what from you would help — a title, an author, a book or a link.",
      },
    ],
  },
  {
    version: "0.14.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Когда вызов инструмента не удаётся выполнить, теперь записывается ПОЧЕМУ: инструмент неизвестен, скрыт из текущего набора или вызван с негодными аргументами. Раньше все три случая выглядели одинаково, и понять причину зависания можно было только гаданием.",
        en: "When a tool call cannot be carried out, the reason is now recorded: the tool is unknown, hidden from the current set, or called with unusable arguments. All three used to look identical, so the cause of a hang could only be guessed at.",
      },
    ],
  },
  {
    version: "0.13.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Устранена причина зависаний, когда агент бесконечно повторял почти одинаковые запросы. Чтобы не раздувать контекст, часть инструментов скрывается из списка, а вызов скрытого перенаправляется к настоящему исполнителю. Перенаправление опиралось на кэш, который со временем вытесняется, — и после этого любой скрытый инструмент превращался в ловушку: модель звала его, получала ошибку вместо результата, переформулировала и звала снова. Теперь промах кэша стоит одного лишнего обращения, а не срыва задачи.",
        en: "Fixed the cause of hangs where the agent endlessly repeated near-identical requests. To keep the context small some tools are hidden from the list, and a call to a hidden one is rerouted to its real executor. That rerouting relied on a cache that is evicted over time — after which every hidden tool became a trap: the model called it, got an error instead of a result, rephrased and called again. A cache miss now costs one extra roundtrip instead of derailing the task.",
      },
    ],
  },
  {
    version: "0.12.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Отчёт по книге теперь пишется в чат на глазах, а не сваливается целиком в конце. Раньше текст копился на стороне модели, и после нескольких минут тишины появлялся разом — читать было нечего, и казалось, что всё замерло. Теперь он идёт по мере написания: можно начинать читать сразу и видно, что работа жива. Если поток оборвётся, отчёт всё равно будет получен целиком обычным способом.",
        en: "A book report is now written into the chat as it goes, instead of dropping in whole at the end. The text used to accumulate on the model side and appear all at once after minutes of silence — nothing to read, and it looked frozen. It now arrives as it is written: you can start reading immediately and can see the work is alive. If the stream breaks, the report is still produced in full the ordinary way.",
      },
    ],
  },
  {
    version: "0.11.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Статистика по токенам снова показывает правду после фонового разбора. Отчёт приходил с нулями — расход, модель и стоимость выглядели пустыми, хотя разбор реально сделал больше десятка обращений к модели. Теперь фоновый проход считает свой расход и передаёт его вместе с ответом, поэтому вкладка «Контекст» показывает то, что действительно потрачено.",
        en: "Token statistics tell the truth again after a background analysis. The report used to arrive with zeros — usage, model and cost all looked empty, although the analysis really made more than a dozen model calls. The background pass now counts what it spends and reports it along with the answer, so the Context tab shows what was actually used.",
      },
      {
        ru: "Надпись о ходе работы больше ничего не выдумывает про ваш материал: считаются реальные файлы, а не внутренние группы, и название берётся из того, что действительно найдено — главы это или просто файлы. Если признака нет, счётчик просто считает, не называя.",
        en: "The progress line no longer invents anything about your material: it counts the real files rather than internal groupings, and the noun comes from what was actually found — chapters or plain files. With no such signal it simply counts without naming the thing.",
      },
    ],
  },
  {
    version: "0.10.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Теперь видно, что происходит во время долгого разбора. Раньше на месте ответа стояло одно слово «Interrupted» и пустота на несколько минут — выглядело как обрыв, хотя шла работа. Теперь там написано, какая глава читается сейчас и сколько их всего, а затем — что собирается итоговый отчёт.",
        en: "You can now see what is happening during a long analysis. The answer area used to show the single word 'Interrupted' and then nothing for minutes — which looked like a failure while work was going on. It now says which chapter is being read and how many there are, and then that the final report is being written.",
      },
    ],
  },
  {
    version: "0.9.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Длинный отчёт больше не обрывается на полуслове. Раньше объём ответа задавался заранее, а подобрать его нельзя в принципе: один и тот же текст на русском стоит примерно втрое дороже английского, поэтому любое число либо расточительно, либо режет. Теперь приложение спрашивает у модели, закончила она мысль или у неё кончилось место, и во втором случае даёт больше места и просит снова.",
        en: "A long report is no longer cut off mid-word. The size of the answer used to be fixed in advance, which cannot be got right: the same text costs about three times more in Russian than in English, so any number is either wasteful or truncating. The app now asks the model whether it finished or simply ran out of room, and in the second case gives it more room and asks again.",
      },
      {
        ru: "Полоса вверху больше не бежит в пустой сессии. Прерванный ход оставлял после себя сообщение без отметки о завершении, и полоса считала его незаконченной работой — бесконечно, хотя не происходило ничего.",
        en: "The line at the top no longer runs in an idle session. An interrupted turn left behind a message with no completion stamp, and the line read it as unfinished work — forever, while nothing at all was happening.",
      },
    ],
  },
  {
    version: "0.8.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Питомец больше НИКОГДА не засыпает, пока идёт работа, а полоса вверху движется только тогда, когда что-то действительно происходит. Раньше долгий разбор шёл в отдельном процессе, и приложение считало сессию простаивающей: питомец укладывался спать посреди работы, а индикаторы противоречили друг другу — из-за этого и возникало ощущение, что всё зависло. Теперь оба показателя читают одно и то же: идёт ли работа на самом деле, включая фоновую.",
        en: "The companion NEVER falls asleep while work is running, and the line at the top moves only when something is actually happening. A long analysis used to run in a separate process while the app considered the session idle: the pet dozed off mid-work and the two indicators contradicted each other — which is what made a live run look like a hang. Both now read the same thing: whether work is really in flight, background work included.",
      },
    ],
  },
  {
    version: "0.7.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Готовый разбор книги теперь приходит как ОТВЕТ, а не как ваша же реплика. Раньше фоновая работа умела вернуть результат только тем же способом, каким пишете вы, — и чат показывал его узким пузырём простым текстом: звёздочки и решётки видны как символы, а сверху висела служебная пометка. Появился способ отдать готовый результат именно как ответ: он занимает всю ширину, размечен как положено, и служебная пометка читателю больше не показывается.",
        en: "A finished book analysis now arrives as an ANSWER instead of as your own message. Background work could previously hand its result back only the way you write — so the chat showed it as a narrow plain-text bubble with asterisks and hashes as characters, and a service marker on top. There is now a way to deliver a finished result as an answer: it uses the full width, is formatted properly, and the service marker is no longer shown to the reader.",
      },
      {
        ru: "Закрыт скрытый бесконечный цикл. Когда разбор не мог взять задачу на себя (слишком маленький корпус, недоступная модель), он возвращал ваш исходный текст модели — но этот же текст снова попадал под перехват, снова возвращался, и так без конца. Теперь возврат происходит ровно один раз на сессию и корпус.",
        en: "A hidden infinite loop is closed. When the analysis could not take a task on (too small a corpus, an unreachable model) it handed your original text back to the model — and that same text was intercepted again, handed back again, without end. The hand-back now happens exactly once per session and corpus.",
      },
    ],
  },
  {
    version: "0.6.0",
    date: "2026-07-25",
    items: [
      {
        ru: "Питомец больше не таращится. Пока шла работа, блик в его глазах пробегал по всем четырём углам восемь раз в секунду — зрачок буквально крутился, и тело подрагивало два с половиной раза в секунду. Теперь это спокойный взгляд влево-вправо и неспешное покачивание: видно, что он бодр, но он больше не перетягивает внимание с текста, который вы читаете.",
        en: "The pet no longer stares wildly. While work was running, the highlight in its eyes travelled all four corners of the socket eight times a second — the pupil literally spun — and the body bobbed two and a half times a second. It is now a calm left-right glance and an unhurried bob: still clearly awake, but no longer pulling your attention off the text you are reading.",
      },
      {
        ru: "Названия чатов больше не показывают разметку. Сессия могла появиться в списке буквально как «**Status**: success | partial | failed | blocked» — со звёздочками, потому что название подставлялось как есть. Теперь заголовок приводится к чистому тексту: убираются звёздочки, решётки, обратные кавычки, ссылки и маркеры списка. Уже созданные названия останутся прежними — правило работает для новых.",
        en: "Chat names no longer show raw markup. A session could appear in the list literally as '**Status**: success | partial | failed | blocked' — asterisks and all, because the generated name was used as-is. Titles are now reduced to plain text: emphasis, heading marks, backticks, links and list markers are removed. Names created earlier stay as they are; the rule applies to new ones.",
      },
    ],
  },
  {
    version: "0.5.0",
    date: "2026-07-24",
    items: [
      {
        ru: "Анализ большой книги теперь действительно доводится до отчёта. Разбор корпуса вынесен в отдельный фоновый процесс: раньше он запускался внутри хука, а хук движок обрывает через 5 секунд — и в headless-режиме процесс завершался сразу после отмены хода, унося работу с собой. Ход отменялся, а разбор молча не начинался. Теперь хук только принимает решение и запускает работника, который живёт независимо и доставляет готовый отчёт в чат сам.",
        en: "A large-book analysis now actually reaches a report. The corpus pass moved into its own background process: it used to run inside the hook, and the engine kills a hook after 5 seconds — while in headless mode the process exited the moment the turn was cancelled, taking the work with it. The turn was cancelled and the analysis silently never started. The hook now only makes the decision and launches a worker that lives independently and delivers the finished report to the chat itself.",
      },
      {
        ru: "Из готового отчёта больше не торчат служебные пометки модели. Отчёт доходил до читателя с меткой вида «<final>» в начале — модель открывала тег и не закрывала, а очистка срабатывала только на парных. Теперь непарные пометки убираются в любом случае, а резюме каждой части чистится сразу, а не только итог: неочищенное резюме дословно попадало и в запрос на синтез, и в запасной вариант отчёта.",
        en: "Service markers no longer show up in a finished report. A report reached the reader with a stray '<final>' at its head — the model opened the tag and never closed it, and the cleanup only handled matched pairs. Unpaired markers are now stripped either way, and each part's summary is cleaned as it is produced rather than only at the end: an uncleaned summary was quoted verbatim both into the synthesis request and into the fallback report.",
      },
      {
        ru: "Строка о том, как собран отчёт, теперь пишется на языке запроса, а не всегда на одном.",
        en: "The line describing how the report was assembled now follows the language of the request instead of always being written in one language.",
      },
      {
        ru: "Ускорен каждый ход: постоянно загружаемые инструкции похудели примерно на 68 000 токенов. В них по недосмотру попал большой внутренний документ, который уходил в модель при каждом запросе в каждом проекте и отнимал внимание у самой задачи.",
        en: "Every turn got cheaper: the always-loaded instructions lost roughly 68,000 tokens. A large internal document had been listed among them, so it was sent to the model on every request in every project and competed with the task itself for attention.",
      },
    ],
  },
  {
    version: "0.4.4",
    date: "2026-07-24",
    items: [
      {
        ru: "Задача «прочитай все главы книги и сделай глубокий анализ» больше не зацикливается. Раньше модель грузила главы по одной в один контекст, пока не срабатывала компакция — а компакция «уезжала» в продолжение анализа вместо резюме (hijack), ретраи падали, движок перестраивал границу, и модель читала главы заново, потому что прогресс чтения нигде не сохранялся. Бесконечный цикл, отчёта не было. Новый плагин перехватывает первый ход такой задачи, отменяет обычный агентский ход и гонит детерминированный map-reduce в фоне: находит корпус (любые .md/.txt, паттерн «глава/часть/chapter» — любой объём, без хардкода), бьёт на батчи, суммаризует каждый батч как ИЗОЛИРОВАННЫЙ вызов локальной модели (роль + стоп + только эти главы — сырой корпус никогда не накапливается в одном контексте, компакция не срабатывает), сохраняет каждое резюме в resume-safe аккумулятор (прерывание посередине — возобновляется, прогресс не теряется), затем синтезирует полный отчёт из резюме и вставляет его в чат. Узкий детектор — обычные задачи не трогает; fail-open на слишком маленьком корпусе. Любая модель в сокете.",
        en: "A 'read all chapters and write a deep analysis' task no longer loops. The model used to load chapters one by one into one context until compaction tripped — and compaction HIJACKED (continued the analysis instead of summarizing), retries failed, the engine rebuilt the boundary, and the model re-read the chapters because the reading progress was never persisted. Infinite loop, no report. The new plugin intercepts the first turn of such a task, cancels the normal agent turn, and runs a deterministic map-reduce in the background: it discovers the corpus (any .md/.txt, a chapter/часть/chapter pattern — any volume, no hardcode), batches it, summarizes each batch as an ISOLATED local-model call (role + stop + only these chapters — the raw corpus never accumulates in one context, compaction never triggers), PERSISTS each summary to a resume-safe accumulator (an interruption mid-run resumes, progress is never lost), then synthesizes the full report from the summaries and re-injects it into the chat. A narrow detector — ordinary tasks are untouched; fail-open on a too-small corpus. Any model in the socket.",
      },
    ],
  },
  {
    version: "0.4.3",
    date: "2026-07-24",
    items: [
      {
        ru: "Универсальный гейт проверки теперь ловит и результат, отданный текстом в чат, а не только файлом. Главный мотивирующий кейс — литературный анализ книги по главам — как раз выдавался развёрнутым текстом в окно чата, и на него гейт молчал: старый путь срабатывал только когда модель писала/редактировала файл. Новый путь срабатывает в конце хода (session.post), и только если задача была вооружена как проверяемый деливерабл, ход завершился нормально, ни одного файла не писалось (значит результат — текст), финальный ответ длинный и структурированный (разбор по главам/разделам, а не просто длинная простыня текста), и slice принадлежит главному агенту, а не фоновому субагенту вроде компакции. Если ключевое утверждение не подтверждается источниками — гейт возвращает замечание прямо в чат, и в следующем ходе модель может его обосновать. Ограниченное число повторных замечаний на задачу, защита от рекурсии, молчит на разговорных и коротких ответах. Чистое ядро покрыто тестами; wiring-тест проверяет все инварианты против реальных хуков.",
        en: "The universal verification gate now also catches a deliverable handed over AS CHAT TEXT, not just as a file. The headline motivating case — a chapter-by-chapter literary analysis of a book — was exactly delivered as long-form text in the chat window, and the gate stayed silent on it: the old path fired only when the model wrote or edited a file. The new path fires at turn end (session.post), and only when the task armed as a verifiable deliverable, the turn completed normally, no file was written (so the result is the text), the final answer is long and structured (a chapter/section breakdown, not just a long wall of prose), and the slice belongs to the main agent rather than a background subagent like compaction. When a load-bearing claim is not supported by the sources, the gate nudges a remark back into the chat so the model can ground it next turn. Bounded re-engagement, a recursion guard, and it stays silent on conversational and short answers. The pure core is unit-tested; a wiring test exercises every invariant against the real hooks.",
      },
    ],
  },
  {
    version: "0.4.2",
    date: "2026-07-24",
    items: [
      {
        ru: "Потерянный клиент и дегенеративная генерация больше не сжигают видеокарту часами. Три независимых стража на транспортном choke-point (адаптер к модели), каждый ловит свой класс и не зависит от конкретной модели в сокете. (1) Любая генерация ограничена по длине (FABULA_MAX_OUTPUT_TOKENS) — раньше это было выключено, и один ход мог тянуться неограниченно. (2) Если клиент закрыл соединение посреди стрима, адаптер теперь закрывает соединение к модели — а закрытие сокета прерывает инференс; прежде сломанный сокет проглатывался, и модель честно досгенерировала весь многосоттысячный ответ в пустоту. (3) Детектор деградации на самом стриме ловит runaway-класс, который был невидим словесному n-gram: слитый без пробелов список «глава_10aглава_10b…» сворачивался в один токен, и страж между шагами его пропускал — теперь символьный shingle видит повторяющийся скелет и рвёт стрим за доли секунды. Тот же детектор закрыл дыру в компакции: «сводчик» мог уйти в такой runaway вместо резюме, и это не опознавалось как сбой. Всё доказано на реальных прогонах и покрыто тестами с мутационной проверкой.",
        en: "A lost client and a degenerating generation no longer burn the GPU for hours. Three independent guards sit on the transport choke-point (the model adapter), each catching its own class, none depending on the model in the socket. (1) Every generation is now length-clamped (FABULA_MAX_OUTPUT_TOKENS) — it used to be off, so a single turn could run unbounded. (2) When a client closes mid-stream, the adapter now closes the connection to the model — and closing that socket aborts the inference; before, the broken write was swallowed and the model dutifully finished a multi-hundred-thousand-token answer into a dead socket. (3) A degeneration detector on the stream itself catches the runaway class that was invisible to the word n-gram: a spaceless list \"глава_10aглава_10b…\" collapsed to a single token, so the per-step guard missed it — now a character shingle sees the recurring skeleton and cuts the stream in under a second. The same detector closed a hole in compaction: the summarizer could slip into such a runaway instead of summarizing, and it was not recognized as a failure. Everything is proven on real runs and covered by mutation-verified tests.",
      },
    ],
  },
  {
    version: "0.4.1",
    date: "2026-07-22",
    items: [
      {
        ru: "Появился универсальный гейт проверки для НЕ-кодовых задач (включён по умолчанию). До сих пор обвязка проверяла только код — «готово» там значит «тесты зелёные». Для анализа, плана или свода такой проверки не было, и качество целиком зависело от модели. Новый гейт распространяет тот же принцип на любой письменный результат: он разбирает его на типизированные утверждения и независимо пере-выводит каждое — цитата обязана дословно совпасть с указанным источником (сверяется в ПРАВИЛЬНОМ разделе, поэтому ловится и приписывание не тому источнику), число обязано быть в источнике, а «прочитаны все N файлов» сверяется с журналом прогона. До дорогой модели доходит только то, что не прошло бесплатную проверку. Молчит на разговорных и оценочных ходах; никогда ложно не отвергает обоснованное. Стоит несколько вызовов вспомогательной модели на задачу-с-результатом — выключается в менеджере плагинов, если не нужно.",
        en: "A universal verification gate for NON-code tasks arrived (on by default). Until now the harness only verified code — there 'done' means the tests are green. For an analysis, a plan or a summary there was no such check, and quality was entirely up to the model. The new gate carries the same principle to any written result: it breaks it into typed claims and independently re-derives each — a quote must match its cited source verbatim (checked in the RIGHT section, so mis-attribution is caught too), a number must appear in the source, and a 'read all N files' claim is checked against the run ledger. Only what fails the free check reaches the costly model. It stays silent on conversational and opinion turns and never falsely rejects grounded work. It spends a few auxiliary-model calls per deliverable task — turn it off in the plugin manager if you don't want that.",
      },
    ],
  },
  {
    version: "0.4.0",
    date: "2026-07-22",
    items: [
      {
        ru: "Длинная задача с рассуждающей моделью больше не обрывается на промежуточном «think-only» шаге. Такая модель нередко заканчивает ход одними рассуждениями, без ответа и без вызова инструмента — это нормальная фаза, а не сбой. Раньше два таких шага за всю задачу (даже разделённых реальной работой — чтением файлов) исчерпывали жёсткий лимит и роняли прогон с ошибкой. Теперь граница осведомлена о прогрессе: залипание (одни и те же рассуждения повторяются) режется как прежде, а движущийся вперёд ход продолжается до высокого потолка; продуктивный шаг (вызов инструмента или ответ с текстом) сбрасывает счётчик. Напоминание тоже конкретнее — «вызови инструмент сейчас», а не «дай ответ».",
        en: "A long task with a reasoning model no longer dies on an intermediate think-only step. Such a model often ends a turn with reasoning alone — no answer, no tool call — which is a normal phase, not a failure. Two such steps across a whole task (even separated by real work like reading files) used to exhaust a hard cap and kill the run. The bound is now progress-aware: a stall (the same reasoning repeated) is cut as before, while a turn that keeps moving continues up to a high ceiling; a productive step (a tool call or an answer with text) resets the counter. The nudge is more concrete too — 'call the tool now' rather than 'give an answer'.",
      },
    ],
  },
  {
    version: "0.3.9",
    date: "2026-07-21",
    items: [
      {
        ru: "Возобновление длинной задачи после перезапуска больше не умирает на одном объявлении плана. Раньше ход без вызова инструментов считался «разговором» и его остановка чтилась без проверки; теперь признак задачи — свойство всей сессии (в окне есть работа инструментами или граница восстановления), и остановка такого хода всегда проходит через судью завершённости. Беседы без следов задачи в окне завершаются сразу, как раньше; в сессии с задачей остановка стоит одну ограниченную проверку.",
        en: "Resuming a long task after a restart no longer dies at a single plan announcement. A turn that called no tools used to count as a 'conversation' and its stop was honored unchecked; task-ness is now a property of the whole session (tool work or a recovery boundary anywhere in the window), so such a stop always reaches the completion judge. Conversations with no task traces in the window still end immediately; in a task session a stop costs one bounded check.",
      },
    ],
  },
  {
    version: "0.3.8",
    date: "2026-07-21",
    items: [
      {
        ru: "У обвязки появился бортовой самописец решений — служебный журнал для диагностики, невидимый в интерфейсе. Каждый выбор — какой страж продолжил ход, почему ход завершился, куда ушло переполнение, судьба сохранений и сводок — пишется строкой в отдельный файл. Включается и выключается на работающем приложении, без перезапуска (маркер-файл trace.on в данных приложения); выключенный — не стоит ничего. Нужен, чтобы причины редких остановок находились чтением журнала, а не раскопками.",
        en: "The harness gained a decision flight recorder — a service journal for diagnostics, invisible in the UI. Every choice — which guard continued a turn, why a turn ended, where an overflow was routed, the fate of saves and summaries — is written as a line to a separate file. It toggles on a RUNNING app, no restart (a trace.on marker file in the app data); when off it costs nothing. It exists so the causes of rare stops are found by reading a journal, not by excavation.",
      },
    ],
  },
  {
    version: "0.3.7",
    date: "2026-07-21",
    items: [
      {
        ru: "Переполнение контекста больше не запускает минуты молчаливой генерации. Разбор по базе показал: «зависание» на этот раз было долгой модельной сводкой — холодный пересчёт ~180 тысяч знаков это несколько минут тишины, за которые сессию дважды перезапустили, обрывая сводку на лету («Compaction did not finish»). Теперь при переполнении, даже если чекпоинт ещё не успел появиться, обвязка сразу ставит мгновенную границу восстановления из измеренных данных — запрос, журнал прочитанных файлов, задачи; её нельзя ни угнать, ни оборвать посреди генерации, и она ничего не стоит. Модельная сводка осталась для ручного сжатия и как последний резерв. Грань зарегистрирована в реестре циклов. И отдельное правило на будущее: перезапуск приложения посреди работающей задачи обрывает её текущий шаг — новые версии подхватывайте между задачами.",
        en: "A context overflow no longer launches minutes of silent generation. The database showed this \"freeze\" was a long model summarization — a cold recompute of ~180K characters is several minutes of silence, during which the session was restarted twice, aborting the summary mid-flight (\"Compaction did not finish\"). Now, on overflow, even when no checkpoint exists yet, the harness immediately inserts an instant rebuild boundary assembled from measured data — the ask, the ledger of files read, the tasks; it cannot be hijacked or aborted mid-generation, and it costs nothing. Model summarization remains for manual compaction and as a last resort. The edge is registered in the loop registry. And a rule worth stating: restarting the app mid-task aborts its current step — pick up new versions between tasks.",
      },
    ],
  },
  {
    version: "0.3.6",
    date: "2026-07-21",
    items: [
      {
        ru: "Закрыта вторая дверь той же ловушки «объявил и встал» — найдена адверсариальной проверкой собственного аудита, до того как она успела сработать у пользователя. Страж ловил пустой ход после сжатия, но после ВОССТАНОВЛЕНИЯ (вторая механика сброса контекста) граница считалась началом нового хода: сегмент обнулялся, выглядел «безинструментальным», и текстовый отчёт сразу после восстановления снова мог завершить сессию. Теперь обе двери — сводка сжатия и граница восстановления — под одним стражем: работа шла до границы, первый ход после неё без единого вызова инструмента — один принудительный ход-продолжение. Проверено мутацией: удаление новой ветки валит ровно новый тест.",
        en: "The second door of the same announce-and-stop trap is closed — found by adversarially auditing this project's own audit, before it fired for the user. The guard caught an empty turn after a compaction, but after a REBUILD (the second context-reset mechanism) the boundary counted as a fresh turn start: the segment reset, looked tool-free, and a text-only report right after a rebuild could end the session again. Both doors — the compaction summary and the rebuild boundary — now sit under one guard: work ran up to the boundary, the first turn after it made not a single tool call — one forced continuation. Mutation-checked: removing the new branch fails exactly the new test.",
      },
    ],
  },
  {
    version: "0.3.5",
    date: "2026-07-21",
    items: [
      {
        ru: "Провал сжатия перестал быть концом задачи. Живой случай: переполнение случилось на третьей минуте — раньше, чем успел появиться первый чекпоинт; сжатие ушло к модели-сводчику, ту дважды угнал перегруженный вызовами транскрипт (включая повтор с прямой поправкой), и сессия честно встала на красной ошибке — видимо, но мертво. Теперь у обвязки есть спасение без модели: при провале сжатия ставится граница восстановления, собранная из измеренных данных — исходный запрос, журнал уже прочитанных файлов с указанием продолжать с непрочитанных, задачи. Ничего из этого не генерируется — подделать или «угнать» нечего. Ограничение одним срабатыванием заложено конструкцией и продублировано счётчиком, грань зарегистрирована в реестре циклов. Ручное сжатие при провале по-прежнему останавливается с ошибкой — спасение только для автоматического.",
        en: "A failed compaction is no longer the end of the task. Live case: the overflow arrived in minute three — before the first checkpoint even existed; compaction fell to the summarizer model, which the call-saturated transcript hijacked twice (corrective retry included), and the session honestly stopped on the red error — visible, but dead. The harness now has a model-free rescue: on compaction failure it inserts a rebuild boundary assembled from measured data — the original ask, the ledger of files already read with an instruction to continue with unread ones, the tasks. None of it is generated, so none of it can be hijacked. The single-firing bound is built into the construction and doubled by a counter; the edge is registered in the loop registry. A failed MANUAL compaction still stops with the error — the rescue is for automatic ones only.",
      },
    ],
  },
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
