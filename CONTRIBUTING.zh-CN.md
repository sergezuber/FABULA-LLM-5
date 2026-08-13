# 为 FABULA-LLM-5 做贡献

[English](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh-CN.md) · [Русский](CONTRIBUTING.ru.md)

感谢你的关注！本项目是一套本地优先的自主智能体框架：插槽里换成哪个模型都能交出经过验证的成果，靠的是监督层——验证门禁、检查点、循环守卫、凭证。如果你的贡献能让它继续**在普通硬件上完全离线运行**，我们尤其欢迎。

## 基本规则

- **一个插件 = 一个文件 = 一个导出。** 每个 `plugin/fabula-*.ts` 只导出一个 `Fabula*` 工厂，别的什么都不要导出——文件里的*每一个*导出，引擎都会当成插件去调用，所以顺手多导出一个辅助函数，加载就会失败。共享的辅助代码放进 `plugin/lib/`。
- **清单说了算。** 新增的工具、插件、外部依赖，都必须在 `plugin/lib/manifest.ts` 里声明，并带上 `check` 和 `install` 命令——然后重新生成摘要：`bun scripts/install-deps.ts --md > DEPENDENCIES.md`。插件的本地化名称、描述和能力标签，写进 `plugin/lib/i18n.ts`；标签沿用 README 插件表格里的那套词汇。
- **文档跟着代码走。** 一项能力如果没在同一个 PR 里写进 `README.md` 和 `docs/`，就算没做完。
- **密钥绝不进仓库。** 密钥只放在 `.env` 和 `*.key` 里，这两类已经被 gitignore 排除。模板文件（`.env.example`、`fabula.config.example.json`）里只写占位符。

## 测试

`bun test` 全绿，并不代表插件在真实运行的 FABULA 里加载得起来——单元测试是必要的，但不够。

一共**三**个测试集，每个都覆盖另外两个够不着的那一层。插件测试集再绿，也测不到适配器和引擎的改动——五个适配器测试文件一个用例都没贡献，`pytest -q` 却报成功，走的正是这个缺口。

```bash
cd plugin  && bun install && bun test                       # plugins: unit + corner + wiring
cd proxy   && python3 -m pytest -q                          # the :1235 adapter (watchdogs, admission, framing)
cd engine/packages/opencode && bun typecheck && bun test test/session test/task test/tool
```

然后拿一个**真实、隔离的引擎**再验一遍：

```bash
ISO=$(mktemp -d)
XDG_DATA_HOME="$ISO" fabula serve --port 5099 --hostname 127.0.0.1 &
# check the log for 0 ERROR / failed-to-load lines, and that models/providers appear
```

新工具要用它真正的 `execute()` 去打活的后端。「看起来没问题」不算验证。

## 提交 Pull Request

- PR 要聚焦；讲清楚*为什么*，而不只是*改了什么*。
- 风格跟着周围的代码走，注释密度也一样。
- 改动如果影响 macOS 应用，就在仓库根目录跑 `./build.sh` 重新构建——前端、引擎二进制、应用包三样一起；只跑 `app/build.sh`，应用对外提供的还是旧引擎。构建完再跑 `bash scripts/verify-deploy.sh`，并说明你点了哪些地方来验证。

## 报告缺陷

提 issue 时请写上：你跑了什么、你预期是什么、实际发生了什么、引擎日志的末尾几行，还有你的环境（macOS 版本、模型、本地还是云端）。涉及安全的问题，请看 [SECURITY.md](SECURITY.zh-CN.md)。
