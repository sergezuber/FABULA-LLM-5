# FABULA-LLM-5 —— 架构总览

[English](ARCHITECTURE.md) · [中文](ARCHITECTURE.zh-CN.md) · [Русский](ARCHITECTURE.ru.md)

FABULA-LLM-5 是一个**本地优先、面向 macOS 的自主编码智能体**。它默认把你的代码生成、
研究和自动化负载跑在**本地模型**上（通过 LM Studio），并提供一条**需显式开启**的升级
通道，把重活交给云端提供商。整套东西被打包成原生 `.app`，因此它的外观和行为像一个
一等公民的桌面应用，而不是浏览器里的一个标签页。

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

**FABULA 引擎**（CLI：`fabula`；派生自一个上游引擎 —— 见
[CREDITS](CREDITS.zh-CN.md)）拥有智能体循环：提示词组装、工具分发、聊天
会话存储、Web UI，以及插件运行时。所有智能体行为都通过 `fabula.config.json` 配置 ——
这是引擎的配置文件名（一个引擎级契约，为兼容性而保留）。把
`fabula.config.example.json` 复制为 `fabula.config.json` 并填好内容，就得到一份
可用的配置。

### 1.2 模型 —— 通过 `:1235` 适配器做到本地优先

模型由 **LM Studio 在本地提供服务**，它自己的服务端口是 `localhost:1234` —— 但 FABULA 里
没有任何东西把推理发到那里。每一次推理调用都发往 `:1235` 上的适配器；原始端口只在读取
原生元数据 API（`/api/v0/models`）时才用到，适配器不代理它，而它也不是推理。`LMSTUDIO_URL`
会覆盖推理端点，除非你要指向另一台机器上的适配器，否则应保持为空 —— 把它设成 `:1234` 会悄悄
关掉转换、准入门禁、两个看门狗以及输出钳制，而且不会响亮地报错，因为 `:1234` 对一次普通的
chat 调用会返回 200。外壳**不会**直接和 LM Studio 对话。它指向的是 `localhost:1235` 上一个
小小的 Python **兼容适配器**（`proxy/lmstudio-adapter.py`），它代理到 LM Studio，并做下面
这些事情，好让*结构化输出*和*工具调用*可靠工作 —— 同时让并发、停顿和缓存失效都在每个
请求必经的这一个点上受到治理：

1. **`json_object` → `json_schema`。** Vercel AI SDK（在引擎内部）为 `generateObject` 发出
   旧版 OpenAI 的 `response_format: {type:"json_object"}` 模式。LM Studio 用 **HTTP 400**
   拒绝该模式 —— 它只接受 `json_schema` 或 `text`。适配器把请求改写成**宽松的**
   `{type:"json_schema", json_schema:{…, additionalProperties:true}}`，这样每个结构化调用方
   都能拿到*属于它自己*那种形状的合法 JSON（每次调用的 schema 放在提示词里，而不是请求体里）。
   想要特定语法的调用方通过 `X-Fabula-Schema` 请求头显式选择（目标裁判用它钉住自己严格的
   判定形状）。

2. **`reasoning_content` → `content`。** 当一个推理模型 —— 整整一类服务化模型都会这样 —— 把
   `content` 留空、把真正的 JSON 答案放进 `reasoning_content` 时，AI SDK 无法解析它。对于
   非流式响应，适配器会检测到这一点并把 `reasoning_content` 复制进 `content`。

3. **停顿看门狗 + 输出上限。** 单次上游调用可能陷入螺旋或挂死，几分钟里吐不出一个
   token。每次读取都带一个**不活动超时**，它有一个首 token
   （预填充）预算，一旦第一个字节到达就降为更小的 token 间预算 ——
   流式和非流式路径*都*适用。停顿的上游会被中止（如果是在第一个字节之前停顿则重试一次，
   否则干净地结束），而不是把这一轮卡死；`FABULA_MAX_OUTPUT_TOKENS` / `FABULA_CONTEXT_WINDOW`
   钳制失控的生成。这是"外壳高于模型"这一论点在传输层上的表达。

