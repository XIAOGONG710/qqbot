# ADR 0168：照 bili-cli 的表把我们差的能力补齐（分五期，全部用我们自己的方式）

- 状态：**第一期已实现（只读），其余四期只有设计、没写代码**
- 日期：2026-10-26
- 关联：[ADR 0084](0084-bilibili.md)（刷视频发给他）、[ADR 0089](0089-bilibili-account.md)（她的号 / 私信 / 评论）、[ADR 0090](0090-bilibili-replies.md)、[ADR 0092](0092-bilibili-topics.md)、[ADR 0129](0129-memes.md)、[ADR 0130](0130-watching.md)、[ADR 0132](0132-bili-stickers.md)、[ADR 0147](0147-platform-accounts.md)（平台账号熔断）、[ADR 0166](0166-social-accounts.md)（小红书 / 抖音）
- 用户提出：2026-10-26「将差的这些全部补齐，用我们自己的方式将其化用，实现他的所有功能，照着（一、能力对照）的表进行补齐」。

## 原则（「用我们自己的方式」= 五条）

1. **不引入 bili-cli**（理由见 ADR 0167）：它把账号交给外部进程、绕开我们的开关 / 熔断 / 名单 / 危机规则。
2. **能力拆成模块进 `packages/bot/`**，每个模块纯函数优先、网络层可注入（测试用假 fetch），和现有 `bilibili*.ts` 同形。
3. **写能力默认关**：`off | dryRun | on`；写动作走「开关 + 名单 + 每小时限流 + 审计 + 风控即停」；`dryRun` 只写草稿。
4. **别人的内容是素材**：标题 / 简介 / 章节 / 弹幕 / 评论 / 画面里的字一律不当指令；进提示词前 `clip()`、不放进链接（链接由代码在后附）。
5. **登录态是用户在场的事**：她的 B 站号扫码、登录后的探针、第一次真发，全部由用户在 VM 上做；我们只写代码和只读探针。

## 表一逐行 → 我们的模块与开关

| 表一的行 | bili-cli 的做法 | 我们的化用 | 开关 | 期 |
| --- | --- | --- | --- | --- |
| 推荐流 | `feed recommend`（账号级个性化）+ 关注动态 + 各榜 | `bilibili-feed.ts`：wbi 签名 + `x/web-interface/wbi/index/top/feed/rcmd` + 「刷」的会话（连续 3–8 个、停留 / 划走、记看过） | `biliFeed` | 2 |
| 看懂一个视频 | `video watch`：信息 + AI 总结 + 字幕 + 章节 + 热评 + 弹幕高能 + 画面总览 | **`bilibili-view.ts`（本期已写）**：view + 章节 + 弹幕高能 + 雪碧图；AI 总结 / ASR 放 2.5 期 | `biliView` | **1（已完成）** |
| 内容生产 | 动态 / 投稿 / 改稿 / 合集 / 互动弹幕 / 定时 / AI 声明 | `bilibili-create.ts`：同一套 action 包装，先只做「动态」与「投稿（仅自己可见 / 定时）」；AI 声明默认勾；每次发之前 `dryRun` 出一条草稿 | `biliPost`、`biliUpload` | 4（要登录 + 用户在场） |
| 数据复盘 | 单稿完播率 / 账号数据 / 数据中心 | `bilibili-stats.ts`：单稿 `x/web-interface/archive/stat` + 创作中心（要 Cookie）；先做只读汇总进周报 | `biliStats` | 3 |
| 社交互动 | 收件箱、真 @、带图、置顶、查折叠、私信实时 | 扩现有 `bilibili-comment/replies/dm`：加「收件箱一次看完 + `--unreplied` + 真 @ + 折叠检查」；`dm` 加轮询式 watch（不接平台推送） | 现有三个开关 | 3 |
| 工具形态 | 80+ 单命令、JSON + hint、schema、MCP | `ops/bili-*.ts` 统一 `--json`（`{ok,data}` / `{ok:false,error:{code,message,hint}}`）+ `ops/bili-schema.ts` 输出命令表；MCP 先不做 | 无 | **1（CLI 已按此写）** |
| 账号运营节奏 | 每动作限流、审计、风控即停 | `bilibili-limit.ts`：每动作滑窗（评论 / 私信 / 动态 / 投稿）+ `logs/bili-audit.jsonl`（动作、对象、结果，不含正文）+ 现有 `bilibili-risk` 熔断 | 跟随各写开关 | 2 |
| 她是一个人 | — | 不动（角色卡 / 生活 / 关系 / 危机规则） | — | — |

