<div align="center">

# FABULA

**让小型本地模型完成困难任务、并且拿出证明的智能体外壳。**

前沿模型兜售自信。FABULA 交付证明。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-black)](#安装)
[![Release](https://img.shields.io/github/v/release/sergezuber/FABULA-LLM-5)](https://github.com/sergezuber/FABULA-LLM-5/releases)

[**安装**](#安装) · [文档](#文档) · [凭证规范](docs/spec/verified-autonomy-receipt-v0.2.md) · [插件](docs/PLUGINS.zh-CN.md) · [评测](docs/EVALS.zh-CN.md) · [贡献指南](CONTRIBUTING.zh-CN.md)

[English](README.md) · [中文](README.zh-CN.md) · [Русский](README.ru.md)

</div>

![FABULA 拒绝在没有证明的情况下接受一个修复 —— 先复现门禁、通过（绿）的验证，以及签发的 Proof-of-Done 凭证](docs/assets/showcase.png)

## FABULA 是什么？

FABULA 是一套智能体外壳，建立在一个赌注之上：**可靠性存在于模型周围的机器之中，而不在模型本身。** 任何 LLM —— 你机器上的本地模型，或者云端的前沿模型 —— 都作为可更换的芯片插入插槽。运行的每一步都由引擎强制执行，而不是靠一段模型可以无视的提示词：没有通过（绿）的测试运行，这次运行就无法宣称「完成」；在请求被满足之前，它无法结束；它也无法悄悄跑偏、陷入循环或者中途退出。

完全本地运行，任何东西都不会离开你的机器。这不是一个成本论点 —— 这是受审计环境真正要求的模式：来自你所拥有的模型的一份已验证凭证，胜过来自你所租用的模型的一句无法验证的说法。

![FABULA 如何工作](docs/assets/how-it-works.svg)

## 为什么叫「FABULA」？

*Fabula* 是拉丁语，意思是「一个故事」。你用过的每一个智能体，最后都用一个故事来结束困难任务 —— 一段自信的文字，谈论着可能存在、也可能并不存在的工作。FABULA 的构建方式让工作不可能以故事收场：一次运行只会停在两种诚实状态之一 —— **已验证**，附带一份可重放的凭证；或者对着真实的失败输出明确给出 **未完成**。这个名字就是失败模式；这个产品就是对它的拒绝。

## 你熟悉的每一种本地智能体失败，都被引擎拒绝

**「它说完成了，但什么都跑不起来。」**
在这里，「完成」是一个测试结果。发生源码修改之后，引擎会不断重新进入这一轮次，直到项目自己的测试真正跑过 —— 这发生在运行循环里，而不是在提示词里。

**「它写了一个什么都证明不了的测试。」**
外壳会把模型新写的测试跑在*打补丁前的代码*上。在那里也通过（绿）？那么这个复现是假复现 —— 「完成」被拒绝。弄坏了一个同级测试？那是回归缺陷 —— 「完成」被拒绝。

**「它干到一半就退出了。」**
结束轮次不是模型的决定。一位独立的裁判读的是真实的工具调用 —— 而不是模型自己的摘要 —— 并且在请求被满足之前拒绝这次停止。当实测轨迹（失败（红）的验证、未经验证的修改、回退）给出相反结论时，「完成」会被直接推翻。

**「它把坑越挖越深。」**
连续两次验证失败，外壳就把每一个文件回退到最近一次通过（绿）的快照 —— 用的是它自己的影子存储，你的 `.git` 不会被碰 —— 并引导换一种方法，同时点名反复出现的根本原因。文件回退无法撤销的副作用（一次安装、一次迁移、一个 POST）会被标记出来，而不是被忘掉。

**「它在同一个搜索上不停打转。」**
逐字节相同的调用和近似重复查询，会在一个实测预算之后被引擎切断 —— 而当一个搜索轮次被停止时，外壳自己会给出一句诚实的「没有找到」，并列出尝试过的内容，而不是留下一个死掉的轮次。

**「它被上下文淹没了。」**
窗口属于一次调用 —— 而不属于整场对话。检查点把状态带过上限，超大的材料被放在上下文之外、按有界的切片读回来，会话的寿命长于窗口。

**「智能体外壳会烧掉 4× 的 token。」**
这一套反而在削减它们。每一步的成本下降了 **45%，在传输层实测**：请求前缀从 72.3k token 降到 40k 以下，并且在一个任务内部保持逐字节稳定，于是模型的 KV 缓存能跨步骤存活下来。这就是为什么一个小型本地模型能在笔记本电脑上跟得上。

## 不要相信它。重放它。

![拿出证明](docs/assets/prove-it.jpg)

每一次全门禁通过的绿色运行都会签发一份 **Proof-of-Done 凭证**：diff、验证命令、当时坐在插槽里的模型，以及产生这份工作的那个确切上下文的 sha256 指纹 —— 提示词前缀、工具 schema、路由配置档、请求文本、服务模型描述符，可选地还包括磁盘上权重文件的真实摘要。没有第二个已发布的智能体，把这份产物作为一份开放、可重放的规范公开出来 —— 如果你知道有，请提一个 issue。

一次真实捕获的运行被逐字提交进了仓库 —— 重放它：

```bash
cd demo && fabula receipt verify
```

```
VERIFIED ✓ — the artifact replayed deterministically:
base c660a02ab138 + patch → `bun test` passed.
```

更难的那一个也是公开的：一个真实的 [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) 任务，由一个本地模型在一台消费级机器上端到端解决，并由该基准测试的*隐藏*验收测试集评分 —— **隐藏测试 100% 通过，判定 RESOLVED** —— 还附带一条命令的 Docker 重放：[`docs/receipts/`](docs/receipts/)。

模型并没有变聪明。是它周围的系统拒绝让「完成」在没有证明的情况下发生。

背后未经编辑的产物：

- [`refusal.cast`](docs/assets/refusal.cast) —— 这次拒绝的实时终端录像（用 asciinema 播放）
- [`captured-run.svg`](docs/assets/captured-run.svg) —— 同一次运行，一拍一拍地渲染出来
- [`HARDEST-JOURNEY.md`](docs/HARDEST-JOURNEY.zh-CN.md) —— 最糟糕的一天：反复的失败（红）、一次自动回退、一次被引导的第二意见

凭证格式是一份任何智能体都可以实现的开放规范 —— [可验证自主性凭证 v0.2](docs/spec/verified-autonomy-receipt-v0.2.md)：JSON schema、逐字段的诚实性规则，以及一套重放协议。FABULA 是它的参考实现：[`docs/GREENPAPER.md`](docs/GREENPAPER.zh-CN.md)。

## 安装

**你需要：**[LM Studio](https://lmstudio.ai) 加一个支持工具调用的模型（或者任何 OpenAI 兼容
端点），以及 `git`。其他一切 —— 引擎、Bun、本地适配器、插件
依赖 —— `setup.sh` 都会替你装好。

### macOS —— 桌面应用

Apple Silicon，外加 Xcode Command Line Tools（引擎构建会编译几个原生模块）。

```bash
xcode-select --install   # once per machine; skip if you already build C/C++
```

```bash
git clone https://github.com/sergezuber/FABULA-LLM-5 && cd FABULA-LLM-5
./setup.sh
open FABULA-LLM-5.app
```

### Linux

```bash
git clone https://github.com/sergezuber/FABULA-LLM-5 && cd FABULA-LLM-5
./setup.sh
bin/fabula serve --port 4096      # then open http://127.0.0.1:4096
```

引擎和每一个插件都在这里运行。桌面窗口单独构建，并打包成 `.deb`：
`bash shell/build.sh`。

### Windows

先安装 **Git for Windows** —— 外壳在每个平台上都通过同一个 POSIX shell 运行每一条命令，
这样安全规则只需要解析一种语法。

```powershell
git clone https://github.com/sergezuber/FABULA-LLM-5; cd FABULA-LLM-5
.\setup.ps1
bin\fabula.exe serve --port 4096   # then open http://127.0.0.1:4096
```

任何时候都可以重新运行 `setup.sh`（或 `setup.ps1`）—— 在一次 `git pull` 之后，在安装了某个依赖之后。它绝不会覆盖你的 `.env` 或 `fabula.config.json`。

### 把它指向一个模型

**本地（默认）：**打开 LM Studio，加载一个支持工具调用的模型，启动它的服务器。`setup.sh` 已经装好了配置所指向的那个本地适配器 —— 不需要再做别的。

<details>
<summary><b>任何 OpenAI 兼容端点</b> —— 一个云提供商或者一个企业网关</summary>

把密钥放进 `.env`（已被 gitignore 忽略），并在 `fabula.config.json` 里描述这个提供商：

```jsonc
// .env
MY_API_KEY=sk-...

// fabula.config.json
{
  "model": "myapi/my-model-id",
  "provider": {
    "myapi": {
      "name": "My endpoint",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://llm.example.com/v1", "apiKey": "{env:MY_API_KEY}" },
      "models": {
        "my-model-id": { "tools": true, "limit": { "context": 131072, "output": 32768 } }
      }
    }
  }
}
```

模型必须支持**工具调用能力**，并且 `limit` 需要同时有 `context` 和 `output`。用 `curl -s https://llm.example.com/v1/models -H "Authorization: Bearer $MY_API_KEY"` 检查端点和确切的模型 id。

</details>

### 首次运行 —— 两分钟的证明

[`demo/`](demo/) 里植入了一个缺陷，而那里的每一个测试却依然是通过（绿）的。

1. 把 `demo/` 作为项目打开。
2. 粘贴：*修复导出缺陷：每晚的导出会静默丢掉日期正好落在结束日期上的行。请拿出证明。*
3. 看着这台机器在证明出现之前拒绝收工。

你会看到它写出一个测试，看着这个测试在旧代码上失败，然后才把这份工作称为完成 —— 在你的机器上，用你的模型。

## 内部有什么

| 门禁 | 它拒绝什么 |
|---|---|
| **verify** | 在项目自己的测试没有通过（绿）的情况下就宣称「完成」—— 引擎会自己把这次运行压回验证。 |
| **reproduce** | 新写的测试在打补丁前的代码上也能通过的修复（假复现），或者弄坏了一个同级测试的修复（回归缺陷）。 |
| **quiz** | 智能体解释不了的改动 —— 在「完成」成立之前，对着它自己的 diff 打分。 |
| **attest** | 断言超出其来源所能支撑范围的书面交付物 —— 引文被逐字重新找回，数字被重新核对，「读完了全部 N 个文件」要对照本次运行自己的读取日志来核查。 |
| **judge** | 在请求被满足之前就结束的轮次 —— 当实测轨迹与模型的「完成」相矛盾时，给出强制否决。 |
| **rewind** | 把坑越挖越深 —— 反复的失败（红）会把文件原子性地回退到最近一次通过（绿）的检查点。 |
| **go floor** | 从来没问过自己那些分析器的 Go 改动 —— 其中六个会在通过（绿）时跑一次，而*可达*的漏洞会拦截，单纯的清单式罗列则不会。 |
| **re-checking** | 断言超出其验证所核查范围的凭证 —— 每一条身份论断都恰好落在一个具名状态上：在此处已重新验证、在此处无法核查、或者不匹配。 |
| **provenance** | 来源不明的工作 —— 每一份凭证都会为产生它的那个确切上下文生成指纹。 |
| **escalate** | 在死路上打转 —— 当实测证据表明再来一次本地尝试不值这个成本时，外壳会自己去取一次云端第二意见；本地模型继续主导。 |
| **memory** | 你选择相信而不是核查的记忆 —— 一条记忆会绑定到它所来自的代码，并在被送回之前对照你的真实代码树重新验证。默认随发布关闭；在你读过它的决定之前，它的决定先跑在影子模式里。 |

门禁周围还有：网络研究、shell、沙箱化代码执行、漂移容忍编辑、浏览器自动化、持久的交接、检查点与撤销，以及 SSRF / 密钥脱敏 / 提示词注入防御。

这些守卫覆盖的是**三道门，而不是一道**：一条能拦住某个工具的规则，同样会拦住经由 shell 做的同一件事；而没有容器的代码，则运行在操作系统内核配置档之下。一个被要求安装开机启动项的智能体，会把这三道门都伸手试一遍 —— 不是为了攻击什么，只是为了完成它的任务。

完整地图 —— 40 个插件、90 个工具：[`docs/PLUGINS.md`](docs/PLUGINS.zh-CN.md)。

一层可选的**证明经济**建立在凭证之上 —— 发布到内容寻址注册表、跨模型见证认证、面向团队工作的证明树。默认关闭：[disrupt 层](docs/PLUGINS.zh-CN.md#颠覆层--把-proof-of-done-变成一套证明经济实验性默认关闭)。

## 隐私

- 本地模型意味着本地数据：除非*你*配置了一个云提供商，否则没有任何东西离开这台机器。
- 删除一个对话会彻底清除它的消息、产物和缓存 —— 应用不保留任何东西。
- 应用退出时会清除 WebKit 缓存；密钥只存在于已被 gitignore 忽略的 `.env` / `*.key` 文件里。
- 没有遥测，没有账号，不回传。

## 社区

- **缺陷与问题** —— [GitHub Issues](https://github.com/sergezuber/FABULA-LLM-5/issues)
- **安全报告** —— 私下提交，按照 [SECURITY.md](SECURITY.zh-CN.md)
- **知道另一个会签发可重放凭证的智能体吗？** 提一个 issue —— 凭证规范就是为了被广泛实现而写的。

## 文档

| 主题 | 位置 |
|---|---|
| 每一个插件和工具 | [`docs/PLUGINS.md`](docs/PLUGINS.zh-CN.md) |
| 协议（草案） | [`docs/GREENPAPER.md`](docs/GREENPAPER.zh-CN.md) |
| **凭证规范 —— 任何智能体都可以实现的开放标准** | [`docs/spec/verified-autonomy-receipt-v0.2.md`](docs/spec/verified-autonomy-receipt-v0.2.md) |
| 公开的可重放凭证 | [`docs/receipts/`](docs/receipts/) |
| 评测与运行记录 | [`docs/EVALS.md`](docs/EVALS.zh-CN.md) |
| 最艰难的旅程（能力走查） | [`docs/HARDEST-JOURNEY.md`](docs/HARDEST-JOURNEY.zh-CN.md) |
| 架构深入 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.zh-CN.md) |
| 每一个依赖 + 安装命令 | [`DEPENDENCIES.md`](DEPENDENCIES.md) |
| 配置模板 | [`fabula.config.example.json`](fabula.config.example.json) · [`.env.example`](.env.example) |
| 贡献与测试规则 | [`CONTRIBUTING.md`](CONTRIBUTING.zh-CN.md) |
| 安全策略 | [`SECURITY.md`](SECURITY.zh-CN.md) |
| 致谢 | [`docs/CREDITS.md`](docs/CREDITS.zh-CN.md) |

## 鸣谢

构建于以下项目之上，并向它们致谢：[MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code)（FABULA 所基于的引擎，[OpenCode](https://opencode.ai) 的一个分支）、[LM Studio](https://lmstudio.ai)、[SearXNG](https://docs.searxng.org)、[Playwright](https://playwright.dev)、[Bun](https://bun.sh)、piper，以及 faster-whisper。若干监督机制改编自 [pi](https://github.com/earendil-works/pi)（Mario Zechner，MIT）的机制设计，在这里重新实现并经过测试。这套工具集遵循了业界领先的助手已经让公众所熟悉的命名与 schema 约定，在这里为你选择运行的任何模型独立实现。更多：[`docs/CREDITS.md`](docs/CREDITS.zh-CN.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
