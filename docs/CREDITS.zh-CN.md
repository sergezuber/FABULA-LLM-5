# 致谢

[English](CREDITS.md) · [中文](CREDITS.zh-CN.md) · [Русский](CREDITS.ru.md)

FABULA 引擎脱胎于 **MiMoCode** 框架（OpenCode 的一个分支）。在它之上的一切——`fabula-*` 插件和它们带来的工具——都是 FABULA 借引擎的插件钩子写出来的**本地优先实现**，为的就是跑在你自己的机器上、用你自己的模型。

本文逐项交代：每项能力**是什么**、在本仓库的**哪个位置**，以及最要紧的一条——**怎么在跑起来的应用里亲眼看到它确实存在**。

---

## 怎么在应用里看到这些功能

功能有四种露面的方式。有的看得见；有的体现在行为上——你看到的是智能体怎么做，而不是某个按钮。

| 在哪里 | 你看到什么 | 示例 |
|---|---|---|
| **插件面板**（设置 → *插件*） | 每一个加载好的 `fabula-*` 插件，绿色代表健康 | `40 Plugins` 那份清单里，`fabula-graph`、`fabula-handoff`、`fabula-ops` … 都在跑 |
| **聊天里的工具调用** | 模型按名字调用工具 | `workflow_graph`、`save_handoff`、`schedule_task`、`mixture_of_agents`、`vision_analyze`、`text_to_speech` |
| **工作流轨迹** | `workflow_graph` 回答末尾的那几行 | `workflow: 2 isolated step(s)` → `s1(research, cloud) → s2(synthesize, local)` |
| **行为性的（钩子 / 需自行开启）** | 智能体的*做法*变了，界面上没有对应的元素 | 模型想反复读同一个文件，这套框架会把它拦下来；网页结果回来时外面裹着 `<untrusted_tool_result>`；一次运行跑完，手机就收到推送 |

**需自行开启的功能已经加载好，但一直休眠，直到你在 `.env` 里设上对应的环境变量**：`FABULA_ROUTER`、`FABULA_SOULS`、`FABULA_NTFY_TOPIC`。设之前插件就在那儿（面板里显示绿色），只是行为不生效。

---

## MiMoCode / OpenCode——FABULA 引擎的出处

**是什么：** FABULA-LLM-5 跑在它上面的那层底座——智能体循环、插件系统（每个 `fabula-*` 插件都接在 `tool.execute.*`、`chat.*`、`experimental.chat.system.transform` 这几个钩子上）、支持任意多家提供商的模型层（OpenAI 兼容的提供商）、web UI，以及 MCP 支持。**为什么：** 智能体循环、插件钩子、多提供商层、web UI 和 MCP 支持，在那边都已经过生产环境的打磨；MiMoCode 是一个成熟的 OpenCode 分支，扩展点恰好正是我们需要的——所以 FABULA 引擎就建在它上面。**在哪里：** 到处都是——`fabula.config.json`、`plugin/fabula-*.ts` 这些文件，还有 macOS 应用内嵌承载的那套 web UI。**怎么看到：** 应用承载的就是引擎的 web UI；设置里的几个面板——连接器（MCP）、权限、插件——都是它自带的。

---

## pi——我们研究并借鉴过的监督机制

