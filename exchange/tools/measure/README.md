# 量化工具（measure）

2026-10-21/22 做“更像人”那一轮时写的一次性脚本，原来在会话临时目录里，会话一结束就没了；放这里，下次一条命令就能复测。
**只出数字或挑出来的句子，不改任何东西。** 路径是这台机器上写死的（线上数据 `C:/Users/XG/Desktop/Project/qqbot/runtime/bot/chats/2260168937.jsonl`、真人样本
`qqbot-exchange/exchange/research/2026-10-real-chat/`、模拟输出 `qqbot-claude2/runtime/sim/<批次>/`），换机器要改。
真人样本只有 120 轮（女方一侧）、偏冲突片段，任何比例都有几个点的误差，别读得太细。

| 脚本 | 看什么 | 用法 |
| --- | --- | --- |
| `live-bubbles.cjs` | 线上她每天每轮发几条、每条多长、带问号的比例、她先开口的轮次 | `node live-bubbles.cjs` |
| `bubble-dist.cjs` | 每轮条数分布：真人女生 / 男生样本 vs 模拟批次 | `node bubble-dist.cjs "标签=批次目录,批次目录" …`（目录用相对 `runtime/sim` 的路径） |
| `filler-stats.cjs` | “废话”占比：笑 / 语气词 / 应声 / 无聊类，整轮都是废话、首条、含废话 | `node filler-stats.cjs "标签=批次目录,…"`，线上用 `标签=live:<chats 目录>` / `liveuser:<目录>` |
| `laugh-attached.cjs` | 带笑 / 拖音 / 语气词收尾 / 感叹 / 省略号 / 表情的轮次占比（线上他和她、真人、模拟批次） | `node laugh-attached.cjs "标签=批次目录,…"` |
| `tail-topic.cjs` | “无关的结尾条”：≥2 条的轮次里最后一条和他上一轮没有共同两字词、也不是问句（她答完后另带一件事的宽松尺子） | `node tail-topic.cjs "标签=批次目录,…"` |
| `agenda-stats.cjs` | DSH 的四个数：自带议程 / 带问句 / 只应一声 / 安抚词 | `node agenda-stats.cjs 批次目录…` |
| `agenda-when.cjs` | 真人什么时候带自己的事：按他上一轮是不是问句、多长切开 | `node agenda-when.cjs` |
| `agenda-turns.cjs` / `filler-turns.cjs` / `split-turns.cjs` | 把提示词里带“自己的事 / 废话 / 分成 N 条”的轮次挑出来，看他的话和她的回复 | `node xxx-turns.cjs 批次目录…` |
| `filler-examples.cjs` | 真人样本里的废话轮次和它的上文 | `node filler-examples.cjs` |
| `content-stats.cjs` / `mirror.cjs` / `show-pairs.cjs` / `shape-compliance.cjs` | 首条气泡的内容占比；她和他的字数对照；成对挑句子；形状计划有没有被遵守 | 见各文件头 |
| `check-sysmsg.mjs` | 只读：她的 B 站号的系统通知 / 未读数 / 会话列表（风险检查用，不打印凭证） | `node check-sysmsg.mjs` |
| `crisis-probe.mjs` | 危机检测的 29 句探针（DSH 的复核），看有几句和预期不符 | `node crisis-probe.mjs` |

批次目录的写法：`./20261021-203823-replay-int-a` 这样的相对路径（先 `cd qqbot-claude2/runtime/sim`）。Git Bash 里不要给带逗号的 `/c/…` 绝对路径（会被改写）。

## 10-22 补充：深夜测试对话（“还是有 AI 味”）

| 脚本 | 看什么 | 用法 |
| --- | --- | --- |
| `ai-smell.cjs` | 线上她最近的气泡里：理由 / 反驳从句、重复、叮嘱 / 劝慰 / 给方案、自证 / 解释、逗号、打转的字词 | `node ai-smell.cjs 2026-10-19T00:00:00+08:00` |
| `make-night-scenario.cjs` | 把用户 10-22 01:00 起的真实提问做成可重放的场景（只写到会话临时目录，不进仓库） | `node make-night-scenario.cjs` |
| `night-compare.cjs` | 同一个场景改代码前后各跑 3 次，比自证 / 往后推的字词 / 金句体 / 重复片段 | `node night-compare.cjs <基线批次目录> <新批次目录>` |

注意：逗号不是“AI 味”——用户自己带逗号的话占 43%，她形状控制后 35%，对上了；别再拿它当尺子。

## 10-22 补充：“太顺”（ADR 0099）——带上文 + 按回复方式分类

旧的鉴别员是单轮、没上文的，看不懂半句话就只能回“咋啦”，而且对改动不敏感（54–59%，±3–6）。这一套换成：带上文重放真人情侣对话 + 另一个调用给回复方式分类，每个版本跑三份不同抽签（共 216 条）。
**路径写死在这台机器和当时的会话临时目录**（`SP` / `OUT` / 各脚本头部），换环境先改路径；用的是 `qqbot-claude2/packages/bot` 里的 `llm.ts` / `config.ts`（要环境变量 `QQBOT_LLM_API_KEY`）。

| 脚本 | 看什么 | 用法 |
| --- | --- | --- |
| `make-ctx-variants.cjs` | 把 `exchange/research/2026-10-real-chat` 里 boyfriend 的 22 段做成 72 个带上文的单轮场景（`history` = 这一轮之前最多 8 条），分 3 份放进 `ctx-<v>-chunk-N`；`v0/v1/v2` 起点错开 0 / 11 / 23 分钟 = 不同抽签 | `node make-ctx-variants.cjs v0` |
| `run-config.sh` | 对一个变体跑模拟器（3 路并行，要先拿 `%TEMP%\qqbot-heavy.lock`） | `bash run-config.sh v0 <标签> --feel` |
| `prep-hers2.cjs` | 从模拟输出取她**最后一次**连续回复（带上文时聊天文件里先有历史行，不能取第一次） | 见文件头 |
| `annotate.mts` | 另一个调用按回复方式分类（完整接话 / 部分 / 应一声 / 短追问 / 自己的事 / 带情绪）+ 解释 / 劝慰 / 俏皮 / 疑问 / 补细节 / 顺从；`human` = 真人回复 | `node annotate.mts <标签> <hers.json|human>` |
| `judge-ctx.mts` | 带上文的鉴别员（旧的 `blind-judge-cli` 的带上文版） | `node judge-ctx.mts <hers.json> <标签>` |
| `collect.sh` | 一个标签 + 变体：取回复 → 分类 → 鉴别 | `bash collect.sh <标签> v0` |
| `pool.cjs` | 把某标签的 `v0..v2` 合并成一行，和真人对照 | `node pool.cjs base feel3` |

读法：真人（71 对）完整接话 23% / 带情绪 38% / 顺从 4% / 补细节 20%；ADR 0099 前她是 47 / 21 / 20 / 37。别拿鉴别员的百分比当尺子，它分不出。
