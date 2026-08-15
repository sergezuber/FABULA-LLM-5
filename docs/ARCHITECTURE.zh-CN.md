# FABULA-LLM-5 —— 架构总览

[English](ARCHITECTURE.md) · [中文](ARCHITECTURE.zh-CN.md) · [Русский](ARCHITECTURE.ru.md)

FABULA-LLM-5 是一个**本地优先、面向 macOS 的自主编码智能体**。代码生成、研究、自动化这些活儿，它默认都跑在**本地模型**上（经由 LM Studio），另外留了一条**需显式开启**的升级通道，把重活交给云端提供商。整套系统打包成一个原生 `.app`，外观和手感都是一个正经的桌面应用，而不是浏览器里的一个标签页。

1. [分层结构](#1-分层结构) —— 应用、引擎、适配器、插件
2. [引擎插件模型](#2-引擎插件模型) —— 钩子，以及单一导出规则
3. [插件](#3-插件) —— 每个核心插件各自负责什么
4. [Workflow-Graph 编排器](#4-workflow-graph-编排器) —— 规划与并行步骤
5. [横切关注点](#5-横切关注点) —— 可靠性、安全、运维
6. [配置与依赖要求](#6-配置与依赖要求)

---

## 1. 分层结构

整个系统由四个相互协作的层组成。

```
                          ┌──────────────────────────────────────────┐
                          │  Native macOS .app (Swift + WKWebView)    │
   user ───────────────►  │  app/FabulaApp.swift                      │
                          │  own icon · no browser chrome             │
                          └───────────────────┬──────────────────────┘
                                              │ hosts web UI of
                                              ▼
                          ┌──────────────────────────────────────────┐
                          │  FABULA ENGINE (`fabula`)                 │
                          │  agent loop (lineage: docs/CREDITS.md)        │
                          │  config: fabula.config.json                    │
                          │                                           │
                          │   ┌─────────────────────────────────┐    │
                          │   │ PLUGIN LAYER (plugin/fabula-*.ts) │   │
                          │   │ plugin/fabula-*.ts · shared lib/  │   │
                          │   └─────────────────────────────────┘    │
                          └───────┬───────────────────────┬──────────┘
                                  │ chat + structured     │ MCP
                                  │ (OpenAI-compatible)   │ (SearXNG, …)
                                  ▼                       ▼
              ┌────────────────────────────────┐   ┌──────────────┐
              │  Adapter  localhost:1235        │   │  MCP servers │
              │  proxy/lmstudio-adapter.py      │   └──────────────┘
              │  schema + reasoning shims,      │
              │  stall watchdog, admission      │
              │  control, cache telemetry       │
              └───────────────┬─────────────────┘
                              │ proxied
                              ▼
              ┌────────────────────────────────┐      ┌─────────────────────┐
              │  LM Studio  localhost:1234      │      │  Cloud: NVIDIA       │
              │  local models (any OpenAI-compat.)      │      │  (OpenAI-compatible) │
              └────────────────────────────────┘      │  OPT-IN, heavy steps │
                                                       └─────────────────────┘
```

### 1.1 引擎（`fabula`）

**FABULA 引擎**（CLI 是 `fabula`，派生自一个上游引擎，见 [CREDITS](CREDITS.zh-CN.md)）掌管着智能体循环：提示词组装、工具分发、聊天会话存储、Web UI，还有插件运行时。智能体的全部行为都通过 `fabula.config.json` 来配置 —— 这是引擎的配置文件名，属于引擎级契约，为兼容性保留至今。把 `fabula.config.example.json` 复制成 `fabula.config.json` 再填好内容，就得到一份能用的配置。

### 1.2 模型 —— 通过 `:1235` 适配器做到本地优先

模型由 **LM Studio 在本地提供服务**，它自己的服务端口是 `localhost:1234` —— 但 FABULA 里没有任何一处往那里发推理请求。每一次推理调用都发往 `:1235` 上的适配器；直接碰那个原始端口只有一种情形，就是读原生元数据接口（`/api/v0/models`），适配器不代理这个接口，它也不算推理。`LMSTUDIO_URL` 会覆盖推理端点，除非你要指向另一台机器上的适配器，否则请让它一直空着 —— 一旦把它设成 `:1234`，转换、准入门禁、两个看门狗和输出钳制会一起悄悄失效，而且当场不会报错，因为 `:1234` 对一次普通的 chat 调用照样返回 200。这套框架**不会**直接跟 LM Studio 对话，它指向的是 `localhost:1235` 上一个小小的 Python **兼容适配器**（`proxy/lmstudio-adapter.py`）。适配器把请求转发给 LM Studio，同时做下面这些事，好让*结构化输出*和*工具调用*可靠地工作 —— 也好让并发、停顿和缓存失效都在每个请求必经的这一个点上统一管起来：

1. **`json_object` → `json_schema`。** 引擎内部的 Vercel AI SDK 为 `generateObject` 发出的是旧版 OpenAI 的 `response_format: {type:"json_object"}` 模式，而 LM Studio 用 **HTTP 400** 拒绝这个模式 —— 它只认 `json_schema` 和 `text`。适配器把请求改写成**宽松的** `{type:"json_schema", json_schema:{…, additionalProperties:true}}`，这样每个走结构化输出的调用方都能拿回合法 JSON，形状是*它自己那一种*（每次调用的 schema 写在提示词里，不在请求体里）。调用方若想要某种特定语法，就用 `X-Fabula-Schema` 请求头明说；目标裁判正是这样钉住自己那份严格的判定形状。

2. **`reasoning_content` → `content`。** 推理模型 —— 整整一类服务化模型都这样 —— 会把 `content` 留空，把真正的 JSON 答案塞进 `reasoning_content`，AI SDK 于是解析不出来。碰上非流式响应，适配器认得出这种情况，会把 `reasoning_content` 里的内容搬进 `content`。

3. **停顿看门狗 + 输出上限。** 单次上游调用可能陷进螺旋，也可能挂死，几分钟里一个 token 都吐不出来。每次读取都带一个**不活动超时**：首 token（预填充）阶段给一份预算，第一个字节一到就换成更小的 token 间预算 —— 流式和非流式两条路径*都*管。上游停住了就中止它（若是停在第一个字节之前，则重试一次，否则干净地收尾），而不是把这一轮卡死；`FABULA_MAX_OUTPUT_TOKENS` / `FABULA_CONTEXT_WINDOW` 则钳住失控的生成。「靠框架托住模型」这个主张，落到数据通路这一环上，就是这个样子。

4. **声明式推理档位控制（需显式开启）+ 遥测。** 有一张配置表（`proxy/reasoning-map.json`）：只要请求带上档位（`X-Fabula-Reasoning` 或环境变量），它就按模型和档位给推理旋钮打补丁；某个模型没定义的档位会**逐档**回落到 `*` 表，所以给一个模型加一个档位，不会连带把其他档位悄悄取消掉。适配器还记录 KV 缓存前缀失效（实测排第一的成本项），并给上下文溢出分类 —— 包括两种*静默*情形：运行时截短了提示词，以及超长提示词照收不误。这两件事都得先知道窗口有多大，而窗口是**向服务运行时问出来的**，不是配出来的：手工填进 `FABULA_CONTEXT_WINDOW` 的数字，模型一重新加载就过期了；而要是不填（这才是常态），分类根本不会触发。只有确实要覆盖时才去设它。

   诊断日志**有上限**：超过 `FABULA_ADAPTER_LOG_MAX`（20 MB），适配器把它复制一份到 `<path>.1`，再就地截断 —— 之所以就地，是因为 launchd 用 `O_APPEND` 打开了这个文件，改名只会让进程接着往没人读的地方写。客户端在保活连接上挂断，只记一行，不打整段堆栈；这本来就是件平常事，而这份日志正是有东西卡住时要求你第一个去读的。

5. **准入控制。** 这一类服务化模型一遇上并发预填充就会垮（下面有实测），而每一个会话、每一次后台流程、每一次见证调用，全都汇到这同一个适配器 —— 于是它把*推理*工作串起来，一件一件做（`FABULA_MAX_CONCURRENT_UPSTREAM`，默认 1；`0` 表示不限）。多出来的请求按 FIFO 排队；排队中的流式客户端会收到 SSE 注释形式的保活，而保活一旦把响应提交出去，上游报错就以带内 SSE 事件的形式传回来，不会再冒出第二行 HTTP 状态行。等待超过调用方的上限则**失效放行**（静默的调用方用 `FABULA_ADMIT_WAIT_MAX`，靠保活撑着的流式调用方用更长的 `FABULA_ADMIT_WAIT_MAX_STREAM`）—— 一道会把人卡死的门禁，还不如没有门禁。元数据（`GET /v1/models`，也就是应用的存活探针）和 embeddings 完全绕开队列。在这台机器上，拿四个互不相同的重预填充并发实测：**不串行 41.1s，串行 2.4s**；共享前缀已经热起来时，门禁开销约 0.15s（每个请求都要用互不相同的前缀 —— 拿共享前缀做样例，什么也测不出来）。门禁保证的是不会有请求一直排不上号；至于谁先谁后，那是上一层的事 —— 后台流程让位给前台工作，准入也把正在进行的一轮排在后台调用前面。

6. **实测出来的空闲预算。** 那个一刀切的 token 间超时，换成了按（模型，提示词大小分桶）算出来的预算，取值来自真实观察到的 *token 间间隔* —— 绝不用首 token 时延，那管的是另一个量 —— 再配上一个下限、一个来自环境变量的上限，冷启动时就等于原先那个常量。`FABULA_IDLE_BASELINE=0` 把常量放回去。

7. **缓存失效分类。** 失效遥测会说清楚前缀*为什么*断：是 `position-shift`（内容逐字节相同，只是位置挪了 —— 这是我们自己注入顺序的问题，日志会点出惹事的那个易变块），是 `content-break`，还是单纯的增长或收缩。`FABULA_CACHE_BREAK_CLASS=0` 把先前那一行放回去。

8. **等过忙碌的会话。** 有些运行时不是整体排队，而是按*会话*逐个排队：某个会话的这一轮还没跑完，第二个请求打过来，它就回 HTTP 409（`session … is already in flight`）。这是一种状态，不是故障：原样放过去，读者面前就会出现一张带「重试」按钮的红色错误卡片 —— 而这个状况一秒钟就自己过去了，跟他也毫无关系。适配器会以逐步拉长的间隔（0.25 秒起，翻倍到 4 秒封顶）重试建连，持续 `FABULA_BUSY_RETRY_WINDOW`（60 秒），此后 409 照旧原样送达 —— 等待不等于吞掉，一个忙了一分钟还没让开的会话，本身就是该让人看见的真问题。这和准入队列是同一个想法，只是低一层：队列是*我们*知道运行时忙的时候排队，而这里是*运行时自己*说忙的时候等。`FABULA_BUSY_RETRY_WINDOW=0` 恢复先前的行为。

**聊天流式响应逐 token 直通**（如今有看门狗守着）；只有*非流式*的结构化响应才会额外缓冲一下，再改写一遍。还有一个可选的**云提供商 —— NVIDIA**（OpenAI 兼容），供那个需显式开启的重步骤路由器使用（见 §4）。

### 1.3 应用 —— 原生 Swift / WKWebView 封装

`app/FabulaApp.swift` 是一层基于 **Swift + WKWebView** 的原生 macOS 封装。它把引擎的 Web UI 放进自己的应用窗口里 —— 有自己的图标，没有浏览器外框 —— 所以 FABULA 呈现出来的是一个独立的桌面应用，而不是浏览器里的一个页面。

### 1.4 插件 —— 能力层

智能体真正的那些能力（web 与文件工具、编排、多模态、运维、可靠性、安全）以一层 TypeScript **插件**的形式交付，放在 `plugin/` 下，由引擎加载，用 **bun** 执行。§2 和 §3 会细说。

---

## 2. 引擎插件模型

引擎会发现并加载插件文件，然后调用它们导出的函数。插件参与智能体循环的方式有两种：

- **工具注册** —— 插件返回一个 `tool` map，其中每一项（`name: tool({…})`）都成为模型可以调用的工具。
- **生命周期钩子** —— 插件返回钩子回调，引擎在循环里预先定好的位置触发它们。本代码库用到的钩子有：
  - `tool.execute.before` —— 在一次工具调用真正跑起来之前查看或改写它，也可以直接中止（在这里抛出异常就**中止**该工具 —— 这是通用的安全门禁兼循环守卫门禁）。
  - `tool.execute.after` —— 查看工具的结果，或者把它包起来（例如包住不可信输出）。
  - `chat.message` / `chat.params` —— 在调用模型之前调整消息或请求参数（例如把 system 消息合并成一条，或者注入精选记忆）。
  - `event` —— 对引擎事件作出反应（例如会话空闲、聊天删除）。

### 1.4 提供商目录在读取时才清洗

提供商和模型的列表在运行时来自一个外部注册表，构建期的品牌清洗够不到它 —— 实测下来，构建产物本身是干净的，设置 ▸ 提供商 里却仍旧挂着 FABULA 引擎 fork 自的那家厂商。`ModelsDev.get()` 只改写那一家厂商的显示名（它显示为 **Zen**）；提供商 ID、API URL 和环境变量名一律不动，这是有意为之：名字一改，用户存下来的凭据和模型选择就再也对不上号。真实的模型厂商从来不动 —— 它们的名字指向的是用户真能选中的模型。

### 2.0 代码智能：引擎的 `lsp` 工具

两个开关，在 FABULA 里默认都开着。`fabula.config.json` 里的 `"lsp": true` 启动语言服务器子系统（36 个服务器；TypeScript 服务器从项目自己的 `node_modules` 里解析），而 `MIMOCODE_EXPERIMENTAL_LSP_TOOL=1` —— 由应用在拉起 serve 时设置 —— 把 `lsp` 工具暴露给模型。引擎把这件工具当实验性功能门控，所以少了这个环境变量，它就悄无声息地不存在；`fabula-context` 里那条姿态提醒也挂在同一个变量上，道理正在于此：绝不能去建议一件根本不在的工具。

操作都是位置式的 —— `goToDefinition`、`findReferences`、`hover`、`documentSymbol`、`goToImplementation`，加上调用层级三件套 —— 接收 `file_path` + `line` + `character`。`workspaceSymbol` 是例外：它按名字搜索整个工作区，接收一个 `query` 而不接收位置，`file_path` 只当提示用。语言服务器要等到有人第一次用到某个文件才启动，所以冷会话里可能一个都没跑起来；这时候来问，工具会明说这一点，而不是回一个空列表 —— 「没人问过」和「没有这个符号」是两个不同的答案，只有后者才意味着符号确实不在。`GET /find/symbol` 同理，它会先把配好的服务器拉起来，再作答。

### 2.1 `plugin/` 与 `plugin/lib/` —— 一个刻意的拆分

**关键规则：** 引擎把 **`plugin/fabula-*.ts` 文件里每一个导出的函数都当成插件**，并且真的会去调用。这些文件里只要多出一个不是插件的导出，提供商和模型的加载就会坏掉。

因此：

- **`plugin/fabula-*.ts`** —— 每个文件**只**导出一个 `Fabula*` 插件工厂（例如 `FabulaTools`、`FabulaGraph`），别的什么都不导出。
- **`plugin/lib/*.ts`** —— 所有共享的纯辅助代码。引擎**不会**把 `lib/` 当插件扫描，所以路由、提供商、解析器、守卫这些辅助逻辑都住在这里，由插件文件导入。

---

## 3. 插件

一共 40 个插件，每个文件导出一个 `Fabula*` 工厂。下面这张表只挑了有代表性的一部分（始终开启的核心）；每个插件、每件工具的完整现况 —— 包括六个默认关闭的**证明经济**插件（`registry`、`witness`、`daemon`、`relay`、`coordinator`、`buddy`）—— 都在 [`docs/PLUGINS.zh-CN.md`](PLUGINS.zh-CN.md) 里，那份文档由清单生成。

| 插件（文件）                | 工厂                 | 职责 |
|----------------------------|---------------------|----------------|
| `fabula-tools.ts`          | `FabulaTools`       | **核心工具带**：`web_fetch`（URL→markdown，含 PDF）、`web_search` + `image_search`（经 SearXNG MCP）、`bash_tool` / `execute_code`（跑 shell 和代码；`execute_code` 优先用 Docker 容器，没有就回落到 macOS 内核配置档，而当调用方明确要求隔离时，它宁可*拒绝*也不降级）、`view` / `str_replace` / `create_file` / `note_append`（文件操作）、`present_files`、`verify_done`、`weather_fetch`、`places_search`、`mixture_of_agents`（扇出到 N 个模型再综合）、`session_search`、`save_skill`、`cost_report`、`batch_run`、`search_mcp_registry`、`suggest_connectors`、`recommend_LLM_apps`、`fetch_sports_data`。 |
| `fabula-graph.ts`          | `FabulaGraph`       | **`workflow_graph`** 编排器：规划器 → 至多 5 个隔离子任务 → 综合，另配一个需显式开启的本地→云路由器。步骤之间的那条边是一份契约 —— 某一步什么都没产出，下游拿到的就是一个明确的「缺失」；凡有截断，就明写出来；输出不可用就重试一次，再不行标记为空 —— 而且每一步都共用同一个开头块，服务端缓存因此能复用。`workflow_graph` 是轻量的单遍编排器；引擎自带的 `workflow` 工具才是完整的那一个 —— 带类型的契约、条件路由、收敛循环。见 §4。 |
| `fabula-handoff.ts`        | `FabulaHandoff`     | 步骤之间、会话之间持久保存的结构化**交接产物**：`save_handoff` / `read_handoff` / `list_handoffs`。存之前先过威胁扫描，并且有大小上限。 |
| `fabula-reliability.ts`    | `FabulaReliability` | **循环守卫**，把反复无进展的工具调用硬停下来（在 `tool.execute.before` 里抛出异常）；工具参数**修复**；经 ntfy 的**出站推送通知**；以及可选的简短角色前言，给 actor 子智能体用（`FABULA_SOULS=1`）。 |
| `fabula-security.ts`       | `FabulaSecurity`    | **SSRF 守卫**、**密钥脱敏**、**不可信结果包裹**（提示词注入防御，走 `tool.execute.after`），以及命令与审批守卫（走 `tool.execute.before`）。 |
| `fabula-context.ts`        | `FabulaContext`     | **精选记忆注入**，以及给严格端点用的 **system 消息合一**（有些端点不接受多于一条 system 消息）。 |
| `fabula-ops.ts`            | `FabulaOps`         | 靠 macOS **launchd** 撑起来的**调度**：`schedule_task` / `list_scheduled` / `cancel_scheduled`，一本带逾期检测的运行台账，还有 `send_notification`。 |
| `fabula-vision.ts`         | `FabulaVision`      | 图像输入管路（`sync_model_vision`）—— 为当前模型门控并开启视觉能力。 |
| `fabula-multimodal.ts`     | `FabulaMultimodal`  | 多模态工具：`vision_analyze`（图像输入）、`text_to_speech`（经 **piper** 的 TTS）、`transcribe_audio`（经 **faster-whisper** 的 STT）。 |
| `fabula-browser.ts`        | `FabulaBrowser`     | **浏览器自动化**：`browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_scroll` / `browser_vision` / `browser_press` / `browser_get_images` / `browser_console` / `browser_cdp` / `browser_close` 等等。 |
| `fabula-readfloor.ts`      | `FabulaReadFloor`   | 把偏小的**默认读取上限**抬高，免得读文件时截得太狠。 |
| `fabula-distill-guard.ts`  | `FabulaDistillGuard`| 在未审查的模型上**拦下这套框架的自动自我改进（distill）流程**。 |
| `fabula-purge-hook.ts`     | `FabulaPurgeHook`   | 把已删除聊天留下的产物**彻底清干净**（走聊天删除的 `event` 钩子）。 |
| `fabula-manage.ts`         | `FabulaManage`      | **插件管理器**：`list_plugins`（状态 + 依赖健康状况）、`enable_plugin` / `disable_plugin`、`check_deps` / `install_plugin_deps`。应用内的 设置 ▸ 插件 面板和菜单栏的 Plugins 菜单都靠它撑着；它自己从不受门控。 |

---

## 4. Workflow-Graph 编排器

`fabula-graph.ts` 只暴露一件工具 —— **`workflow_graph`**，专门对付那些一遍走完效果不好的多部分任务。它的流水线是这样的：

1. **规划。** 规划器产出一张图，上面是**至多 5 个隔离子任务**，彼此的依赖关系都写明。
2. **隔离运行。** 每个步骤都作为一次**单独隔离的模型调用**跑起来，喂给它的只有：
   - 它声明的那些依赖产出的结果，
   - 一段简短的**角色前言**，以及
   - 一个 `STOP` 哨兵。
   步骤既然是隔离的，就不会继承整段对话 —— 它拿到的正好是所需的那点上下文；至于答案落在哪里，适配器那层推理转写保证它落在 `content` 里，模型处于哪种推理模式都一样。
3. **并行扇出。** 步骤按**依赖层级**运行：同一层里互不依赖的步骤并行跑。
4. **综合。** 各步骤的输出汇成最终答案，后面再附一小段轨迹。

**默认本地优先。** 每个步骤都打在本地模型上（`localhost:1235/v1`）。可调项：`FABULA_GRAPH_URL`、`FABULA_GRAPH_MODEL`、`FABULA_GRAPH_TIMEOUT_MS`。

### 4.1 需显式开启的本地→云路由器（`FABULA_ROUTER`）

路由器（`plugin/lib/router.ts`）**需显式开启**，**默认是关的**（`FABULA_ROUTER=0`）。一旦开启（`FABULA_ROUTER=1`）**并且**配好了云提供商，路由器就逐个步骤地看（例如按 `FABULA_ROUTER_HEAVY_CHARS`），把「重」的步骤**升到云模型**上去做，轻的步骤留在本地。要是根本没有可用的云提供商，那就全都留在本地。最终那段轨迹里会注明路由器当时是开是关。

---

## 5. 横切关注点

这些东西*横跨*各个工具运行，本身不是工具，主要靠生命周期钩子实现。

- **可靠性**（`fabula-reliability.ts`）：**循环守卫**盯着那些反复出现的无进展调用和失败调用，在 `tool.execute.before` 里抛出异常，把它们**硬中止**掉 —— 劝告式的停止信号，插槽里换上任何一个模型都可能不理它，所以守卫把这一停做成确定性的。此外还有**工具参数修复**、空闲或出错时经 **ntfy** 的推送通知，以及可选的 actor 角色前言（`FABULA_SOULS=1`）。

- **安全**（`fabula-security.ts`）：出站抓取上的 **SSRF 守卫**、**密钥脱敏**、在 `tool.execute.after` 里把**不可信结果包起来**（于是工具输出只当数据看，不当指令看 —— 这就是提示词注入防御），以及 `tool.execute.before` 里的命令与审批守卫。交接插件还会对存下来的产物做**威胁扫描并设上限**。

- **运维**（`fabula-ops.ts`）：经 macOS **launchd** 的持久**调度**（`schedule_task` / `list_scheduled` / `cancel_scheduled`）、一本带逾期检测的**运行台账**，以及原生**通知**。

---

## 6. 配置与依赖要求

### 配置

- 把 **`fabula.config.example.json` 复制成 `fabula.config.json`**（引擎、模型、MCP、插件的接线都在这儿）。
- 把 **`.env.example` 复制成 `.env`**，然后填好。
- **密钥只放 `.env` / `*.key`**（这两者都在 gitignore 里）—— 绝不写进提交上去的配置。
- 关键环境变量都是 **`FABULA_*`** 这一族，`.env.example` 里有说明，例如：`FABULA_ROUTER`、`FABULA_ROUTER_HEAVY_CHARS`、`FABULA_GRAPH_URL`、`FABULA_GRAPH_MODEL`、`FABULA_GRAPH_TIMEOUT_MS`、`FABULA_SOULS`、`FABULA_NTFY_TOPIC` / `FABULA_NTFY_URL`、`FABULA_VISION_*`、`FABULA_PIPER_*`、`FABULA_WHISPER_PYTHON`、`FABULA_CODE_SANDBOX`、`FABULA_MOA_ENDPOINTS`、`FABULA_SKILLS_DIR`。

### 依赖要求

- **macOS**
- **引擎 CLI**（`fabula` —— `build.sh` 会把它构建到仓库本地的 `bin/fabula`；`setup.sh` 装一个 `fabula` 包装脚本去运行它）
- **LM Studio**（本地模型）**+ `:1235` 适配器**（`proxy/lmstudio-adapter.py`）
- **bun** —— 用来运行 TypeScript 插件
- *可选：* **Docker** —— 沙箱化代码执行
- *可选：* **Python** —— 适配器和一些 MCP 服务器
- *可选：* 一个 **SearXNG** 实例 —— 用于 `web_search` / `image_search`
- *可选：* 一个**云提供商（NVIDIA）** —— 仅用于需显式开启的重步骤路由器
