# 致谢

[English](CREDITS.md) · [中文](CREDITS.zh-CN.md) · [Русский](CREDITS.ru.md)

FABULA 引擎派生自 **MiMoCode** 外壳（一个 OpenCode 分支）。在它之上的一切——
`fabula-*` 插件及其工具——都是通过引擎的插件钩子表达的**本地优先实现**，为在你自己的机器和模型上运行而构建。

本文档把每一项能力映射到它**是什么**、它在本仓库中**位于何处**，以及——最
重要的——**如何看到它在运行中的应用里确实存在。**

---

## 如何在应用中看到这些功能

功能以四种方式呈现。有些是可见的；有些是行为性的（你观察智能体做了什么，
而不是某个按钮）。

| 在哪里 | 你看到什么 | 示例 |
|---|---|---|
| **插件面板**（设置 → *插件*） | 每一个已加载的 `fabula-*` 插件，绿色 = 健康 | `40 Plugins` 列表——`fabula-graph`、`fabula-handoff`、`fabula-ops`、… 都是活跃的 |
| **聊天中的工具调用** | 模型按名称调用工具 | `workflow_graph`、`save_handoff`、`schedule_task`、`mixture_of_agents`、`vision_analyze`、`text_to_speech` |
| **工作流轨迹** | 一次 `workflow_graph` 回答的尾部 | `workflow: 2 isolated step(s)` → `s1(research, cloud) → s2(synthesize, local)` |
| **行为性（钩子 / 需自行开启）** | 智能体*行为*不同——没有 UI 元素 | 模型被硬性阻止重复读取同一个文件；web 结果被包在 `<untrusted_tool_result>` 里返回；一次运行结束时手机收到推送 |

**需自行开启的功能已被加载但处于休眠，直到你设置某个环境变量**（在 `.env` 中）：`FABULA_ROUTER`、
`FABULA_SOULS`、`FABULA_NTFY_TOPIC`。在此之前插件是存在的（面板里显示绿色），但行为是关闭的。

---

## MiMoCode / OpenCode —— FABULA 派生自的引擎

**是什么：** FABULA-LLM-5 运行其上的基础——智能体循环、插件系统（每个 `fabula-*` 插件接入的 `tool.execute.*`、
`chat.*`、`experimental.chat.system.transform` 钩子）、多提供商
模型层（OpenAI 兼容提供商）、web UI，以及 MCP 支持。
**为什么：** 智能体循环、插件钩子、多提供商层、web UI 和 MCP 支持在那里已经过生产环境的加固；MiMoCode 是一个成熟的 OpenCode 分支，恰好具备
我们需要的扩展点——因此 FABULA 引擎构建于其上。
**在哪里：** 全部——`fabula.config.json`、`plugin/fabula-*.ts` 文件，以及 macOS 应用所承载的内嵌 web UI。
**怎么看到：** 应用承载着引擎的 web UI；设置面板——连接器（MCP）、权限、插件——都随它一起提供。

---

## pi —— 我们研究并借鉴的监督机制