4. **声明式推理档位控制（需显式开启）+ 遥测。** 一张配置表
   （`proxy/reasoning-map.json`）可以在提供了档位时（`X-Fabula-Reasoning` / 环境变量），
   按模型/档位给请求的推理旋钮打补丁；某个模型未定义的档位会**按档位**回落到 `*` 表，
   因此为某个模型新增一个档位不会悄悄取消其他档位。适配器还会记录 KV 缓存前缀失效
   （实测排名第一的成本），并对上下文溢出分类 —— 包括两种*静默*情况：提示词被截断，以及
   超长提示词被毫无怨言地接受。这些都需要知道窗口大小，而窗口是**向服务运行时询问的**，
   不是配置出来的：手工填进 `FABULA_CONTEXT_WINDOW` 的数字在模型第一次重新加载时就过期了，
   而如果不设（正常情况），分类根本不会触发。只在需要覆盖时才设置它。

   诊断日志是**有界的**：超过 `FABULA_ADAPTER_LOG_MAX`（20 MB）后，适配器把它复制到
   `<path>.1` 并就地截断 —— 之所以就地，是因为 launchd 以 `O_APPEND` 打开了那个文件，
   重命名它会让进程继续写到没人读的地方。客户端在保活连接上挂断只用一行来报告，而不是一整段
   堆栈；它是一个普通事件，而这份日志正是有东西挂住时要求你首先去读的那一份。

5. **准入控制。** 这类服务化模型在并发预填充下会崩塌（下面有实测），而每一个会话、
   后台流程和见证者调用都汇聚到这同一个适配器 —— 因此它把*推理*工作串行化
   （`FABULA_MAX_CONCURRENT_UPSTREAM`，默认 1；`0` = 不限）。多出来的请求按 FIFO 排队；
   排队中的流式客户端会收到 SSE 注释形式的保活，而一旦这些保活提交了响应，上游错误就会
   作为带内 SSE 事件传出，而不是第二行 HTTP 状态行。等待超过调用方的上限则**失效放行**
   （静默调用方用 `FABULA_ADMIT_WAIT_MAX`，靠保活撑着的流式调用方用更长的
   `FABULA_ADMIT_WAIT_MAX_STREAM`）—— 一个会阻塞的门禁比没有门禁更糟。元数据
   （`GET /v1/models`，应用的存活探针）和 embeddings 完全绕过队列。在这台硬件上用四个并发的
   *互不相同*的重预填充实测：**未串行化 41.1s，串行化 2.4s**；在共享前缀已热的情况下门禁
   开销约 0.15s（每个请求用互不相同的前缀 —— 共享前缀的样例什么也测不出来）。门禁限制的是
   饥饿；优先级在上一层 —— 后台流程让位于前台工作，而准入把活跃的轮次排在后台调用之前。

6. **实测空闲预算。** 扁平的 token 间超时被按
   （模型，提示词大小分桶）替换为一个源自真实观察到的 *token 间间隔*的预算 ——
   绝不用首 token 时延，那管的是另一个量 —— 并带有一个下限、
   一个环境变量上限，以及等于该扁平常量的冷启动值。`FABULA_IDLE_BASELINE=0`
   恢复为常量。

7. **缓存失效分类。** 失效遥测会说明前缀*为什么*断了：
   `position-shift`（逐字节相同、只是位置移动了的内容 —— 我们自己的注入顺序问题，
   并且会点名那个惹事的易变块）对比 `content-break`，再对比增长/收缩。
   `FABULA_CACHE_BREAK_CLASS=0` 恢复为先前那一行。

**聊天流式响应逐 token 直通**（现在有看门狗守着）；只有*非流式*的结构化响应会被额外缓冲
并改写。一个可选的**云提供商 —— NVIDIA**（OpenAI 兼容）—— 可用于那个需显式开启的重步骤
路由器（见 §4）。

### 1.3 应用 —— 原生 Swift / WKWebView 封装

`app/FabulaApp.swift` 是一个基于 **Swift + WKWebView** 构建的原生 macOS 封装。它把引擎的
Web UI 托管在它自己的应用窗口里 —— 有自己的图标，没有浏览器外框 —— 因此
FABULA 呈现为一个独立的桌面应用，而不是浏览器里的一个页面。

### 1.4 插件 —— 能力层

智能体的实际能力（web/文件工具、编排、多模态、运维、可靠性、安全）以一层 TypeScript
**插件**的形式交付，位于 `plugin/` 下，由引擎加载并用 **bun** 执行。它们在 §2 和 §3 中详述。

---

## 2. 引擎插件模型

引擎会发现并加载插件文件，并调用它们导出的函数。插件以两种方式参与智能体循环：

- **工具注册** —— 插件返回一个 `tool` map；每一项（`name: tool({…})`）
  都会成为模型可以调用的工具。
