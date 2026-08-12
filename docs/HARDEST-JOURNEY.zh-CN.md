# 最艰难的旅程——机器在最糟糕的一天里做了什么

[English](HARDEST-JOURNEY.md) · [中文](HARDEST-JOURNEY.zh-CN.md) · [Русский](HARDEST-JOURNEY.ru.md)

首页展示的是一次**捕获的运行**（真实的录制、真实的凭证）。本页展示的是**完整的失败阶梯**——当一次运行比那更糟时会触发的机制：反复的失败（红）验证、自动的文件回退、被引导发起的云端第二意见。

> 这份走查是一个**能力示意**，不是一次捕获的运行：其中每一道门禁都是真实、已发布、你可以阅读的代码（下方有链接），但这一具体序列是为了在一个故事中展示整条阶梯而组合出来的。捕获的运行位于[首页](../README.zh-CN.md)以及 [`docs/receipts/`](receipts/) 中。

![One hard task surviving failure — a baseline green verify captures the shadow-git checkpoint; reproduce-first demands a failing test before the fix counts; two repair attempts go red; the harness auto-rewinds the files to the last green checkpoint and steers a different approach; one cloud second opinion later the third attempt goes green, and change-quiz grades the agent on its own diff before done stands](assets/hero.svg)

## 这条阶梯，逐个机制来看

| 梯级 | 触发了什么 | 它位于何处 |
|---|---|---|
| 失败（红）→ 自我修复 | `verify_done` 报告真实的失败输出；模型对照它进行迭代 | [`plugin/fabula-tools.ts`](../plugin/fabula-tools.ts) |
| 通过（绿）但没有测试 | reproduce-gate 会把「完成」降级，直到有一个先失败后通过的测试真正覆盖了这次改动 | [`plugin/fabula-reproduce-gate.ts`](../plugin/fabula-reproduce-gate.ts) |
| 通过（绿）但没有理解 | change-quiz 对照智能体自己的 diff 给它打分 | [`plugin/fabula-change-quiz.ts`](../plugin/fabula-change-quiz.ts) |
| 失败（红）×2（可通过 `FABULA_REWIND_THRESHOLD` 配置） | 自动回退原子性地把文件恢复到最后一个通过（绿）的影子 git 检查点，并引导换一种做法 | [`plugin/fabula-rewind.ts`](../plugin/fabula-rewind.ts) |
| 仍然卡住 | 引导指令指向 `escalate_to_cloud`——并且外壳会直接触发它，因为一条模型可以无视的引导指令是一个请求，而不是一个机制——来自更强模型的一次第二意见；插槽中的模型继续主导 | [`plugin/fabula-escalate.ts`](../plugin/fabula-escalate.ts) |
| 全门禁通过（绿） | Proof-of-Done 凭证自行签发 | [`plugin/fabula-receipt.ts`](../plugin/fabula-receipt.ts) |
