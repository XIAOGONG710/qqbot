# Claude handoff — memory hardening integration, round 2

- 日期：2026-11-06 00:10（UTC+8）
- 基线：`origin/memory-hardening-1105@52c3d73a`（GPT 上一个检查点），之上 30 个**本地**提交，**没有推送**
- 运行基线仍是 `dsh/qq-control@9dcfbc9b`；本分支**不能部署**（还有 8 项失败，见下）
- 工作目录：`C:\Users\XG\code\qqbot-consolidation-1105`（worktree）

## 验证结果（本检查点，未经手工挑选）

- bot 完整测试：**3849 项，3833 通过，5 失败，11 跳过**（`--test-timeout=60000`，TZ=Asia/Shanghai 预加载；`c85efdd0` 之后。最初是 8 失败）。
- 全仓 `npm run typecheck`：0 个错误。
- character-tools 44、koishi-plugin 67、mobile-companion 65、PWA 12：全部通过。
- 对照：GPT 检查点（+2 提交）完整跑是 3527 项、39 失败；main 自己单跑 `diary.test.ts` 也有 3 项失败。
  GPT 后期只跑「合成子集」（约 1020 项），没跑全量，所以这些失败当时没被发现。
- 测试必须设时区：本机是 Asia/Tokyo，不设 TZ 会多出约 85 项作息/日期相关失败。时区修复在 main 的 `58803856`，
  **不在这条线上**；Git Bash 里 `TZ=... node` 对 Windows 版 Node 无效，用 PowerShell 的 `$env:TZ` 或 `--import` 预加载。
- `node --test` 默认不设单测超时，一条永远等不到的测试会把整套挂住（这次真的发生过）。跑完整测试请加 `--test-timeout=60000`。

## 仍然失败的 5 项（真实源码缺口，这些测试在 main 上通过）

1. `memory-responder-drain-review`（5）：错字「先删后更正」、发送 ACK 事务、副索引转换回调。
   依赖 main 的 `4c1c2b94`（主动消息发送意图原子落盘，改 `responder.ts` 102 行 + `proactive-planner.ts` 233 行）
   和 `0a4b3614`（照片写入协调 + 发送生命周期事实）。试合冲突都在 DSH 敏感核心（`photos.ts`、`proactive-planner.ts`、
   `responder.ts` 双方都改过），没有硬合，需要 DSH 评审后再做。
（原第 2 项 `memory-long-term-state-review` 的 3 条已处理，见下一节。）

## 坏记忆进度文件：保留 DSH 的失败关闭，修了一个会让她不回消息的缺陷（`c85efdd0`）

- 两条线策略相反：main 把坏进度改名成 `.corrupt-*` 隔离、用空进度继续写；DSH 失败关闭（`invalid: 'throw'`，不重写、不派发、等人修复）。
  **用户 2026-11-06 选定保留 DSH 的策略**，main 的三条测试改成断言 DSH 的行为。
- 缺陷：DSH 的读路径（recall / recallCommon / othersToday / relationship / impression）也直接抛错。`relationship()` 是同步调用、
  `contact.ts` 里没人接，进度一坏每轮回复都失败——**她不再回这个人的消息**。真实 App 端到端复现：联系人进度写成 `[]` 后发「在吗」，
  修复前 8 秒内不回，修复后照常回复、坏文件原样保留。
- 修法：读路径进度不可信时这一轮不带记忆（返回 undefined，固定文字诊断、只记一次）；写路径不动。反向检查：撤掉修复，新测试和端到端都会变红。
- **线上 `dsh/qq-control` 有同样的隐患**（`#load` 用失败关闭的读取器，`relationship()` 同步调用它，`contact.ts:647` 没接）。
  写入是原子的，文件坏掉不常见，但一旦发生影响很大。要不要单独给 `dsh/qq-control` 打一个小补丁，请 DSH 决定。
- 顺带的差异：DSH 重写进度时不保留未知扩展字段（main 会保留）。只在两个版本交替读写同一份数据时才有影响，没改源码。

## 本轮搬进来的（均为 main 的修复，按原提交标题）

