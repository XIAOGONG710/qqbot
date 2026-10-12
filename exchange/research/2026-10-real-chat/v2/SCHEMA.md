# v2 语料格式（K1/K2）

对应任务：`exchange/tasks/2026-10-12-dsh-corpus-n2.md`（Claude，2026-10-12 12:35 发布）。
复核：`exchange/reviews/2026-10-12-claude-review-dsh-corpus-v2-k1k2.md`（Claude，12:50）——**格式 OK**，
本版按它的 7 处小改与反例调整改过一遍（见第 7 节）。

## 1. 文件

| 文件 | 内容 |
| --- | --- |
| `samples.jsonl` | 30 段（`rc-001`..`rc-030`）补标注后的版本，编号沿用原 `../samples.jsonl` |
| `closing-turns.jsonl` | 6 段收尾（`ct-001`..`ct-006`）补标注后的版本 |
| `counterexamples.jsonl` | 反例库，`cx-001`..`cx-076`（中间有跳号，见第 7 节），7 类 |
| `counterexamples.md` | 每类 2 条最典型的 |
| `samples-b1.jsonl` | **K3 第一批（试采）**：5 段，`rc-b1-001`..`rc-b1-005`，字段与 `samples.jsonl` 一致，另带 `stats_scope` |
| `samples-b2.jsonl` | **K3 第二批**：4 段，`rc-b2-001`..`rc-b2-004`（用「登录态副本」跑的那轮；`rc-b2-003` 是 `persona_fit: high`） |
| `batch1.md` / `batch2.md` | 两批说明：怎么采、抄录脱敏、没收的、本批段落、流水线的坑 |
| `user-browse-route.md` | 路线 1（用户自己翻、我只读本机数据）给用户看的一页：搜索词、缓存路径、另存文件夹 |
| `annotate.py` | K1 生成脚本：读 `../samples.jsonl`、`../closing-turns.jsonl`，写本目录两个 jsonl |
| `build_counterexamples.py` | K2 生成脚本：反例表 → jsonl + md |
| `build_batch1.py` / `build_batch2.py` | K3 生成脚本：脱敏抄录表 + 人工标注 → `samples-b1/2.jsonl`（原始图已删，脚本自带抄录内容） |
| `check.py` | K1/K2 自检门：字段、编号、统计可复算、反例编号唯一、反例来源行真实存在 |
| `check_batch.py` | **K3 批次自检门**：脱敏硬规则（≤20 字/气泡、无号码/链接/账号、无日期钟点）+ 格式 + 编号唯一 |

原文件 `../samples.jsonl`、`../closing-turns.jsonl` **未改动**，产物全部落在 `v2/`。

## 2. 字段

在原有字段（`id`/`context`/`turns`/`her`/`confidence`/`notes`…）之上新增：

| 字段 | 位置 | 口径 |
| --- | --- | --- |
| `relation` | 顶层 | 沿用 `boyfriend` / `bestie` / `friend`；拿不准的保留 `unknown`（`rc-003`、`rc-022`、`rc-028`） |
| `scene` | 顶层 | 原 1–8 不变，新增 `9` = 约人 / 改约 / 取消 / 拒绝。`closing-turns` 全部记 `5`（「收尾」渠道抽样，按原口径归 5） |
| `turns[].act` | **只标她这一侧** | 10 个取值：`answer` `confirm` `comfort` `joke` `share` `clarify` `ask` `refuse` `close` `silent` |
| `turns[].mood` | **只标她这一侧** | 7 个取值：`平` `开心` `难过` `生气` `撒娇` `无聊` `累` |
| `turns[].stats` | **只标她这一侧** | `{bubbles, median_chars, asked, asked_strict, switched_topic}`，见第 3 节 |
| `stats` | 顶层 | 聚合：`her_turns`、`silent_turns`、`bubbles_per_turn_median`、`bubbles_per_turn_counts`、`median_chars`、`asked_rate`、`asked_strict_rate`、`switched_topic_count` |
| `persona_fit` | 顶层 | `{level: high/mid/low, why}`；对照 `characters/linmengyao/source/persona.yml`——**像不像她**，不是像不像真人。`her` 未知的样本记 `n/a` |
| `stats_scope` | 顶层 | `in`（进所有统计）/ `overall_only`（只进总体，不进按关系的表）/ `excluded`（不进任何统计）；可选 `stats_scope_why` |
| `staged` | 顶层 | 照旧；`closing-turns` 原来写字符串 `yes/no`，v2 统一成布尔，原值位置记在 `staged_note` |