**是什么：** [pi](https://github.com/earendil-works/pi)（作者 Mario Zechner，MIT 许可）是一个极简的编码智能体
外壳，其工程写作塑造了 FABULA 的若干监督机制。本仓库中的实现
是 FABULA 自己的（不同语言、不同引擎、在此处有单元测试），但下面的*机制
设计*可追溯到 pi，应当归功于它：

| 机制（pi 起源） | FABULA 实现 |
|---|---|
| 跨提供商会话重放——工具调用 id 的规范化/重映射、为孤立调用合成结果、跳过出错的轮次（pi 的 `transform-messages`） | `plugin/lib/xprovider.ts`，接入到 `plugin/fabula-escalate.ts` |
| 上下文溢出分类，包括*静默*截断（pi `overflow.ts` 的模式矩阵） | `proxy/adapter_util.py` → `classify_overflow`，接入到 `:1235` 适配器 |
| 前缀缓存遥测——检测稳定的提示词前缀何时被破坏、KV 缓存何时未命中（pi 的 cache-stats） | `proxy/adapter_util.py` → `stable_prefix` / `shared_prefix_len`（`CACHE-BREAK` 日志） |
| 有界的工具输出——限制超大结果，把完整文本溢写到文件，返回一个续读游标 | `plugin/lib/outputcap.ts`，接入到 `bash_tool` |
| 漂移容忍编辑——规范化弯引号 / 破折号 / unicode 空格 / BOM，让一次几乎命中的编辑仍能落地 | `plugin/lib/fuzzymatch.ts`（`unicode` 规范化器） |
| 失败时的会话回退——pi 回退会话；FABULA 把这个想法向两个方向扩展：一次到最后一个通过（绿）的影子 git 检查点的*原子文件回退*，外加一次会话树回退，折叠掉失败的区段，使重试从未被污染的状态开始 | `plugin/fabula-rewind.ts` + `plugin/lib/rewind.ts` |
| 精简的按任务工具暴露（一条隐藏无关工具的编码「工具带」） | `plugin/lib/toolbelt.ts` + `plugin/lib/toolmeta.ts`（`FABULA_PROFILE=coding`） |

**为什么：** pi 用测量证明了，让一个智能体变可靠的是一小组确定性的外壳机制——而不是
更大的模型。这也是 FABULA 的论点，所以我们采纳了其中最强的
那些机制并加以扩展（文件级原子回退、内核级沙箱、自触发门禁）。

---

## 可靠性、安全、已验证完成、运维

| 能力 | 在哪里 | 如何验证它确实存在 |
|---|---|---|
| **循环守卫**（硬性中止重复的无进展工具调用） | `fabula-reliability` + `lib/loopguard.ts` | 给插槽中的任何模型一个它会陷入循环的任务（例如反复读取同一个文件）。在若干次相同的无进展调用之后，它会被**硬性中止**并得到指引，而不是永远循环下去。 |
| **工具调用参数修复**（畸形/多余键的工具调用仍能抵达执行） | `fabula-reliability` + `lib/argrepair.ts` | 一个发出略微错误的 `actor`/工具参数结构的模型仍然会运行，而不是直接报错。 |
| **安全层**（SSRF 守卫、密钥脱敏、不可信结果包裹、命令/审批守卫） | `fabula-security` + `lib/*` | 让智能体 `web_fetch` 一个页面——结果会包在 `<untrusted_tool_result>` 包装里返回；工具输出/日志中的密钥被脱敏；危险的 shell 命令被阻止或需要审批。 |
| **已验证完成**（一个步骤必须拿出它已完成的证据） | `verify_done` 工具 + 图的每步 `verifyStep` | 一个没有返回实质性输出的步骤——一次拒绝或一段被回显的错误——会被重试一次，然后被标记为降级，并告知综合器；一个失败的步骤绝不会作为数据流向下游。 |
| **能力 + 运维工具** | `fabula-ops`、`fabula-multimodal`、`fabula-vision` | `schedule_task`、`send_notification`、`vision_analyze`、`text_to_speech`、`transcribe_audio` 这些工具在被使用时会出现在聊天中。 |

---

## 工作流图 + 本地→云端路由器（本地优先）

工作流图是**本地优先**的：本地模型是默认的工作者，云端是一个需自行开启的升级通道。

| 能力 | 在哪里 | 如何验证它确实存在 |
|---|---|---|
| **带步骤隔离的工作流图**——规划器产出 ≤5 个子任务；每个都作为一次隔离调用运行，*只*由其依赖项的输出（+ 一个角色 + STOP）作为种子；相互独立的步骤并行运行；结果被综合 | `fabula-graph` → 工具 **`workflow_graph`**，逻辑在 `lib/graph.ts` | 对一个多部分任务调用 `workflow_graph`。回答以一段轨迹结尾：`workflow: N isolated step(s)`，每个步骤一行（`id(role, local/cloud, needs:[…])`）。`fabula-graph` 在插件面板中显示绿色。 |
| **本地→云端路由器**——规则逐步判断某一步是否「重」到需要升级到云端模型 | `plugin/lib/router.ts`，由 `FABULA_ROUTER=1` 控制 | 设置 `FABULA_ROUTER=1` 加一个云端密钥，然后运行一个包含研究型步骤的工作流 → 轨迹会显示该步骤被路由为 `, cloud,`，而轻量步骤保持 `, local,`。默认关闭（仅本地）。 |

---

## 自主智能体能力

这些能力是本地优先且需自行开启的。

| 能力 | 在哪里 | 如何验证它确实存在 |
|---|---|---|
| **对外 ntfy 事件推送**——运行完成 / 出错 / 循环守卫阻断时向手机推送 | `fabula-reliability`，由 `FABULA_NTFY_TOPIC` 控制 | 设置 `FABULA_NTFY_TOPIC=<topic>` 并在 ntfy 应用中订阅。完成一次运行 / 触发一次循环守卫阻断 → 手机上会收到推送。 |
| **精选记忆注入**——你的操作笔记被注入系统提示词 | `fabula-context` | 模型知道你的内部规则（来自 `.fabula/memory/MEMORY.md`），无需每个会话都被告知一遍。 |
| **调度器可靠性 + 运行台账**——通过 macOS `launchd` 的周期性/一次性任务，带逾期检测与结果捕获 | `fabula-ops` + `lib/heartbeat.ts`、`lib/schedule.ts` | 使用 `schedule_task` 然后 `list_scheduled`——每个任务都被标注为「last ran Xh ago / ⚠️ OVERDUE / never ran」。 |
| **角色前导语**——为子智能体加上简短的按角色「谁来跑这一步 + STOP」前缀 | `plugin/lib/souls.ts`，由 `FABULA_SOULS=1` 控制 | 设置 `FABULA_SOULS=1` 后，actor 子智能体会被前置一段简短的角色/STOP 前导语，使插槽中的任何模型都保持在任务上。 |
| **持久的交接产物**——步骤/会话之间结构化、经过威胁扫描的交接 | `fabula-handoff` → `save_handoff` / `read_handoff` / `list_handoffs` | 这三个工具在被使用时会出现在聊天中；`read_handoff` 返回的内容经过包裹/威胁扫描；`fabula-handoff` 在插件面板中显示绿色。 |

---

## 关于上述表格的说明

这些表格是**功能文档**——每一项能力都是在你自己的机器和模型上运行的本地优先实现。
MiMoCode / OpenCode 引擎采用 MIT/Apache 许可，其条款得到遵守。
