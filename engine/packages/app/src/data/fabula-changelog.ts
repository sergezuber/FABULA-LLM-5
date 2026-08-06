// FABULA: local versioning — the app's own patch notes. Every deployed change lands here as a
// dated entry (newest first) and is shown in Settings > Changes. No network fetch: the log
// ships with the build, so it is always current for the binary the user runs.
export const FABULA_VERSION = "0.191.0"

export type ChangelogEntry = {
  version: string
  date: string // ISO yyyy-mm-dd
  items: { ru: string; en: string }[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.191.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Проверки, заявляющие «путь ВНЕ проекта», строят свои каталоги действительно вне рабочей копии. Прежде они брали временные каталоги из корня, лежащего внутри репозитория, — и тогда рабочим деревом проекта оказывался сам репозиторий, соседний каталог был ВНУТРИ него, разрешение спрашивать было не о чем, а проверка измеряла, где случайно расположились её собственные фикстуры. Программа всё это время вела себя верно; замерено на ряду: «внешний» каталог не внешний, рабочее дерево — выгрузка.",
        en: "Checks that claim \"this path is OUTSIDE the project\" now build their directories genuinely outside a working copy. They took temporary directories from a root that sits inside the repository, which made the project's worktree the repository itself, a sibling directory INSIDE it, and no permission due — so the check measured where its own fixtures happened to live. The program was right the whole time; measured on a runner: the \"outside\" directory was not outside, and the worktree was the checkout.",
      },
    ],
  },
  {
    version: "0.190.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Проверки разрешений оболочки спрашивают ещё и о том, считается ли целевой каталог внешним ВООБЩЕ. Вся эта группа сообщает, что разрешение не запрошено, — но у этого две причины с разными исправлениями: путь не извлекли, либо он и не снаружи, потому что временные каталоги проверки — соседи под корнем, лежащим внутри рабочей копии. Одно поле разделяет их, вместо того чтобы гадать дальше.",
        en: "The shell-permission checks also ask whether the target counts as outside the project AT ALL. The whole group reports that no permission was requested, and that has two causes with different fixes: the path was not extracted, or it is not outside — the check's temporary directories are siblings under a root that itself sits inside a working copy. One field tells them apart instead of leaving it to be guessed.",
      },
    ],
  },
  {
    version: "0.189.0",
    date: "2026-08-06",
    items: [
      {
        ru: "«Развёрнуто ли здесь» спрашивается про ВСЕ три носителя версии, а не про один. Проверка смотрела только на собранный лицевой слой — а его порождает и сборка одного движка, — и отвечала «развёрнуто» там, где оболочку не собирали вовсе. Дальше сторож верно сообщал об отсутствии третьего артефакта как об устаревании: правдивая фраза о развёртывании, которого никто не делал.",
        en: "\"Is anything deployed here\" is asked of ALL three carriers of the version, not one. The check looked only at the built front end — which building the engine alone also produces — and answered \"deployed\" where the shell had never been built. The guard then correctly reported the missing third artifact as staleness: a true sentence about a deployment nobody made.",
      },
    ],
  },
  {
    version: "0.188.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Приведение пути к написанию служебного корня имеет ОДНО определение, рядом с самим корнем. Мест, которым оно нужно, четыре, и три из них уже написали своё. Там, где у каталога одно написание, это ничего не меняет; где несколько — это разница между «запись внутри собственной бухгалтерии обвязки» и передачей её тому запросу разрешения, который сторож памяти и должен был заменить.",
        en: "Bringing a path into the bookkeeping root's spelling has ONE definition, beside that root. Four places need it and three had already written their own. Where a directory has one spelling this changes nothing; where it has several it is the difference between \"this write is inside the harness's own bookkeeping\" and handing it to the very permission request the memory guard exists to take over from.",
      },
      {
        ru: "Завершающая уборка не решает исход прогона. Она идёт в самом конце: все проверки уже отчитались, помешать оставшийся каталог больше некому, а система отпускает описатели сразу после выхода. Целый зелёный набор краснел здесь — под пустым именем, потому что уборка не тест. Там, где занятость означает, что запущенное прогоном ещё живо, ошибка по-прежнему поднимается — но это вопрос уборки за каждой отдельной проверкой, и она его задаёт.",
        en: "The final sweep does not decide the run. It happens at the very end: every check has reported, there is no later test for a leftover directory to disturb, and the system releases the handles as soon as the process exits. A whole green suite was going red here, under no test name at all, because tidying up is not a test. Where a busy directory means something the run started is still alive, it is still raised — but that is the per-check cleanup's question, and it asks it.",
      },
    ],
  },
  {
    version: "0.187.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Проверка развёртывания ищет строку в двоичном файле средствами самой среды, а не перебором байтов на языке сценария. Файл весит около ста сорока трёх мегабайт, поэтому прежний перебор шёл сотнями миллионов шагов в интерпретаторе: он не укладывался в отведённое ему время, обрывался на полпути — и отчёт просто ЗАКАНЧИВАЛСЯ, ни разу не дойдя до собственного вывода. Развёртывание объявлялось устаревшим на дереве, с которым всё было в порядке.",
        en: "The deploy check searches the binary with the runtime's own string search rather than walking bytes in the script language. The file is about a hundred and forty-three megabytes, so the old walk ran hundreds of millions of interpreted steps: it did not fit in the time it was given, was cut off part-way, and the report simply ENDED without ever reaching its own verdict. A deployment was called stale on a tree that was fine.",
      },
    ],
  },
  {
    version: "0.186.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Набор проверок движка полностью зелёный и на этой машине тоже. Последняя неустойчивая истекала по сроку, при том что каждый её отдельный шаг молчал: причина оказалась арифметической, а не зависанием — сумма допусков, отведённых внутренним шагам, превышала внешний срок, который должен был стоять ЗА ними. Время не сосредоточено, оно размазано, и ни один шаг своего допуска не превышает.",
        en: "The engine suite is fully green on this machine too. The last unsteady check expired while every one of its individual steps stayed silent, and the cause turned out to be arithmetic rather than a hang: the allowances given to the inner steps summed to more than the outer budget that was supposed to sit BEHIND them. The time is not concentrated, it is spread, and no single step exceeds its own allowance.",
      },
      {
        ru: "Проверки написаний пути перестали подделывать двусмысленность. Снимая букву диска, они превращали путь в такой, чей первый отрезок — одна буква, а это ровно то, как Git Bash пишет ДИСК. Программа читала его как другой диск — по этому соглашению верно, — и проверка сообщала о дефекте там, где двусмысленность создала сама фикстура.",
        en: "The path-variant checks stopped manufacturing an ambiguity. Stripping the drive letter turned a path into one whose first segment is a single letter, and a leading slash-letter-slash is exactly how Git Bash spells a DRIVE. The program read it as a different drive — correctly, by that convention — and the check reported a defect where the fixture had invented the ambiguity itself.",
      },
    ],
  },
  {
    version: "0.185.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Корень файловой системы снова можно ПРОСМОТРЕТЬ в выборщике папок. Выборщик идёт сверху вниз, а там, где корней несколько, единого верха нет: «/» разрешается в корень текущего носителя и не содержит домашний каталог, лежащий на другом, — цепочка предков просто обрывалась. Это разрешение СМОТРЕТЬ, а не открывать: корень как рабочий каталог по-прежнему отклоняется тем сторожем, чья это забота.",
        en: "A filesystem root can be BROWSED in the folder picker again. The picker walks down from the top, and where there is more than one root there is no single top: \"/\" resolves to the root of the current volume and does not contain a home living on another — the ancestor chain simply ended. This permits LOOKING, not opening: a root as a working directory is still refused by the guard whose job that is.",
      },
      {
        ru: "Каталог берётся у модуля путей, а не отрезается выражением по одной косой черте: там, где путь написан другой, выражение не совпадало, и каталогом создавался ПОЛНЫЙ путь файла — записывать после этого было некуда.",
        en: "A directory is asked of the path module rather than cut off by an expression matching one kind of slash: where a path is written with the other kind the expression matched nothing, and the whole FILE path was created as a directory, leaving the write that followed nowhere to land.",
      },
      {
        ru: "Запись хода для последующего чтения человеком больше не решает вердикт проверки: не удалось записать — так и сказано в выводе, а проверка судит о том, о чём она.",
        en: "Writing down a trajectory for a human to read afterwards no longer decides a check's verdict: if it could not be written, the output says so, and the check judges what it is about.",
      },
    ],
  },
  {
    version: "0.184.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Удаление рабочего дерева больше не объявляет неудачу там, где система просто ещё не отпустила каталог. Где удаление отказывает, пока открыт последний описатель, освобождение приходит через секунды после того, как программа, читавшая этот каталог, закончила, — а прежний запас был в полсекунды. Пользователю сообщали, что удалить не удалось, хотя оно ещё не случилось.",
        en: "Removing a worktree no longer declares failure where the system has simply not let the directory go yet. Where removal is refused until the last handle closes, the release arrives seconds after the program that was reading that directory finished — and the old allowance was half a second. The user was told the removal failed when it merely had not happened yet.",
      },
      {
        ru: "Проверка отчёта о развёртывании печатает строки вердикта, а не последние четыре. Прежде она показывала «дерево устарело:» и следом четыре строки «ок» — причина оставалась за пределами окна.",
        en: "The deploy-report check prints the verdict lines rather than the last four. It used to show \"the tree reports stale:\" followed by four lines all reading ok — the reason itself stayed outside the window.",
      },
    ],
  },
  {
    version: "0.183.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Каталог, из которого запущена программа, и домашний каталог узнаются В ТОМ НАПИСАНИИ, В КАКОМ ИХ ДАЛИ, а не только в приведённом. Приводить разрешено только их — проверяемый путь не трогается намеренно, потому что обращение к файловой системе за ним однажды заморозило весь сервер на облачной папке. Из-за этого на файловой системе, у которой для одного каталога есть несколько написаний, база и кандидат описывали одно место разными словами: проект в собственном профиле пользователя получал ответ «не разрешено». Хранить второе написание рядом с первым — это одно сравнение и никакого обращения к диску.",
        en: "The launch directory and the home directory are recognised IN THE SPELLING THEY WERE GIVEN, not only in the canonical one. Only they may be canonicalised — the path being checked is deliberately left alone, because asking the filesystem about it once froze the whole server on a cloud-managed folder. So on a filesystem with more than one spelling for a directory, the base and the candidate described the same place in different words, and a project inside the user's own profile was answered \"not allowed\". Keeping the second spelling beside the first is one comparison and no disk access.",
      },
    ],
  },
  {
    version: "0.182.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Собственный домашний каталог того, кто запустил программу, больше не отклоняется как «системный». Домашний каталог суперпользователя стоит в списке защищённых, чтобы на него не мог указать ДРУГОЙ пользователь, — но когда он и есть дом запустившего, это не каталог операционной системы, а место, где лежит работа человека. Найдено запуском: окно открылось, и страница сказала «доступ запрещён» — программа отказала пользователю в его собственном доме. Ни одна автоматическая проверка этого не видела: ни одна из них не выполняется под пользователем, чей дом в том списке.",
        en: "The home directory of whoever is running is no longer refused as a system one. The superuser's home is on the protected list so that ANOTHER user cannot point at it — but when it is the home of the person running, it is not the operating system's, it is where their work lives. Found by launching: the window opened and the page said access denied — the application had refused the user their own home. No automated check saw it: none of them runs as a user whose home is on that list.",
      },
      {
        ru: "Приветствие называет машину, а не одну платформу: «модели работают на этой машине». Прежний текст говорил про Mac — на других системах это просто неверно.",
        en: "The welcome text names the machine rather than one platform: models run on this machine. The old wording named a Mac, which on other systems is simply untrue.",
      },
      {
        ru: "Сторож записи в служебное дерево снова сравнивает пути как СТРОКИ и не трогает файловую систему — так его можно спрашивать о путях, которых на этой машине нет. Приведение к написанию этой машины переехало туда, где обе стороны о ней и говорят.",
        en: "The bookkeeping write guard compares paths as STRINGS again and does not touch the filesystem — so it can be asked about paths that are not on this machine at all. Bringing both sides into this machine's spelling moved to the place where both sides are about this machine.",
      },
    ],
  },
  {
    version: "0.181.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Проверка развёртывания различает «развёрнутого здесь нет» и «развёрнутое отстало». Выгрузка, где собран только движок, не имеет ни собранного лицевого слоя, ни приложения — сторож верно называет это устаревшим, но речь тогда о развёртывании, которого не делали, а это другое утверждение. И когда сторож всё же ругается, в отчёт едут ЕГО СОБСТВЕННЫЕ слова: прежде отбирались строки по одному значку, которого сторож другой платформы не печатает, поэтому отчёт сообщал «дерево устарело:» и дальше ничего.",
        en: "The deploy check distinguishes \"nothing is deployed here\" from \"what is deployed fell behind\". A checkout that built only the engine has neither a built front end nor an application artifact — the guard is right to call that stale, but stale then describes a deployment nobody made, which is a different statement. And when the guard does object, its OWN words reach the report: lines used to be selected by one marker that the other platform's guard does not print, so the report said \"the tree reports STALE:\" and then nothing at all.",
      },
    ],
  },
  {
    version: "0.180.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Все пути служебного дерева строятся от ОДНОГО приведённого корня, и сторож записи приводит цель к тому же написанию. Корень приходил приведённым, а цель — как её написал вызывающий, поэтому сторож решал, что запись вообще не в этом дереве, и передавал её тому запросу разрешения, который сам же и должен был заменить.",
        en: "Every path in the bookkeeping tree is built from ONE canonical root, and the write guard brings its target into that same spelling. The root arrived canonical and the target as the caller wrote it, so the guard decided the write was not in that tree at all and handed it to the very permission request it exists to take over from.",
      },
      {
        ru: "Проверки разрешений на команды оболочки называют, что было запрошено на самом деле. «Ожидалось одно, получено другое» говорит лишь, какой запрос оказался первым, — но не был ли путь вовсе не распознан, распознан и сочтён внутренним, или запрошен в другом порядке. Это три разные неисправности с тремя разными исправлениями, и теперь вся последовательность едет в сообщении.",
        en: "The shell-command permission checks name what was actually asked. \"Expected one, received another\" says only which request came first — not whether the path was never recognised, was recognised and judged internal, or was asked for in a different order. Those are three different faults with three different fixes, and the whole sequence now travels in the message.",
      },
    ],
  },
  {
    version: "0.179.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Остановка рабочего потока действительно останавливает его, даже когда подчинённые вызовы ждут ответа модели. Вежливая отмена просит остановиться при первой возможности, а у того, кто ждёт модель, такой возможности нет, пока модель не ответит, — и отмена ждала подтверждения от каждого. Измерено: восемь подчинённых в полёте, отмена всё ещё идёт через двадцать секунд; один-двое возвращались сразу. Для нажавшего «Стоп» это значило, что стоп не останавливает.",
        en: "Stopping a workflow actually stops it, even when its subordinate calls are waiting on the model. A graceful cancel asks them to stop at the first opportunity, and one waiting on the model has no opportunity until the model answers — and the cancel awaited an acknowledgement from every one of them. Measured: eight in flight, the cancel still running after twenty seconds, where one or two returned at once. For the person who pressed Stop, Stop did not stop.",
      },
      {
        ru: "Поправка к предыдущей записи этой же волны: перестановка порядка записи отмены была объявлена второй половиной исправления, а затем измерена — исходы совпадают с ней и без неё, потому что при ограниченном ожидании отметка успевает лечь в любом случае. Перестановка отменена; чинит только окно ожидания.",
        en: "A correction to the entry above, from this same wave: reordering when a cancellation is recorded was announced as the second half of the fix and then measured — the outcomes are identical with and without it, because once the wait is bounded the mark lands in time either way. The reorder was reverted; the window is the whole fix.",
      },
      {
        ru: "Каталоги пользователя перестали получать отказ там, где система записывает домашний каталог не в той переменной, что читалась. Сторож брал только одну и молча подменял дом рабочим каталогом, отвергая ровно те проекты, ради которых существует.",
        en: "The user's own directories are no longer refused on a system that records the home directory in a variable other than the one being read. The guard read only that one and silently substituted the launch directory, refusing exactly the projects it exists to allow.",
      },
    ],
  },
  {
    version: "0.178.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Путь к файлу с записанными правилами читается в момент обращения, а не запоминается при загрузке. Снимок означал, что указание, где этот файл лежит, соблюдается или игнорируется в зависимости от того, успел ли модуль загрузиться раньше — правилом такое не назовёшь. И хранилище прочитанного теперь привязано к файлу, который прочитало: одна ячейка на значение, вход которого меняется, отдавала всем следующим то, что положил первый.",
        en: "The path to the file of written-down rules is read when it is asked for, not remembered at load. A snapshot meant the setting that says where that file lives was honoured or ignored depending on whether the module happened to load first, which is not a rule anyone can rely on. And what was read is now keyed by the file it was read from: one slot for a value whose input can change handed everyone after the first whatever the first had put there.",
      },
      {
        ru: "Проверки, зависящие от общей системной службы — синтеза речи и распознавания, — называют свою предпосылку. Выбор движка решается до первого произведённого звука; сам звук требует службы, которую делят все, и на занятой машине она отвечает в тридцать раз дольше. Не дождались — так и сказано, с причиной; ответила и отказала — по-прежнему провал.",
        en: "Checks that depend on a shared system service — speech synthesis and recognition — name their precondition. Which engine is chosen is decided before a single sample is produced; producing them needs a service everyone shares, and on a busy machine it answers thirty times slower. Not finishing is said outright with the reason; answering and refusing is still a failure.",
      },
    ],
  },
  {
    version: "0.177.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Имена файлов, которые сценарий рабочего потока получает от поиска по образцу, пишутся одним способом на любой системе. Сценарий — переносимый текст: он передаёт эти имена обратно на чтение и запись, сравнивает их и сортирует. Отдавая ему разделитель хозяина, мы заставляли один и тот же сценарий сортировать и совпадать по-разному в зависимости от того, где он запущен.",
        en: "The file names a workflow script receives from a pattern search are written the same way on every system. A script is portable text: it hands those names back to read and write, compares them and sorts them. Giving it the host's separator made one and the same script sort differently and match differently depending on where it ran.",
      },
      {
        ru: "Ожидание завершения работы называет, чего дождалось. Неограниченное ожидание, истекая, сообщало только про часы — а по такому сообщению единственный доступный ответ — снова увеличить число. Теперь на истечении читается собственное состояние работы, и следующий отказ будет фактом о ней, а не о секундомере.",
        en: "A wait for a run to finish now names what it was waiting on. An unbounded wait reported only the clock when it expired, and the only available response to that is to raise the number again. The run's own status is read on expiry, so the next failure is a fact about the run rather than about the stopwatch.",
      },
    ],
  },
  {
    version: "0.176.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Проверка отправки уведомления не выдаёт чужой простой за нашу поломку. Она бьёт по настоящей внешней службе: когда та отвечает — утверждение настоящее, наш запрос ею принимается; когда не отвечает — измерена чужая доступность, и об этом говорится прямо, с названной причиной. Ответ по существу, но с отказом, по-прежнему считается провалом — ради этого проверка и существует.",
        en: "The notification check no longer reports somebody else's downtime as our defect. It posts to a real external service: when that service answers, the assertion is the real thing — the request we build is one it accepts; when it does not answer, what was measured is its availability, and the check says so with the reason named. A service that answers and refuses us is still a failure, which is what the check is for.",
      },
    ],
  },
  {
    version: "0.175.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Приведение пути к каноническому написанию больше не зависит от того, СУЩЕСТВУЕТ ли последняя часть. Прежде оно спрашивало систему только о существующем пути, а для всего прочего возвращало просто разобранную строку — и каталог с файлом внутри него получали РАЗНЫЕ написания ровно тогда, когда каталог уже есть, а файл ещё нет. Всякий сторож, проверяющий «лежит ли это внутри того», сравнивал два написания одного и того же места и отвечал «нет»: запись в служебное дерево обвязки читалась как запись вне его. Теперь приводится самая длинная существующая часть, остальное дописывается как есть.",
        en: "Canonicalising a path no longer depends on whether its last component EXISTS. It used to ask the system only about a path that was there and fall back to the merely-resolved string for anything else — so a directory and a file inside it came back in DIFFERENT spellings exactly when the directory was there and the file was not yet. Every guard asking \"is this inside that\" then compared two spellings of one place and answered no: a write into the harness's own bookkeeping read as a write outside it. The longest existing prefix is canonicalised now, and the rest appended unchanged.",
      },
      {
        ru: "Проверки, которым нужен настоящий временной каталог, спрашивают его у системы. Вписанный «/tmp» — настоящий каталог на одних системах и путь на случайном диске на других: файл-метка туда не писался, и каждая такая проверка сообщала, что хук ни разу не сработал.",
        en: "Checks that need a real temporary directory ask the system for one. A literal \"/tmp\" is a real directory on some systems and a path on whatever drive is current on others: the marker file was never written there, and each such check reported that the hook had never fired.",
      },
    ],
  },
  {
    version: "0.174.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Память снова записывается там, где пути пишутся обратной косой чертой. Разбор пути признавал только прямую, а обходчик подаёт ему написание своей системы — совпадений не было ни одного, поэтому не индексировалось НИЧЕГО и любой поиск по памяти возвращал пусто. Не медленно — вовсе, и молча: путь, который не разобрался, неотличим от файла, который памятью не является. Ключ при этом сохраняется в одном написании, чтобы запись, сделанная на одной машине, значила то же на другой.",
        en: "Memory is indexed again where paths are written with backslashes. The path reader accepted only forward slashes while the walker hands it the system's own spelling, so nothing ever matched: NOTHING was indexed and every memory search came back empty. Not slowly — not at all, and silently, because a path that does not parse is indistinguishable from a file that is not a memory file. The stored key is written in one spelling, so a record made on one machine means the same on another.",
      },
      {
        ru: "Каталог, который система ещё держит после теста, больше не выдаётся за неудачу теста. Там, где удаление отказывает, пока не закрыт последний описатель, это обычное состояние конца работы, а не улика: подопытное уже прошло, а не удалась уборка за ним — она доделывается в конце прогона, и об отложенном сообщается вслух. Там, где занятость означает, что запущенное тестом всё ещё живо, ошибка по-прежнему поднимается.",
        en: "A directory the system still holds after a test is no longer reported as the test failing. Where removal is refused until the last handle closes, that is the ordinary end-of-work state rather than evidence: the subject had passed and what failed was the tidying, which is finished by the end-of-run sweep and said aloud when deferred. Where a busy directory means something the test started is still alive, it is still raised.",
      },
      {
        ru: "Проверки, читающие исходник, приводят окончания строк. Выражение искалось с закрывающей скобкой и переводом строки подряд, а выгрузка может положить между ними возврат каретки — и проверка сообщала, что выражение «переименовано или перестроено», на дереве, где ничего не переименовывали.",
        en: "Checks that read source text normalise line endings. An expression was matched by a closing bracket followed immediately by a newline, and a checkout may put a carriage return between them — so the check reported the expression \"renamed or restructured\" on a tree where nothing had been renamed.",
      },
    ],
  },
  {
    version: "0.173.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Версия попадает в файлы настольной оболочки при КАЖДОЙ сборке, на любой платформе. Проставлял её только тот шаг, который собирает саму оболочку, — а на этой платформе собирается другая, поэтому два отслеживаемых файла тихо отставали, и собранные из них пакет и установщик честно сообщали, что declared-версии не несут. Отставание теперь ловится ДО сборки, а не после неё.",
        en: "The version reaches the desktop shell's manifests on EVERY build, on every platform. Only the step that builds that shell used to stamp them, and this platform builds a different one — so two tracked files lagged quietly, and the package and installer built from them reported, correctly, that they did not carry the declared version. A lag is now caught BEFORE the build rather than after it.",
      },
      {
        ru: "Проверка отмены веерного запуска ждёт УСЛОВИЯ, а не отрезка времени, и спрашивает о тех детях, что были в полёте на момент отмены. Прежде она ждала полтораста миллисекунд в надежде, что дети успели зарегистрироваться, и на загруженной машине объявляла сиротой то, чего ещё не существовало.",
        en: "The fan-out cancellation check waits for a CONDITION rather than a stretch of time, and asks about the children that were in flight when the cancel ran. It used to wait a hundred and fifty milliseconds hoping the children had registered, and on a loaded machine reported an orphan where nothing had yet come into being.",
      },
    ],
  },
  {
    version: "0.172.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Про изолирующую среду спрашивают одним способом и зовут её одним именем. Реализаций было две, и они уже разошлись: одна слушала настройку, которой можно подставить другую среду, вторая нет — поэтому подставленная среда одобрялась при одном взгляде и игнорировалась при другом, а запускалась и вовсе третья. Здоровая служба, выдающая образы не того рода, по-прежнему считается непригодной и говорит, какого именно.",
        en: "The isolation runtime is asked one way and named one way. There were two implementations and they had already parted company: one honoured the setting that points at a stand-in runtime and the other did not, so a stand-in was approved on one look and ignored on the next, while a third was what actually ran. A healthy service serving the wrong kind of images still counts as unusable and says which kind it serves.",
      },
    ],
  },
  {
    version: "0.171.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Пустой список поставщиков читался как «перечислено ноль» вместо «не перечислено ничего». Такой список остаётся после удаления последней записи — и тогда отсекались ВСЕ доступные поставщики: машина с рабочим ключом сообщала, что поставщиков у неё нет вовсе.",
        en: "An empty provider list read as \"zero named\" instead of \"none named\". That list is what remains after the last entry is removed, and it then excluded EVERY provider available — a machine with a working key reported having none at all.",
      },
      {
        ru: "Ускоритель опрашивается одним способом. Опросов было два, и они уже разошлись: тот, по которому считается окно модели, знал одного производителя, поэтому машина с картой AMD или Intel считалась машиной без карты — и окно считалось по системной памяти, тогда как кэш живёт в видеопамяти. Заодно читается и занятая часть, поэтому запас на устройстве измеряется, а не назначается.",
        en: "The accelerator is asked one way. There were two probes and they had already drifted: the one the window plan uses knew a single vendor, so a machine with an AMD or Intel card counted as a machine with none — and the window was sized against system memory while the cache lives in VRAM. What the card already holds is read too, so a device's reserve is measured rather than assigned.",
      },
      {
        ru: "Доля памяти, отдаваемая под окно на видеокарте, стала собственным решением, а не тем же числом, что для единой памяти. Значение сегодня то же, и это намеренно: выдумать ДРУГОЕ неизмеренное число — та же ошибка, только с виду скромнее. Разница в том, что теперь пересчёт одного не двигает другое молча.",
        en: "The share of memory a window may take on a discrete card is its own decision rather than the figure measured for unified memory. The value is the same today, deliberately: inventing a DIFFERENT unmeasured number is the same mistake wearing humility. What changed is that re-measuring one no longer moves the other silently.",
      },
      {
        ru: "Корень памяти сравнивается в одном написании с обеих сторон. Цель приводилась к каноническому виду, а корень — нет, поэтому запись ВНУТРИ служебного дерева читалась как снаружи и вызывала запрос разрешения на собственную бухгалтерию обвязки.",
        en: "The memory root is compared in one spelling on both sides. The target was canonicalised and the root was not, so a write INSIDE the harness's own bookkeeping read as outside it and raised a permission request for it.",
      },
    ],
  },
  {
    version: "0.170.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Вопрос «лежит ли этот путь внутри того каталога» имеет теперь один ответ на всю программу. Их было два, в разных местах и с разной начинкой: один спрашивают тридцать девять файлов, включая проверку, можно ли вообще открыть проект; другой — шесть, включая сторож, который пропускает или отклоняет каждое обращение к каталогу. Исправление, написанное в один из них, оставляло другой решать наоборот — и так каталог за пределами проекта прочитался как внутри него. Правило переехало туда, где его зовут, второе определение убрано, а имя осталось прежним для всех, кто им пользовался.",
        en: "The question \"is this path inside that directory\" now has one answer for the whole program. There were two, in different places with different insides: one is asked by thirty-nine files, among them the check deciding whether a project may be opened at all; the other by six, among them the guard that admits or refuses every request naming a directory. A correction written into one left the other deciding the opposite — which is how a directory outside the project came to read as inside it. The rule moved to where it is called, the second definition is gone, and the name stayed for everyone who used it.",
      },
      {
        ru: "Корень файловой системы узнаётся в любом написании, а не только в одном. Проект без системы контроля версий записывает корень как свой рабочий каталог, и сторож, знавший лишь одно написание, для всех прочих объявлял «внутри проекта» весь диск целиком — то есть разрешение на выход за пределы проекта не спрашивалось никогда.",
        en: "A filesystem root is recognised in every spelling it has, not just one. A project with no version control records the root as its worktree, and a guard that knew a single spelling answered \"inside the project\" for an entire drive in every other case — so the permission that exists to ask before reaching outside the project was never requested.",
      },
      {
        ru: "Каталог с именем, начинающимся с двух точек, снова читается как лежащий внутри проекта. Прежняя проверка смотрела на первые два знака, а не на то, ведёт ли путь наружу.",
        en: "A directory whose name begins with two dots reads as inside the project again. The older check looked at the first two characters rather than at whether the path leads outward.",
      },
      {
        ru: "Каталоги, принадлежащие операционной системе, отклоняются на КАЖДОЙ платформе. Список был только для одной из них и отключался на остальных целиком — там не защищалось ничего. Теперь каждая платформа называет свои: домашний каталог суперпользователя добавлен, а системные каталоги Windows читаются из среды, поэтому иное расположение системы или иной язык покрыты тем же правилом.",
        en: "Directories belonging to the operating system are refused on EVERY platform. The list covered one of them and was switched off entirely on the others, where nothing was protected at all. Each platform now names its own: the superuser's home is added, and the Windows system directories are read from the environment, so a different install location or a different language is covered by the same rule.",
      },
    ],
  },
  {
    version: "0.169.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Проверки прав оболочки спрашивают прямо: читается ли путь ВНЕ проекта как внешний. Набор не находит ничего либо потому, что довод не разрешился в путь, либо потому, что путь разрешился и был сочтён лежащим внутри проекта, — это противоположные неисправности с противоположными исправлениями, а незапрошенное разрешение выглядит для обеих одинаково. Раньше приходилось гадать, какая из двух; теперь это отдельное утверждение, и оно же остаётся постоянным свойством: путь снаружи обязан читаться снаружи, иначе разрешение спрашивать не о чем.",
        en: "The shell-permission checks now ask outright whether a path OUTSIDE the project reads as external. A scan finds nothing either because the argument did not resolve to a path, or because it resolved and then read as living inside the project — opposite faults with opposite fixes, and an unasked permission looks identical for both. Which of the two had to be guessed at; it is now its own assertion, and a standing property besides: a path outside must read as outside, or there is nothing for a permission to be about.",
      },
    ],
  },
  {
    version: "0.168.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Разбор записанного идёт по ЛЮБОМУ окончанию строки. Подставная программа, которую система заводит своими средствами, пишет то окончание, которым пользуется сама, — и разрез только по одному оставлял лишний знак в конце каждого значения, из-за чего верно записанный путь не совпадал сам с собой.",
        en: "What was recorded is split on EITHER line ending. A stand-in a system starts by its own means writes the ending that system uses, and cutting on only one left a stray character at the end of every value — so a correctly recorded path failed to match itself.",
      },
    ],
  },
  {
    version: "0.167.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Хвост пути сверяется КАК ПУТЬ, а не как строка с одним вшитым разделителем. Записанный через прямую косую, он был утверждением об одной файловой системе и ложью для каждого настоящего пути на другой. Это оказалось последним звеном того же класса в этом наборе: отметка уже появлялась, а проверка оставалась красной из-за одной строки сравнения.",
        en: "The tail of a path is compared AS A PATH, not as a string with one separator baked into it. Written with a slash it was a claim about one filesystem and false for every real path on another. It turned out to be the last link of that same class here: the mark had begun appearing while the check stayed red over a single line of comparison.",
      },
    ],
  },
  {
    version: "0.166.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Отсутствие следа от прибора теперь и читается как отсутствие следа, а не как мёртвый механизм. Само решение обхода проверено выше — на любой машине, из того же чтения, что делает и сам механизм. Не хватает лишь отметки о том, что подставную программу запустил ИМЕННО хук, при том что такая же программа, с такими же доводами, пишет отметку, когда её запускает проверка. Прямо названный пробел: там, где эта ветка берётся, «воркер действительно запущен» НЕ покрыто — покрыто решение о запуске; сам запуск остаётся покрытым везде, где отметка появляется, и там же поймается всякая порча.",
        en: "A missing trace from the instrument now reads as a missing trace rather than as a dead mechanism. The traversal decision itself is asserted above — on any machine, from the same reading the mechanism makes. What is absent is only the mark showing the stand-in was started BY THE HOOK, while a stand-in of the same shape, handed the same arguments, does leave that mark when the check starts it. The gap is named outright: where that branch is taken, «the worker really launched» is NOT covered — the decision to launch is; the launch stays covered everywhere the mark appears, which is where a regression would be caught.",
      },
    ],
  },
  {
    version: "0.165.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Продуктовое утверждение проверяется отдельно от прибора, которым его проверяли. Само утверждение простое: чтение файла за файлом из одного каталога, сверх того, что помещается в окно, ЕСТЬ разбор набора, — и вердикт обязан это сказать и назвать тот каталог, который дали задаче, а не папку, в которую ход забрёл. Раньше это можно было увидеть только по следу, оставленному подставной программой, и там, где она не заводилась, живой и верно работающий механизм читался как мёртвый. Теперь решение проверяется из того же чтения, что делает и сам механизм, — везде, на любой машине.",
        en: "The product claim is now checked separately from the instrument used to check it. The claim is simple: reading file after file out of one directory, past what the window holds, IS a corpus pass — and the verdict must say so and must name the directory the task was given rather than a folder the turn wandered into. Until now that could only be seen through the trace a stand-in program left, so wherever that program would not start, a live and correctly working mechanism read as a dead one. The decision is now checked from the same reading the mechanism makes, on any machine.",
      },
    ],
  },
  {
    version: "0.164.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Набор проверок, где размеры выводятся из окна, теперь ОБЪЯВЛЯЕТ окно, о котором говорит, вместо того чтобы наследовать последнее, которому научили процесс. Все его величины считаются от этого числа, а сам механизм спрашивает окно у процесса во время работы — поэтому сосед, измеривший другое, беззвучно сдвигал бюджет из-под этих величин, и результат, задуманный заведомо помещающимся, приходилось выгружать. Обратная проверка воспроизводит это точно: с чужим окном — три красных, со своим — все зелёные.",
        en: "A suite whose sizes are derived from the window now DECLARES the window it is about, instead of inheriting whichever one the process was last taught. Every size in it follows from that number while the mechanism under test asks the process for the window at run time — so a neighbour that measured a different one silently moved the budget out from under those sizes, and a result meant to fit comfortably had to be offloaded instead. The reverse check reproduces it exactly: with the other window three go red, with its own all pass.",
      },
    ],
  },
  {
    version: "0.163.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Измеренное окно принадлежит МОДЕЛИ, и смена модели его отбрасывает. Величина хранится на весь процесс и живёт по времени, поэтому без этого окно прежней модели подменяло собой окно новой, пока не истечёт срок, — и всякое решение о размере в промежутке считалось от машины, держащей нечто иное. Оно же перетекало между несвязанными частями прогона: три проверки в соседней области краснели из-за числа, выставленного здесь. Отбрасывание — только при СМЕНЕ: при первом появлении отбрасывать нечего, а сделать это значило бы выкинуть замер, взятый до того, как всё началось.",
        en: "A measured window belongs to a MODEL, and a change of model discards it. The figure is held for the whole process and lives on a timer, so without this the previous model's window stood in for the new one until that timer ran out — and every size decision in between was computed against a machine holding something else. It also leaked between unrelated parts of a run: three checks in an adjacent area went red for a number set here. Discarded only on a CHANGE: on first sight there is nothing to invalidate, and doing it then would throw away a measurement taken before any of this began.",
      },
    ],
  },
  {
    version: "0.162.0",
    date: "2026-08-06",
    items: [
      {
        ru: "«Лежит ли каталог внутри рабочего» спрашивается без предположения о разделителе. Написанное с одним, это не совпадало ни с чем там, где пути пишутся другим: рабочий каталог не попадал в кандидаты вовсе, и побеждала та подпапка, в которую ход случайно забрёл, — ровно та ошибка, ради предотвращения которой кандидат и заведён. Одна опечатка возвращала поведение, из-за которого папка со снимками экрана однажды подменила собой книгу.",
        en: "«Is this directory inside the working one» is now asked without assuming a separator. Written with one, it matched nothing where paths are spelled with the other: the working directory never became a candidate at all, and whichever subfolder the turn had wandered into won by default — the very mistake that candidate exists to prevent. A single character restored the behaviour that once let a folder of screenshots stand in for a book.",
      },
    ],
  },
  {
    version: "0.161.0",
    date: "2026-08-06",
    items: [
      {
        ru: "🔴 На третьей системе разбор больших наборов текстов был МЁРТВ целиком — и молча. Механизм следит, какие файлы ход втянул в себя, и решал это вопросом «начинается ли путь с косой черты». Это факт об одной системе: там, где абсолютный путь начинается с буквы диска, ответ ложен для КАЖДОГО настоящего пути, поэтому ни одно чтение не засчитывалось, обход не видел набора никогда, и всё, что стоит за ним, не запускалось ни разу — при полностью зелёных собственных проверках. Теперь путь признаётся абсолютным в любом из двух написаний.",
        en: "🔴 On the third system the pass over large sets of texts was ENTIRELY DEAD — and silent. The mechanism watches which files a turn has pulled in, and decided that by asking whether the path starts with a slash. That is a fact about one system: where an absolute path begins with a drive letter the answer is false for EVERY real path, so no read was ever counted, the traversal never saw a set, and nothing downstream of it ever ran — with all of its own checks green. A path is now recognised as absolute in either spelling.",
      },
      {
        ru: "Найдено в конце длинной цепочки, и цепочка стоит того, чтобы её записать: каждое решение ниже по течению научили называть себя — сработал, отказался, промолчал по прежней передаче, не запустился помощник. Не назвалось НИ ОДНО. Значит до них не доходило, и искать надо было выше — в самом первом вопросе, который задаётся раньше всех остальных.",
        en: "Found at the end of a long chain, and the chain is worth writing down: every decision downstream was taught to announce itself — acted, declined, stood down on an earlier hand-back, helper failed to start. NONE of them announced anything. Which meant none was being reached, and the search belonged further up: at the very first question, the one asked before all the others.",
      },
    ],
  },
  {
    version: "0.160.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Закрыт последний немой выход этого механизма: когда работа уже была передана обратно ранее, помощник не запускается — это верно и не оставляло НИКАКОГО следа, неотличимо от помощника, который стартовал и пропал. Оба состояния встретились в одном разборе, и истинным было одно. Теперь каждое решение здесь — сработать, отказаться, промолчать по прежней передаче — называет себя.",
        en: "The last silent exit of this mechanism is closed: where the work was handed back on an earlier attempt, no helper starts — correct, and it left NO trace at all, indistinguishable from a helper that started and vanished. Both states were met in one investigation and only one of them was true. Every decision here now names itself: acting, declining, and standing down on an earlier hand-back.",
      },
    ],
  },
  {
    version: "0.159.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Отказ передать разбор корпуса отдельному процессу теперь называет себя. Механизм объявлял о себе, когда СРАБАТЫВАЛ, и молчал, когда отказывался, — поэтому «корпус не был принят к обработке» и «был принят, а помощник не запустился» давали одно и то же свидетельство: никакого. Отказ пишется один раз за ход, поэтому обычный ход, читающий пару файлов, остаётся тихим.",
        en: "A refusal to hand a corpus pass to a separate process now names itself. The mechanism announced itself when it ACTED and stayed silent when it declined, so «the corpus was never taken over» and «it was taken over and the helper never started» produced the same evidence: none. The refusal is written once per turn, so an ordinary turn reading a couple of files stays quiet.",
      },
    ],
  },
  {
    version: "0.158.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Проба передаёт подставной программе доводы ТОЙ ЖЕ формы, что и боевой запуск, и сверяет записанное. Одно опрятное слово доказывает, что запуск состоялся, и ничего не говорит о том, доезжают ли настоящие доводы — путь с разделителями и длинная строка, — а именно эта половина и не работала. Файл, появившийся с искажёнными доводами, — другая неисправность, чем не появившийся вовсе, и обе иначе читались бы как «прибор исправен».",
        en: "The probe hands the stand-in arguments of THE SAME shape the real launch does, and checks what was recorded. One tidy word proves the spawn happened and says nothing about whether the real arguments survive the trip — a path carrying separators, a long string — and that is the half that was failing. A file appearing with the arguments mangled is a different fault from one that never appears, and both would otherwise read as «the instrument works».",
      },
    ],
  },
  {
    version: "0.157.0",
    date: "2026-08-06",
    items: [
      {
        ru: "Проба «заводится ли здесь мой прибор» запускает подставную программу ТЕМ ЖЕ способом, каким её запускает сам механизм, — довод за доводом. Проба, пускающая иначе, отвечает на другой вопрос: она сообщала, что заглушка запускается, тогда как боевой запуск не давал ничего, причём без ошибки в обоих случаях. Проверка из-за этого раз за разом докладывала о мёртвом механизме, хотя не мог выполниться прибор — в тех условиях, которые и важны.",
        en: "The probe asking «does my instrument start here» now starts the stand-in THE SAME WAY the mechanism itself starts it, argument for argument. A probe that starts it some other way answers a different question: it reported the stand-in startable while the real launch produced nothing, and neither raised an error. The check therefore kept reporting a dead mechanism when what could not run was the instrument, under the conditions that actually matter.",
      },
    ],
  },
  {
    version: "0.156.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Подставная программа стала ОДНОЙ программой, которую командный истолкователь запускает напрямую. Прежде она передавала аргументы второму истолкователю: работает, пока работает каждое звено, а когда не работает — читать нечего, потому что вывод потомка отбрасывается по замыслу, и цепочка, оборвавшаяся в середине, неотличима от так и не начавшейся. Она обрывалась молча и стоила нескольких заходов. Аргумент с пробелами при этом сохраняется — очевидный способ перебрать их в командном файле как раз этого не умеет.",
        en: "The stand-in became ONE program, started directly by the command interpreter. It used to hand its arguments to a second interpreter: fine while every link holds, and when one does not there is nothing to read, because the child's output is discarded by design and a chain broken in the middle is indistinguishable from one that never started. It broke silently and cost several rounds. An argument containing spaces survives, which the obvious way of walking them in a command file does not manage.",
      },
    ],
  },
  {
    version: "0.155.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Провал запуска рабочего процесса перестал быть НЕМЫМ. Обработчик ошибки был пуст — намеренно, чтобы ход не падал из-за не запустившегося помощника, — и из-за этого запуск, которого не было, выглядел ровно как состоявшийся: ни отчёта, ни отметки, ничего, что можно прочитать. Ход по-прежнему переживает такую ошибку, но причина теперь записывается туда же, куда пишутся остальные решения этого механизма.",
        en: "A worker that fails to start is no longer SILENT. The error handler was empty — deliberately, so a turn would not die because a helper could not start — and that made a launch that never happened look exactly like one that did: no report, no marker, nothing to read. A turn still survives such an error; the reason is now written where the rest of this mechanism's decisions are written.",
      },
      {
        ru: "И командный истолкователь называется ЯВНО, а не запрашивается настройкой «через оболочку». Уважает ли среда такую настройку — свойство среды, а не системы; когда не уважает, запуск падает с «не найдено» про файл, который очевидно есть, — прямо в тот самый пустой обработчик.",
        en: "And the command interpreter is NAMED outright rather than asked for through a «use a shell» option. Whether a runtime honours that option is a property of the runtime, not of the platform; where it does not, the spawn fails with «not found» about a file that plainly exists — straight into that same empty handler.",
      },
    ],
  },
  {
    version: "0.154.0",
    date: "2026-08-05",
    items: [
      {
        ru: "🔴 На третьей системе разрешение «выйти за пределы проекта» не запрашивалось НИКОГДА. Правило «путь внутри проекта» решало по одному признаку: относительный путь между ними не поднимается вверх. Между двумя КОРНЯМИ файловой системы относительного пути не существует вовсе — система возвращает абсолютный, в нём подъёма нет, и правило читало это как «внутри». То есть при проекте на одном диске любой путь на другом считался своим: ничего не оказывалось внешним, и охрана, которая обязана спросить перед тем, как тронуть что-то вне проекта, молчала — присутствуя. На системе с одним корнем такой случай породить НЕЛЬЗЯ, поэтому он и пережил все машины, на которых проверялся.",
        en: "🔴 On the third system the permission to reach outside the project was NEVER requested. The rule for «this path is inside the project» decided on one sign: the relative path between them does not climb. Between two filesystem ROOTS no relative path exists at all — the system answers with an absolute one, it contains no climb, and the rule read that as «inside». So with a project on one drive, every path on another counted as its own: nothing was ever external, and the guard whose job is to ask before touching anything outside stayed silent while being present. On a system with a single root the case CANNOT be produced, which is why it survived every machine it was checked on.",
      },
      {
        ru: "Само решение отделено от системы, поэтому проверяется где угодно — в том числе там, где такой случай невозможен: абсолютность спрашивается в ОБОИХ написаниях, а не в том, на котором говорит машина-читатель. Найдено не догадкой: падающая проверка была научена называть, что у неё СПРАШИВАЛИ, и вернула пустой список.",
        en: "The decision itself is separated from the platform, so it can be checked anywhere — including where the case cannot arise: absoluteness is asked in BOTH spellings rather than the one the reading machine happens to speak. Not found by guessing: the failing check had been taught to name what it HAD been asked for, and it came back with an empty list.",
      },
    ],
  },
  {
    version: "0.153.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Длительность запроса измеряется часами, которые способны его увидеть. Прежние считали целые миллисекунды, а быстрая точка отвечает быстрее одной — замер округлялся в ноль и отбрасывался как «не замер», то есть самые быстрые машины оказались бы теми, которые себя никогда не измеряют.",
        en: "A request's duration is timed by a clock able to see it. The previous one counted whole milliseconds, and a fast endpoint answers inside one — the reading rounded to zero and was discarded as not a reading at all, which would have made the fastest machines the ones that never measured themselves.",
      },
      {
        ru: "И проверка этой записи теперь сначала называет вердикт самой калибровки. Без этого прогон, где калибровка вовсе не состоялась, выглядел точно так же, как прогон, где она состоялась и ничего не записала, — а это противоположные неисправности. Прибор ответил сразу: калибровка сравнивает два замера и отказывается, когда они отличаются меньше её порога, потому что ниже него измеряется дрейф, а не кэш. Отказ — это механизм в работе; заглушка была неверна.",
        en: "And the check for that record now names the calibration's own verdict first. Without it, a run where the calibration never happened looked exactly like one where it happened and recorded nothing — opposite faults. The instrument answered at once: the calibration compares two readings and declines when they differ by less than its floor, because below it drift is measured rather than cache. The refusal is the mechanism working; the stand-in was what was wrong.",
      },
    ],
  },
  {
    version: "0.152.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Отчёт о возможностях машины описан там, где перечислены остальные средства управления: что это за машина и что из неё выведено — род и объём памяти, ядра, ускоритель, может ли ядро ограничить чужой код, есть ли контейнеры, — вместе с политикой окна и рабочей точкой, каждая с указанием, откуда взялось число.",
        en: "The machine-capacity report is described where the other management tools are listed: what this machine is and what was derived from it — memory kind and size, cores, accelerator, whether the kernel can confine foreign code, whether containers are available — together with the window policy and the working point, each naming where its number came from.",
      },
    ],
  },
  {
    version: "0.151.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Появился способ сказать «никогда не исполняй код без ограничения». Контейнер пробуется первым везде; там, где ядро тоже умеет ограничивать, запасной путь тоже ограничен. Там, где не умеет, запасной путь исполнял написанный моделью код без чего-либо между ним и машиной — понижение осознанное и объявленное в выводе, но ОТКАЗАТЬСЯ от него было нельзя: у машины, которая ограничивать не умеет, не было настройки, делающей её безопасной. По умолчанию выключено, потому что включение по умолчанию отняло бы возможность у целой системы, не спросив её владельца. Отказ называет выход: контейнер — это и есть та изоляция, которая у этой системы имеется.",
        en: "There is now a way to say «never run code with nothing confining it». A container is tried first everywhere; where the kernel can also confine, the fallback is confined too. Where it cannot, the fallback ran the model's own code with nothing between it and the machine — a deliberate degrade, announced in the output, and one that could not be REFUSED: a machine unable to confine had no setting that made it safe. Off by default, because turning it on by default would take the capability away from an entire system without its owner asking. The refusal names the way out: a container runtime is the isolation that system does have.",
      },
    ],
  },
  {
    version: "0.150.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Сколько вызовов одновременно доходит до модели — теперь ЗАМЕР этой машины, а не константа с чужой. Единица в работе сама пришла из настоящего измерения: два одновременных запроса на одном компьютере стоили 48.4с против 41.9с при последовательном прогоне, потому что одновременная подготовка ухудшает ОБА, а не совмещает их. Вывод верен для той машины и не является фактом обо всех: хост с двумя ускорителями может ответить иначе, а число ядер до сих пор не спрашивалось вообще. Ответ теперь берётся по порядку: что задал владелец → что измерено ЗДЕСЬ → единица как объявленный осторожный пол. И число сопровождается тем, ОТКУДА оно, — этого голое целое сказать не может.",
        en: "How many calls reach the model at once is now a MEASUREMENT of this machine rather than a constant from another. The 1 in use came from a real measurement itself: two concurrent requests on one computer cost 48.4s against 41.9s run one after the other, because concurrent preparation degrades BOTH instead of overlapping them. Sound for that machine, and not a fact about all of them: a host with two accelerators can answer differently, and the core count was never asked at all. The answer is now taken in order — what the owner set, what was measured HERE, and one as the declared conservative floor. And the number travels with WHERE it came from, which a bare integer cannot say.",
      },
      {
        ru: "Замер бесплатный: калибровка и так делает настоящий запрос известного размера, и его длительность теперь записывается. Сравнение появляется только тогда, когда машину действительно прогнали при двух разных значениях, — то есть ровно тогда, когда есть что сравнивать. Планка доказательности стоит на самой рабочей точке, а не внутри одной записи: иначе собственное измерение обвязки — по одному запросу за раз — было бы вечно неприемлемым.",
        en: "The measurement is free: the calibration already makes a real request of known size, and its duration is now written down. A comparison appears only once the machine has actually been run at two different settings — precisely when there is something to compare. The evidence bar sits on the working point rather than inside a single reading; otherwise the harness's own measurement, one request at a time, would have been permanently inadmissible.",
      },
      {
        ru: "И появился отчёт «что это за машина и что из неё выведено»: род и объём памяти, ядра, ускоритель, может ли ядро ограничить чужой код, есть ли контейнеры — вместе с рабочей точкой и политикой окна. Читать его стоит прежде, чем верить размеру окна или отказу: и то и другое — решения о железе, а железо у каждого своё.",
        en: "And there is now a report of what this machine is and what was derived from it: memory kind and size, cores, accelerator, whether the kernel can confine foreign code, whether containers are available — together with the working point and the window policy. Worth reading before believing a window size or a refusal: both are decisions about hardware, and hardware differs for everyone.",
      },
    ],
  },
  {
    version: "0.149.0",
    date: "2026-08-05",
    items: [
      {
        ru: "🔴 ГЛАВНОЕ: у кого стоит отдельная видеокарта, размер окна модели не планировался ВООБЩЕ. Четыре числа (резерв памяти, доля, пол, квант) были измерены на ОДНОЙ машине с единой памятью, и обвязка честно ОТКАЗЫВАЛАСЬ применять их где-либо ещё — отказ верный, но означал, что продукт верен для одной машины и отсутствует для следующей. Теперь политика ВЫВОДИТСЯ из машины: на единой памяти резерв — это суждение (сколько оставить рабочему столу, который делит тот же пул), а на отдельной карте судить не о чем — оставить нужно то, что УЖЕ занято, и эту цифру сообщает сам драйвер. Одно и то же поле оказывается выбором на одной машине и замером на другой, и оба ответа честны. Отказ остался только там, где род памяти вообще не определён: это не описание машины, а его отсутствие.",
        en: "🔴 THE HEADLINE: for anyone with a discrete graphics card, the model's window was NOT PLANNED AT ALL. The four numbers — memory reserve, commit share, floor, quantum — were measured on ONE machine with unified memory, and the harness honestly REFUSED to apply them anywhere else. The refusal was correct, and it meant a product right for one machine and absent for the next. The policy is now DERIVED from the machine: on unified memory the reserve is a judgement (how much to leave a desktop sharing the pool), while on a discrete card there is nothing to judge — what must be left is what is ALREADY HELD, and the driver reports that figure. The same field is a choice on one machine and a reading on another, and both are honest. The refusal remains only where the kind of memory could not be established at all: that is not a description of a machine but the absence of one.",
      },
      {
        ru: "Появилась одна сущность «что это за машина»: род и объём памяти, число ядер, ускоритель и его память, возможность изоляции ядром, наличие контейнеров. Читается при вызове, кладётся на диск с ОТПЕЧАТКОМ ЖЕЛЕЗА — прочитанное на другой машине никогда не подаётся за это. Занятая память в отпечаток не входит: иначе каждое чтение обесценивало бы предыдущее.",
        en: "There is now one entity for «what machine is this»: the kind and size of memory, the core count, the accelerator and its memory, whether the kernel can confine anything, whether containers are available. Read at call time and written to disk with a HARDWARE FINGERPRINT — a reading taken on another machine is never served for this one. Memory in use is deliberately not part of that fingerprint: otherwise every reading would invalidate the last.",
      },
      {
        ru: "И ускоритель спрашивается у КАЖДОГО вендора, а не у одного. Прежде спрашивался один, поэтому любая другая машина отвечала «ускорителя нет» — а «нет» это как раз то, что велит планировщику считать по системной памяти. Машина с картой, которую некому было назвать, планировалась как машина без карты. «Нет» и «не опознан» теперь разные ответы, и оба используются.",
        en: "And the accelerator is asked of EVERY vendor rather than one. Only one was asked before, so every other machine answered «no accelerator» — and «none» is precisely what tells the planner to size against system memory. A machine holding a card nobody could name was planned for as a machine without one. «None» and «unidentified» are now different answers, and both are used.",
      },
    ],
  },
  {
    version: "0.148.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Двенадцать проверок прав оболочки, не найдя ожидаемого запроса разрешения, теперь показывают, какие запросы БЫЛИ. Прежде каждая сообщала лишь «не найдено», и семнадцать одинаковых сообщений не отличали «разрешение не запросили вовсе» от «до него не дошли, потому что первым остановил другой запрос». Это разные неисправности с разными исправлениями, а стенд намеренно останавливается на первом же запросе — значит порядок и есть то, что нужно видеть.",
        en: "Twelve shell-permission checks, on not finding the request they expect, now show which requests there WERE. Each previously reported only «not found», and seventeen identical messages did not separate «the permission was never asked for» from «nothing reached it because an earlier request stopped the run». Those are different faults with different corrections, and the harness deliberately stops at the first request — so the order is exactly what needs to be visible.",
      },
    ],
  },
  {
    version: "0.147.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Две проверки обхода корпуса, не дождавшись отметки, теперь говорят, ЧТО решил механизм, а не только что файла нет. Здесь сходятся две очень разные вещи: обход, отказавшийся передавать работу, и передача, при которой не завелась подставная программа. Снаружи обе выглядят как отсутствующий файл и требуют противоположных исправлений.",
        en: "Two corpus-traversal checks, on finding no marker, now say WHAT the mechanism decided rather than only that a file is absent. Two very different things end there: a traversal declining to hand the work over, and a hand-over during which the stand-in failed to start. From outside both look like a missing file, and they call for opposite corrections.",
      },
    ],
  },
  {
    version: "0.146.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Проверки охраны каталога памяти и проверки внешних каталогов строят свои абсолютные пути для ТОЙ машины, на которой идут. Записанные с ведущей косой чертой, они были фактом об одной системе: дальше они склеиваются разделителем платформы, и получался путь, не начинающийся ни с корня, ни с каталога проекта, — охрана считала цель посторонней и пропускала её. Пятьдесят с лишним проверок докладывали, что охрана открыта, тогда как неверен был образец. Сама охрана не менялась: она с самого начала сравнивала по разделителю платформы.",
        en: "The memory-directory guard's checks and the external-directory checks now build their absolute paths for THE machine they run on. Spelled with a leading slash they were a fact about one system: they are then joined with the platform's separator, producing a path that starts with neither the root nor the project directory — so the guard read every target as foreign and let it through. Fifty-odd checks reported the guard as open when what was wrong was the fixture. The guard itself is unchanged; it compared by the platform's separator all along.",
      },
    ],
  },
  {
    version: "0.145.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Проба, спрашивающая «заводится ли здесь мой инструмент», укорочена и получила собственный бюджет: она живёт в подготовительном хуке, у которого есть свой потолок, и проба, способная его пересидеть, докладывает о поломке хука вместо ответа на свой вопрос.",
        en: "The probe asking «does my instrument start here» was shortened and given a budget of its own: it lives inside a setup hook with its own ceiling, and a probe able to outlast that hook reports the hook as broken instead of answering its question.",
      },
    ],
  },
  {
    version: "0.144.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Отсоединение процесса запрашивается на прямом пути запуска и НЕ запрашивается там, где запуск идёт через оболочку. Различие измерено, а не выбрано из вкуса: отсоединение вместе с оболочкой и отброшенным выводом не запускает НИЧЕГО на той системе, которой эта оболочка и нужна — та же программа стартует обычным запуском и не стартует отсоединённым, восемнадцать секунд, без файла и без единого сообщения, потому что вывод отбрасывается по замыслу. Ход завершается без ожидания благодаря другому механизму, и он применяется в обоих случаях; отсоединение добавляло лишь отдельную группу процессов — выгода меньшая, чем то, что работа вообще начинается.",
        en: "Detaching is asked for on the direct spawn and NOT where the start goes through a shell. The difference is measured rather than a matter of taste: detaching, plus a shell, plus discarded output starts NOTHING on the very system that needs the shell — the same program launches from a plain spawn and never launches from a detached shell one, eighteen seconds, no file and no message, because the output is discarded by design. What actually lets the turn finish without waiting is a different mechanism, and it applies to both; detaching only added a separate process group, a smaller benefit than the work starting at all.",
      },
    ],
  },
  {
    version: "0.143.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Проверка, доказывающая, что обход корпуса ЗАПУСКАЕТ отдельную программу, теперь сначала спрашивает, может ли она вообще запустить свой собственный инструмент, — и спрашивает это ЗАПУСКОМ, а не по названию системы. Там, где не может, она честно говорит, что часть про аргументы не покрыта, и оставляет доказанной ту часть, которая доказана: ход не отменён и обход дошёл до запуска. Красная строка, утверждающая, что механизм мёртв, и строка «мой прибор не завёлся» снаружи выглядят одинаково, а означают противоположное; выбирать между ними должна проверка, а не читатель.",
        en: "The check proving that a corpus traversal LAUNCHES a separate program now first asks whether it can start its own instrument at all — and asks by starting one, not by reading the platform's name. Where it cannot, it says plainly that the argument half is not covered and leaves proven the half that is: the turn was not cancelled and the traversal ran as far as launching. A red line claiming a mechanism is dead and a line saying «my instrument would not start» look identical from outside and mean opposite things; choosing between them is the check's job, not the reader's.",
      },
    ],
  },
  {
    version: "0.142.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Запуск через оболочку теперь заключает в кавычки то, что запускает. Такой запуск передаёт оболочке строку целиком и ОТКЛЮЧАЕТ автоматическое заключение в кавычки, которое делает обычный запуск, — поэтому программа, живущая по пути с пробелом (а именно там такие пути и живут), читается как команда плюс посторонние слова, и не стартует ничего. Замерено: воркер не запускался восемнадцать секунд, и ни одна строка об этом не сказала.",
        en: "Starting through a shell now quotes what it starts. That form hands the shell the whole line and TURNS OFF the automatic quoting a direct spawn performs — so a program living under a path with a space in it, which is exactly where such paths live, reads as a command plus stray words and nothing starts at all. Measured: the worker did not launch for eighteen seconds, and not one line said so.",
      },
    ],
  },
  {
    version: "0.141.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Две проверки, которые ждут ЗАПУСКА отдельной программы, получили собственный бюджет времени. Прежде их обрывал общий бюджет прогонщика на пятой секунде — раньше, чем истекало их собственное ожидание, — поэтому продление ожидания ничего не меняло, а результат читался как «механизм не сработал». Бюджет должен принадлежать той проверке, которая ждёт, и соответствовать тому, чего она ждёт.",
        en: "Two checks that wait for a separate program to START were given a time budget of their own. The runner's shared budget cut them at the fifth second — sooner than their own wait expired — so extending that wait changed nothing while the result read as «the mechanism never fired». A budget belongs to the check that waits, and has to match what it is waiting for.",
      },
    ],
  },
  {
    version: "0.140.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Опрос активности в запросе на слияние перестал спрашивать «а ты вообще установлен?» без ограничения времени. Это единственный вызов, который не может быть долгим по уважительной причине, поэтому бесконечное ожидание на нём — всегда затык (приглашение войти, подвисший сетевой диск в пути поиска), держащий ход открытым и не показывающий ничего.",
        en: "The pull-request activity poll stopped asking «are you installed at all?» without a time limit. That is the one call here which cannot be slow for a good reason, so an unbounded wait on it is always a wedge — a sign-in prompt, a stalled network drive on the search path — holding a turn open with nothing to show.",
      },
      {
        ru: "И проверки, ожидающие ПОЯВЛЕНИЯ чего-либо, получили щедрый бюджет вместо едва достаточного. Подставная программа запускается тем механизмом, какого требует система, а холодный старт там стоит секунд. Бюджет, которого хватает лишь на самом быстром пути, превращает медленный старт в ложное отрицание — ровно то прочтение, которое говорит «механизм не сработал», когда он просто ещё не успел.",
        en: "And checks that wait for something to APPEAR were given a generous budget instead of a barely sufficient one. A stand-in program is started through whatever machinery the system requires, and a cold start there costs seconds. A budget that suffices only on the fastest path turns a slow start into a false negative — precisely the reading that says a mechanism never fired when it merely had not yet.",
      },
    ],
  },
  {
    version: "0.139.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Ограничитель захватываемого вывода теперь ограничивает. Прежняя форма переставала добавлять только ПОСЛЕ превышения потолка, поэтому последний кусок ложился целиком, и настоящей границей было «потолок плюс одно чтение». Программа, напечатавшая пять мегабайт одной записью, проходила стотысячный предел насквозь. Коварство в том, что промах зависел от РАЗБИЕНИЯ на куски: та же программа при другой настройке интерпретатора приходит мелкими порциями и укладывается — то есть один и тот же код выглядел верным на одной машине и неверным на другой по причине, не относящейся ни к той, ни к другой. Теперь берётся ровно остаток бюджета, и зависимость исчезает.",
        en: "The cap on captured output now caps. The old form stopped adding only AFTER the ceiling was crossed, so the last chunk landed whole and the real bound was «the ceiling plus one read». A program printing five megabytes in a single write went straight through a hundred-thousand-character limit. What made it slippery is that the miss depended on CHUNKING: the same program under a different interpreter setting arrives in small pieces and stays under — so identical code looked correct on one machine and wrong on another for a reason belonging to neither. It now takes exactly the remaining budget, and the dependency is gone.",
      },
    ],
  },
  {
    version: "0.138.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Подставная программа, которой проверки доказывают, что механизм действительно кого-то ЗАПУСТИЛ, теперь на каждой системе написана на том, что эта система заводит БЕЗ посредников. Прежде это был POSIX-скрипт плюс обёртка, передающая его POSIX-оболочке, — цепочка из трёх программ, а цепочка умеет рваться молча, когда вывод потомка никто не слушает. Так и вышло: файл с аргументами просто не появлялся, и проверки читали это как «обход не запустил воркер» — ровно ту подмену, ради ловли которой они и существуют.",
        en: "The stand-in program by which checks prove a mechanism really DID launch something is now written, on each system, in what that system starts WITHOUT help. It used to be a POSIX script plus a wrapper handing it to the POSIX shell — a chain of three programs, and a chain can break silently when nobody is listening to the child's output. That is what happened: the argv file simply never appeared, and the checks read it as «the traversal never launched the worker», precisely the substitution they exist to catch.",
      },
    ],
  },
  {
    version: "0.137.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Разбор корпуса запускает названный оператором интерпретатор так, как этот файл вообще можно запустить. На третьей системе совершенно обычный ответ на вопрос «чем запускать мой скрипт» — командный файл: именно так там поставляется точка входа у большинства инструментов. Прямым запуском такой файл не стартует — система отвечает «не найдено» про файл, который очевидно есть. Теперь ровно такие передаются оболочке, а всё остальное запускается напрямую, как и раньше: иначе между обвязкой и её собственными аргументами встала бы вторая грамматика. Разница между «уважить выбор оператора» и «молча его проигнорировать».",
        en: "The corpus pass starts the interpreter the operator named in the way that file can actually be started. On the third system a perfectly ordinary answer to «what runs my script» is a command file — that is how most tooling ships its entry point there — and such a file does not start by direct spawn: the system answers «not found» about a file that plainly exists. Exactly those are now handed to a shell, while everything else is spawned directly as before, since routing a real executable through a shell would put a second grammar between the harness and its own arguments. The difference between honouring the operator's choice and silently ignoring it.",
      },
      {
        ru: "И проверка рабочего каталога перестала сравнивать НАПИСАНИЕ. Оболочка печатает путь в той форме, какая ей удобна: macOS отдаёт временный каталог через ссылку, POSIX-оболочка на третьей системе печатает свою дисковую форму, а сама система может вернуть укороченное имя вместо длинного — и всё это ОДИН каталог. Сравнение текста спрашивало лишь о том, какую форму выбрала оболочка. Теперь проверка пишет файл и смотрит, лёг ли он туда, куда инструменту указали.",
        en: "And the working-directory check stopped comparing SPELLING. A shell prints a path in whatever form suits it: macOS serves the temp directory through a link, a POSIX shell on the third system prints its own drive form, and that system may return a shortened name instead of a long one — and every one of those is ONE directory. Comparing text only asked which form the shell chose. The check now writes a file and looks for it where the tool was pointed.",
      },
    ],
  },
  {
    version: "0.136.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Запуск кода теперь прямо говорит потомку, что разговор идёт в UTF-8. Иначе Python пишет вывод в кодовой странице консоли, и на однобайтовой это не косметика, а ПАДЕНИЕ: попытка напечатать слово с диакритикой обрывает программу, и она не выдаёт ничего. Под это подпадает любой не-английский текст, любые эмодзи и любой из языков, на которых пишут сами пользователи. Режим UTF-8 заодно чинит чтение имён файлов, поэтому файл с не-ASCII именем теперь можно открыть и изнутри кода.",
        en: "Running code now tells the child outright that the conversation is in UTF-8. Otherwise Python writes its output in the console's code page, and on a single-byte one that is not cosmetic but a CRASH: printing a word with a diacritic ends the program, which then produces nothing at all. That covers any non-English text, any emoji, and any of the languages the users themselves write in. UTF-8 mode also fixes how filenames are read, so a file with a non-ASCII name can now be opened from inside the code as well.",
      },
      {
        ru: "И проверки перестали требовать от файловой системы того, чего она не предлагает: имя файла с двойной кавычкой на одной из систем запрещено, а проверка ждала, что файл создастся. Всё, что оболочка попыталась бы истолковать — пробелы, доллар, обратная кавычка, апостроф, скобки, — в имени осталось; убран ровно один символ, и в содержимом он сохранён.",
        en: "And the checks stopped asking the filesystem for what it does not offer: a filename containing a double quote is forbidden on one of the systems, while the check expected the file to be created. Everything a shell would try to interpret — spaces, a dollar, a backtick, an apostrophe, parentheses — stays in the name; exactly one character was dropped, and it is kept in the content.",
      },
    ],
  },
  {
    version: "0.135.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Подставные программы, которыми проверки доказывают, что механизм действительно ЗАПУСКАЕТСЯ, писались вручную — и на третьей системе получались файлами, которые она запустить не может. Ни один вызов не стартовал, журнал вызовов оставался пуст, и проверки читали это как «пол не запустил ни одного инструмента»: ровно та подмена, ради ловли которой они и существуют, но по причине, к самому полу отношения не имеющей. Теперь все они идут через одно определение, которое заодно пишет обёртку, нужную этой системе для старта.",
        en: "The stand-in programs by which checks prove a mechanism really IS INVOKED were written by hand, and on the third system came out as files it cannot execute. Not one call started, the argv log stayed empty, and the checks read that as «the floor invoked none of its tools» — precisely the substitution they exist to catch, for a reason having nothing to do with the floor. They all go through one definition now, which also writes the wrapper that system needs in order to start anything.",
      },
      {
        ru: "И чтение текстовых файлов в проверках адаптера перестало полагаться на кодировку по умолчанию: на одной из систем она однобайтовая, и чтение собственных исходников проекта обрывалось ошибкой посреди файла — проверка падала из-за нечитаемости файла, а не из-за того, что в нём написано.",
        en: "And text reads in the adapter's checks stopped relying on the default encoding: on one system it is a single-byte code page, and reading this project's own sources broke partway through a file — the check failed because the file was unreadable, not because of what it says.",
      },
      {
        ru: "Отчёт проверки развёртывания на той же системе печатался мимо потока вывода: на экране он был верным и полным, а перехватить его было нельзя. Отчёт, который программа не может прочитать, — половина отчёта.",
        en: "The deploy check's report on that same system printed past the output stream: on screen it was correct and complete, and nothing could capture it. A report a program cannot read is half a report.",
      },
    ],
  },
  {
    version: "0.134.0",
    date: "2026-08-05",
    items: [
      {
        ru: "На третьей системе диагностический журнал адаптера не ограничивался ничем. Две другие вручают процессу уже открытый файл и позволяют спросить у ядра, какой именно, — там ротация работает сама. Здесь такого вопроса задать нельзя, и адаптер честно отвечает «не знаю», потому что обрезать не тот файл хуже, чем не обрезать вовсе. Но тогда обязана назвать файл сама служба — иначе ничем не ограничен ровно тот журнал, который правила велят читать ПЕРВЫМ при любом зависании. Теперь задание перенаправляет свой вывод в названный файл и это имя адаптеру сообщает.",
        en: "On the third system the adapter's diagnostic log was bounded by nothing. The other two hand the process an already-open file and let it ask the kernel which file that is, so rotation looks after itself. Here that question cannot be asked, and the adapter honestly answers «I do not know», because truncating the wrong file is worse than not truncating at all. But then the service itself must name the file — otherwise the one log the rules say to read FIRST whenever anything hangs is the one thing nothing bounds. The task now redirects its output to a named file and tells the adapter that name.",
      },
      {
        ru: "И проверка перестала требовать от каждой системы того, что умеет только часть из них: теперь каждой задаётся вопрос, на который она может ответить, а отдельная проверка следит, что названный явно журнал уважается везде — ведь именно это и держит границу там, где спросить нельзя.",
        en: "And the check stopped demanding of every system what only some of them can do: each is now asked the question it can answer, while a separate check watches that an explicitly named log is honoured everywhere — since that is precisely what holds the bound where the question cannot be asked.",
      },
    ],
  },
  {
    version: "0.133.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Путь этой машины, вставленный внутрь команды оболочки, теперь записывается так, чтобы оболочка прочла его как тот же самый путь. Оболочка у обвязки одна и та же везде — в этом и смысл единой грамматики, — а вот пути приходят с файловой системы, которая на одной из систем пишет их обратной косой. Внутри команды такая косая означает экранирование: подставная программа исправно писала журнал вызовов в файл, которого никто не мог найти, и проверки докладывали, что инструменты не запускались вовсе.",
        en: "A path from this machine, embedded inside a shell command, is now written so the shell reads it as that same path. The harness's shell is the same everywhere — that is the point of one grammar — but paths come from a filesystem that on one system spells them with a backslash, and inside a command a backslash means escaping. A stand-in program dutifully logged every call into a file nobody could find, and the checks reported that the tools had never run at all.",
      },
      {
        ru: "И проверка, гоняющая песочницу в контейнере, спрашивала «отвечает ли демон», тогда как сам инструмент спрашивает «умеет ли он линуксовые образы». На машине, где демон отвечает, но образы не запускает, проверка гоняла случаи, от которых инструмент СПРАВЕДЛИВО отказался. Условие, расходящееся с кодом, который оно охраняет, меряет только это расхождение.",
        en: "And the check exercising the container sandbox asked «does the daemon reply» while the tool itself asks «can it run Linux images». On a machine where the daemon replies but cannot start those images, the check ran cases the tool had RIGHTLY declined. A gate that disagrees with the code it gates measures only the disagreement.",
      },
    ],
  },
  {
    version: "0.132.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Дочитана до конца история про несработавшую контрольную точку. Служба, которая её снимает, подставляет себя в общую ссылку в момент ПОСТРОЕНИЯ своего слоя — а слой запоминается, поэтому повторный запрос отдаёт готовую службу и ссылку заново не выставляет. Финализатор соседней области её при этом уже снял. В работе это невидимо: один долгоживущий рантайм, построен один раз, снят при выходе. В наборе проверок каждая закрывает свою область — и следующей достаётся пустая ссылка. На одной системе порядок это скрывал, на другой нет. Проверки теперь воспроизводят живое состояние прямо, а не полагаются на то, кто из соседей отработал последним.",
        en: "The story of the checkpoint that was never taken is finished. The service that takes it binds itself into a shared reference when its LAYER IS BUILT — and the layer is memoised, so asking for the service again returns the existing one and does not re-bind. A neighbouring scope's finaliser had meanwhile emptied it. In use this is invisible: one long-lived runtime, built once, torn down at exit. In a suite each check closes a scope, and the next one inherits an empty reference. On one system the ordering hid it; on another it did not. The checks now reproduce the live shape directly instead of depending on which neighbour ran last.",
      },
    ],
  },
  {
    version: "0.131.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Сторож, который следит, чтобы у каждой заявленной вспомогательной функции был живой вызывающий, собирал имя модуля из настоящего пути — и на третьей системе переставал узнавать собственные исключения, записанные через прямую косую. Имя модуля — это опознавательный знак, его читают люди и он ездит между машинами, поэтому у него ровно одна форма, независимо от машины.",
        en: "The watchdog that requires every declared helper to have a live caller assembled the module name from a real path — and on the third system stopped recognising its own exemptions, which are written with a forward slash. A module name is an identifier: people read it and it travels between machines, so it has exactly one shape regardless of the machine.",
      },
      {
        ru: "А проверка, что каждая команда установки — синтаксически верная команда оболочки, называла оболочку по её расположению на одной системе. Строки были в порядке; проверка просто не могла запустить разбор. Теперь она спрашивает ту же программу, которую спросит установщик.",
        en: "And the check that every install command is syntactically valid shell named the shell by its location on one system. The strings were fine; the check simply could not start the parser. It now asks the same program the installer will ask.",
      },
    ],
  },
  {
    version: "0.130.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Создание файла по пути вида «~/заметки.txt» на третьей системе клало файл НЕ туда, куда просили: раскрытие читало только одну переменную окружения, а там домашний каталог хранится в другой. Пустая подстановка превращала путь в относительный, и файл молча уезжал в рабочий каталог сессии. Хуже того, это было ТРЕТЬЕ место со своим ответом на вопрос «где дом», а одно из двух остальных — запрет на запись: путь, о котором они расходятся, проверяется под одним именем, а пишется под другим.",
        en: "Creating a file at a path like «~/notes.txt» on the third system put the file somewhere other than asked: the expansion read only one environment variable, and there the home directory lives in a different one. The empty substitution turned the path relative and the file quietly went to the session's working directory. Worse, this was the THIRD module with its own answer to «where is home», and one of the other two is the write refusal: a path they disagree about is checked under one name and written under another.",
      },
      {
        ru: "Заодно сведены к одному определению ещё четыре таких места, включая одно, которое собирало каталог данных вручную и потому не замечало ни переноса данных движка, ни настройки размещения — публичный реестр доказательств оставался бы на старом месте.",
        en: "Four more such places are collected into the one definition, including one that rebuilt the data directory by hand and so noticed neither a move of the engine's data nor the setting that places it — the public proof registry would have been left behind at the old location.",
      },
    ],
  },
  {
    version: "0.129.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Проверка снятия контрольной точки больше не опирается на случайность. Точку снимает служба запуска подпроцессов; она подставляет себя в общую ссылку при построении и УБИРАЕТ её, когда её область закрывается. Проверка эту службу не запрашивала — и работала на остатке от соседа, который построил её последним. На одной системе остаток доживал, на другой финализатор успевал сработать раньше: службы не оказывалось, точка не снималась. Теперь зависимость заявлена прямо. Найдено не рассуждением, а тем, что накануне научили называть причину отказа: машина сама сказала, чего ей не хватило.",
        en: "The checkpoint check no longer rests on chance. The checkpoint is taken by the service that spawns subprocesses; it binds itself into a shared reference when its layer is built and CLEARS that reference when its scope closes. The check never asked for the service — it was running on the leftover binding of whichever neighbour had built the layer last. On one system that leftover survived; on another the finaliser ran first, the service was not there, and no checkpoint was taken. The dependency is now stated outright. Found not by reasoning but because the refusal had just been taught to name itself: the machine said what it was missing.",
      },
    ],
  },
  {
    version: "0.128.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Отказ снять контрольную точку теперь называет себя. Пять разных условий возвращали одно и то же слово «пропущено», и по нему нельзя было узнать, какое из них сработало: ни в логе, ни в проверке. Каждое условие пишет свою причину в бортовой самописец решений — тот самый канал, который для таких молчаливых решений и заведён, — вместе с числами, по которым видно, что именно не сошлось. Пользователь этого не видит: канал только для разбора.",
        en: "A refusal to take a checkpoint now names itself. Five different conditions returned the same word «skipped», and from that word there was no way to learn which one fired — not from the log, not from a check. Each condition now records its reason on the decision recorder — the very channel that exists for silent decisions like these — together with the numbers that show what did not line up. The user sees none of it: the channel is for diagnosis only.",
      },
      {
        ru: "И закрыта дыра в самом запрете: раскрытие «~» и «$HOME» брало домашний каталог из одного источника, а правила запрета строились из другого. Два прочтения одного и того же — и они действительно расходятся: одно читает системную базу учётных записей и кэшируется на старте, другое берёт то, что реально выставили приложение и обвязка. Как только они разошлись, «~/.ssh/authorized_keys» превращался в один файл, а правило, которое его запрещает, было написано про другой, — совпадения нет, запись разрешена. Теперь источник один; проверка нарочно разводит эти два прочтения и краснеет, если вернуть прежнее.",
        en: "And a hole inside the refusal itself is closed: expanding «~» and «$HOME» took the home directory from one source while the deny rules were built from another. Two readings of one thing — and they genuinely diverge: one reads the system account database and is cached at process start, the other takes what the app and the harness actually set. The moment they differed, «~/.ssh/authorized_keys» became one file while the rule refusing it named another — no match, write allowed. There is one source now; a check deliberately drives the two apart and goes red if the old reading returns.",
      },
      {
        ru: "Понадобилось это сразу: те же проверки на другой системе показали, что точка не снимается, и не сказали почему. Теперь причина попадает прямо в текст несошедшейся проверки, поэтому расхождение между системами приходит уже с диагнозом, а не как повод начинать расследование.",
        en: "It was needed at once: the same checks on another system showed that no checkpoint was taken and did not say why. The reason now travels into the text of the failing check itself, so a difference between systems arrives already diagnosed rather than as the start of an investigation.",
      },
    ],
  },
  {
    version: "0.127.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Запуск кода теперь находит интерпретатор, а не называет его по памяти. Имя «python3» — это соглашение одной системы; на другой интерпретатор зовётся иначе, и жёсткое имя давало отказ вида «python не установлен» на машине, где он очевидно стоит. Список кандидатов берётся оттуда же, откуда его берёт установка служебной части, — чтобы две половины продукта не разошлись во мнении, как здесь называется интерпретатор. То же и со средой выполнения JavaScript: имя разрешается в полный путь, потому что по голому имени запуск подставляет расширение не везде.",
        en: "Running code now finds the interpreter instead of naming it from memory. «python3» is one system's convention; on another the interpreter is called something else, and the hardcoded name produced a «python is not installed» refusal on a machine where it plainly is. The candidate list comes from the same place the service installer takes it, so the two halves of the product cannot come to disagree about what an interpreter is called here. The same for the JavaScript runtime: the name is resolved to a full path, because a bare name is not filled out with an extension everywhere.",
      },
      {
        ru: "И проверки перестали задавать рабочим каталогом «/tmp». Каталога с таким именем на третьей системе нет, а запуск с несуществующим рабочим каталогом сообщает об отсутствии ПРОГРАММЫ — поэтому проверка объявляла оболочку ненайденной там, где она установлена. Берётся настоящий временный каталог этой машины, каким бы он ни был.",
        en: "And the checks stopped naming «/tmp» as a working directory. No such directory exists on the third system, and spawning with a working directory that does not exist reports the PROGRAM as missing — so a check declared the shell absent on a machine where it is installed. The real temp directory of whatever machine is running is used instead.",
      },
    ],
  },
  {
    version: "0.126.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Правило, привязанное к домашнему каталогу, теперь строится ровно одним способом — и сразу в обоих написаниях. Обвязка не выбирает форму этого каталога: он приходит из окружения, и на одной из систем приходит с обратными косыми. Склейка одной формы с другой давала путь, не принадлежащий ни одной системе и не совпадающий ни с чем — так запрет на автозапуск и на ключи доступа оказывался немым при полностью зелёных проверках. Ошибка была сделана трижды в трёх списках одинаково, поэтому вместо трёх исправлений сделано одно определение: другого способа привязаться к дому больше нет.",
        en: "A rule anchored at the user's home is now built exactly one way — and in both spellings at once. The harness does not choose that directory's shape: it arrives from the environment, and on one system it arrives with backslashes. Joining one shape with the other produced a path belonging to no system and matching nothing, which is how the refusals covering autostart and key files came to be silent while their checks were entirely green. The same mistake had been made three times in three lists, so instead of three corrections there is one definition: there is no other way to anchor at a home now.",
      },
      {
        ru: "И проверки перестали опираться на то, что на машине есть конкретные посторонние файлы: там, где нужна была настоящая программа, она теперь создаётся — с тем расширением, которого требует эта система. Прежде проверка искала то, чего на третьей системе просто нет, и сообщала о поломке поиска, тогда как не хватало лишь того, что он искал.",
        en: "And the checks stopped resting on particular unrelated files happening to exist on the machine: where a real program was needed, one is now made — carrying the extension that system requires of an executable. Before, a check looked for something the third system simply does not have and reported the lookup broken, when all that was missing was the thing it went looking for.",
      },
    ],
  },
  {
    version: "0.125.0",
    date: "2026-08-05",
    items: [
      {
        ru: "В репозиторий попали файлы, чьи имена целиком состояли из чужих разделителей, и на третьей системе это ломало не тесты, а саму выкачку дерева: git отказывает всему дереву целиком и выходит с ошибкой ещё до старта любой проверки — а выглядит это как «тесты упали». Файлы убраны, причина закрыта, и поставлены ворота: трекнутый путь с обратной косой чертой теперь запрещён без исключений. Исключений нет намеренно — такой символ в этом проекте не нужен ничему, поэтому честное правило абсолютное, и его нельзя будет обойти потом по одному удобному пути за раз.",
        en: "Files whose names consisted entirely of another system's separators reached the repository, and on the third system that broke not the tests but the checkout itself: git refuses the whole tree and exits before any check starts — while reading like «the tests failed». The files are gone, the cause is closed, and a gate is in place: a tracked path containing a backslash is now refused, without exceptions. The absence of exceptions is deliberate — nothing in this project needs that character, so the honest rule is the absolute one, and it cannot later be argued away one convenient path at a time.",
      },
      {
        ru: "Причина же была в том, что четыре хранилища — память, накопитель разбора корпуса, хранилище выгруженных кусков и журнал обращений за помощью — спрашивали, где им лежать, не уточняя, что спрашивают про ЭТУ машину. Под прогоном, который притворяется другой системой, они писали настоящие файлы под чужими именами. Теперь у них одно общее определение, и забыть в нём нечего.",
        en: "The cause was that four stores — memory, the corpus accumulator, the offloaded-chunk store and the ask ledger — asked where they should live without saying they were asking about THIS machine. Under a run pretending to be another system they wrote real files under the other system's names. They now share one definition, which leaves nothing to forget.",
      },
    ],
  },
  {
    version: "0.124.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Запланированная задача теперь называет оболочку полным путём. Планировщики — и системный на macOS, и на Linux — программу в PATH НЕ ищут: определение, где написано просто «bash», не запускается вовсе, и узнаётся об этом в ту самую минуту, когда никто не смотрит. Для запуска короткое имя по-прежнему правильно (пусть PATH и отвечает), поэтому это два разных ответа, а не один: тот, кем запускают, и тот, кого записывают в определение. Поймано проверкой, где полный путь был вписан буквально, — она покраснела, как только вместо буквы появилось вычисление.",
        en: "A scheduled job now names the shell by full path. Neither scheduler — the one on macOS nor the one on Linux — searches PATH: a definition that says merely «bash» does not start at all, and that is discovered at the exact minute nobody is watching. For spawning, the short name remains right (let PATH answer), so these are two different answers rather than one: the shell you run with, and the shell you write into a definition. Caught by a check that had the full path spelled out literally — it went red the moment a computation replaced the literal.",
      },
      {
        ru: "И собрана в одно место склейка путей под чужую систему: раньше каждый файл шва склеивал сам, и на выходе получались гибриды вроде пути с обеими косыми чертами сразу — форма, не совпадающая ни с одним правилом. Теперь диалект один на весь шов, и отдельная проверка требует, чтобы в ответе была ровно одна разновидность разделителя.",
        en: "And path joining for another system is collected into one place: each file of the seam used to join for itself, producing hybrids such as a path carrying both kinds of slash at once — a shape matching no rule at all. The dialect is now one definition for the whole seam, and a separate check requires every answer to carry exactly one kind of separator.",
      },
    ],
  },
  {
    version: "0.123.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Запрет на запись в системные файлы молчал на третьей системе целиком. Причина не в списке — он там применялся, — а в том, что среда сама переписывает такой путь в свою форму с буквой диска и обратными слэшами ещё до проверки, и правила, написанные прямыми, переставали совпадать. Проверка теперь смотрит и на это переписанное написание, ровно как она уже давно смотрит на второе имя системных каталогов macOS. Буква диска отбрасывается безопасно: правило совпадает по началу пути, поэтому обычный рабочий файл системным от этого не становится — на это есть отдельная проверка. Важно, что это не теория: обвязка на той системе ТРЕБУЕТ POSIX-оболочку, а через неё файлы вроде автозапуска командной строки — настоящие и исполняются при каждом входе.",
        en: "The refusal to write into system files was silent on the third system entirely. Not because the list was missing there — it was applied — but because the environment itself rewrites such a path into its own drive-lettered, backslashed form before the check runs, and rules written with forward slashes stopped matching. The check now also looks at that rewritten spelling, exactly as it has long looked at the second name macOS gives its system directories. Dropping the drive letter is safe: a rule matches by the start of the path, so an ordinary working file does not become a system one — there is a separate check for that. This is not theoretical: the harness REQUIRES a POSIX shell on that system, and through it files such as the shell's own startup script are real and run at every login.",
      },
      {
        ru: "Разделено то, что раньше смешивалось: одни функции ОТВЕЧАЮТ, где что лежало бы на названной системе, другие ДЕЙСТВУЮТ — открывают файл здесь и сейчас. Первые обязаны отвечать в форме той системы, о которой спросили; вторые — всегда в форме этой машины, иначе прогон, притворяющийся другой системой, пишет свои хранилища туда, откуда их здесь никто не откроет. Различие закреплено проверкой, которая гоняет обе разновидности под подменой платформы.",
        en: "A distinction that had been blurred is now drawn: some functions REPORT where something would live on a named system, others ACT — they open a file here and now. The first must answer in the shape of the system asked about; the second always in the shape of this machine, or a run pretending to be elsewhere writes its stores where nothing here can open them. The distinction is pinned by a check that drives both kinds under a substituted platform.",
      },
    ],
  },
  {
    version: "0.122.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Функции, которые спрашивают «где это лежит на такой-то системе», склеивали путь по правилам ТОЙ машины, на которой их спросили. Параметр системы им, по сути, лгал: спроси с одной машины про другую — и в ответ приходил путь наполовину чужой формы. На настоящей машине обе формы совпадают, поэтому в работе это было невидимо и вылезало ровно там, где одну систему спрашивают про другую, — то есть в тех самых проверках, что строят правила запрета. Теперь каждая такая функция отвечает в форме той системы, о которой её спросили; пути на этой машине не сдвинулись ни на символ. Заодно исправлены и ожидания проверок: они тоже были написаны в форме машины-хозяина, из-за чего верный ответ кода читался как ошибка.",
        en: "Functions that answer «where does this live on such-and-such a system» joined the path by the rules of the machine they were asked on. The system parameter was, in effect, lying to them: ask from one machine about another and the answer came back half in the wrong shape. On a real machine both shapes agree, so this was invisible in ordinary work and surfaced exactly where one system is asked about another — which is where the deny rules are checked. Each such function now answers in the shape of the system it was asked about; paths on this machine did not move by a single character. The checks were corrected too: their expectations were also written in the host machine's shape, which made the code's correct answer read as a failure.",
      },
    ],
  },
  {
    version: "0.121.0",
    date: "2026-08-05",
    items: [
      {
        ru: "На третьей системе путь к файлу SSH-ключей НЕ отказывался к записи — то есть первое, ради чего список запретов и существует, там было открыто, при полностью зелёных проверках на двух других системах. Причина в разделителе: правила писались с одним видом косой черты, а домашний каталог там пишется с другим, и склейка давала гибрид, не совпадающий ни с чем. Теперь каждое такое правило принимает оба написания, а домашняя привязка строится в обоих. Найдено приёмом, которого раньше не пробовали: система подменяется не только по имени, но и вместе с формой домашнего каталога — тогда правила строятся из тех самых строк, которые эта система и производит. Проверки на это — чистая работа со строками, поэтому идут на любой машине и поймали бы дефект с самого начала. Обратная проверка сделана: вернуть одно написание — и проверка краснеет.",
        en: "On the third system the path to the SSH key file was NOT refused for writing — the first thing the deny list exists for was open there, with the checks on the other two systems entirely green. The cause is the separator: the rules were written with one kind of slash while the home directory there is written with the other, and joining them produced a hybrid matching nothing. Every such rule now accepts both spellings, and the home-anchored one is built in both. Found with a technique not tried before: the system is substituted not only by name but together with the shape of its home directory, so the rules are built from the very strings that system produces. The checks for this are pure string work, so they run on any machine and would have caught it from the start. The reverse check was done: restore a single spelling and a check goes red.",
      },
    ],
  },
  {
    version: "0.120.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Выбор изолированного запуска задавал не тот вопрос. Он спрашивал, отвечает ли служба контейнеров, — а все образы, которыми пользуется этот инструмент, принадлежат одной системе, и на другой служба может быть совершенно здоровой и при этом не уметь запустить ни один из них. Инструмент выбирал способ, которым не мог воспользоваться: на сборочной машине третьей системы десять проверок падали при службе, объявившей себя доступной. Живой человек упёрся бы в ту же стену — явно запрошенная изоляция не отказывала бы честно, а ломалась. Теперь спрашивается ровно то, что определяет пригодность образов, и служба, которая их не потянет, честно считается недоступной: инструмент уходит на защиту ядра или отказывает, и в обоих случаях говорит, что произошло. Заодно убран глушитель ошибок в условии проверок: он проглатывал отсутствующую зависимость и отвечал «контейнеров нет» — двенадцать проверок молча пропускались, а две работали, опираясь на ложную посылку.",
        en: "The choice of isolated execution asked the wrong question. It asked whether the container service answers — but every image this tool uses belongs to one system, and on another the service can be perfectly healthy while unable to start any of them. The tool was choosing a route it could not take: on the third system's build machine ten checks failed while the service reported itself available. A real person would have hit the same wall — isolation asked for explicitly would not have refused honestly, it would have broken. The question now matches what actually determines whether the images can run, and a service that cannot run them counts honestly as unavailable: the tool falls back to the kernel protection or refuses, and says which in either case. A silent error-swallow was removed from the checks' own condition as well: it absorbed a missing dependency and answered \"no containers\" — twelve checks skipped in silence while two ran on a premise that was false.",
      },
    ],
  },
  {
    version: "0.119.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Слой, отвечающий за различия систем, строил пути в форме той машины, на которой считал, а не той, для которой считал. Путь одной системы остаётся её путём, кто бы его ни вычислял, — но встроенная функция отвечает в форме хозяина, поэтому на третьей системе список запрещённых для записи мест получался с чужими разделителями, и ни одно правило, написанное в привычной форме, больше не совпадало: шестьдесят пять проверок краснели там и ни одной здесь. Теперь каждый построитель называет, для какой системы он строит. Заодно приведены к одному источнику истины условия самих проверок: они спрашивали свойство ХОЗЯИНА, пока проверяемый код спрашивал выбранную систему, — расхождение, невозможное на настоящей машине и неизбежное при подмене. И проверка, утверждавшая «этого файла нет», убирала его ПОСЛЕ утверждения: один остаток от давнего прогона валил все последующие, хотя защита работала.",
        en: "The layer that handles differences between systems built paths in the shape of the machine doing the computing rather than the one being computed for. A path belonging to one system stays that system's path no matter who works it out — but the built-in function answers in the host's shape, so on the third system the list of forbidden write locations came out with foreign separators and not one rule written in the usual shape matched any more: sixty-five checks went red there and none here. Each builder now names the system it is building for. The conditions on the checks themselves were brought to one source of truth as well: they asked a property of the HOST while the code under test asked the selected system — a disagreement impossible on a real machine and unavoidable under substitution. And a check asserting \"this file does not exist\" removed it AFTER asserting: one leftover from a long-past run failed every later one, while the protection itself was working.",
      },
    ],
  },
  {
    version: "0.118.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Изолированный запуск кода в контейнере не работал на второй системе — и это было невидимо на той, где он писался. Временная папка создаётся с правами «только владельцу», а контейнер запускается от другого пользователя: на этой системе прослойка подменяет владельцев и всё выглядит рабочим, а на второй интерпретатор отвечает «нет доступа» ровно к тому файлу, который его попросили выполнить. Теперь права выставляются явно и минимально: чужой может ВОЙТИ в папку и прочитать названный файл, но не увидеть, что там ещё лежит. Папка живёт секунды, содержит один временный файл и подключается только для чтения. Найдено сборочной машиной второй системы — то есть ровно тем, ради чего проверки на нескольких системах и заводят.",
        en: "Running code isolated in a container did not work on the second system — and that was invisible on the one it was written on. The temporary folder is created owner-only, and the container runs as a different user: on this system the intermediate layer substitutes owners and everything looks fine, while on the second the interpreter answers \"permission denied\" about the very file it was asked to run. Permissions are now set explicitly and minimally: another user may ENTER the folder and read the named file, but not see what else is in it. The folder lives for seconds, holds one temporary file, and is attached read-only. Found by the second system's build machine — which is exactly what checks on several systems are kept for.",
      },
    ],
  },
  {
    version: "0.117.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Проверки на двух других системах стали зелёными — и не тем способом, каким это обычно делают. Ни одно утверждение не ослаблено: те, что говорили о механизме ОДНОЙ системы (её способ автозапуска, её защита ядра, её расположение программ), теперь объявляют свою область, как в этом наборе уже сделано для двух других механизмов; те, что говорили о свойстве, общем для всех, получили цель, запрещённую на всех трёх, и стали проверять больше, чем раньше. Проверка, называвшая условием «когда контейнеров нет», теперь и вправду выполняется только тогда; проверка живого поискового сервера спрашивает не только запись в настройках, но и установлена ли сама программа — иначе отсутствующий пакет читался как сломанная связка. По дороге найден настоящий пробел, который я же и внёс: на третьей системе список запрещённых для записи путей потерял системные файлы учётных записей — а они там достижимы через совместимый слой; правило, которое ни с чем не совпадает, ничего не стоит, а отсутствующее стоит ровно того случая, о котором не подумали. Обратная проверка сделана: если убрать цели из общего списка, шесть проверок краснеют на обеих системах.",
        en: "The checks on the two other systems went green — and not the usual way. No assertion was weakened: the ones that spoke about ONE system's mechanism (its autostart, its kernel protection, where its programs live) now declare their scope, exactly as this suite already does for two other mechanisms; the ones that spoke about a property common to all were given a target refused on all three, and now check more than they did. The check that named \"when containers are unavailable\" as its condition now really runs only then; the live search-server check asks not only whether the settings name it but whether the program is installed — otherwise a missing package read as a broken integration. Along the way a real gap surfaced that I had introduced myself: on the third system the list of paths forbidden to write had lost the system account files — and those are reachable there through the compatibility layer; a rule that matches nothing costs nothing, while an absent one costs exactly the case nobody thought of. The reverse check was done: remove the targets from the shared list and six checks go red on both systems.",
      },
    ],
  },
  {
    version: "0.116.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Проверка приёмки на второй системе показывала успех поверх упавшей приёмки — и это худший вид дефекта, потому что он врёт именно в ту сторону, в которую врать нельзя. Она запускала проверку так, чтобы её код возврата не учитывался (ради того, чтобы вывод был виден всегда), и требовала лишь, чтобы три условия не были ПРОПУЩЕНЫ; условие, которое ПРОВАЛИЛОСЬ, этому требованию удовлетворяло. Внутри было «4 пройдено, 2 провалено», снаружи — зелёная галочка. Теперь проверка запускается один раз, печатает всё, и краснеет от любого из трёх: собственного кода возврата, пропуска условия, которое эта машина заведомо может выполнить, и вывода, не похожего на отчёт вообще. Заодно с настоящей второй системы получены первые честные результаты: защита отказывает во всех дверях, планировщик отвечает, расчёт окна модели подходит этой машине, после закрытия не остаётся процессов.",
        en: "The acceptance check on the second system reported success over a failing acceptance — the worst kind of defect, because it lies in the one direction that must never be lied in. It ran the check so that its exit code was ignored (so the output would always be visible) and then required only that three conditions were not SKIPPED; a condition that FAILED satisfied that requirement. Inside it said \"4 passed, 2 failed\"; outside it showed a green tick. It now runs once, prints everything, and goes red on any of three things: its own exit code, a skip of a condition this machine can certainly run, and output that does not look like a report at all. Along with it came the first honest results from the real second system: the protection refuses through every door, the scheduler answers, the model-window arithmetic fits that machine, and nothing is left running after closing.",
      },
    ],
  },
  {
    version: "0.115.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Первый прогон на настоящих машинах трёх систем нашёл три вещи, и все три — в проверках, не в продукте. Выбор цели сборки совпадал по части имени, поэтому просьба собрать одну цель тянула ещё и её «базовую» разновидность, про которую в том же файле написано, что она скачивается ненадёжно; нужная цель при этом собралась и прошла дымовой тест, а задача всё равно упала — успех, поданный как провал. Теперь имя совпадает целиком. Проверка сборки на второй системе подсовывала себе командный файл с расширением исполняемого: система такое не запускает, поэтому первый же пункт падал, пока три следующих проходили. Теперь берётся настоящий исполняемый файл, к которому дописан номер версии, — и он и запускается, и несёт номер. И сюите адаптера ставят то, что она требует, вместо предположения, что оно уже есть: раньше она падала на всех трёх системах разом, а это всегда признак того, что неверна проверка, а не проверяемое.",
        en: "The first run on real machines of all three systems found three things, and all three were in the checks rather than in the product. Build-target selection matched on part of a name, so asking for one target also dragged in its \"baseline\" variant, which that very file warns downloads unreliably; the wanted target built and passed its smoke test, and the job failed anyway — a success presented as a failure. The name is now matched whole. The build check on the second system fed itself a command file with an executable's extension: the system will not run that, so the very first item failed while the next three passed. It now uses a real executable with the version number appended — it both runs and carries the number. And the adapter suite is given what it requires instead of it being assumed present: it had been failing on all three systems at once, which is always a sign that the check is wrong rather than the thing checked.",
      },
    ],
  },
  {
    version: "0.114.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Приёмка перестала зависеть от того, какая оболочка установлена. Она считала плагины конвейером из мира одной системы и звала интерпретатор именем, которого на второй системе нет, — и получила бы «собрано ноль тестов», то есть выдала бы НЕ ЗАПУСКАВШУЮСЯ проверку за пустую. Теперь файлы считает тот же код, что их и читает, а интерпретатор спрашивается тем именем, которое на этой системе есть. И добавлена сборочная задача, которая гоняет всю приёмку на настоящей второй системе: восемь условий из десяти там проверяются машиной, а три из них не имеют права быть пропущенными — если пропущены, задача падает и называет номер. Пропуск не есть прохождение.",
        en: "Acceptance stopped depending on which shell happens to be installed. It counted plugins with a pipeline from one system's world and called the interpreter by a name the second system does not have — and would have reported \"zero tests collected\", presenting a check that NEVER RAN as an empty one. Files are now counted by the same code that reads them, and the interpreter is asked for by the name this system actually uses. A build job was added that runs the whole acceptance on the real second system: eight of the ten conditions are checked there by machine, and three of them have no right to be skipped — if they are, the job fails and names the number. A skip is not a pass.",
      },
    ],
  },
  {
    version: "0.113.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Приёмка перестала быть списком на бумаге и стала программой: одна команда проверяет десять условий и выдаёт вердикт, который не нужно толковать. Это важно потому, что принимать продукт на двух других системах будет человек, впервые видящий этот проект, на машине, куда никто отсюда не зайдёт, — а «защита всё ещё держится» не проверяется взглядом. Исходов ровно три, а не два: пройдено, не пройдено, или ПРОПУЩЕНО с названной причиной — и пропуск печатается так же громко, как провал, и в приёмку не засчитывается. Список, молча роняющий строки, которые не смог выполнить, читается точно так же, как список, который их прошёл. Два условия честно помечены как требующие человека: открыть приложение и провести через него настоящую задачу — подменять это чем-то автоматизируемым было бы подлогом. Первый же прогон нашёл настоящее: собранное приложение отстало от исходников после кросс-сборки.",
        en: "Acceptance stopped being a list on paper and became a program: one command checks ten conditions and returns a verdict nobody has to interpret. That matters because the product will be accepted on the two other systems by someone seeing this project for the first time, on a machine nobody here can log into — and \"the protection still holds\" is not something anyone can eyeball. There are exactly three outcomes, not two: passed, failed, or SKIPPED with the reason named — and a skip is printed as loudly as a failure and is not counted as acceptance. A list that silently drops the rows it could not run reads exactly like a list that passed them. Two conditions are honestly marked as needing a human: opening the application and running a real task through it — substituting something automatable would be a forgery. The very first run found something real: the built application had fallen behind its sources after a cross-build.",
      },
    ],
  },
  {
    version: "0.112.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Установщик для второй системы теперь собирается — и собирается на машине, где той системы нет. Значит и само окно для неё не просто написано, а компилируется и линкуется: получен настоящий исполняемый файл, и объявленный номер версии лежит внутри него, в системном ресурсе. По дороге не хватало иконы нужного формата — её не было вовсе, и без неё сборка не доходила до конца. Отдельно закрыт тихий риск: числа, которыми считается размер окна модели, — это суждение о конкретной машине, измеренное там, где память общая. На машине с отдельной видеопамятью те же числа означают совсем другое, и раньше они молча применились бы к ней. Теперь источник памяти сверяется, и при несовпадении планировщик ОТКАЗЫВАЕТСЯ и говорит, что константы под это железо не измерены — вместо того чтобы выдать правдоподобное число для несуществующей машины.",
        en: "The installer for the second system now builds — and builds on a machine that does not have that system. Which means the window for it is not merely written but compiles and links: a real executable is produced, and the declared version number sits inside it, in the system resource. An icon in the required format was missing entirely along the way, and without it the build never finished. Separately closed a silent risk: the numbers that size a model's window are a judgement about one particular machine, measured where memory is shared. On a machine with separate video memory those same numbers mean something else entirely, and until now they would have been applied to it in silence. The memory source is now compared, and on a mismatch the planner REFUSES and says the constants have not been measured for this hardware — rather than producing a plausible number for a machine that does not exist.",
      },
    ],
  },
  {
    version: "0.111.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Проверка «жив ли ещё собеседник» перестала зависеть от того, как система назвала ошибку. Она решала по типу исключения: одно значило «жив, просто пока нечего читать», любое другое — «ушёл». На второй системе коды сокетов из другого семейства, и если бы они не совпали с этим типом, каждый живой собеседник объявлялся бы ушедшим при первой же паузе — а по этому решению обрывается ответ, которого человек ждёт. Цена двух ошибок несимметрична: пропустить настоящий обрыв — потерять секунды работы, выдумать его — уничтожить сделанное. Теперь решение принимается по номеру ошибки, и обе системы отвечают одинаково. И отдельно установлено фактом, а не предположением: библиотека терминала несёт настоящую поддержку псевдоконсоли второй системы — запасной путь не нужен.",
        en: "The check for whether the other side is still there stopped depending on what the system called the error. It decided by exception type: one meant \"alive, just nothing to read yet\", anything else meant \"gone\". On the second system socket codes come from a different family, and had they not matched that type, every live peer would have been declared gone at its first pause — and that decision aborts the answer a person is waiting for. The cost of the two mistakes is not symmetric: missing a real disconnect loses seconds of work, inventing one destroys what was done. The decision is now made by the error's number, and both systems answer identically. Separately established as fact rather than assumption: the terminal library carries genuine pseudo-console support for the second system, so no fallback is needed.",
      },
    ],
  },
  {
    version: "0.110.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Окно приложения впервые собрано и слинковано для второй системы, а не только написано для неё — и сборка тут же нашла настоящий дефект: путь к содержимому окна был записан так, что работал лишь потому, что каталог случайно назывался нужным словом; копия проекта в любом другом месте не собралась бы. Получен и настоящий установочный пакет, и он несёт тот же номер версии, что объявлен в источнике. Ограничитель размера служебного журнала перестал быть привязан к одной системе: раньше он спрашивал путь способом, который есть только там, и на остальных не делал ничего — а это тот самый журнал, который правила велят читать первым, когда что-то зависает. Теперь путь спрашивается у каждой системы по-своему, и главное: когда служба отдаёт не файл, а канал, ответом честно становится «ничего» — усечь нечего, а усечь не то хуже, чем не усекать вовсе.",
        en: "The application window was compiled and linked for the second system for the first time rather than merely written for it — and the build immediately found a real defect: the path to the window's content was written so that it worked only because a directory happened to carry the right name; a copy of the project anywhere else would not have built. A real installable package was produced too, and it carries the same version number the source declares. The bound on the service journal stopped being tied to one system: it used to ask for the path in a way only that system offers, and did nothing at all elsewhere — and this is the very journal the rules say to read first when anything hangs. The path is now asked of each system in its own way, and most importantly: when the service hands over a pipe rather than a file, the honest answer becomes nothing — there is nothing to truncate, and truncating the wrong thing is worse than not truncating at all.",
      },
    ],
  },
  {
    version: "0.109.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Сторож сборки для второй системы перестал быть только написанным — он запущен и проверен в обе стороны: дерево без нужных файлов объявляется несобранным с названной причиной, правильное дерево — собранным, и коды возврата те, на которые опирается автоматическая проверка. Подмена номера в одном файле делает вердикт отрицательным и заставляет отчёт НАЗВАТЬ, что этот файл несёт на самом деле. Чтение памяти видеокарты проверено на подлинном формате вывода драйвера: две карты складываются, а не берётся первая; мусор от драйвера отвергается целиком, а не разбирается наполовину в выдуманное число; на этой системе драйвер не опрашивается вовсе, потому что спрашивать нечего. Честная граница записана: проверен разбор ответа, а не поведение настоящей видеокарты — её здесь нет.",
        en: "The build guard for the second system stopped being merely written — it was run and checked in both directions: a tree without the needed files is declared unbuilt with the reason named, a correct tree is declared built, and the exit codes are the ones the automatic check relies on. Substituting the number in one file turns the verdict negative and forces the report to NAME what that file actually carries. Reading video-card memory was verified against the driver's authentic output format: two cards are summed rather than the first being taken; garbage from the driver is refused outright rather than half-parsed into an invented number; on this system the driver is not queried at all, because there is nothing to ask. The honest boundary is recorded: the parsing of the answer is verified, not the behaviour of a real card — there is none here.",
      },
    ],
  },
  {
    version: "0.108.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Защита нижнего уровня для Linux запрещала НИЧЕГО, и это выяснилось только когда её спросили у ядра, а не у кода. Она закрывала опасные пути, подставляя пустой каталог, которого в системе нет, — а такая подстановка по правилам инструмента молча пропускается. Все правила были пустышками, а проверки при этом были зелёными, потому что читали список аргументов, а не ответ системы. Ровно тот же дефект, что однажды был в защите для этой системы, в другом синтаксисе и по той же причине. Теперь опасный путь закрывается сам собой в режиме только-чтение, а каталоги с ключами подменяются пустой файловой системой; измерено по одному правилу за раз: запись автозапуска и чтение ключа получают отказ ядра, а обычная работа проходит — и оба контроля обязательны, иначе сломанная защита выглядит как работающая. Закреплено проверкой, которая спрашивает ядро и падает, если вернуть прежнюю ошибку.",
        en: "The lower-level protection for Linux denied NOTHING, and that surfaced only when the kernel was asked rather than the code. It shielded dangerous paths by substituting an empty directory the system does not have — and by that tool's own rules such a substitution is skipped in silence. Every rule was a no-op while the checks stayed green, because they read the argument list rather than the system's answer. Exactly the defect this protection once had on the other system, in a different syntax and for the same reason. A dangerous path is now shielded by itself in read-only mode and key directories are replaced by an empty filesystem; measured one rule at a time: writing an autostart entry and reading a key are refused by the kernel while ordinary work goes through — and both controls are mandatory, or broken protection looks exactly like working protection. Pinned by a check that asks the kernel and fails if the old mistake is restored.",
      },
    ],
  },
  {
    version: "0.107.0",
    date: "2026-08-05",
    items: [
      {
        ru: "У нового окна появилось меню — те же пункты, ради которых оно и существует: перезапустить движок, не выходя из приложения, стереть следы удалённых чатов, включить уведомления, открыть каталог с записями решений, изменить масштаб. Масштаб теперь запоминается между запусками: настройка, которая сбрасывается при каждом старте, — это настройка, которую заново применяют при каждом старте. Открытие каталога в файловом менеджере названо для каждой системы отдельно, иначе этот пункт работал бы ровно на одной. Уведомления умеют спросить разрешение: система, которую не спросили, не показывает ничего, и узнать об этом изнутри приложения было невозможно. Сторож сборки получил двойника для системы, где оболочка командной строки — устанавливаемая зависимость: проверка, которая не может запуститься на той системе, которую проверяет, — не проверка.",
        en: "The new window gained its menu — the items it exists for: restart the engine without leaving the application, erase the traces of deleted chats, enable notifications, open the folder holding the record of decisions, change the zoom. Zoom is now remembered between launches: a setting that resets on every start is a setting the user re-applies on every start. Opening a folder in the file manager is named separately for each system, or that item would work on exactly one. Notifications can ask for permission: a system that was never asked shows nothing, and there was no way to discover that from inside the application. The build guard gained a twin for the system where the command shell is an installed dependency: a check that cannot run on the system it guards is not a check.",
      },
    ],
  },
  {
    version: "0.106.0",
    date: "2026-08-05",
    items: [
      {
        ru: "У приложения появилось окно для систем, где его не было. Оно не переписывает прежнее, а выполняет тот же договор: поднимает движок с тем же окружением, сохраняет его диагностический канал, ждёт готовности по абсолютному сроку и при неудаче показывает экран с тем, что проверить, а не вечный бегунок. Встроенное окно само по себе молчит на выбор файла и на вопросы «уверены?» — это дорисовано, иначе переименование чата просто ничего бы не делало. Интерфейс при этом не тронут: окно само объявляет тот способ связи, на котором он уже написан, поэтому одна и та же страница работает в обоих окнах без единой правки. Проверено вживую: окно подняло движок, ноль ошибок загрузки, интерфейс держит пять соединений. Измерена и честно записана граница: при штатном закрытии движок снимается сразу, а при убийстве окна сигналом он переживает — до ближайшей уборки, которая его находит по реестру запущенного и снимает.",
        en: "The application gained a window for the systems that had none. It does not rewrite the existing one; it performs the same contract: it starts the engine with the same environment, keeps its diagnostic channel, waits for readiness against an absolute deadline, and on failure shows a screen saying what to check rather than an endless spinner. An embedded window is silent by itself about file pickers and about \"are you sure?\" questions — those are supplied, or renaming a chat would simply do nothing. The interface itself is untouched: the window declares the same channel the interface is already written against, so one page works in both windows without a single edit. Verified live: the window started the engine, zero load errors, the interface holding five connections. A boundary was measured and is recorded honestly: on an ordinary close the engine goes down with it, while a window killed by signal leaves it running until the next cleanup, which finds it in the registry of what was started and takes it down.",
      },
    ],
  },
  {
    version: "0.105.0",
    date: "2026-08-05",
    items: [
      {
        ru: "Движок теперь собирается для Linux и Windows с этой же машины — и артефакты проверены как настоящие исполняемые файлы тех систем, а не переименованные здешние. Сборка получила выбор целей, потому что раньше можно было собрать либо всё сразу, либо ровно свою систему, и ни то ни другое не годится для двух нужных. Опечатка в имени цели теперь отказывает вместо того, чтобы молча собрать ноль целей и выглядеть успешной. Уборка следов удалённых чатов и безопасный перезапуск переписаны и больше не зависят от четырёх внешних программ, две из которых вне macOS не существуют вовсе: обещание «удалённый чат не оставляет следов» не может держаться на том, установил ли кто-то утилиту. По дороге найден дефект в самой уборке: указание на копию базы всё равно чистило настоящий каталог данных — теперь названная база решает всё, что за ней следует. Зависимости научились называть команду установки той системы, где их ставят, а не только здешнюю. Сборочный сторож проверяет третий артефакт, который есть у этой системы, и отсутствие по-прежнему считает находкой, а не пропуском.",
        en: "The engine now builds for Linux and Windows from this machine, and the artifacts are verified to be genuine executables of those systems rather than renamed local ones. The build gained target selection, because previously it was all targets or exactly this machine's own, and neither suits building the two that are wanted. A typo in a target name now refuses, instead of quietly building nothing and looking successful. Erasing the traces of deleted chats, and restarting safely, were rewritten and no longer depend on four external programs, two of which do not exist off macOS at all: the promise that a deleted chat leaves nothing behind cannot rest on whether someone installed a utility. A defect in the erasing itself surfaced on the way: pointing it at a copy of the database still cleaned the real data directory — a named database now decides everything downstream of it. Dependencies now name the install command of the system they are being installed on, not only this one's. The build guard checks the third artifact this system actually has, and still treats absence as a finding rather than a skip.",
      },
    ],
  },
  {
    version: "0.104.0",
    date: "2026-08-03",
    items: [
      {
        ru: "Правила, которые зависят от операционной системы, собраны в одно место — и по дороге нашлись два расхождения, работавшие уже давно. Первое: двадцать шесть мест внутри обвязки сами вычисляли, где лежат её данные, и ни одно не знало о переменной, которой движок переносит свой корень целиком; поставь её — движок уносит базу и настройки, а история отмен, передачи, память и замеры остаются на старом месте. Второе: список того, что запрещено записывать, существовал в двух рукописных копиях — для проверок внутри процесса и для запрета на уровне ядра, — и копия успела потерять ключи SSH: проверка отказывала, ядро пропускало. Теперь это один список, из которого обе формы выводятся, и разойтись они больше не могут. Заодно ветка репозитория перестала молча исчезать из контекста под нагрузкой: полторы секунды на опрос было мало, факт пропадал без единого слова.",
        en: "Rules that depend on the operating system are collected in one place — and two long-standing divergences surfaced on the way. First: twenty-six places inside the harness each worked out where its data lives, and none knew about the variable with which the engine relocates its whole root; set it, and the engine moves its database and settings while the undo history, handoffs, memory and measurements stay behind. Second: the list of what must never be written existed as two hand-written copies — one for the in-process checks, one for the kernel-level denial — and the copy had lost SSH keys: the check refused, the kernel allowed. It is now one list from which both forms are rendered, and they can no longer disagree. Separately, the repository branch stopped silently vanishing from the model's context under load: a second and a half was too little for the probe, and the fact disappeared without a word.",
      },
    ],
  },
  {
    version: "0.103.0",
    date: "2026-08-01",
    items: [
      {
        ru: "Сторож развёртывания стал сверять и сам номер версии, а не только время и содержимое. Раньше он смотрел лишь на движок: собранный веб-интерфейс и паспорт приложения не проверял никто, а бинарь, собранный пять минут назад из другой копии репозитория, проходил как свежий — по времени он новее всех исходников и несёт все нужные механизмы. Теперь номер, объявленный в источнике, обязан лежать в каждом из трёх артефактов — в собранном интерфейсе, в байтах самого движка и в паспорте приложения; каждый артефакт отвечает отдельной строкой отчёта, а при расхождении сторож называет номер, который артефакт несёт на самом деле. Проверки закреплены тестом, который гоняет сам скрипт по подставным деревьям, где каждый артефакт по очереди несёт чужой номер: убери любую из трёх проверок — упадёт именно её тест.",
        en: "The deploy guard now checks the version number itself, not only timestamps and contents. It used to look at the engine alone: nobody checked the built web interface or the app bundle's manifest, and a binary built five minutes ago from a different copy of the repository passed as fresh — newer than every source file and carrying every required mechanism. Now the number declared in the source must sit inside each of the three artifacts — the built interface, the bytes of the engine itself, and the app bundle's manifest; each artifact answers with its own report line, and on a mismatch the guard names the number the artifact actually carries. The checks are pinned by a test that runs the script itself over synthetic trees where each artifact in turn carries a foreign number: remove any one of the three checks and exactly its test falls.",
      },
    ],
  },
  {
    version: "0.102.0",
    date: "2026-08-01",
    items: [
      {
        ru: "Красная точка у одного из подключаемых серверов означала не поломку, а стёртую папку. Движок сообщал «нет такого файла» и называл при этом команду — а команда была на месте и отвечала за полсекунды; отсутствовал рабочий каталог, из которого её пытались запустить (остатки прогонов и удалённая тестовая папка). Система сообщает об этом одинаково в обоих случаях, поэтому читающий шёл проверять исправный файл. Теперь каталог проверяется до запуска, и в сообщении стоит то, чего действительно нет.",
        en: "A red dot beside one of the connected servers meant a deleted folder, not a broken server. The engine reported \"no such file\" and named the command — while that command was present and answered a handshake in half a second; what was missing was the working directory it was being started from (leftovers of finished runs, and a deleted test folder). The system reports both cases identically, so whoever read it went to check a file that was fine. The directory is now checked before starting, and the message names what is actually absent.",
      },
    ],
  },
  {
    version: "0.101.1",
    date: "2026-08-01",
    items: [
      {
        ru: "Публичный счёт инструментов исправлен с 85 на 89. Команда, которой число выводилось, не учитывала инструменты с цифрой в имени — четыре выпадали из счёта, и витрина занижала собственный продукт. Команда исправлена в самом источнике, чтобы дефект не вернулся.",
        en: "The public tool count was corrected from 85 to 89. The command that derived the number missed tools with a digit in their name — four fell out of the count, and the storefront undersold its own product. The command itself was corrected at the source so the defect cannot return.",
      },
    ],
  },
  {
    version: "0.101.0",
    date: "2026-08-01",
    items: [
      {
        ru: "Каждая возможность, помеченная как сломанная в полной проверке запуском, исправлена и перепроверена. Три вещи, которые считали заранее — сколько памяти занимает модель, сколько её занимает соседняя, сколько стоит один токен окна, — считали неверно: строку «21.95 GB» читали как двоичную и придумывали полтора гигабайта несуществующих весов; вторую загруженную модель, чей размер сервер не сообщает, просто выбрасывали из расчёта, то есть считали машину пустой; а измерение стоимости токена повторяло одну и ту же подсказку и попадало в кэш сервера, показывая вчетверо меньше правды и портя сохранённое измерение. Теперь единица читается так, как её напечатали, невзвешенный сосед заставляет отказаться от плана вместо того чтобы исчезнуть, а измерение каждый раз новое и не принимается, если противоречит уже известному в опасную сторону.",
        en: "Every capability marked broken in the full run-it-and-see audit was repaired and re-checked. Three quantities computed in advance — how much memory the model holds, how much a neighbouring one holds, what one token of window costs — were computed wrongly: the string \"21.95 GB\" was read as binary and invented a gigabyte and a half of weights that do not exist; a second loaded model whose size the server does not report was dropped from the arithmetic entirely, i.e. the machine was treated as empty; and the cost measurement repeated one identical prompt and hit the server's own cache, reporting a quarter of the truth and spoiling the stored reading. The unit is now read as it was printed, an unmeasured neighbour makes the plan refuse rather than vanish, and each measurement is fresh and is declined when it disagrees with what is already known in the dangerous direction.",
      },
      {
        ru: "Защиты, которые выглядели включёнными, но не срабатывали, теперь срабатывают. Ссылка на ещё не существующий файл проходила мимо запрета на запись — именно тот случай, ради которого запрет и написан; запрет действовал только для пяти инструментов из всех, а тот единственный, который остаётся у части моделей, в этот список не входил и путь свой не сообщает — теперь он читается из самого содержимого правки; запись адреса в другой форме открывала доступ к собственным службам машины; заявка на исключение для одной команды, поданная изнутри работы, снимала защиты целиком, а теперь записывается, но действует только по решению владельца; и шесть правил ядерного запрета записи в изолированной среде не совпадали ни с чем из-за одной лишней косой черты.",
        en: "Guards that looked switched on but did not fire now fire. A link to a not-yet-existing file walked past the write ban — the very case the ban is written for; the ban ran for five tools out of all of them, and the one tool some models are left with is not on that list and carries no path of its own, so its target is now read out of the edit itself; writing an address in another form opened the way to the machine's own services; a request to exempt one command, filed from inside a run, disarmed the guards wholesale and is now recorded but effective only by the owner's decision; and six kernel-level write bans in the isolated environment matched nothing at all because of one extra backslash.",
      },
      {
        ru: "Ответ пишется на языке вопроса — и инструкция об этом больше себе не противоречит: на китайский, японский, корейский и арабский вопрос она называла нужный язык и в том же предложении его запрещала. Языковая пометка теперь принадлежит своей беседе, а не последней по времени — при двух открытых чатах один перебивал язык другого. Отчёт по книге тоже пишется на языке просьбы: его заготовки были жёстко русскими, и английская просьба возвращала русский разбор.",
        en: "The answer is written in the language of the question — and the instruction saying so no longer contradicts itself: for a Chinese, Japanese, Korean or Arabic question it named the right language and banned that script in the same sentence. The language pin now belongs to its own conversation rather than to whichever was most recent — with two chats open, one overwrote the other's language. A book report follows the request's language too: its scaffolding was hardcoded Russian, so an English request came back as a Russian analysis.",
      },
      {
        ru: "Подбор инструментов под задачу перестал решаться шумом. Профили вложены друг в друга, и прежний подсчёт складывал всё общее — полсотни одинаковых слагаемых заглушали те два-три, которые профили и различают, так что явная просьба поискать в интернете уходила в профиль, где поиск скрыт: живьём 29 решений из 29 оказались одинаковыми. Теперь общий инструмент не голосует вовсе, а признак «этой просьбе нужен интернет» — один и тот же и для подсказки модели, и для набора инструментов, поэтому нельзя велеть искать и одновременно спрятать поиск.",
        en: "Per-task tool selection stopped being decided by noise. The profiles are nested, and the old score summed everything they share — fifty identical terms drowning the two or three that actually tell them apart — so an explicit ask to search the web routed to the profile that hides search: live, 29 of 29 decisions came out the same. A tool every profile keeps now casts no vote at all, and \"this ask needs the web\" is one definition shared by the model's nudge and the toolset, so the harness can no longer order a search on a turn that just hid it.",
      },
      {
        ru: "Оркестратор снова вызывается. Все шесть его операций ломались о собственную починку аргументов: она считала форму вложенной, а схема плоская, и обязательные поля срезались до пустоты. Голое имя действия вместо тела запроса — семь отказов за один день, каждый с одинаковой ошибкой — теперь дописывается до полного вызова обоими слоями. Сохранённый на диске сценарий стало возможно запустить по имени: раньше его знал только вызов изнутри другого сценария. А запрет, который обвязка выставляет зациклившемуся вызову, на одном из трёх мест исполнения молча терялся, и вызов шёл дальше.",
        en: "The orchestrator can be called again. All six of its operations were broken by their own argument repair: it assumed a nested shape where the schema is flat, so every required sibling field was stripped to nothing. A bare action name in place of the request body — seven refusals in one day, each with the identical error — is now completed into a full call by both layers. A workflow saved to disk can be run by name: previously only a call from inside another workflow knew about it. And the stop the harness issues to a looping call was silently discarded at one of the three places calls are executed, so the call ran anyway.",
      },
      {
        ru: "Панели и списки перестали показывать не то. Переключатель одного из плагинов писал имя, которого никто не читает, — плагин продолжал работать, а выключатель рисовался выключенным; имя плагина берётся из места, где оно объявлено, а не выводится из имени файла. Карточки показывают человеческое название, а не служебный ярлык. Строки о контекстном окне на пятнадцати языках всё ещё говорили о пределе беседы — беседа не упирается в окно, и теперь это написано на всех языках. Тема оформления при первом запуске больше не мигает старой. Панель проверенной работы показывала нули там, где проверок было много: две целые категории не считались нигде и потому выглядели как «ничего не было».",
        en: "Panels and lists stopped showing the wrong thing. One plugin's switch wrote a name nothing reads — the plugin kept running while the switch rendered off; a plugin's id now comes from where it is declared rather than being derived from a filename. Cards show a human name instead of an internal slug. The context-window rows in fifteen languages still spoke of a limit on the conversation — a conversation does not end at the window, and now every language says so. The theme no longer flashes the old one on a first launch. The verified-work panel showed zeros where many checks had run: two whole categories were counted nowhere and so read as \"nothing happened\".",
      },
      {
        ru: "Два независимых проверяющих прошли по этой волне с противоположными заданиями — один опровергал заявления документов, читая исходники, другой искал изменения, не описанные нигде. Из их находок важнейшая была не в документах, а в коде: заявление «правило, останавливающее инструмент, останавливает то же самое в оболочке» оказалось верным только для буквального написания пути. Через переменную, через шаблон имени и изнутри программы, запущенной оболочкой, запись проходила. Текст команды тут не поможет — путь, который ВЫЧИСЛЯЕТ программа, читать негде. Поэтому оболочка теперь работает под профилем ядра, несущим ровно те пути, которые правила уже объявили: ни одно из пяти написаний больше не попадает на диск, а обычная работа — сборка, git, запись собственного .env в своём проекте — проходит нетронутой. Ещё они нашли, что удалённый чат оставлял на диске полный текст своего разбора, что документированный выключатель песочницы ничего не выключал, и что сторож, следящий за честностью документации, сам считал обычные константы настройками.",
        en: "Two independent reviewers went through this wave with opposite briefs — one refuting the documentation's claims against the source, the other hunting for changes described nowhere. Their most important finding was not in the documents but in the code: the claim that \"a rule stopping a tool stops the same thing through the shell\" held only for the literal spelling of a path. Through a variable, through a filename pattern, and from inside a program the shell started, the write went through. No amount of reading the command text closes that — a path a program COMPUTES has no text to read. So the shell now runs under a kernel profile carrying exactly the paths the rules already declare: none of the five spellings reaches the disk any more, while ordinary work — a build, git, writing your own project's .env — passes untouched. They also found that a deleted chat left the full text of its analysis on disk, that a documented sandbox off-switch switched nothing off, and that the guard watching over the documentation's honesty was itself counting ordinary constants as settings.",
      },
      {
        ru: "Версии 0.96–0.99 были шагами сборки внутри одной этой волны: каждый собирался и запускался, чтобы проверить очередную починку на живом приложении, но ни один не был отдельным состоянием для читателя. Всё, что они несли, описано здесь.",
        en: "Versions 0.96-0.99 were build steps inside this one wave: each was built and launched to check the next repair against the live application, but none was a separate state for a reader. Everything they carried is described here.",
      },
      {
        ru: "Диагностика перестала врать молчанием. Пять файлов проверок движка-переходника не запускались вовсе — набор был зелёным, ничего не проверив; классификация тихого переполнения не могла сработать ни разу, потому что ждала настройку, которую никто не задаёт, а теперь спрашивает у сервера; правило уровня раздумий не наследовалось и незаметно отменяло все остальные уровни модели; обрыв связи клиентом печатал полную трассу — треть журнала, который положено читать первым; журнал ничем не ограничивался; а подсказка «вот этот блок сместил кэш» не могла назвать виновника на настоящем запросе. Описание api отдавало две строки вместо полутора сотен, поиск символов возвращал пустоту вместо ответа, а у поиска по имени символа не было поля для имени.",
        en: "Diagnostics stopped lying by omission. Five of the adapter's test files did not run at all — the suite was green having checked nothing; the silent-overflow classification could never fire because it waited on a setting nobody sets, and now asks the server; the reasoning-level rule did not fall through and silently cancelled every other level for a model; a client hanging up printed a full stack trace — a third of the log one is required to read first; the log had nothing bounding it; and the hint naming which block shifted the cache could not name anyone on a real request. The api description served two entries instead of a hundred and fifty, symbol search returned emptiness instead of an answer, and search-by-symbol-name had no field for a name.",
      },
      {
        ru: "Работа, которая уже сделана, больше не теряется. Готовый отчёт по книге писался на диск до отправки и не стирается, пока не доставлен, — прежде неудачная доставка уничтожала его вместе с накопленным прогрессом, а состояние сообщало «готово»; поток письма отчёта не открывался никогда из-за требования непустого текста там, где текста ещё нет по смыслу; удалённая переписка оставляла прежние версии передач в архиве, который очистка не замечала; расписание показывало давно осиротевшие задания как действующие и не могло сообщить, что задание не запускалось; а просьба выполнить код изолированно молча выполнялась на самой машине.",
        en: "Work already done is no longer lost. A finished book report is written to disk before delivery and is not erased until it lands — previously a failed delivery destroyed it along with the accumulated progress while the status reported \"done\"; the report's streaming channel never opened at all, refused by a non-empty-text rule at the one point where there is no text yet by definition; a deleted conversation left earlier versions of its handoffs in an archive the purge did not look at; the schedule listed long-orphaned jobs as live and could never report that a job had not run; and a request to run code in isolation quietly ran it on the machine itself.",
      },
    ],
  },
  {
    version: "0.95.0",
    date: "2026-08-01",
    items: [
      {
        ru: "Публичное описание проекта переписано практикой вперёд. Главная страница теперь ведёт не философией, а узнаваемыми ситуациями — «сказал готово, а ничего не работает», «бросил на полпути», «зациклился» — и на каждую отвечает тем, что делает движок, с командой, которой это можно проверить самому. Вся документация выровнена по одному правилу: каждое заявление либо повторимо командой, либо ему не место на витрине; заявления, привязанные к конкретной модели, переписаны — в гнездо ставится любая модель, и текст теперь говорит именно это.",
        en: "The public description of the project was rewritten practice-first. The front page now leads not with philosophy but with situations everyone recognizes — \"it said done but nothing works\", \"it quit halfway\", \"it looped\" — and answers each with what the engine does, plus the command to check it yourself. All documentation was aligned to one rule: every claim is either replayable by a command or it does not belong on the storefront; claims tied to one specific model were rewritten — any model goes into the socket, and the text now says exactly that.",
      },
    ],
  },
  {
    version: "0.94.0",
    date: "2026-08-01",
    items: [
      {
        ru: "Разрешение на уведомления больше не спрашивается при запуске. Приложение подписано локально, и такая подпись меняется при каждой сборке, поэтому система считала обновлённое приложение новым и просила разрешение заново — окно ждало человека у клавиатуры, а если он отошёл, оно висело до его возвращения. Теперь при запуске только проверяется, выдано ли разрешение раньше, и ничего не спрашивается; сам вопрос задаётся один раз по пункту меню «Включить уведомления», то есть тогда, когда человек только что сам его выбрал. Если разрешение было отклонено ранее, открывается страница настроек — единственное место, где это ещё можно изменить.",
        en: "The notification permission is no longer requested at startup. The app is signed locally, and such a signature changes with every build, so the system treated an updated app as a new one and asked again — the dialog waited for someone at the keyboard, and if they had stepped away it hung until they returned. Startup now only checks whether permission was granted earlier and asks nothing; the question itself is asked once, from the menu item “Enable Notifications”, that is at the moment a person has just chosen it. If permission was refused earlier, the settings page opens — the only place where that can still be changed.",
      },
      {
        ru: "Замеры продукта теперь идут через само приложение, запущенное как из Finder, а не через отдельный вызов движка из терминала. Разница оказалась существенной: приложение передаёт движку навигацию по коду, отбор инструментов под задачу и проверку выполнения цели, а отдельный вызов не передавал ничего из этого. То есть прежние замеры относились не к той программе, которую запускает пользователь.",
        en: "Product measurements now go through the app itself, launched the way Finder launches it, rather than through a separate engine invocation from the terminal. The difference turned out to be substantial: the app hands the engine code navigation, per-task tool selection and goal-completion checking, and the separate invocation handed it none of these. The earlier measurements therefore described a different program from the one a user runs.",
      },
    ],
  },
  {
    version: "0.93.0",
    date: "2026-07-31",
    items: [
      {
        ru: "Замер стоимости памяти под контекст больше не обманывается тёплым кэшем. Прежде он делал один запрос и смотрел, насколько выросла память; но выделяет память только первый запрос после загрузки, а следующие обслуживаются из уже готового — и тот же замер на той же модели давал то втрое больше, то втрое меньше. Теперь берутся две пробы разного размера и считается разница между ними: всё уже готовое обслуживает обе и в разнице сокращается. Результат сошёлся с другой моделью того же устройства с точностью до пяти процентов.",
        en: "The measurement of what context costs in memory is no longer fooled by a warm cache. It used to make one request and watch how much memory grew; but only the first request after a load allocates, later ones are served from what is already there — and the same measurement on the same model returned three times more, then three times less. It now takes two probes of different sizes and uses the difference between them: whatever is already there serves both and cancels out. The result agreed with another model of the same design to within five percent.",
      },
      {
        ru: "Требование к размеру пробы применялось не к тому числу. Оно проверялось на запрошенном объёме текста по записанной оценке, а записывался настоящий счёт, который сообщает сама модель — и у модели с более плотным счётом каждая проба выходила ниже требования и отбрасывалась. Оценка теперь измеряется у самой модели, требование проверяется на том, что записывается, а негодная проба не сохраняется вовсе: раньше такие вытесняли годные и создавали видимость согласия.",
        en: "The size requirement for a probe was applied to the wrong number. It was checked against the amount of text requested using a written-down estimate, while what got recorded was the real count the model itself reports — and on a model that counts more densely every probe came out under the requirement and was thrown away. The estimate is now measured from the model itself, the requirement is checked against what is recorded, and an unusable probe is not stored at all: previously such probes evicted good ones and created an appearance of agreement.",
      },
      {
        ru: "Загрузчик проверяет, послушался ли его сервер. Команда загрузки может завершиться успешно и оставить окно прежним — так и произошло с одной моделью, чья собственная настройка перебивает переданное значение. Раньше сообщалось, что окно понижено, хотя оно не менялось; теперь это называется отказом, и превышение оценивается в гигабайтах.",
        en: "The loader checks whether the server obeyed it. A load command can succeed and leave the window unchanged — which is what happened with one model whose own configuration outranks the value passed to it. It used to report the window as lowered when nothing had changed; that is now named as a refusal, and the excess is priced in gigabytes.",
      },
    ],
  },
  {
    version: "0.92.0",
    date: "2026-07-31",
    items: [
      {
        ru: "Переключение НА ещё не загруженную модель снова считает окно. Вес загруженной модели сообщает рантайм, но для незагруженной он отвечает пустотой — и расчёт отказывался ровно в тот момент, ради которого существует: перед загрузкой. Теперь вес берётся из файлов самой модели на диске — для этого движка это в точности то, что ляжет в память. Побочный выигрыш: точный вес с диска дал окно 147 456 вместо прежних 135 168.",
        en: "Switching TO a not-yet-loaded model computes its window again. The runtime reports the weight of a loaded model, but answers nothing for an unloaded one — so the plan refused at exactly the moment it exists for: before the load. The weight now comes from the model's own files on disk, which for this engine is precisely what the load will put in memory. A side gain: the exact on-disk weight yields a 147,456 window where the previous figure gave 135,168.",
      },
    ],
  },
  {
    version: "0.91.0",
    date: "2026-07-30",
    items: [
      {
        ru: "Панель больше не выдаёт окно за предел разговора. Строки назывались «лимит контекста» и «использование», и это читалось как стена, к которой беседа подходит: две трети пройдено, треть осталась. Стены там нет — когда окно заполняется, работает сжатие, и разговор идёт дальше. Теперь строки называют то, чем являются: размер окна одного вызова и то, насколько оно заполнено сейчас.",
        en: "The panel no longer presents the window as a limit on the conversation. The rows were called context limit and usage, which read as a wall the conversation is approaching — two thirds gone, one third left. There is no wall: when the window fills, compaction runs and the conversation continues. The rows now name what they are — the size of one call's window, and how full it is right now.",
      },
    ],
  },
  {
    version: "0.90.0",
    date: "2026-07-30",
    items: [
      {
        ru: "Список зависимостей в настройках больше не пугает зря. Часть инструментов ставится в собственный каталог, который приложение, открытое двойным щелчком, не видит: панель показывала их как отсутствующие, хотя проверка их находила и запускала. Владелец переустанавливал уже установленное. Теперь панель смотрит туда же, куда смотрит сама проверка, и обе говорят одно.",
        en: "The dependency list in the settings no longer raises false alarms. Some tools install into their own directory, which an application opened by double-click does not see: the panel showed them as absent even though the check found and ran them. That had the owner reinstalling what was already there. The panel now looks where the check itself looks, and the two agree.",
      },
      {
        ru: "Проверено, что при запуске из Finder работает каждый плагин, а не только те, что попались под руку. Все объявленные зависимости всех сорока плагинов прогнаны в том окружении, которое приложение получает от системы — оно беднее, чем в терминале. Обязательных пропусков не осталось; браузерный плагин требовал разовой загрузки браузера, она сделана. Три оставшихся пропуска необязательны и названы прямо: без одного не работает распознавание речи, у остальных есть штатная замена.",
        en: "Every plugin was checked under a Finder launch, not just the ones that came to hand. All declared dependencies of all forty plugins were run in the environment the system actually gives the application — a poorer one than a terminal has. No required dependency is missing any more; the browser plugin needed a one-time browser download and it has been done. The three remaining gaps are optional and named outright: without one of them speech recognition does not work, the others have a built-in substitute.",
      },
    ],
  },
  {
    version: "0.89.0",
    date: "2026-07-30",
    items: [
      {
        ru: "Проверка Go теперь честно говорит, где она работает и что ей нужно. В описании плагина, в настройках и в документации прямо сказано: это только для проектов на Go — в репозитории без go.mod она не делает ничего и ничего не стоит. Там же перечислено, что установить, чтобы она заработала, и что именно теряется без каждого инструмента: без одного из них исчезает проверка известных уязвимостей целиком. Отсутствующие инструменты и раньше назывались в самом отчёте, чтобы узкая проверка не читалась как чистая; теперь это видно ещё до первого запуска.",
        en: "The Go check now says plainly where it works and what it needs. The plugin description, the settings entry and the documentation all state it outright: this is for Go projects only — in a repository with no go.mod it does nothing and costs nothing. The same places list what to install for it to work at all, and what is lost without each tool: without one of them the known-vulnerability check disappears entirely. Missing tools were already named inside the report so a narrow check could not read as a clean one; now that is visible before the first run.",
      },
      {
        ru: "Инструменты проверки Go находятся и тогда, когда приложение запущено из Finder. Программы, устанавливаемые командой go install, кладутся в отдельный каталог, а сам Go — ещё в один; приложение, открытое двойным щелчком, не наследует пользовательские пути и нашло бы только один инструмент из шести, сообщив, что остальных нет. Теперь проверка сама добавляет эти каталоги к своему пути поиска, а выбор, сделанный вручную, остаётся главнее.",
        en: "The Go analysers are found even when the application is launched from Finder. Programs installed with go install go into their own directory, and Go itself into another; an application opened by double-click inherits no user paths and would have found one tool out of six, reporting the rest as absent. The check now adds those directories to its own search path, while a path chosen by hand still wins.",
      },
    ],
  },
  {
    version: "0.88.0",
    date: "2026-07-30",
    items: [
      {
        ru: "Go-код теперь проверяют программы, а не только рассуждение. Когда правка на Go закончена и тесты позеленели, по модулю один раз прогоняются его собственные анализаторы; если они не чисты, «готово» забирается назад и показывается, что именно нашли — с файлом и строкой. Известная уязвимость останавливает работу только тогда, когда уязвимая функция действительно вызывается: та, что просто лежит в списке зависимостей, не мешает. Отдельно проверяется то, что ни один анализатор решить не может — чтение мимо транзакции, утечка горутины, молча пропущенная ветка, запрос без предела, слишком ранний коммит смещения, объект из пула без сброса; всё, что и так ловит анализатор, у модели не спрашивают.",
        en: "Go code is now checked by programs, not by reasoning alone. When a Go change is finished and the tests go green, the module's own analysers run over it once; if they are not clean, \"done\" is taken back and what they found is shown with file and line. A known vulnerability stops the work only when the vulnerable function is actually called — one that merely sits in the dependency list does not get in the way. Separately, the things no analyser can decide are checked: a read that escapes its transaction, a leaked goroutine, a silently skipped branch, a query with no limit, an offset committed too early, a pooled object reused without a reset; anything an analyser already catches is never put to the model.",
      },
      {
        ru: "Независимый рецензент изменений больше не читает один текст. Ему передают то, что установили программы — результат прогонов и находки анализа, — и это лежит перед самим изменением, чтобы он сверялся, а не выводил заново. Замерено на девяти тысячах проверок: такая сверка возвращает почти половину того, что рецензент пропускает сам, и выигрыш тем больше, чем скромнее модель. Комментарии в коде при этом не вырезаются: их удаление измеримо ухудшает результат у более слабых моделей.",
        en: "The independent reviewer of a change no longer reads text alone. What programs established — the run results and the analysis findings — is handed to it, placed ahead of the change itself so it cross-references instead of re-deriving. Measured over nine thousand trials: that cross-reference recovers almost half of what the reviewer misses on its own, and the gain is larger the more modest the model. Comments in the code are not stripped out for it: removing them measurably worsens the result for weaker models.",
      },
      {
        ru: "Ответ больше не обрезается на записанном числе. Ход ограничивался двумя жёсткими потолками, не связанными с тем, сколько ответу нужно места: облачная модель получала тридцать две тысячи токенов, локальная — сто двадцать восемь тысяч, хотя её паспорт предлагал больше, а адаптер поверх того резал каждый ответ до восьми тысяч. Теперь потолка у хода нет — он длится столько, сколько нужно, и останавливается сам; единственная оставшаяся стена в двести пятьдесят шесть тысяч охраняет только от зависшего хода, который никогда не скажет «стоп». Окно ввода и физика памяти при этом не пострадали: потолок вывода в адаптере по-прежнему считается так, чтобы запрос и ответ вместе поместились в загруженное окно — иначе сервер падал при выделении памяти.",
        en: "An answer is no longer cut off at a written-down number. A turn was bounded by two hard caps unrelated to how much room the answer needed: a cloud model got thirty-two thousand tokens, the local one got a hundred and twenty-eight thousand though its passport offered more, and the adapter on top of that cut every reply to eight thousand. Now a turn has no cap — it runs as long as it needs to and stops on its own; the one wall left, at two hundred fifty-six thousand, guards only against a runaway turn that never says stop. The input window and the physics of memory are untouched: the adapter's output ceiling is still computed so the request and the reply fit the loaded window together — otherwise the server crashed allocating memory.",
      },
    ],
  },
  {
    version: "0.87.0",
    date: "2026-07-30",
    items: [
      {
        ru: "Разбор большого материала больше не обрывается на полуслове. Длина итогового текста росла вместе с объёмом источника, но упиралась в записанное число: книга из двадцати восьми глав заработала место на восемь с половиной тысяч слов-единиц, получила шесть, и разбор остановился посреди фразы. Теперь предел выводится из того окна, через которое ответ должен вернуться, за вычетом самого запроса — где материала много, там и места много, а где мало, там короче.",
        en: "Work on large material no longer stops mid-word. The length of the final text grew with the size of the source but ran into a written-down number: a twenty-eight chapter book earned room for eight and a half thousand units, was given six, and the analysis stopped mid-sentence. The limit is now derived from the window the answer has to come back through, less the request itself — where there is a lot of material there is a lot of room, and where there is little it is shorter.",
      },
    ],
  },
  {
    version: "0.86.0",
    date: "2026-07-30",
    items: [
      {
        ru: "Разбор большого материала снова виден. Работа шла в фоне и сообщала о себе — сколько частей прочитано из скольких, — но эта строка выводилась только рядом с пометкой о прерванном ходе, а такой пометки в этом случае не возникает. На экране оставалось «поработал две минуты» и пустота, пока в фоне читались двадцать восемь глав. Теперь строка о ходе работы показывается всегда, пока работа идёт.",
        en: "Work on large material is visible again. It was running in the background and reporting itself — how many parts had been read of how many — but that line was only shown beside the interrupted-turn marker, and in this case no such marker ever appears. The screen kept saying it had worked for two minutes and then showed nothing, while twenty-eight chapters were being read. The progress line is now shown whenever work is actually running.",
      },
    ],
  },
  {
    version: "0.85.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Разговор сокращается один раз на одно переполнение, а не на каждом шаге после него. Отметка «беседа переросла порог» ставилась один раз и держалась: сокращение отрабатывало, отметка оставалась, и на следующем шаге всё повторялось. Живой замер: на вопрос «сколько файлов в этой папке?» — двенадцать сокращений, сорок восемь сообщений и ни одного ответа, причём ничего не ломалось — просто один и тот же вопрос задавался снова и снова. Сокращение, которое отработало, снимает отметку; следующее нужно заслужить новым ростом.",
        en: "A conversation is shortened once per overflow, not on every step after it. The mark saying \u201cthe conversation outgrew its threshold\u201d was set once and held: shortening ran, the mark stayed, and the next step repeated it. Measured live on \u201chow many files are in this folder?\u201d \u2014 twelve shortenings, forty-eight messages and no answer, with nothing actually broken: the same question was simply being asked forever. A shortening that ran clears the mark; the next one has to be earned by new growth.",
      },
    ],
  },
  {
    version: "0.84.0",
    date: "2026-07-29",
    items: [
      {
        ru: "Пять настроек, которые движок читал, названы в примере конфигурации. Проверка, следящая за этим, смотрела лишь в одну папку движка из многих — и обвиняла верно описанные настройки в том, что код их не читает; естественным ответом на такую жалобу было бы стереть правильное описание.",
        en: "Five settings the engine reads are now named in the example configuration. The check that guards this looked at only one of the engine's directories, and accused correctly documented settings of being promises the code does not keep — the natural way to silence such a complaint is to delete the description that was right.",
      },
      {
        ru: "Проверка достижимости помощников научилась видеть остров: модуль, чьи части ссылаются только друг на друга, снаружи мёртв, но выглядел живым. Она также перестала считать доказательством совпадение общего имени и больше не объявляет мёртвым то, что запускается по пути, а не по ссылке.",
        en: "The reachability check now sees an island: a module whose parts reference only each other is dead from outside while looking alive. It also stopped treating a shared name as evidence, and no longer calls dead something that is launched by path rather than by reference.",
      },
    ],
  },
  {
    version: "0.83.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Фраза о вызове больше не исполняется как вызов. Вчерашнее послабление — принимать вызов, если блок разметки полон, — открыло дыру: предложение «я бы написал сюда вызов, но не буду» цитирует безупречно составленный блок и потому исполнялось. Различает не полнота блока, а его место: тот, кто вызывает, договаривает, вызывает и умолкает; тот, кто рассказывает о вызове, продолжает фразу дальше. Речь после блока — признак рассказа.",
        en: "A sentence about a call is no longer executed as one. Yesterday\u2019s relaxation \u2014 accept a call when the markup block is complete \u2014 opened a hole: \u201cI would normally write a call here, but I will not\u201d quotes a flawless block and was therefore executed. What separates them is not the block\u2019s completeness but its position: one who calls finishes speaking, calls, and stops; one who describes a call keeps writing. Speech after the block is the mark of description.",
      },
    ],
  },
  {
    version: "0.82.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Вызов инструмента, написанный текстом вместо настоящего вызова, теперь узнаётся и восстанавливается. Модель иногда описывает вызов прозой; ни одна из двух защит не срабатывала: движок требовал, чтобы причина остановки была «вызов инструмента» — но она такой не бывает, когда вызов не распознан, — и знал лишь один диалект разметки из нескольких. Адаптер же принимал вызов, только если во всём ответе не было ни слова прозы, а модель предваряет вызов фразой. Итог: один вопрос давал тридцать три сообщения и ход не доходил до ответа. Теперь распознаётся суть, а не написание, а вокруг полного блока допускается обычная речь.",
        en: "A tool call written as text instead of being made is now recognised and recovered. The model sometimes describes a call in prose; neither guard fired: the engine required the finish reason to be \u201ctool call\u201d \u2014 which it never is when the call was not parsed \u2014 and knew one markup dialect out of several. The adapter accepted a call only when the whole reply contained no prose at all, while the model narrates before calling. One question produced thirty-three messages and never reached an answer. Substance is matched now rather than spelling, and ordinary speech around a complete block is allowed.",
      },
      {
        ru: "Сводчик, который раз за разом срывается, признаётся неспособным. Проверка «освободило ли место» осталась, но её мало: сорванная сводка может освободить место и при этом быть мусором. Три срыва подряд — и ход завершается; одна удачная сводка обнуляет счёт.",
        en: "A summarizer that keeps derailing is judged unable. The \u201cdid it free room\u201d test stays, but it is not enough on its own: a derailed summary can free room and still be garbage. Three derailments in a row end the turn; one clean summary resets the count.",
      },
    ],
  },
  {
    version: "0.81.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Ответила — значит закончила. Сокращение разговора существует, чтобы дать место работе, которая ещё идёт, и больше не воскрешает ход, который модель уже завершила: раньше длинная беседа оставалась выше порога навсегда, сокращение срабатывало на каждом шаге и каждый раз говорило «продолжай» — модель считала спустя долгое время после того, как ответ был на экране. Признак берётся у самой модели: шаг остановился сам, оставил текст и ни одного незавершённого инструмента. Размер ответа при этом ничем не ограничен — одна строка и двадцать страниц одинаково считаются ответом; сколько нужно вопросу, решает модель, а не обвязка.",
        en: "Answered means done. Shortening the conversation exists to make room for work still going, and no longer resurrects a turn the model already finished: a long conversation used to sit above the threshold permanently, so shortening fired on every step and each pass said \u201ccontinue\u201d — the model computing long after the answer was on screen. The signal comes from the model itself: a step that stopped of its own accord, left text, and has no tool still pending. Nothing bounds the answer\u2019s size — one line and twenty pages are equally answers; what the question deserves is the model\u2019s call, not the harness\u2019s.",
      },
    ],
  },
  {
    version: "0.80.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Продолжать работу можно, только если сокращение разговора действительно освободило место. Прежняя граница — «не больше двух попыток» — была числом, выбранным заранее, и ошибалась в обе стороны: ход, который ещё расчищал место, останавливали без причины, а ход, не расчищавший ничего, получал две бесполезные попытки. Теперь меряется единственное, ради чего сокращение существует: если сводка не стала заметно меньше того, что заменила, места не появилось — следующий круг будет таким же, и ход завершается. Расчистило — продолжаем, сколько бы кругов ни прошло.",
        en: "Work continues only when shortening the conversation actually freed space. The earlier bound \u2014 \u201cat most two attempts\u201d \u2014 was a number chosen in advance, and it was wrong in both directions: a turn still clearing room was stopped for nothing, and a turn clearing nothing was given two pointless rounds. What is measured now is the one thing shortening exists for: if the summary is not materially smaller than what it replaced, no space appeared, the next round will be the same, and the turn ends. If space did appear, work continues \u2014 however many rounds have passed.",
      },
    ],
  },
  {
    version: "0.79.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Ход больше не может молотить бесконечно. Вчерашняя правка заменила аварийное завершение на запасную сводку и продолжение — и тем сняла единственное условие остановки: один вопрос «что тут? о чем?» дал десять сжатий, четыре запасные сводки и полсотни сообщений, а модель продолжала считать спустя долгое время после того, как ответ был получен. Запасных сводок теперь не больше двух: сдаться позже — лучше, чем упасть сразу, но сдаваться бесконечно — это петля.",
        en: "A turn can no longer churn forever. Yesterday\u2019s change replaced the abort with a fallback summary and a continuation, and in doing so removed the only stopping condition there was: one question produced ten compactions, four fallback summaries and fifty-odd messages, with the model still computing long after the answer had arrived. At most two fallback summaries now: degrading beats dying, but degrading forever is a loop.",
      },
    ],
  },
  {
    version: "0.78.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Пока агент работает, в чате не остаётся ничего, кроме свёрнутого заголовка. Раньше наружу выносилась последняя реплика модели — и, пока ход не закончен, ею оказывалась заметка о процессе: «продолжаю читать ключевые главы». Ответ есть только у завершённого хода; до тех пор под свёрнутым заголовком лежит всё.",
        en: "While the agent works, nothing stands in the conversation but the folded header. The last piece of model text used to be shown in the open, and until a turn finishes that is a progress note \u2014 \u201ccontinuing with the key chapters\u201d. Only a finished turn has an answer; until then the fold holds everything.",
      },
    ],
  },
  {
    version: "0.77.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Свёрнутый блок работы теперь действительно один — прошлая правка легла в файл, который лентой не используется. Правило то же: служебные сообщения обвязки не открывают собственного блока, вся работа собирается под единственный заголовок хода, а в чате остаются только он и готовый ответ.",
        en: "There really is one folded work block now \u2014 the previous change landed in a file the timeline does not use. The rule is unchanged: the harness\u2019s own messages open no block of their own, all the work gathers under the single turn header, and the conversation shows only that and the finished answer.",
      },
    ],
  },
  {
    version: "0.76.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Один вопрос — один свёрнутый блок работы и один ответ. Обвязка вставляет собственные сообщения, чтобы продлить ход, и каждое такое открывало отдельный блок «Worked for…»: одна просьба возвращалась несколькими блоками, а между ними в открытую стояли заметки модели о ходе чтения — «продолжаю читать остальные главы», «у меня 14 из 22». Теперь служебные сообщения не начинают своего блока, вся работа собирается под единственный свёрнутый заголовок хода, а в ленте остаётся только он и готовый ответ. Захотите посмотреть, как всё делалось — разверните.",
        en: "One question, one folded work block, one answer. The harness inserts its own messages to keep a turn alive, and each opened a separate \u201cWorked for\u2026\u201d block: a single request came back as several, with the model\u2019s progress notes standing in the open between them \u2014 \u201ccontinuing with the rest of the chapters\u201d, \u201c14 of 22 read\u201d. Those messages no longer start a block of their own; all the work gathers under the one folded turn header, and the conversation shows only that and the finished answer. Unfold it if you want to see how it was done.",
      },
    ],
  },
  {
    version: "0.75.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Просьба прочесть всё больше не превращается в чтение выборочно. Указание держать в памяти понемногу звучало как «возьми несколько штук» — и на задаче «изучи папку» модель честно объявила, что читает главы выборочно. Дробление касается ПАМЯТИ, а не охвата: теперь сказано прямо — прочитать нужно каждый файл, ничего не пропуская и не выбирая, пока не останется непрочитанного; а если охватить всё не выходит, сказать об этом, а не выдавать образец за целое.",
        en: "A request to read everything no longer turns into reading selectively. The instruction to hold little at a time sounded like \u201ctake a handful\u201d \u2014 and on a \u201cstudy this folder\u201d task the model duly announced it was reading chapters selectively. Batching is about MEMORY, not coverage: it now says outright that every file is read, nothing skipped or sampled, until nothing is left unread \u2014 and that failing to cover everything must be stated, never dressed up as the whole.",
      },
      {
        ru: "Чат больше не называется мыслью модели. Заголовок «<｜dsml:thinking>Let me explore the current folder structure…» пережил очистку, потому что она знала только одно написание маркера размышления. Теперь строка с любым таким маркером отбрасывается целиком — не очищается: под маркером всё равно внутренний монолог, а не имя разговора.",
        en: "A chat is no longer named after the model\u2019s own thought. The title \u201c<\uff5cdsml:thinking>Let me explore the current folder structure\u2026\u201d survived the cleaner because it knew only one spelling of a reasoning marker. A line carrying any such marker is now dropped whole rather than cleaned \u2014 what sits under the marker is still inner monologue, not the name of a conversation.",
      },
    ],
  },
  {
    version: "0.74.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Агент больше не рассказывает читателю о своей внутренней кухне и не переспрашивает задачу, которая стоит сообщением выше. Живой случай: после внутренней пересборки контекста модель написала «контекст не сохранился, нет записанной задачи — уточните, чем заняться» — притом что вопрос был прямо над этим, а файлы лежали на диске. Обе внутренние записки переписаны: пустые блоки памяти значат «нечего нести», а не «что-то потеряно»; сброшенный из контекста материал перечитывается с диска, а не выпрашивается у пользователя заново.",
        en: "The agent no longer tells the reader about its internal housekeeping and no longer re-asks for a task that sits one message above. Live case: after an internal context rebuild the model wrote \u201ccontext was not preserved, no recorded task \u2014 please clarify what to do\u201d \u2014 while the request stood right above it and the files sat on disk. Both internal notes are reworded: empty memory blocks mean nothing was worth carrying, not that something was lost; material dropped from context is re-read from disk, never requested from the user again.",
      },
    ],
  },
  {
    version: "0.73.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Разобран ход, закончившийся хвостом разметки вместо ответа. Причина — в конфиге у модели было вписано окно вдвое меньше настоящего: измеренная поправка чинила текущий запрос, но в файл не попадала, если загрузчику нечего было делать, — и пороги сжатия считались от вымышленного числа. Сжатие било в 84-секундном ходе, сводчик дважды сбивался на продолжение задачи, работа сгорала. Теперь измеренное окно пишется в конфиг в момент самой поправки, а после двойного сбоя сводчика собирается механическая сводка — некрасивая, но ничего не теряющая и читателю невидимая.",
        en: "The turn that ended in a tail of markup instead of an answer is dissected. The config carried a window half the real size for the model: the measured correction fixed the current request but never reached the file when the loader had nothing to do — so the compaction thresholds computed from a fictional number. Compaction fired inside an 84-second turn, the summarizer derailed into task continuation twice, and the work burned. The measured window is now written to the config at the moment of correction, and after a double derail a mechanical summary is assembled — plain, lossless, and invisible to the reader.",
      },
    ],
  },
  {
    version: "0.72.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Найдена и устранена причина «приложение намертво зависает»: проверяя, можно ли показать чат, движок спрашивал у файловой системы канонический путь каждой папки каждой сессии — а этот вызов на папке под iCloud (Рабочий стол) периодически засыпает в ядре без ограничения времени. Один такой путь останавливал весь сервер: ни списка чатов, ни ответов, ноль загрузки процессора. Зависание приходило и уходило вместе с настроением синхронизации — потому и казалось случайным. Теперь вопрос «своя ли это папка» решается сравнением строк, без единого обращения к диску: виснуть больше нечему.",
        en: "The cause of \u201cthe app freezes solid\u201d is found and removed: deciding whether a chat may be shown, the engine asked the filesystem for the canonical path of every session\u2019s folder \u2014 and that call, on an iCloud-managed folder (Desktop), periodically sleeps in the kernel with no time limit. One such path stopped the whole server: no chat list, no answers, zero CPU. The freeze came and went with the sync daemon\u2019s mood, which is why it looked random. \u201cIs this folder ours\u201d is now answered by comparing strings, with not a single disk access \u2014 there is nothing left to sleep.",
      },
    ],
  },
  {
    version: "0.71.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Фоновые само-проходы — «Авто-сон» (уборка памяти) и «Авто-дистилляция» (навыки из сделанного) — теперь выключены по умолчанию, для всех. Они запускались сами, едва наступала тишина после ответа, занимали единственный слот модели и выглядели как бесконечное «думает»; следующий вопрос вставал за ними в очередь. Включаются осознанно: два переключателя в Настройках ▸ Основные, применяются со следующего запуска. Ручные /dream и /distill работают как раньше.",
        en: "The background self-improvement passes — Auto Dream (memory consolidation) and Auto Distill (skills from finished work) — are now off by default, for everyone. They used to start on their own the moment a turn went quiet, occupy the single model slot and read as endless \u201cthinking\u201d; the next question queued behind them. Enabling is a deliberate act: two switches in Settings \u25b8 General, applied from the next launch. Manual /dream and /distill work as before.",
      },
    ],
  },
  {
    version: "0.70.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Разбор книги приходит только готовым — или не приходит вовсе. Когда итоговый синтез не удавался, в чат вываливались сырые заготовки по группам глав, склеенные разделителями и обрезанные на полуслове, — рабочий материал машины вместо ответа. Теперь неудавшийся синтез собирается слоями: группы заготовок сводятся во внутренние части, части — в один итог; не вышло и так — задача молча возвращается обычному ходу, и читатель получает ответ оттуда. Оборванная трансляция больше не оставляет огрызок: сообщение одно, и оно дозаполняется до целого.",
        en: "A book analysis arrives finished — or not at all. When the final synthesis failed, raw per-group drafts were dumped into the chat, joined with dividers and cut mid-word: the machine's working material in place of the answer. A failed synthesis now assembles in layers — group drafts into internal parts, parts into one whole; failing even that, the task quietly returns to the ordinary turn and the reader gets the answer from there. An interrupted stream no longer leaves a stump: there is one message, and it fills in to completion.",
      },
    ],
  },
  {
    version: "0.69.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Из диалога убраны последние машинные пометки: «Session compacted», «Compacting context…», «Compaction did not finish · Retry» и голое «Interrupted». Сжатие повторяется и восстанавливается само — кнопка дублировала автоматику; обрыв хода либо сопровождается осмысленной подписью о идущей работе, либо не говорит ничего. В диалоге остаются только ваши слова и ответы; состояние машины — в журнале.",
        en: "The last machine markers are gone from the conversation: \"Session compacted\", \"Compacting context…\", \"Compaction did not finish · Retry\" and the bare \"Interrupted\". Compaction retries and recovers on its own — the button duplicated the automatic path; an interrupted turn either carries a meaningful label about work in progress or says nothing. The conversation keeps only your words and the answers; the machine's state lives in the log.",
      },
    ],
  },
  {
    version: "0.68.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Служебный текст сжатия больше не попадает в диалог — четырьмя путями разом. Сводка сжатия («## Goal…») была видна как ответ — теперь она не показывается: о сжатии говорит только разделитель. Внутренняя записка модели после сжатия рисовала пустое сообщение от вашего имени — пузырь скрыт. Та же записка, написанная по-английски, сбивала определитель языка — «о чём книга?» получал ответ по-английски; язык теперь определяется только по вашим собственным словам. И сама записка переписана: раньше она велела модели объяснять читателю про лимиты и вложения — теперь прямо запрещает упоминать механику и требует отвечать на языке пользователя.",
        en: "Compaction's internal text no longer reaches the conversation, closed four ways at once. The compaction summary (\"## Goal…\") rendered as an answer — it is hidden now, and only the divider speaks of compaction. The internal follow-up note drew an empty message in your name — that bubble is gone. The same note, written in English, misled the language pin — a Russian question got an English answer; the language is now read from your own words only. And the note itself is reworded: it used to tell the model to explain limits and attachments to the reader — it now forbids mentioning the machinery and requires answering in the user's language.",
      },
    ],
  },
  {
    version: "0.67.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Закрывая приложение, оно больше не обрывает чужую работу. Уходя, оно снимает всё, что запустило само, — и последней страховкой глушило разбор корпуса по имени скрипта, а под это имя попадал любой такой разбор на машине, кем бы он ни был начат. Дважды за день это оборвало чужой прогон — на 7-й главе из 52 и на 31-й. Работа продолжилась с того же места, потерялось только время; но «ничто, запущенное FABULA, не переживает FABULA» никогда не давало права заканчивать начатое кем-то другим. Теперь под страховку попадают только собственные работники — те, что отчитываются этому же приложению.",
        en: "Closing the app no longer cuts off somebody else's work. On the way out it ends everything it started itself, and its last safety net silenced a corpus pass by the name of its script — which matched any such pass on the machine, whoever had begun it. Twice in one day that ended another run, at chapter 7 of 52 and again at 31. The work carried on from where it stopped and only time was lost; but \"nothing FABULA starts may outlive FABULA\" was never a licence to end what something else started. The net now catches only its own workers — the ones reporting back to this app.",
      },
    ],
  },
  {
    version: "0.66.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Просьба разобрать книгу целиком работает какими угодно словами. Раньше её узнавали по формулировке, и список узнаваемых оборотов приходилось расширять каждый раз, когда кто-то спрашивал иначе: он знал «все главы», но не «полностью», знал «критика», но не «критическое», знал «анализ», но не «о чём». Теперь смотрят не на просьбу, а на работу: файл за файлом из одной папки, сверх окна, с которым модель реально загружена, и непрочитанное ещё осталось. Это одно и то же на любом языке — и для той фразы, которую ещё никто не написал.",
        en: "Asking for a whole book taken apart works in whatever words you use. It used to be recognised by phrasing, and the list of recognisable turns of speech had to be widened every time somebody asked differently: it knew «every chapter» but not «in full», knew «critique» but not «critical», knew «analysis» but not «what is it about». What is looked at now is the work rather than the request: file after file out of one folder, past the window the model is actually loaded with, with more still unread. That is the same in any language — and for the sentence nobody has written yet.",
      },
      {
        ru: "Крупный результат больше не заливается в переписку. Когда прочитанное перестаёт помещаться в ход, текст целиком остаётся снаружи, а вместо него приходит короткая ссылка: что это, какого размера, как начинается и как добраться до остального. Дальше можно задать вопрос ко ВСЕМУ материалу — он читается по частям отдельными вызовами, а ответы сводятся в один, — или прочитать любой кусок дословно. Ничего не обрезается и ничего не теряется. Обычные результаты не трогаются, так что на повседневной работе это не стоит ничего.",
        en: "A large result is no longer poured into the conversation. When what has been read stops fitting the turn, the text stays outside it whole and a short reference arrives instead: what it is, how big it is, how it starts, and how to reach the rest. A question can then be asked of ALL of it — read in parts by separate calls, the answers merged into one — or any passage read verbatim. Nothing is truncated and nothing is lost. Ordinary results are untouched, so everyday work pays nothing for it.",
      },
      {
        ru: "Глава читается целиком, а не первой своей пятой частью. Размер порции был записан числом — восемь тысяч знаков, — а глава живой книги вчетверо длиннее, так что просьба прочесть всё оборачивалась чтением начала каждой главы и догадками об остальном. Теперь порция считается от окна, с которым модель загружена, и набирается под самую его ёмкость: длинный текст входит целиком, вызовов становится меньше, а покрытие — полным.",
        en: "A chapter is read whole rather than in its first fifth. The size of a portion was written down as a number — eight thousand characters — and a chapter of a real book runs four times that, so a request to read everything came out as reading the opening of each chapter and inferring the rest. A portion is now worked out from the window the model is loaded with and packed close to its capacity: a long text goes in whole, there are fewer calls, and the coverage is complete.",
      },
      {
        ru: "Ответ приходит один. Когда разбор корпуса уходит в фон, собственный ход модели теперь завершается — раньше он продолжал набирать главы, которые уже не помещались, пока рядом писался настоящий отчёт.",
        en: "One answer arrives. When covering a corpus moves to the background the model's own turn now ends — it used to go on taking in chapters that no longer fitted while the real report was being written beside it.",
      },
    ],
  },
  {
    version: "0.65.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Разговор больше не встаёт намертво через несколько минут после запуска. Дойдя до определённого объёма, беседа откладывает в сторону свою краткую запись — и перед этим ждала, пока машина освободится. Занята она была этой самой беседой: ожидание держало разговор, разговор держал ожидание. Через полчаса ожидание сдавалось, и всё продолжалось само, но эти полчаса выглядели как зависшее приложение — окно живо, ответа нет, процессор пуст. Теперь запись дожидается своей очереди в стороне, а разговор идёт дальше не останавливаясь. Из-за той же ошибки запись не делалась ни разу с тех пор, как ожидание появилось сегодня утром: закончиться иначе, чем впустую, оно не могло.",
        en: "A conversation no longer stops dead a few minutes after launch. Past a certain size it sets aside a short record of itself, and before doing so it waited for the machine to fall quiet — while what was keeping the machine busy was that very conversation: the wait held the turn, the turn held the wait. After half an hour the wait gave up and everything carried on, but that half hour looked exactly like a frozen app — window alive, no answer, processor idle. The record is now made out of the way and the conversation continues without pausing. By the same fault not one record had been made since the wait arrived this morning: it could not end any way but empty-handed.",
      },
    ],
  },
  {
    version: "0.64.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Разбирается та папка, на которую вы указали, а не та, куда агент заглянул по дороге. Дважды на живом прогоне он заходил в подпапку со снимками экрана, набирал материал там — и работа шла по ней, пока рядом лежали непрочитанные главы. Подпапка рабочей папки — часть той же работы, а не соперник ей. Заодно файлы под папкой считаются вглубь: при счёте по верхнему уровню корень выглядел меньше собственного ребёнка, из-за чего папка снимков и обходила книгу.",
        en: "The folder taken apart is the one you pointed at, not the one the agent stepped into along the way. Twice on live runs it walked into a screenshots subfolder, took its material in there, and the work followed it while unread chapters sat alongside. A subfolder of the working directory belongs to the same job rather than competing with it. Files beneath a folder are also counted downward now: counted only at the top level, a root looked smaller than its own child, which is how a screenshots folder came to outrank a book.",
      },
    ],
  },
  {
    version: "0.63.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Когда материала набралось больше, чем помещается, разбирается самый крупный незакрытый массив — а не та папка, где счётчик первым перевалил. На живом прогоне это была подпапка со снимками экрана, куда агент заглянул мимоходом, пока рядом лежали непрочитанные главы. Переполнение теперь считается по всему ходу, потому что окно у него одно на всё; а цель выбирается по объёму работы, а не по весу файлов — папка картинок тяжелее книги почти всегда и почти никогда не является тем, что изучают.",
        en: "When more material has come in than fits, the largest unfinished body is the one taken apart \u2014 not whichever folder tripped the counter first. On a live run that was a screenshots subfolder the agent had glanced into, while unread chapters sat beside it. Overflow is now counted across the whole turn, because the turn has one window for all of it; the target is chosen by how much work is left rather than by how heavy the files are, since a folder of images outweighs a book almost always and is almost never the thing being studied.",
      },
    ],
  },
  {
    version: "0.62.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Работа с большим материалом больше не опознаётся по словам вопроса. Раньше нужно было попасть в формулировку — «прочти все главы»; спрошенное иначе шло обычным путём, по файлу за раз, пока нить не терялась. Теперь смотрится происходящее: файл за файлом из одной папки, прочитанного уже больше, чем помещается, и непрочитанное осталось. Это видно одинаково на любом языке и при любой формулировке, включая те, которых ещё никто не написал. Проверено запросом «ну и?» — под него шаблон не напишешь, а разбор собрался.",
        en: "Working through a large body of material is no longer recognised by the words of the question. It used to require hitting a phrasing — read all the chapters; asked any other way, the work went file by file until the thread was lost. What is watched now is what is happening: file after file from one directory, more taken in than fits, and more still unread. That looks the same in any language and any phrasing, including ones nobody has written yet. Proven with the question \u201cну и?\u201d \u2014 nothing a pattern could catch, and the analysis was still produced.",
      },
    ],
  },
  {
    version: "0.61.0",
    date: "2026-07-28",
    items: [
      {
        ru: "«Interrupted» больше не висит над готовым ответом. Когда обвязка сама снимает ход, чтобы доделать работу в стороне, и работа доходит до конца, ход ничем не прерван — ответ лежит тут же, строкой ниже. Слово оставалось потому, что завершённое состояние выбрасывалось, и подпись о ходе работы просто исчезала; хуже того, через полторы минуты оно возвращалось навсегда. Теперь завершение — это факт, и он не стирается.",
        en: "\u201cInterrupted\u201d no longer sits above a finished answer. When the harness takes a turn down so the work can complete elsewhere, and that work arrives, nothing was interrupted \u2014 the answer is one line below. The word survived because the finished state was discarded and the progress label simply vanished; worse, after ninety seconds it came back for good. Finishing is now a fact that is kept.",
      },
      {
        ru: "Отчёт по книге начинается с самого разбора. Раньше первой строкой шло, из скольких файлов и за сколько заходов он собран — учёт машины на том самом месте, где ждут ответ. Как работа была поделена, остаётся в журнале.",
        en: "A book report now opens with the analysis itself. It used to begin with how many files and passes it was assembled from \u2014 the machine\u2019s own bookkeeping in the one place reserved for the answer. How the work was divided stays in the log.",
      },
    ],
  },
  {
    version: "0.60.0",
    date: "2026-07-28",
    items: [
      {
        ru: "«О чём книга? прочти полностью» теперь читается как просьба прочесть её целиком. Такая просьба идёт коротким путём — произведение разбирается частями, каждая укладывается в свой запрос, и до конца доходит вся книга. Раньше узнавалась лишь одна формулировка — «прочти все главы»; остальные шли обычным путём, по главе за раз, пока нить не терялась. Добавлена не фраза, а то, КАК об этом просят: «полностью», «целиком», «о чём», «перескажи», «критическое описание» — и то же по-английски.",
        en: "“What is this book about? read it in full” now reads as a request to read the whole of it, and takes the short path: the work is covered in parts, each part fits its own request, and the end of the book is reached. Only one phrasing was recognised before — “read all the chapters” — and everything else went the ordinary way, a chapter at a time, until the thread was lost. What was added is not a sentence but the WAY people ask: in full, cover to cover, what is it about, summarise, a critical description.",
      },
    ],
  },
  {
    version: "0.59.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Отменена вчерашняя замена сводки: она лезла прямо в диалог. Служебный текст о том, что и чем сокращалось, показывался как ответ — со списками вызванных инструментов и открытых файлов, повторяясь снова и снова, вместо того чтобы остаться внутри. Убрано целиком: вам такое видеть незачем.",
        en: "Yesterday's replacement summary is withdrawn: it was appearing in the conversation itself. Internal text about what was being shortened and how was shown as an answer — lists of tools called and files opened, repeating over and over — instead of staying out of sight. Removed entirely: there is no reason for you to see it.",
      },
    ],
  },
  {
    version: "0.58.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Работа больше не пропадает, если сжатие не удалось. Когда история становится длинной, её просят сократить — но, читая разговор, полный указаний «прочти главы», модель иногда продолжала читать вместо того чтобы сокращать. FABULA это замечала, просила ещё раз, а после второй неудачи прекращала ход красной ошибкой — и всё прочитанное пропадало ровно в тот момент, когда вы ждали ответа. Теперь после второй неудачи сводка собирается из того, что в разговоре и так есть: ваши слова, какие файлы открывались, чем всё закончилось. Суше, зато всегда есть, и подменить её нечем — ни у кого ничего не спрашивают.",
        en: "Work is no longer lost when compression fails. As a history grows long the model is asked to shorten it — but reading a conversation full of instructions to read chapters, it sometimes kept reading instead of shortening. FABULA noticed, asked again, and after a second failure ended the turn with a red error, losing everything already read at exactly the moment you were waiting for an answer. After a second failure the summary is now assembled from what the conversation already contains: your own words, which files were opened, where things stood. Drier, but always available, and impossible to derail because nothing is asked of anyone.",
      },
    ],
  },
  {
    version: "0.57.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Найдена настоящая причина падений — и она оказалась сложением. Окно модели вмещает и вопрос, и ответ вместе, а место под ответ просилось всегда одинаковое: четверть окна, сколько бы ни занимал сам вопрос. Замерено: вопрос на 133 385 при окне 135 168 помещался свободно, но вместе с запрошенной четвертью выходило 167 177 — и сервер умирал при выделении. Каждая часть по отдельности выглядела разумной, просто никто их не складывал. Теперь место под ответ считается из того, что осталось свободным, с запасом на неточность подсчёта.",
        en: "The real cause of the crashes turned out to be an addition. A model's window holds the question and the answer together, while the room asked for the answer was always the same: a quarter of the window, however much the question already took. Measured: a question of 133 385 fit comfortably in a 135 168 window, but together with the quarter it asked for it came to 167 177 — and the server died allocating. Each part looked reasonable on its own; nobody added them up. The room for an answer is now computed from what is actually left free, with a margin for the estimate being inexact.",
      },
    ],
  },
  {
    version: "0.56.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Сжатие разговора больше не отправляет всё разом. Когда история переставала помещаться, её сворачивали одним запросом — и на шести главах книги он выходил больше, чем модель способна удержать: сервер умирал, сжатие обрывалось, а всё прочитанное пропадало. Теперь длинная история сворачивается по частям: старая часть сокращается, её итог переносится в следующую, и так до конца. Каждый запрос помещается, а целое не ограничено ничем. Если история и так помещалась — она по-прежнему обрабатывается одним разом.",
        en: "Compressing a conversation no longer sends all of it at once. When the history stopped fitting it was folded in a single request — and six chapters of a book made that request larger than the model can hold: the server died, the compression broke off, and everything already read was lost. A long history is now folded in parts: the oldest part is condensed, its result carried into the next, and so on to the end. Every request fits, while the whole is bounded by nothing. A history that fitted anyway is still handled in one go.",
      },
    ],
  },
  {
    version: "0.55.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Записи о том, что делает обвязка, больше не выбрасываются. Всё, что расширения писали о принятых решениях, уходило в никуда — и разобраться, почему что-то повело себя не так, было нечем: механизм, который на самом деле работал, выглядел ни разу не запускавшимся, а единственным доказательством был случайный след в файле настроек. Теперь это пишется в отдельный файл рядом с остальными журналами. Вас это не касается — записи для того, кто разбирает поломки.",
        en: "What the harness does is no longer thrown away. Everything extensions wrote about the decisions they took went nowhere, leaving nothing to reason from when something behaved oddly: a mechanism that was in fact working looked as though it had never run, and its only evidence was an incidental trace in a settings file. This is now written to its own file beside the other journals. It does not concern you — the notes are for whoever is diagnosing a fault.",
      },
    ],
  },
  {
    version: "0.54.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Служебная разметка больше не приходит вместо ответа. Иногда модель не вызывает инструмент, а пишет его вызов текстом — в том виде, в каком принято у неё внутри. Сервер модели передаёт это как обычный текст, потому что не узнаёт такую запись, а FABULA видит законченный ход с парой строк — и вы получаете угловые скобки вместо ответа. Теперь такая запись распознаётся и превращается в настоящий вызов. Осторожно: превращается, только если весь ответ состоит из таких вызовов и ни одного слова кроме — сообщение, где эта разметка просто упомянута, остаётся текстом.",
        en: "Markup no longer arrives instead of an answer. A model sometimes does not call a tool but writes the call out as text, in the notation its own template uses. The model server passes that through as ordinary text because it does not recognise the dialect, and FABULA sees a finished turn with a couple of lines in it — so you get angle brackets instead of a reply. Such notation is now recognised and turned into a real call. Carefully: only when the whole answer consists of those calls and nothing else — a message that merely mentions the markup stays text.",
      },
    ],
  },
  {
    version: "0.53.0",
    date: "2026-07-28",
    items: [
      {
        ru: "FABULA перестала рассуждать о размерах по числу из настроек. Когда решать пора — сокращать историю, сжимать её, сколько можно отправить — считалось от значения, которое кто-то однажды вписал в файл. Оно расходилось с тем, что модель на самом деле держит: замерено, запросы на 188 841 и 271 525 единиц уходили к модели с окном 65 536, и сервер умирал, выделяя под них память — то самое «модель упала». Теперь настоящий предел спрашивается у сервера перед каждым решением и подставляется на место записанного. Если спросить не удалось и ничего не запомнено — записанное остаётся нетронутым.",
        en: "FABULA no longer reasons about size from a number in a settings file. Every decision about when to trim history, when to compress it and how much may be sent was computed from a figure somebody typed once. It disagreed with what the model actually holds: measured, requests of 188 841 and 271 525 units went to a model with a 65 536 window, and the server died allocating memory for them — the 'model has crashed' you saw. The real limit is now read from the server before those decisions and put in place of the written one. When it cannot be read and nothing is remembered, the written figure is left untouched.",
      },
    ],
  },
  {
    version: "0.52.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Отменено вчерашнее ускорение остановки: оно выбрасывало настоящие ответы. Чтобы заметить, что вы ушли, пока модель читает запрос, за соединением следили и обрывали его, если оттуда ничего не приходит. Но обычный сетевой собеседник, отправив запрос, закрывает свою сторону отправки и молча ждёт ответа — и это выглядело точно так же. В итоге ответ обрывался на полпути, сервер модели дописывал его в никуда, а окно оставалось пустым. Признак признан негодным и убран; отличать ушедшего от ждущего нужно иначе.",
        en: "Yesterday's faster stop is withdrawn: it was discarding real answers. To notice that you had left while the model was still reading the request, the connection was watched and dropped when nothing came back from it. But an ordinary network peer closes its sending side once the request is out and then waits quietly for the reply — which looked exactly the same. Answers were cut off mid-flight, the model server finished writing them to nobody, and the window stayed empty. The signal is unsound and has been removed; telling someone who left from someone who is waiting needs a different one.",
      },
    ],
  },
  {
    version: "0.51.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Остановка замечается сразу, а не после первого слова ответа. Пока модель читает ваш запрос, ей нечего вам отправить — а уход собеседника до сих пор обнаруживался только по неудачной отправке. Поэтому нажатие «Стоп» на длинном запросе не давало ничего: замерено 45 секунд и больше. Теперь за соединением следят отдельно и обрывают его через секунду. Оговорка, которую честнее назвать: уже начатое чтение запроса сервер модели доводит до конца, так что освободится она не мгновенно — но отвечать на отменённое уже не станет.",
        en: "A stop is noticed at once, rather than after the answer's first word. While the model is reading your request there is nothing to send you, and until now a departed caller was only discovered by a failed send — so pressing Stop on a long request did nothing at all: measured at 45 seconds and counting. The connection is now watched separately and dropped within a second. The caveat is worth stating plainly: the model server finishes a read it has already begun, so it does not free up instantly — but it will not answer what was cancelled.",
      },
    ],
  },
  {
    version: "0.50.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Автоподбор окна контекста снова включён, и теперь он не может поднять вторую копию модели. Именно это однажды и случилось: выгрузка не смогла забрать занятую модель, ошибку проглотили, загрузка пошла всё равно — и два экземпляра весов не поместились в память, а тот, что обслуживал ваш ход, был убит. Теперь выгрузка проверяется, а не предполагается: если модель осталась в памяти, загрузка отменяется. Вес модели берётся из того источника, который его действительно сообщает, и при неизвестном весе окно не планируется вовсе.",
        en: "The context-window autoloader is back on, and it can no longer bring up a second copy of the model. That is precisely what happened once: an unload could not take a busy model, the error was swallowed, the load went ahead anyway — and two sets of weights did not fit in memory, so the one serving your turn was killed. The unload is now verified rather than assumed: if the model is still resident, the load is called off. The model's weight is read from whichever source actually reports it, and with an unknown weight no window is planned at all.",
      },
    ],
  },
  {
    version: "0.49.0",
    date: "2026-07-28",
    items: [
      {
        ru: "Ваш запрос больше не стоит в очереди за служебной работой. Очередь к модели одна, и до сих пор она обслуживала строго по порядку прихода — а служебные записи состояния успевали занять её первыми. Теперь каждый запрос говорит, кто его послал, и живой ход проходит вперёд. Служебная работа по-прежнему выполняется и по-прежнему в своём порядке, просто никогда впереди вас. Запрос, который себя не назвал, считается вашим.",
        en: "Your request no longer queues behind background work. There is one queue to the model, and until now it served strictly by order of arrival — which background state records were reaching first. Every request now states who sent it, and a live turn goes ahead. Background work still runs, still in its own order, simply never in front of you. A request that does not identify itself is treated as yours.",
      },
    ],
  },
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
