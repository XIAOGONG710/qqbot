# v2 语料格式（K1/K2）

对应任务：`exchange/tasks/2026-10-12-dsh-corpus-n2.md`（Claude，2026-10-12 12:35 发布）。
本目录是**交付格式的草案**：Claude 和 GPT 先审格式，格式定了才放大采集（K3）。

## 1. 文件

| 文件 | 内容 |
| --- | --- |
| `samples.jsonl` | 30 段（`rc-001`..`rc-030`）补标注后的版本，编号沿用原 `../samples.jsonl` |
| `closing-turns.jsonl` | 6 段收尾（`ct-001`..`ct-006`）补标注后的版本 |
| `counterexamples.jsonl` | 反例库，`cx-001`..`cx-069`，7 类 |
| `counterexamples.md` | 每类 2 条最典型的 |
| `annotate.py` | K1 生成脚本：读 `../samples.jsonl`、`../closing-turns.jsonl`，写本目录两个 jsonl |
| `build_counterexamples.py` | K2 生成脚本：反例表 → jsonl + md |
| `check.py` | 自检门：字段、编号、统计可复算、反例来源行真实存在 |

原文件 `../samples.jsonl`、`../closing-turns.jsonl` **未改动**，产物全部落在 `v2/`。

## 2. 字段

在原有字段（`id`/`context`/`turns`/`her`/`confidence`/`notes`…）之上新增：

| 字段 | 位置 | 口径 |
| --- | --- | --- |
| `relation` | 顶层 | 沿用 `boyfriend` / `bestie` / `friend`；拿不准的保留 `unknown`（原 `rc-003`、`rc-022`、`rc-028`） |
| `scene` | 顶层 | 原 1–8 不变，新增 `9` = 约人 / 改约 / 取消 / 拒绝。`closing-turns` 全部记 `5`（它们是「收尾」渠道抽出来的样本，按原口径归 5） |
| `turns[].act` | **只标她这一侧** | 10 个取值：`answer` `confirm` `comfort` `joke` `share` `clarify` `ask` `refuse` `close` `silent` |
| `turns[].mood` | **只标她这一侧** | 7 个取值：`平` `开心` `难过` `生气` `撒娇` `无聊` `累` |
| `turns[].stats` | **只标她这一侧** | `{bubbles, median_chars, asked, switched_topic}`，含义见第 3 节 |
| `stats` | 顶层 | 该段的聚合：`her_turns`、`bubbles_per_turn_median`、`bubbles_per_turn_counts`、`median_chars`、`asked_rate`、`switched_topic_count` |
| `persona_fit` | 顶层 | `{level: high/mid/low, why}`；对照 `characters/linmengyao/source/persona.yml`——**像不像她**，不是像不像真人。`her` 未知的样本记 `n/a` |
| `staged` | 顶层 | 照旧；`closing-turns` 原来写字符串 `yes/no`，v2 统一成布尔，原值位置记在 `staged_note` |

非她那一侧的轮次**不带** `act`/`mood`/`stats`，`check.py` 会拦。

## 3. 脚本算 vs 人工标

| 项 | 谁做 | 说明 |
| --- | --- | --- |
| `bubbles` | 脚本 | 她这一轮的气泡数 |
| `median_chars` | 脚本 | 她这一轮各气泡 **Unicode 码点**数的中位数 |
| `asked` | 脚本 | 该轮任一气泡末尾是 `？`/`?` 或末尾是 `吗`/`呢`/`吧`（沿用 `../README.md` 1.3 的口径） |
| `switched_topic` | **人工** | 脚本判不出「有没有自己转话题」，由标注人给布尔值 |
| `act` / `mood` | **人工** | 语义判断 |
| `persona_fit` | **人工** | 对照 persona.yml |

复算：`python annotate.py && python build_counterexamples.py && python check.py`。
原语料只读，脚本重跑结果稳定（`check.py` 会逐条比对脚本算出的数与文件里的数）。

## 4. 两个结构约定

- **`silent` 目前标不出来**：轮次对象是因为「有气泡」才存在的，她整轮没回时没有对象可标。
  这个取值留给 K3——采集时要显式记一条「她这一轮没回」的空轮，否则已读不回在语料里是隐形的。
- **`closing-turns` 的 `closing` 字段改名为 `turns`**：与 `samples.jsonl` 统一，其余字段原样保留。
- **`ct-006` 的 `her` 是未知**（原值 `?`）：v2 里 `her: null`、`persona_fit.level: n/a`、不标任何 act/mood，
  它不参与任何女性说话方式的结论。

## 5. 反例库（K2）

- 7 类：助手腔、过度安慰、复述对方的话、机械追问、强行汇报生活、连续三段式、编造没有的事。
- 每条 `{id, type, source, line, why, nearest_real}`；`source` 写成 `仓库内路径:行号`，
  `line` 必须是该行的原文子串——`check.py` 会打开文件核对，**编来源会被拦下**。
- `nearest_real` 是语料里的真人样本编号，只指方向，不表示两者等价。
- 来源只用仓库里现成的东西（`exchange/evidence/*/**/report.md` 的模拟器重放、`exchange/live/2026-10-08/` 的线上聊天）；
  **没有**登录任何平台、**没有**新采数据。

## 6. 已知边界

1. 「编造没有的事」这一类的证据最薄：语料里没有专门的「编事」检查项，其中 2 条靠检查项的❌反推（已在 `why` 里写明），不是一眼可判的编造。
2. `rc-026` 实为家庭群（3 人）的对话，`relation` 记的是 `friend`；群聊按 README 不收，这一段是既有语料的遗留，K1 只做标注、没有删改。
3. 本机没有线上 `runtime/`，所有结论是静态比对，不是实跑验证。