## 第二期（本次已做，只读）

`feed-browsing.ts`：一天一次（14 点后、醒着、按作息）、拿一页 → 排会话 → 记账（`watching/feed.json`，30 天 / seen 300），`dryRun` 只写 `presence/drafts.md`；`app` 里 30 分钟看一眼、随 app 停。开关 `biliFeed`（插件 schema 里已有说明）。
`bilibili-wbi.ts`（混音表 + `mixinKey` + `signParams`）、`bilibili-feed.ts`（`fetchRecommend` / `parseFeedItems` / `stayVerdict` / `planSession` / `sessionSize`）、`bilibili-limit.ts`（评论 / 私信 / 动态 / 投稿四个滑窗 + 审计行）、`ops/bilibili-feed-cli.ts`。

**实测**（2026-10-26，本机直连，未登录）：`ok:true`，rcmd 返回 6 条、会话计划 7 个；签名通过（不签名会 code -352）。发现两处要在接线前补：rcmd 不带 `tname`（分区为空，只能靠标题黑名单兜）+ 生活区以外内容混得多，已把时长上限收到 15 分钟、标题黑名单补了凶案类词。

## 第一期（本次已做）

- `packages/bot/src/bilibili-view.ts`：`fetchView` / `fetchDanmaku` / `fetchStoryboard` + 纯函数 `parseView` / `parseDanmakuXml` / `danmakuPeaks` / `viewNote`；全部只读、失败返回空 / undefined，不假装；
- `packages/bot/src/ops/bilibili-view-cli.ts`：人看的摘要 + `--json`（`{ok,data}`，失败带 `code/message/hint`）；
- `bilibili-view.test.ts` 4 项：view 解析、弹幕 XML（含 CDATA / 转义 / 坏行）、10 秒桶高能、提示词事实（没有章节/弹幕就不编）。

**验收**：`node src/ops/bilibili-view-cli.ts BV… --json` 在能连 B 站的机器上返回 `ok:true`，`data.view.chapters` 非空（有章节的稿件）、`data.peaks` 有 1–3 段。

**已实测**（2026-10-26 23:5x，本机直连 B 站，`BV1GJ411x7h7`）：`ok:true`，view 拿到标题 / 时长 213 秒 / cid，弹幕读到第一条 10 秒就有 506 条、样本里是「非 物质 文化 遗产」这类刷屏；雪碧图这次没拿到（`x/player/videoshot` 可能要 wbi），代码按「读不到就不写」处理。

## 后面四期怎么排（不是现在做，按用户点头一次一期）

| 期 | 内容 | 前置 | 验收 |
| --- | --- | --- | --- |
| 2 | 推荐流 + 「刷」的会话 + 限流/审计骨架 | 一个能读的 rcmd 签名（线上探针） | 一次会话刷 5 个、记进 `watching`，不发任何东西 |
| 2.5 | AI 总结（wbi）+ 本地 ASR（可选，Python 依赖单独装） | 用户同意装 ASR | 无字幕视频也能拿到一段摘要 |
| 3 | 收件箱 / 真 @ / 数据复盘 | 她的号登录（用户扫码）+ 平台状态正常 | `dryRun` 草稿一周；只读数据进周报 |
| 4 | 动态 / 投稿（仅自己可见、定时、AI 声明） | 用户在场 + 专号 + 先看草稿 | 先发一条仅自己可见的测试动态 |
| 5 | 合集 / 改稿 / 互动弹幕 / 数据看板 | 4 稳定运行 | 逐项，一次一个 |

## 没做 / 风险

- **投稿、评论、私信都是写操作**，且 B 站 10-24 起风控多；这套补齐必须先有「她的专号 + 登录 + 熔断」三件，且 B 站线现在是全静默。
- AI 总结要 wbi 签名（B 站改过两次）；ASR 要 Python/GPU（VM 内存 6 GB，装之前要用户点头）。
- 本章只承诺第一期；后面四期的代码量按 bili-cli 的 80+ 命令估，是「多个开发日」，不是一个提交。
- 数据接口和投稿接口的字段**没在真机上核对过**，照 B 站网页端历史接口写，第一期先只做只读、有探针可验。