- **生命周期钩子** —— 插件返回钩子回调，引擎会在循环中定义好的位置触发它们。本代码库
  中用到的钩子包括：
  - `tool.execute.before` —— 在工具调用运行前检查/改写/中止它（在这里抛出会
    **中止**该工具 —— 这是通用的安全/循环守卫门禁）。
  - `tool.execute.after` —— 检查/包裹工具的结果（例如包裹不可信输出）。
  - `chat.message` / `chat.params` —— 在模型被调用之前调整消息或请求参数
    （例如合并 system 消息、注入精选记忆）。
  - `event` —— 对引擎事件作出反应（例如会话空闲、聊天删除）。

### 1.4 提供商目录在读取时被清洗

提供商与模型的列表在运行时来自一个外部注册表，因此构建期的品牌清洗够不到它 —— 实测中，
构建产物是干净的，而 设置 ▸ 提供商 里仍然显示着 FABULA 引擎所 fork 自的那个厂商。
`ModelsDev.get()` 只改写那一个厂商的显示名（它显示为 **Zen**）；提供商 ID、API URL 和
环境变量名有意保持不变，因为重命名它们会让用户已保存的凭据和模型选择变成孤儿。真实的
模型厂商永远不会被改动 —— 它们的名字标识的是用户真的能选到的模型。

### 2.0 代码智能：引擎的 `lsp` 工具

两个开关，在 FABULA 里默认都是开的。`fabula.config.json` 中的 `"lsp": true` 会启动语言服务器
子系统（36 个服务器；TypeScript 服务器从项目自己的 `node_modules` 中解析），而
`MIMOCODE_EXPERIMENTAL_LSP_TOOL=1` —— 由应用在其 serve 启动时设置 —— 把 `lsp` 工具暴露给
模型。引擎把该工具作为实验性功能门控，因此没有这个环境变量它就悄无声息地不存在，这也是
为什么 `fabula-context` 中的姿态提醒被同一个变量门控：它绝不能建议一个并不存在的工具。

操作是位置式的 —— `goToDefinition`、`findReferences`、`hover`、`documentSymbol`、
`goToImplementation`，以及调用层级三件套 —— 并接收 `file_path` + `line` + `character`。
`workspaceSymbol` 是例外：它按名字搜索整个工作区，接收一个 `query` 而不接收位置，且
`file_path` 只作为提示接受。语言服务器在某个文件第一次被使用时才启动，因此在冷会话里可能
一个都没在跑；此时被问到，工具会明确说出这一点，而不是返回一个空列表，因为「没有问过」和
「没有这个符号」是两个不同的答案，而只有其中一个意味着符号确实不存在。同样的道理适用于
`GET /find/symbol`，它会先把已配置的服务器拉起来再作答。

### 2.1 `plugin/` 与 `plugin/lib/` —— 一个刻意的拆分

**关键规则：** 引擎把 **`plugin/fabula-*.ts` 文件里每一个导出的函数都当作插件**，并且会
调用它。这些文件里出现一个多余的非插件导出，会破坏提供商/模型的加载。

因此：

- **`plugin/fabula-*.ts`** —— 每个文件**恰好**导出一个 `Fabula*` 插件工厂
  （例如 `FabulaTools`、`FabulaGraph`），**别无他物**。
- **`plugin/lib/*.ts`** —— 所有共享的、纯粹的辅助代码。引擎**不会**把 `lib/` 当作插件
  扫描，因此辅助逻辑（路由、提供商、解析器、守卫）住在这里，由插件文件导入。

---

## 3. 插件

一共有 40 个插件。每个文件导出一个 `Fabula*` 工厂。下面这张表是一个有代表性的
子集（始终开启的核心）；每个插件和工具的完整、最新的全景图 —— 包括六个默认关闭的
**证明经济**插件（`registry`、`witness`、`daemon`、`relay`、`coordinator`、
`buddy`）—— 位于 [`docs/PLUGINS.zh-CN.md`](PLUGINS.zh-CN.md)，由清单生成。

