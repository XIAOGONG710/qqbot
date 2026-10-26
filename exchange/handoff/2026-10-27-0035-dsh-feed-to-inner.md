# 2026-10-27 00:3x DSH：刷到的进内心（ADR 0168 收尾这一步）

- 用户 10-27「继续」。分支 `dsh/qq-control`（`83263af`，已推送）。
- 这一步把上一轮「只记账」的推荐流接到她的内心：今天刷到的，可以成为她想事情时的一件真事。

## 做了什么

- `feed-browsing.ts` 新增 `feedFactEntry(file, now)`：返回 `{ id: "feed:<bvid>", text: "你今天在 B 站刷到过《…》（分区），停了 N 秒" }`；只认**当天、mode=on** 的第一条，`dryRun` 不算。
- `app.ts`：原来只有 `config.watching` 时才有 `watchedFacts`；现在改成 **`innerLife` 且（`watching` 或 `biliFeed` 开着）** 就给，逻辑是「看过的视频优先，没有就看今天刷到的」。
- 复用了原有的「想过一次就记 id，不再反复想同一件」机制（`inner.reflected`），没有新增状态文件。
- 测试：`feed-browsing` 5 项（新增 `feedFactEntry`：带 id、只认当天 on、dryRun 不算）；`app.test.ts` 65 秒 **85/85**；类型检查干净。

## 现在的效果（开关联动）

| 配置 | 她会得到什么 |
| --- | --- |
| `innerLife: on` + `biliFeed: on` | 每天刷到的那条（第一条停下来的）会作为「今天刷到过…」进内心题目一次 |
| `innerLife: on` + `watching: on` | 原来「最近在 B 站看过的」优先；没有才用刷到的 |
| `innerLife: off` | 什么都不发生（推荐流只记账） |
| `biliFeed: dryRun` | 只写草稿，不进内心 |

## 还没做 / 下一步

- B 站线仍全静默（8 个值全关）；这些代码默认关，等用户恢复后先 `dryRun` 看草稿；
- 第 2.5 期（AI 总结 wbi + 可选 ASR）与第 3 期起（收件箱 / 真 @ / 数据）未动，前置见 ADR 0168：登录 + 熔断 + 用户在场；
- 下一步要么等恢复 B 站线验收，要么继续第 2.5 期（先把 AI 总结的 wbi 接口写成只读 CLI，不依赖登录）。
