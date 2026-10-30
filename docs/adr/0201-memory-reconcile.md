# ADR 0201：记忆对账——「记着写过」不等于 Hindsight 里真有

- 状态：**已实现，新开关 `memoryReconcile`，默认关**。DSH 那台机器拉取、在 `koishi.yml` 里加 `memoryReconcile: true`、重启 Koishi 才生效（开不开要用户点头）
- 日期：2026-10-30
- 关联：[ADR 0004](0004-time-scheduling-memory.md)（片段 `ep-<首条时间戳>`）、[ADR 0012](0012-hindsight-tuning.md)（异步写入）、[ADR 0017](0017-long-term-memory-like-a-person.md)（公共库）、[ADR 0068](0068-crisis-response.md)（危机相关的片段不进公共库）、[ADR 0199](0199-history-migration.md)（迁移，`verify` 就是在这里查出来的）
- **起因（2026-10-30，现场）**：DSH 迁移 VM 素材之后跑 `verify`，他的 bank 98/101——有 3 个片段在进度文件 `retained` 里记着「写过」，Hindsight 里却查不到。

## 原因

写入走 `POST …/memories`，请求体是 `async: true`：Hindsight **受理**了就返回 200，事实抽取在后台做。受理之后后台任务可能失败（Hindsight 被停了 / 重启、模型出错、数据库连接坏了——10-30 下午就有一次，16:03 被 Ctrl+C 停了 79 分钟），而机器人只在「受理」这一步判断成功，立刻在进度文件里记成「这个片段写完了」。以后每次同步看到的都是「已写」，**永远不会重写**。记忆就悄悄少了一块，没有任何日志。

迁移那次是 `verify` 恰好把它查了出来；平时没有人在查。

## 做法

`LongTermMemory` 在同步时（`#sync`，每个联系人）顺手对一次账（`#reconcile`）：

1. 读 Hindsight 里那个 bank 的所有文档 id（`HindsightApi.listDocumentIds`，分页 GET）。
2. 进度文件里每个「写过」的片段，如果 Hindsight 里没有它的 `document_id`（他的 bank 是 `ep-…`，公共库是 `<他的哈希>:ep-…`），就把进度里那一条删掉，同一次 `#sync` 后面的 `due()` 就会把它重写（同一个 `document_id` 重写是覆盖，不会重复）。
3. 保守，不闯祸：
   - **刚提交的不算缺**：每次提交记下时间（`retainedAt` / `commonAt`），`RECONCILE_GRACE_MS` = 2 小时内的不查（Hindsight 在后台慢慢处理，迁移那次一口气几十个要十几分钟）。旧的进度文件没有这个字段，就当早就提交了；
   - **读不到列表就不动**（记一行日志，下一个周期再来）；
   - **Hindsight 里一篇都没有、却记着 ≥ 5 个写过的**：多半是 bank 不对 / 接口变了，不动（记一行日志）；
   - **公共库里危机相关的片段本来就不写**（ADR 0068 决策 8），不算缺；
   - **一次最多重排 30 个**（`RECONCILE_MAX`），**同一个片段最多重排 3 次**（`RECONCILE_MAX_TRIES`，记在进度文件 `requeued` 里——Hindsight 总是处理失败的那种内容，别一直写）；
   - **节奏**：没发现缺的 6 小时一次；发现缺了之后 10 分钟再查一次（看重排的写进去了没有）；重启后第一次同步就查一次（只要有够老的可查）。
4. **日志只写数量，不写内容**：`记忆对账：记着写过、Hindsight 里却查不到的片段——他的 bank N 个、公共库 M 个，重新排队写`。

联系人遗忘（[ADR 0070](0070-hardening-program.md) 第 9 项）会把这个联系人的聊天记录和进度文件一起挪进回收目录、再删 Hindsight 里的文档，所以对账不会把被遗忘的记忆「救」回来。

## 顺带修的（迁移工具）

- `verify` 查公共库时，危机相关的片段本来就不写，却会被当成「缺」。加了 `--common`：把这些从「该有的」里去掉；`expectedEpisodeIds` 改成直接用 `splitEpisodes`，和机器人切片段的方式是同一份代码。
- `verify` / `plan` / `apply` 结尾用 `process.exit` 会在 Windows 上打出 `Assertion failed ... uv_handle`（DSH 10-30 见到）：改成设 `process.exitCode` 让事件循环自己收完。
- 同样的检查现在能当一个日常小工具用：`node packages/bot/src/ops/history-migrate-cli.ts verify --data … --qq … --hindsight … --bank …`（不限于迁移）。

## 开不开

默认关。理由：它会对 Hindsight 多发几次 GET，并在发现缺了时重写；虽然上面有一串保险，仍是新的自动行为。我的建议是 DSH 那台机器开：已经现场出过三个，而且那边 Hindsight 没有守护、停过 79 分钟。开了之后观察几天日志里「记忆对账」那一行出现的频率——正常应该很少（只在 Hindsight 出过事之后）。

## 回滚

`memoryReconcile: false`（或删掉这一行）。进度文件里多出来的 `retainedAt` / `commonAt` / `requeued` 老版本代码会忽略。

## 验证

- `memory-reconcile.test.ts` 11 项：没开不管；丢一篇只重写那一篇、日志不含内容；宽限期内不动；旧进度没有提交时间照样对；读不到列表不动、下个周期再来；一篇都没有（≥5）不动、少于 5 个全重排；节奏（6 小时 / 10 分钟）；同一片段最多重排 3 次、一次最多 30 个；公共库缺的重排、危机片段不算缺、公共库也有宽限期；默认是关。变异检验 16 处全红（第一遍有 1 处没红——公共库的提交时间没人测——补了测试）。
- `history-migrate.test.ts` 加一条：`skipCrisis` 只看他说的、只在查公共库时去掉危机片段。