| 插件（文件）                | 工厂                 | 职责 |
|----------------------------|---------------------|----------------|
| `fabula-tools.ts`          | `FabulaTools`       | **核心工具带**：`web_fetch`（URL→markdown，含 PDF）、`web_search` + `image_search`（经 SearXNG MCP）、`bash_tool` / `execute_code`（shell 与代码；`execute_code` 优先使用 Docker 容器，回落到 macOS 内核配置档，并且在明确要求隔离时宁可*拒绝*也不降级）、`view` / `str_replace` / `create_file` / `note_append`（文件操作）、`present_files`、`verify_done`、`weather_fetch`、`places_search`、`mixture_of_agents`（扇出到 N 个模型再综合）、`session_search`、`save_skill`、`cost_report`、`batch_run`、`search_mcp_registry`、`suggest_connectors`、`recommend_LLM_apps`、`fetch_sports_data`。 |
| `fabula-graph.ts`          | `FabulaGraph`       | **`workflow_graph`** 编排器：规划器 → ≤5 个隔离子任务 → 综合，带一个需显式开启的本地→云路由器。步骤之间的边是一个契约 —— 什么都没产出的步骤以缺失的形式抵达，截断会自我声明，不可用的输出重试一次后被标记为空 —— 而且每个步骤共享同一个开头块，因此服务端缓存得以复用。`workflow_graph` 是轻量的单遍编排器；引擎自己的 `workflow` 工具才是完整的那个 —— 带类型的契约、条件路由、收敛循环。见 §4。 |
| `fabula-handoff.ts`        | `FabulaHandoff`     | 步骤/会话之间持久的结构化**交接产物**：`save_handoff` / `read_handoff` / `list_handoffs`。经过威胁扫描并有大小上限。 |
| `fabula-reliability.ts`    | `FabulaReliability` | **循环守卫**，硬停止反复无进展的工具调用（在 `tool.execute.before` 中抛出）、工具调用参数**修复**、**经 ntfy 的出站推送通知**，以及可选的、给 actor 子智能体用的简短角色前言（`FABULA_SOULS=1`）。 |
| `fabula-security.ts`       | `FabulaSecurity`    | **SSRF 守卫**、**密钥脱敏**、**不可信结果包裹**（提示词注入防御，经 `tool.execute.after`），以及命令/审批守卫（经 `tool.execute.before`）。 |
| `fabula-context.ts`        | `FabulaContext`     | **精选记忆注入**，以及面向严格端点的 **system 消息合并为一条**（有些端点拒绝多于 1 条 system 消息）。 |
| `fabula-ops.ts`            | `FabulaOps`         | 由 macOS **launchd** 支撑的**调度**：`schedule_task` / `list_scheduled` / `cancel_scheduled`、一个带逾期检测的运行台账，以及 `send_notification`。 |
| `fabula-vision.ts`         | `FabulaVision`      | 图像输入管道（`sync_model_vision`）—— 为当前模型门控/启用视觉能力。 |
| `fabula-multimodal.ts`     | `FabulaMultimodal`  | 多模态工具：`vision_analyze`（图像输入）、`text_to_speech`（经 **piper** 的 TTS）、`transcribe_audio`（经 **faster-whisper** 的 STT）。 |
| `fabula-browser.ts`        | `FabulaBrowser`     | **浏览器自动化**：`browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_scroll` / `browser_vision` / `browser_press` / `browser_get_images` / `browser_console` / `browser_cdp` / `browser_close` 等。 |
| `fabula-readfloor.ts`      | `FabulaReadFloor`   | 抬高偏小的**默认读取上限**，让文件读取不至于被过于激进地截断。 |
| `fabula-distill-guard.ts`  | `FabulaDistillGuard`| 在未审查的模型上**阻止外壳的自动自我改进（"distill"）流程**。 |
| `fabula-purge-hook.ts`     | `FabulaPurgeHook`   | 对已删除聊天的产物做**彻底清除**（经聊天删除的 `event` 钩子）。 |
| `fabula-manage.ts`         | `FabulaManage`      | **插件管理器**：`list_plugins`（状态 + 依赖健康状况）、`enable_plugin` / `disable_plugin`、`check_deps` / `install_plugin_deps`。它支撑应用内的 设置 ▸ 插件 面板以及菜单栏的 Plugins 菜单；自身从不被门控。 |

---

## 4. Workflow-Graph 编排器

`fabula-graph.ts` 暴露单一工具 **`workflow_graph`**，用于那些单遍处理得不好的多部分任务。
它的流水线：

1. **规划。** 规划器产出一张由**≤5 个隔离子任务**组成的图，并声明彼此的
   依赖关系。
