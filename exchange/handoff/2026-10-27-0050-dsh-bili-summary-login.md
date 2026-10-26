# 2026-10-27 00:5x DSH：AI 总结（第 2.5 期只写了一半——实测要登录）

- 用户 10-27「继续」。分支 `dsh/qq-control`（`6a45b09`，已推送）。
- 结论先说：**AI 总结接口要登录**。代码写了，但没在匿名状态验收；按工作流「先取证」，先把事实钉死。

## 做了什么

- `packages/bot/src/bilibili-summary.ts`：`fetchSummary` 用 wbi 签名请求 `x/web-interface/view/conclusion/get`，解析 `model_result.summary` + `outline`（章节 + 要点时间戳）；
- 返回三态：`ok` / `needLogin` / `none`——不再把「要登录」当成「没总结」；
- `bilibili-view.ts` 的 view 增加 `upMid`（总结接口要）；
- `ops/bilibili-view-cli.ts --summary`：人看时显示「要她的 B 站号登录（未登录回 code -101）」；`--json` 里带 `summaryStatus`；
- 测试 `bilibili-summary.test.ts` 3 项（解析、空结果、截断）；类型检查干净。

## 取证记录（2026-10-27 00:5x，本机直连）

- 未登录请求 `conclusion/get`（wbi 签名已通过）：`code -101 message "账号未登录"`；
- 同一个视频的 view / 弹幕 / 雪碧图都能读（弹幕 1800 条、雪碧图 2 张），**只有总结被登录挡住**。

## 影响

- 第 2.5 期的 AI 总结**不能在匿名阶段验收**，挪到第 3 期（她的 B 站号恢复后一起验）；
- ASR（本地语音转写）与登录无关，但要 Python/GPU，仍需用户点头，单列。

## 下一步

- 等 B 站号恢复：先 `biliView`/`--summary` 在 VM 上验证总结能读到；
- 或者继续做「不依赖登录」的下一项：把 `bilibili-view` 的章节 / 弹幕接进 `watching.ts`（她真看的时候多这两层事实），这是纯只读、可离线验证的。