**主键统一成 `id`**（复核第 1 条）：`closing-turns.jsonl` 原来叫 `key`，v2 起没有 `key` 字段。

**收尾样本独有的三个字段**（复核第 2 条）：`population`（人群）、`use`（用途）、`skip`。
6 条收尾全是 `use: evidence-only`，人群都不是目标人群（已婚 3、年龄不明 2、两名男性 1）。
**`evidence-only` 的不进任何分布统计**，只当「收尾怎么说」的例子——用它们算分布会整体带偏。

**`stats_scope` 的三处既有脏点**（复核第 3 条）：
- `rc-026` 实为家庭群（3 人）对话 → `excluded`，文件里保留但不进任何统计；
- `rc-003` / `rc-022` / `rc-028` 关系未知 → `overall_only`，只进总体，不进按关系的表；
- K3 新采的一律不收拿不准的（关系判不出、说话人判不出的都不收）。
`stats.silent_turns` 记她整轮没回的轮数；`median_chars` 的聚合**排除空轮**。

非她那一侧的轮次**不带** `act`/`mood`/`stats`，`check.py` 会拦。

## 3. 脚本算 vs 人工标

| 项 | 谁做 | 说明 |
| --- | --- | --- |
| `bubbles` | 脚本 | 她这一轮的气泡数 |
| `median_chars` | 脚本 | 她这一轮各气泡 **Unicode 码点**数的中位数 |
| `asked` | 脚本 | **宽松口径**：该轮任一气泡末尾是 `？`/`?` 或末尾是 `吗`/`呢`/`吧`（旧 README 1.3 的口径，留着做对照） |
| `asked_strict` | 脚本 | **严格口径**：与 `packages/bot/src/sim/stats.ts` 一致——问号或 `吗`/`呢`/`么` 结尾，去掉反问（是吧、对吧、难道、不是吗…），**不含「吧」**。**K4 拿她的数来对照时用这一列** |
| `switched_topic` | **人工** | 脚本判不出「有没有自己转话题」 |
| `act` / `mood` | **人工** | 语义判断 |
| `persona_fit` | 人工 | 对照 persona.yml |

复算：`python annotate.py && python build_counterexamples.py && python check.py`。
原语料只读，脚本重跑结果稳定（`check.py` 会逐条比对脚本算出的数与文件里的数）。

## 4. 三个结构约定

- **`silent`（K3 起用）**：她整轮没回时，显式记一条空轮——
  `{"who":"B","bubbles":[],"gap":"…","act":"silent","mood":"平","stats":{"bubbles":0,"median_chars":0,"asked":false,"asked_strict":false,"switched_topic":false}}`。
  只在能看出来的时候记：对方连着发了两轮以上、中间隔着明显间隔，或下一张图里她明确回「刚看到」。
- **`closing-turns` 的 `closing` 字段改名为 `turns`**：与 `samples.jsonl` 统一，其余字段原样保留。
- **`ct-006` 的 `her` 是未知**（原值 `?`）：v2 里 `her: null`、`persona_fit.level: n/a`、不标任何 act/mood，
  它不参与任何女性说话方式的结论。

## 5. 反例库（K2）

- 7 类：助手腔、过度安慰、复述对方的话、机械追问、强行汇报生活、连续三段式、编造没有的事。
- 每条 `{id, type, source, line, why, nearest_real, source_date, still_reproduces}`；
  `source` 写成 `仓库内路径:行号`，`line` 必须是该行的原文子串——`check.py` 会打开文件核对，**编来源会被拦下**。
- **「连续三段式」的单位是一整轮**：`line` = 这一轮所有气泡用 ` / ` 连起来，另带 `turn_bubbles`（气泡数）与 `turn_sentences`（句数）；
  `check.py` 会逐段核到 `source` 那几行里。
- `source_date` 标明证据是哪个版本的产物；`still_reproduces: null` = 还没用现在的版本回放测过（留给 Claude/GPT 回放后填）。
- `nearest_real` 是语料里的真人样本编号，只指方向，不表示两者等价。
- 来源只用仓库里现成的东西（`exchange/evidence/*/**/report.md` 的模拟器重放、`exchange/live/2026-10-08/` 的线上聊天、
  `exchange/reviews/` 里记下的现场）；**没有**登录任何平台、**没有**新采数据。

## 6. 已知边界