笑话来源校验与刷新、成语抽取归属（含 `messageCursor`）、被动视频读取与风险观察收尾、热梗刷新/作者意图、
表情包可取消收集与索引恢复、B 站回复与风险收尾（含「读不出内容继续重试」）、直发通知、主动命令通知、
DSH 建议取消、设备命令回复、记忆健康探针、聊天动作回执、好友申请、熟人读取取消、Web 孤儿查询取消、
回复等待取消，以及前置的日历年份修复 `6e2184e8`。

## 解冲突时保留的 DSH 行为

`DshConversationContext`（持久化）、`look()` 联网查询（ADR 0180）、空气质量/日照/日历/交通收尾项、
`webTurns`、设备 capture 的「她同意才执行」（`pendingAsk`）、指令收敛（`/主动` 等已不是命令）。

## 没搬的，以及为什么

- **手机伴侣停止所有权**（main `1318e5a8`、`d46c21c0`）：DSH 的 `packages/mobile-companion` 比 main 新很多
  （语音会话、照片审核、十项发布加固），直接合会重写 `runtime.ts` 的 7 个冲突块。DSH 版本目前**没有**随 App 停止而关闭的逻辑，
  这个修复有价值，要对着 DSH 的版本重做。
- **危机状态停机 flush**（main `414145cf` 的另一半）：整合线的 crisis 状态没有 `flush`，要靠 main 对 `emotion/crisis*.ts`
  的改动，属于必须 DSH 审的禁区。只搬了「取消回复等待」那一半（`10f99cfa`）；对应测试与 ADR 0068 说明未带。
- main 上约 40 个 `fix(life)` / `fix(world)` / `fix(social)` / `fix(proactive)` 提交：会碰 DSH 的 App、日记、回复器，逐条判断后再搬，本轮未动。

## 为对齐 DSH 线而改的测试（源码没改，原因写在各提交里）

- 热梗：DSH 线必须带「为什么好笑」「什么时候别用」才入库、6 小时刷新；夹具按此改（`ca6e5cae`）。
- 设备 capture 的 4 条所有权测试与 `/主动` 的 1 条测试：前提在 DSH 线不成立，**skip 并写明原因**，待按同意流程重写。
- `app.test.ts`：`afterEach` 要 `await stop()`（租约要等收尾）；补回用例的实时消息要与历史同一秒（ADR 0238）。
- 严格 fetch 桩（pending-recall、send-drain）与 web-owner：DSH 每次互动会向 `127.0.0.1:7777/note` 发请求，不应计入。
- `bilibili-risk`、`diary`、`timeline`、`memory`、`ledger`、`storage`：断言文字或容忍度已被加固后的源码有意改变。
  其中 diary 3 项在 main 上同样失败。

## 一个真缺陷（已修）

DSH 的入口去重 `rememberIngress` 只用 `用户:消息ID`；ADR 0238 确认 QQ 的 message_id 会被不同消息重用。
合并后同 ID 不同序号的新消息会被入口吞掉。键改为 `用户:消息ID:real_seq:time`（`3a5ad9b3`）。

## 其他需要知道的

- ADR 编号：main 的记忆 ADR 在整合线上被 GPT 改成了 03xx（0236 / 0240 / 0242 等在两条线上是不同文档）。
  我新增的 ADR（时区 0248）只在 main，不在这里。
- 本机 `main` 已被推到 origin（`13a669fb`，含时区修复）；按 DSH 的要求「别推 main」已经来不及，需要告知 DSH。
- 整合线尚未推送。要推的话先确认 DSH 是否接受这个半成品分支（8 项失败、两个提交没搬）。

## 建议下一步

1. DSH 评审 `4c1c2b94` / `0a4b3614`，决定怎么并进 `responder.ts`、`proactive-planner.ts`、`photos.ts`，修掉 responder-drain 的 5 项。
2. 决定是否把 `c85efdd0`（坏进度不再让她不回消息）单独先给 `dsh/qq-control`。
3. 对着 DSH 的 mobile-companion 重做停止所有权。
4. 以上做完后重跑完整测试（含 `--test-timeout`）、类型检查、模块清单检查，再决定合进 `dsh/qq-control`。
