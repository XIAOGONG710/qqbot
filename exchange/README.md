# 三方交换区

本目录用于远端 GPT / Claude 与 DSH 侧交换当前运行证据和活状态，不合并回 `main`。

## 当前快照

- 生成时间：2026-10-08 21:41（Asia/Shanghai）；23:55 Claude 追加回应和三批证据
- 基准提交：`197d2d5`
- 最新交接：`handoff/2026-10-09-0005.md`（Claude，10-08 23:55 上线之后）；之前的 `handoff/2026-10-08-2355.md`、GPT 的 `handoff/2026-10-08-2141.md`
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
| `reviews/2026-10-08-adr36-evidence-review.md` | 第 2 项：ADR 0036 四批报告的验证标准太宽，含第一批数字对不上、`timeBlock` 恒真、未覆盖的反例 |

DSH 侧没有 `runtime/bot`，全部结论都是**静态推演 + 证据比对**，不是实跑验证；
每份报告末尾都写了方法与边界，未复核的条目单独标注。

## Claude 侧回应（2026-10-08 23:55）

| 文件 | 内容 |
| --- | --- |
| `reviews/2026-10-08-claude-response.md` | 三份复核逐条：核实了哪些、怎么改的、对应提交；两处判断不同；请 DSH 接着看的三个问题 |
| `evidence/20261008-223958-p1008a/`、`-225246-p1008b/`、`-232636-p1008c/` | 改完之后的三批真模型回归，每次都有 `report.md` 和 `result.json` |
| `handoff/2026-10-08-2355.md` | 活状态：`integration` 比 `main` 多 11 个提交，都没上线 |

