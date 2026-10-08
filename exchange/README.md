# 三方交换区

本目录用于远端 GPT / Claude 与 DSH 侧交换当前运行证据和活状态，不合并回 `main`。

## 当前快照

- 生成时间：2026-10-08 21:41（Asia/Shanghai）
- 基准提交：`197d2d5`
- 最新交接：`handoff/2026-10-08-2141.md`
- 线上证据：`live/2026-10-08/`
- 最近模拟：`evidence/20261008-*`
- 生效配置摘要：`config/koishi.redacted.yml`

## 数据约定

- 仓库为私有仓库，账号持有人已经明确授权同步其账号相关的提示词、聊天、日志、世界状态和承诺状态。
- QQ 号和对话原文为诊断上下文，按授权保留。
- API key、密码、token、cookie 等可用于接管服务的凭据仍必须移除。
- 每次更新 handoff 时记录对应的 `main` 提交和线上进程状态，严格区分“已提交”与“已上线”。

## DSH 读取顺序

1. `handoff/2026-10-08-2141.md`
2. `live/2026-10-08/last-prompt.json`
3. `live/2026-10-08/logs/`
4. `evidence/`
5. `config/koishi.redacted.yml`
6. `live/2026-10-08/world-state.json`、`promises/`、`proactive/`

## DSH 侧回写（2026-10-08）

| 文件 | 对应 handoff 第 40 节的哪一项 |
| --- | --- |
| `reviews/2026-10-08-dsh-diagnosis.md` | 第 1 项：她「仍不像真人」的具体来源（含逐条证据、行号、修复优先级） |
| `reviews/2026-10-08-action-engine-review.md` | 第 3 项：静态检查 `d03b057` / `b5f2a6f`，判定**不足以支撑执行器**，附 5 条必须先补的能力 |
| （待出）ADR 0036 四批报告复核 | 第 2 项：验证标准是否过宽、未覆盖的反例 |

DSH 侧没有 `runtime/bot`，全部结论都是**静态推演 + 证据比对**，不是实跑验证；
每份报告末尾都写了方法与边界，未复核的条目单独标注。


