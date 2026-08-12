# 为 FABULA-LLM-5 做贡献

[English](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh-CN.md) · [Русский](CONTRIBUTING.ru.md)

感谢你的关注！本项目是一个本地优先的自主智能体外壳：监督层——验证门禁、检查点、循环守卫、凭证——才是让插槽中的任何模型都能交付已验证工作的原因。特别欢迎那些能让它**在普通硬件上完全离线运行**的贡献。

## 基本规则

- **一个插件 = 一个文件 = 一个导出。** 每个 `plugin/fabula-*.ts` 只导出一个 `Fabula*` 工厂函数，除此之外什么都不导出——引擎会把插件文件的*每一个*导出都当作插件来调用，因此多余的辅助函数导出会破坏加载。共享辅助代码放在 `plugin/lib/` 中。
- **清单即法律。** 每一个新工具、插件或外部依赖都必须在 `plugin/lib/manifest.ts` 中声明（带上 `check` 和 `install` 命令）——然后重新生成摘要：`bun scripts/install-deps.ts --md > DEPENDENCIES.md`。把插件的本地化名称/描述与能力标签加入 `plugin/lib/i18n.ts`（标签使用与 README 插件表格相同的词汇表）。
- **文档随代码一起走。** 在同一个 PR 中没有反映到 `README.md` / `docs/` 里的能力，视为未完成。
- **密钥绝不进入仓库。** 密钥只存放在 `.env` / `*.key`（已被 gitignore 忽略）中。模板（`.env.example`、`fabula.config.example.json`）只包含占位符。

## 测试

一次通过（绿）的 `bun test` 可能掩盖某个插件在真实外壳中加载失败——单元测试是必要的，但不是充分的。

一共有**三**个测试集，每一个都覆盖其他测试集触达不到的一层。对适配器或引擎的改动不会被插件测试集覆盖，无论它有多绿——正是这个缺口，导致五个适配器测试文件贡献了零个测试，而 `pytest -q` 却报告成功。

```bash
cd plugin  && bun install && bun test                       # plugins: unit + corner + wiring
cd proxy   && python3 -m pytest -q                          # the :1235 adapter (watchdogs, admission, framing)
cd engine/packages/opencode && bun typecheck && bun test test/session test/task test/tool
```

然后对照一个**真实、隔离的引擎**进行验证：

```bash
ISO=$(mktemp -d)
XDG_DATA_HOME="$ISO" fabula serve --port 5099 --hostname 127.0.0.1 &
# check the log for 0 ERROR / failed-to-load lines, and that models/providers appear
```

用新工具真实的 `execute()` 对活跃后端进行实际调用。「看起来是对的」不构成验证。

## Pull request

- 保持 PR 聚焦；解释*为什么*，而不只是*做了什么*。
- 与周围代码的风格保持一致（包括注释密度）。
- 如果改动影响 macOS 应用，请在仓库根目录用 `./build.sh` 重新构建（前端、引擎二进制和应用包——仅运行 `app/build.sh` 会让应用继续提供过时的引擎），然后运行 `bash scripts/verify-deploy.sh`，并说明你点击了什么来验证。

## 报告缺陷

提交 issue 时请包含：你运行了什么、你期望什么、实际发生了什么、引擎日志的尾部，以及你的环境（macOS 版本、模型、本地/云端）。任何涉及安全的问题，请参见 [SECURITY.md](SECURITY.zh-CN.md)。
