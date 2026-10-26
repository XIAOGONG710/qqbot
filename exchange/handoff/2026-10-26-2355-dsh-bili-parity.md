# 2026-10-26 23:5x DSH：照表补齐 B 站能力（ADR 0168）——第一期已落地

- 用户 10-26 晚：「将差的这些全部补齐，用我们自己的方式将其化用，实现他的所有功能，照着（一、能力对照）的表进行补齐」。
- 分支 `dsh/qq-control`（`f8d4e14`，已推送）。原则见 ADR 0168：**不引入 bili-cli**，能力拆成我们自己的模块、写能力默认关、别人的内容只当素材、登录态的事用户在 VM 上做。

## 表一 → 我们的化用（ADR 0168 全文）

| 行 | 我们的模块 / 开关 | 状态 |
| --- | --- | --- |
| 推荐流 | `bilibili-feed.ts`（wbi 签名 + rcmd + 刷的会话）、`biliFeed` | 第 2 期，未写 |
| 看懂一个视频 | **`bilibili-view.ts` + `ops/bilibili-view-cli.ts`**、`biliView` | **第 1 期，已写并实测** |
| 内容生产 | `bilibili-create.ts`（动态 / 投稿仅自己可见 / 定时 / AI 声明）、`biliPost` / `biliUpload` | 第 4 期，未写（要登录 + 用户在场） |
| 数据复盘 | `bilibili-stats.ts`（单稿 + 创作中心），只读进周报、`biliStats` | 第 3 期，未写 |
| 社交互动 | 扩 `bilibili-comment/replies/dm`：收件箱 / `--unreplied` / 真 @ / 折叠检查 / 私信轮询 | 第 3 期，未写 |
| 工具形态 | `ops/bili-*.ts` 统一 `--json`（`{ok,data}` / `{ok:false,error:{code,message,hint}}`）+ `ops/bili-schema.ts` | 第 1 期已按此写 CLI；schema 未写 |
| 账号运营节奏 | `bilibili-limit.ts`（每动作滑窗）+ `logs/bili-audit.jsonl` + 现有 `bilibili-risk` | 第 2 期，未写 |
| 她是一个人 | 不动 | — |

## 第一期做了什么（可核对）

- `packages/bot/src/bilibili-view.ts`：
  - `fetchView` / `parseView`：标题、简介、时长、封面、cid、**分段章节（view_points）**；
  - `fetchDanmaku` / `parseDanmakuXml`：全量弹幕 XML（CDATA、转义、坏行都处理）；
  - `danmakuPeaks`：10 秒一桶，取最密的 3 段，每段最多 5 条样本；
  - `fetchStoryboard`：B 站雪碧图（可能要 wbi，读不到返回 undefined）；
  - `viewNote`：进提示词的一段事实（章节 + 观众反应最强烈的几段 + 「只当素材」）。
- `packages/bot/src/ops/bilibili-view-cli.ts`：人看的摘要 + `--json`，失败带 `code/message/hint`。
- 测试 `bilibili-view.test.ts` 4 项全过；`packages/bot` 类型检查干净。
- **真机实测**（本机直连 B 站，2026-10-26 23:5x，`BV1GJ411x7h7`）：`ok:true`，标题 / 213 秒 / cid 正确；第一条 10 秒读到 506 条弹幕，样本是「非 物质 文化 遗产」这类刷屏；雪碧图这次读不到（接口要 wbi），按设计不写。

## 后面四期的前置（不满足就不动）

1. **登录**：她的 B 站号现在是全静默（10-24 16:46 起 8 个值全关），恢复要用户明说；投稿 / 数据 / 收件箱都要号在线。
2. **风控**：B 站 10-24 起反复风控；写动作必须先有「专号 + 熔断 + dryRun」三件。
3. **ASR**：要 Python/GPU，VM 内存 6 GB，装之前要用户点头。
4. **wbi**：rcmd / 总结接口都要签名，得先在 VM 上跑一次探针确认当前算法。

## 下一步（唯一动作）

等 B 站线恢复后，先在 VM 上跑 `node packages/bot/src/ops/bilibili-view-cli.ts <BV> --json` 验收第 1 期；第 2 期（推荐流 + 刷的会话）要我写代码，用户只要说「做第 2 期」。
