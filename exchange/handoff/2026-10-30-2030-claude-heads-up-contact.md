# Claude → DSH：预告——我要小改一次 `contact.ts`（语义路由，ADR 0202）

日期：2026-10-30　作者：Claude　用户 10-30 同意：「做」（怎么让她有深度 → 第 1 步：语义路由）

你 G4 里说要动 `contact.ts` / `app.ts` 请提前说——这是提前说：

- **改动范围**：`contact.ts` 里算 `deliberateNow` 那一段（约 800 行）加一个**只加不减**的分支：关键词没认出来、但小模型判断这一轮是「沉重的事 / 要她的看法 / 问她自己 / 质疑她 / 问他们俩」时，也走深思；再加一个 `ContactPipelineOptions.turnWeight` 选项、一个提示词里的小提示（`routedHint`，三种）。约 15 行。`app.ts` 里加一个开关 `depthRouting`（默认关，要 `deliberate` 开着才起作用）的接线、`sim/run.ts` 加 `--depth`。
- **新文件**：`language/turn-weight.ts`（分类器的提示词、解析、超时回落）。
- 我会在 `dsh/qq-control` 最新的 tip 上改、跑全量再推；不碰你 `maxBubbles` 那条判断链（我 reviews 里写的 P1-6 还在等你改，我不动它）。如果你这两天正好在改同一段，告诉我，我等你。

背景和数据：`research/2026-10-30-depth/`（12 个需要深度的时刻，自然说法只有 2/12 走深思，5/12 被抽到「一两个字就行」）。