**是什么：** [pi](https://github.com/earendil-works/pi)（Mario Zechner 作，MIT 许可）是一个极简的编码智能体框架，它的工程记录塑造了 FABULA 的好几处监督机制。本仓库里的实现都是 FABULA 自己写的——语言不同、引擎不同、这里另有单元测试——但下面这些*机制设计*要追溯到 pi，功劳该归它：

| 机制（源自 pi） | FABULA 的实现 |
|---|---|
| 跨提供商的会话重放：把工具调用 id 规范化、重新映射，为配不上结果的调用补一个结果，跳过出错的轮次（对应 pi 的 `transform-messages`） | `plugin/lib/xprovider.ts`，接进 `plugin/fabula-escalate.ts` |
| 上下文溢出分类，*静默*截断也算在内（pi `overflow.ts` 的那张模式矩阵） | `proxy/adapter_util.py` → `classify_overflow`，接进 `:1235` 适配器 |
| 前缀缓存遥测：稳定的提示词前缀什么时候断了、KV 缓存什么时候没命中，都能看出来（pi 的 cache-stats） | `proxy/adapter_util.py` → `stable_prefix` / `shared_prefix_len`（`CACHE-BREAK` 日志） |
| 有上界的工具输出：超大结果先封顶，完整文本溢写到文件，再返回一个续读游标 | `plugin/lib/outputcap.ts`，接进 `bash_tool` |
| 容得下漂移的编辑：把弯引号、破折号、unicode 空格、BOM 都归一化，差一点点的编辑照样能落上去 | `plugin/lib/fuzzymatch.ts`（`unicode` 归一化器） |
| 失败之后回退会话——pi 回退的是会话；FABULA 把这个想法往两头都推了一步：一是把文件原子地退回最后一个通过的影子 git 检查点，二是回退会话树，把失败的那一段折叠掉，让重试从干净的上下文重新开始 | `plugin/fabula-rewind.ts` + `plugin/lib/rewind.ts` |
| 按任务精简工具暴露面（一条编码用的「工具带」，把不相干的工具收起来） | `plugin/lib/toolbelt.ts` + `plugin/lib/toolmeta.ts`（`FABULA_PROFILE=coding`） |

**为什么：** pi 拿测量数据说清了一件事：让智能体变可靠的，是一小组确定性的框架机制，而不是更大的模型。这也是 FABULA 的论点，所以我们把其中最硬的几条接了过来，又往前推了一步（文件级原子回退、内核级沙箱、自己会触发的门禁）。

---

## 可靠性、安全、已验证完成、运维

| 能力 | 在哪里 | 怎么确认它确实存在 |
|---|---|---|
| **循环守卫**（重复的、没有进展的工具调用，直接叫停） | `fabula-reliability` + `lib/loopguard.ts` | 给插槽里的任何模型一个它会绕圈的任务（比如反复读同一个文件）。几次一模一样、毫无进展的调用之后，它不会一直绕下去，这套框架会**把它叫停**，同时给出下一步该怎么走。 |
| **工具参数修复**（结构畸形、多带了键的调用照样能执行） | `fabula-reliability` + `lib/argrepair.ts` | 模型给出的 `actor` 或别的工具参数结构稍有出入，调用照样跑得起来，不会直接报错。 |
| **安全层**（SSRF 守卫、密钥脱敏、不可信结果包裹、命令与审批守卫） | `fabula-security` + `lib/*` | 让智能体 `web_fetch` 一个页面——结果回来时外层裹着 `<untrusted_tool_result>`；工具输出和日志里的密钥都做过脱敏；危险的 shell 命令要么直接拦住，要么得先过审批。 |
| **已验证完成**（一个步骤必须拿出自己干完了的证据） | `verify_done` 工具 + 图里每一步的 `verifyStep` | 一个步骤没交出实质内容——只有一句拒绝，或者把错误原样回显——就先重试一次，再不行标成降级，并且把这件事告诉综合器；失败的步骤绝不会当成数据往下游流。 |
| **能力工具与运维工具** | `fabula-ops`、`fabula-multimodal`、`fabula-vision` | 用到 `schedule_task`、`send_notification`、`vision_analyze`、`text_to_speech`、`transcribe_audio` 的时候，这些工具就出现在聊天里。 |

---

## 工作流图 + 本地→云端路由（本地优先）

工作流图是**本地优先**的：本地模型是默认的执行者，云端只是一条你自己决定要不要开的升级通道。

| 能力 | 在哪里 | 怎么确认它确实存在 |
|---|---|---|
| **带步骤隔离的工作流图**——规划器给出不超过 5 个子任务；每个子任务都作为一次隔离的模型调用来跑，喂给它的*只有*它所依赖的那几步的输出（外加一个角色和 STOP）；互不依赖的步骤并行跑；最后把结果综合起来 | `fabula-graph` → 工具 **`workflow_graph`**，逻辑在 `lib/graph.ts` | 拿一个分成好几块的任务调用 `workflow_graph`。回答末尾会带一段轨迹：`workflow: N isolated step(s)`，每个步骤占一行（`id(role, local/cloud, needs:[…])`）。插件面板里 `fabula-graph` 是绿的。 |
| **本地→云端路由**——规则逐步判断这一步是不是「重」到该交给云端模型 | `plugin/lib/router.ts`，由 `FABULA_ROUTER=1` 开启 | 设上 `FABULA_ROUTER=1` 和一个云端密钥，再跑一个带研究型步骤的工作流 → 轨迹里那一步会标成 `, cloud,`，轻的步骤仍然是 `, local,`。默认关着，只走本地。 |

---

## 自主智能体能力

这些能力都是本地优先的，也都要你自己开启。

| 能力 | 在哪里 | 怎么确认它确实存在 |
|---|---|---|
| **对外的 ntfy 事件推送**——运行结束、出错、循环守卫拦下的时候，往手机推一条 | `fabula-reliability`，由 `FABULA_NTFY_TOPIC` 开启 | 设上 `FABULA_NTFY_TOPIC=<topic>`，在 ntfy 应用里订阅。跑完一次运行，或者触发一次循环守卫的拦截 → 手机上就收到推送。 |
| **精选记忆注入**——把你的操作笔记写进系统提示词 | `fabula-context` | 模型知道你定的那些规矩（来自 `.fabula/memory/MEMORY.md`），不用每个会话再交代一遍。 |
| **调度器可靠性 + 运行台账**——周期性任务和一次性任务都走 macOS `launchd`，带逾期检测，也把结果记下来 | `fabula-ops` + `lib/heartbeat.ts`、`lib/schedule.ts` | 先 `schedule_task`，再 `list_scheduled`——每个任务后面都标着「last ran Xh ago / ⚠️ OVERDUE / never ran」。 |
| **角色前导语**——给子智能体加一小段按角色写的「这一步谁来跑 + STOP」前缀 | `plugin/lib/souls.ts`，由 `FABULA_SOULS=1` 开启 | 打开 `FABULA_SOULS=1` 之后，actor 子智能体前面会多出一小段角色与 STOP 前导语，插槽里换成哪个模型都不跑题。 |
| **耐久的交接产物**——步骤之间、会话之间的交接是结构化的，还过了威胁扫描 | `fabula-handoff` → `save_handoff` / `read_handoff` / `list_handoffs` | 用到这三个工具时，它们会出现在聊天里；`read_handoff` 交回的内容经过包裹和威胁扫描；插件面板里 `fabula-handoff` 是绿的。 |

---

## 关于上面这几张表

这几张表就是**功能文档**——每一项能力都是本地优先的实现，跑在你自己的机器上、用你自己的模型。MiMoCode / OpenCode 引擎采用 MIT/Apache 许可，我们遵守它的条款。