1. 「编造没有的事」这一类的证据最薄：语料里没有专门的「编事」检查项；现行 8 条里 4 条是硬的（还没有相机、编绿萝、替第三方编话、把经过说成发生），另 4 条靠复核记录与记忆失真（`why` 里都写明依据）。
2. `rc-026` 实为家庭群、`rc-003/022/028` 关系未知——按第 2 节的 `stats_scope` 处理，K1 只做标注与标记，**没有删改原文件**。
3. 本机没有线上 `runtime/`，所有结论是静态比对，不是实跑验证。

## 7. 本版相对第一版（`5b44def`）的改动

按 Claude 复核（`exchange/reviews/2026-10-12-claude-review-dsh-corpus-v2-k1k2.md`）：

| # | 改了什么 |
| --- | --- |
| 1 | 收尾样本主键 `key` → `id`，与前一份统一 |
| 2 | SCHEMA 补 `population` / `use` / `skip`，并写清 `evidence-only` 不进分布 |
| 3 | 问句给两个口径：`asked`（宽松，旧）/ `asked_strict`（严格，对齐 `sim/stats.ts`）；K4 用严格 |
| 4 | 「连续三段式」的 `line` 改成一整轮所有气泡（` / ` 连接），带 `turn_bubbles` / `turn_sentences` |
| 5 | 每条反例加 `source_date` 与 `still_reproduces: null` |
| 6 | 去重后统计：不同来源行 67 条、不同原话 71 条（同一句可以犯两个毛病，按去重后的句子数报） |
| 7 | 「复述对方的话」补两个别的来源（`cx-074` / `cx-075`，来自线上聊天而不是同一个模拟场景） |
| — | 删旧 `cx-066`（拍照不算许做不到的诺）、旧 `cx-067`/`cx-068`（三体那两句与旧说法一致，属重复话头）、旧 `cx-069`（「我刚算了一下」是口语）；编号留空不复用，新条目从 `cx-070` 起 |
| — | 编造补 4 条硬证据：`cx-070`（思考里编了一句他没说的话）、`cx-071`（杭州）、`cx-072`（耳机）、`cx-073`（小皮鞋） |
| — | 三段式补 1 条（`cx-076`，001318-c1 r4：4 句发成 2 条） |

## 8. 表情包 / 图片 / 语音占位符的口径（Claude 10-12 复核，K3 批次后统一）

`[表情包]` `[图片]` `[语音]` 这类占位符**也是一条消息**（`bubbles` 照数），但它不是她打的字：

| 字段 | 怎么算 |
| --- | --- |
| `stats.bubbles` | 该轮气泡条数（含占位符） |
| `stats.text_bubbles` | 其中文字气泡的条数 |
| `stats.truncated` | 其中被脱敏截断的气泡数（「…」结尾） |
| `stats.median_chars` | **只数文字气泡、且排除截断的**；两者都没有时为 `null`（原来会把 `[表情包]` 当 5 个字算进去） |
| `stats.stickers` | `{"表情包": n, "图片": n, "语音": n}` |
| `stats.asked` / `asked_strict` | 只在文字气泡上判（截断的不排除） |
| 顶层 `stats.stickers_total` / `sticker_turns` | 该段合计的占位符个数 / 含占位符的轮数（**含「图片」，跟 K4 对照请用 `turns[].stats.stickers.表情包`**） |
| 顶层 `stats.truncated_bubbles` | 该段合计的截断气泡数 |

实现共用 `annotate.py` 里的 `is_sticker / text_bubbles / counted_bubbles / truncated_count / sticker_counts / turn_median`；`check.py` 与 `check_batch.py` 都 import 同一套，避免两边算得不一样。

**重算后（36 段 + 5 段 + 4 段）**：K1 那 36 段里只有 `rc-005`、`ct-002` 各 1 个占位符（各 1 轮），`ct-006` 整段只有占位符 → `median_chars: null`；K3 批次里 `rc-b1-001` 3 个、`rc-b1-002` 1 个、`rc-b1-005` 1 个、`rc-b2-004` 1 个占位符。
**截断气泡共 28 个**（rc 23 + ct 1 + b1 2 + b2 2），按 Claude 10-12 复核从 `median_chars` 里剔除；`rc-b2-001` 的中位字数因此从 19 变成 **13**。

**另外（复核建议）**：关系是「暧昧期」的两段（`rc-b1-002` / `rc-b1-003`）加了 `relation_note`，K4 的「朋友 / 闺蜜」格不要把调情语域混进去。