2. **隔离运行。** 每个步骤作为一次**独立的、隔离的模型调用**运行，只由以下内容
   播种：
   - 它所声明的依赖的输出，
   - 一段简短的**角色前言**，以及
   - 一个 `STOP` 哨兵。
   因为步骤是隔离的，它们不会继承完整的对话 —— 它们拿到的正好是所需要的
   上下文；适配器的推理垫片保证答案落在 `content` 里，无论模型处于哪种推理模式。
3. **并行扇出。** 步骤按**依赖层级**运行：同一层级中互不依赖的步骤
   并行运行。
4. **综合。** 各步骤的输出被综合成最终答案，并附上一段简短的
   轨迹。

**默认本地优先。** 每个步骤都跑在本地模型上
（`localhost:1235/v1`）。可调项：`FABULA_GRAPH_URL`、`FABULA_GRAPH_MODEL`、
`FABULA_GRAPH_TIMEOUT_MS`。

### 4.1 需显式开启的本地→云路由器（`FABULA_ROUTER`）

路由器（`plugin/lib/router.ts`）**需显式开启**，且**默认关闭**
（`FABULA_ROUTER=0`）。当它被启用（`FABULA_ROUTER=1`）**并且**配置了云提供商时，
路由器会检查每个步骤（例如通过 `FABULA_ROUTER_HEAVY_CHARS`）并把"重"步骤
**升级到云模型**，同时把轻步骤留在本地。如果没有可用的云提供商，一切都留在本地。最终的
轨迹会注明路由器当时是否为 ON。

---

## 5. 横切关注点

这些是*横跨*工具运行的，而不是工具本身，主要通过生命周期
钩子实现。

- **可靠性**（`fabula-reliability.ts`）：**循环守卫**检测反复的
  无进展/失败工具调用，并通过在 `tool.execute.before` 中抛出来**硬中止**它们 ——
  一个建议性的停止信号是插槽中的任何模型都可以忽略的，因此守卫把这个停止变成
  确定性的。此外还提供**工具调用参数修复**、空闲/出错时的 **ntfy** 推送通知，以及可选的
  actor 角色前言（`FABULA_SOULS=1`）。

- **安全**（`fabula-security.ts`）：出站抓取上的 **SSRF 守卫**、**密钥
  脱敏**、在 `tool.execute.after` 中的**不可信结果包裹**（这样工具输出被当作
  数据而不是指令 —— 提示词注入防御），以及在 `tool.execute.before` 中的命令/审批
  守卫。交接插件还会对存储的产物做**威胁扫描并设上限**。

- **运维**（`fabula-ops.ts`）：经 macOS **launchd** 的持久**调度**
  （`schedule_task` / `list_scheduled` / `cancel_scheduled`）、一个带逾期检测的
  **运行台账**，以及原生**通知**。

---

## 6. 配置与依赖要求

### 配置

- 把 **`fabula.config.example.json` 复制为 `fabula.config.json`**（引擎/模型/MCP/插件的接线）。
- 把 **`.env.example` 复制为 `.env`** 并填好内容。
- **密钥只放在 `.env` / `*.key` 中**（两者都已被 gitignore 忽略）—— 绝不放进被提交的配置。
- 关键环境变量是 **`FABULA_*`**，记录在 `.env.example` 中，例如：
  `FABULA_ROUTER`、`FABULA_ROUTER_HEAVY_CHARS`、`FABULA_GRAPH_URL`、`FABULA_GRAPH_MODEL`、
  `FABULA_GRAPH_TIMEOUT_MS`、`FABULA_SOULS`、`FABULA_NTFY_TOPIC` / `FABULA_NTFY_URL`、
  `FABULA_VISION_*`、`FABULA_PIPER_*`、`FABULA_WHISPER_PYTHON`、`FABULA_CODE_SANDBOX`、
  `FABULA_MOA_ENDPOINTS`、`FABULA_SKILLS_DIR`。

### 依赖要求

- **macOS**
- **引擎 CLI**（`fabula` —— 由 `build.sh` 构建到仓库本地的 `bin/fabula`；`setup.sh` 会安装一个运行它的 `fabula` 包装器）
- **LM Studio**（本地模型）**+ `:1235` 适配器**（`proxy/lmstudio-adapter.py`）
- **bun** —— 用来运行 TypeScript 插件
- *可选：* **Docker** —— 沙箱化代码执行
- *可选：* **Python** —— 适配器和一些 MCP 服务器
- *可选：* 一个 **SearXNG** 实例 —— 用于 `web_search` / `image_search`
- *可选：* 一个**云提供商（NVIDIA）** —— 仅用于需显式开启的重步骤路由器
