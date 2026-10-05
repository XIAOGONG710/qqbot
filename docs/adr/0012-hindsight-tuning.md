# ADR 0012：Hindsight 调优——趁记忆从头攒，先把写入和召回调好

- 状态：已采纳（2026-10-05：待定问题与用户确认，见文末「确认记录」）
- 日期：2026-10-05
- 关联：[ADR 0004](0004-time-scheduling-memory.md) 决策 3（长期记忆接 Hindsight）、[ADR 0011](0011-proactive-messages.md)（主动消息要靠记忆；第 10 节测试数据归档、记忆从头攒）、
  [docs/hindsight.md](../hindsight.md)（部署：hindsight-api-slim 0.10.2、PGroonga 二字切分、`multilingual-e5-small`、重排 `rrf`、DeepSeek 抽取）

## 背景

用户 10-05 要求 M5 这一阶段加上 Hindsight 调优，按官方文档和最佳实践来。时机正好：ADR 0011 第 10 节要把记忆归档、从头攒，
写入格式、mission、时区这些在攒之前改好，旧数据就不用重抽。

### 取证（2026-10-05，一个只读的子代理 + 我核对）

读了 v0.10.2 标签下的官方文档（best-practices、retain、retrieval、multilingual、observations、mental-models、memory-banks、models、performance、changelog）
和博客《Structuring Chat Logs for Agent Memory》，对照装着的 0.10.2 源码（`runtime/hindsight/venv/.../hindsight_api/`）核实默认值和实际行为。
v0.10.2 是最新发布版（2026-09-29），之后 main 上的改动和我们的问题无关，不升级。

我自己又核对了两条最要紧的：PGroonga 关键词检索匹配的是 `text || context || text_signals`（`engine/sql/postgresql.py` 381–398 行）；
`dry-run-extract`（只抽取、不写库，能在请求里覆盖 mission 和块大小）默认开着（`config.py` `DEFAULT_ENABLE_DRY_RUN_EXTRACT = True`）。

**发现的问题，按影响排：**

| # | 现状 | 问题 | 依据 |
| --- | --- | --- | --- |
| 1 | 写入时每个片段带一段约 70 字的 `context`（`long-term.ts` 170 行） | `context` 原样存进每条事实，而且在关键词检索的范围里。里面「不是」「聊天」「真实」「消息」这些常用二字词，查询里只要有一个，全库都命中，`rrf` 没有重排把这些噪声压下去。绰号常排在第 8–10 条，这是原因之一 | `fact_extraction.py` 3272 行、`sql/postgresql.py` 381–398 行 |
| 2 | 写入的 `timestamp`、召回的 `query_timestamp` 用 `toISOString()`（UTC） | 抽取时按这个时间的日期和星期换算「明天」「下周三」，北京时间 0–8 点会差一天；召回时「今天」「昨天」也按 UTC 的日历日算 | `fact_extraction.py` 1830 行、`chinese_temporal_periods.py` |
| 3 | 转写每行带 `[message_id=…]` 和完整的带时区时间（`episodes.ts` 34–40 行） | 每行约 50 字符开销；默认每 3000 字符一块分开抽取，一块只装约 40 条，块边界会切断「那个面试」这种指代；消息里的换行让第二行没有说话人 | 官方推荐格式 `名字 (时间): 内容`；`config.py` 1629 行、`fact_extraction.py` 553–657 行 |
| 4 | `retain_mission` 7 句通用话（`long-term.ts` 36–44 行） | 没写清「谁说的、关于谁」「她的虚构日常不是他的事」「未来的事写成绝对日期」「绰号写成谁的什么」「近几天的状态也记」；内置的精简模式会丢掉短期状态 | mission 放在内置规则之前、优先级更高（`fact_extraction.py` 1764–1781 行） |
| 5 | 召回结果的日期前缀用 `occurred_start`（`long-term.ts` 293 行） | 观察（多条事实整合的）的 `occurred_start` 是来源里最早的日期，「现在戒糖了」会被标成最早那天 | `consolidator.py` 270–272 行 |
| 6 | 关系概况 `max_tokens: 300`、源查询写「150 字以内」 | `max_tokens` 会变成「写约 300 token」的长度指令，和「150 字」打架；自动刷新失败后会暂停，直到手动刷新成功一次 | `reflect/prompts.py` 813–832 行 |
| 7 | 主动消息的召回用「最近几句」作查询（ADR 0011 第 4 步） | 最近几句常是「晚安」「明天见」，里面的「明天」会按现在去解析，落到错的日子 | `temporal_window` 只加权、不过滤（`response_models.py` 314 行） |
| 8 | 召回查询截 400 字 | 超过 500 token 时接口直接返回 400 | `http.py` 6028–6036 行 |
| 9 | 记忆写入进度文件按「QQ + 档位」存（`memory/<QQ>-<档位>.json`），不分 bank 前缀 | 换了 bank 前缀，进度文件还说「这些片段写过了、mission 写过了」：新 bank 不写 mission，旧片段也不写进去 | 我读代码发现的（`long-term.ts` `#load`） |

**要你定的（有代价的）：**

- **重排**：现在是 `rrf`（不用模型，按名次融合）。官方多语言文档建议中文配多语言重排模型。可选：
  - flashrank：本地 ONNX，要另装 flashrank 包；多语言模型 `ms-marco-MultiBERT-L-12` 的中文效果没人测过；这台机器只有 4 GB 内存。
  - siliconflow 的远程重排：要 key，聊天内容会多发给一家服务商。
  - 本地 sentence-transformers：要 torch，slim 版不适合。
- **embedding**：现在是 `multilingual-e5-small`（384 维）。换更大的（e5-base、bge-m3）要清空整个库（embedding 维度是全库的），只有这次重攒时换成本最低；
  但模型大好几倍，这台机器只有 4 GB 内存，Hindsight、PostgreSQL、Koishi、NapCat 都在上面。

## 决策（提议）

### 1. 直接做（只改我们的客户端，不清库）

1. **`context` 缩成一句**：`QQ 私聊：{char}（AI 扮演）和{user}`。「都是真实发出的消息、不是示例、她的日常是虚构的」挪进 `retain_mission`（mission 不进索引）。
2. **时间都带本机时区**：写入的 `timestamp`、召回的 `query_timestamp` 改用 `episodes.ts` 已有的 `localIso()`。
3. **转写瘦身**：去掉 `[message_id=…]`（片段 id 已经能追溯）；时间只写 HH:MM，换日时插一行「—— 10月6日 星期二 ——」；消息里的换行换成「／」。
4. **重写 `retain_mission`**：逐条写明——
   - 每条事实写清谁说的、关于谁，用名字，不写「用户」；
   - {char} 说的自己的日常照记，但标明是她说的，不能当成 {user} 的事；
   - {user} 说的之后要发生的事，写成绝对日期加上午 / 下午，按那一行的时间换算；
   - 绰号写成「铁锅（{user}的组长）」；否定和更正各单列一条；
   - 生病、心情差这类近几天的状态也记，带日期；{char} 复述以前聊过的事不算新事实；寒暄、表情不记。
5. **观察的日期**用 `mentioned_at`（最近一次被提到的时间），事实照旧用 `occurred_start`。
6. **关系概况**：`max_tokens` 改 256（接口最小值），刷新的 `budget` 改 `low`；源查询加「写几月几日，不写今天 / 明天；过去的事只写结果」；
   状态页显示它多久没刷新了，太久没更新就手动刷新一次。
7. **主动消息的召回**：查询 = 时机说明（「他最近在忙什么、身体心情、这几天的安排」）+ 当天待跟进的事 + 最后话题的一两句；
   带 `temporal_window` = [现在 − 3 天, 现在 + 2 天]。
8. 召回查询截到 300 字。
9. **进度文件跟着 bank 走**：进度文件里记着 bank ID，和现在算出来的对不上（换了前缀）就当作新的，重新写 mission、重新写入片段。

### 2. 怎么验证

- **抽取**：用 `dry-run-extract`（只抽取、不写库）拿 5–6 段编的对话（含绰号、否定、更正、她的虚构日常、半夜说的「明天下午面试」、跨午夜的片段），
  改前、改后各抽一遍，逐条比：说话人对不对、她的日常有没有被记成他的事、日期对不对。只调 DeepSeek，不碰真实聊天记录。
- **召回**：模拟器 `boyfriend-memory`（临时 bank）跑 3 次；加一个场景：灌到 100 条以上的记忆，用带「不是」「今天」的查询看绰号、偏好变化、日期排第几（`trace` 看分数）；
  再加 ADR 0011 的「明天下午面试」，第二天早安的召回里要有这一条。
- 单元测试：请求体的形状（时区、`context`、转写格式、`temporal_window`）、观察用哪个日期、进度文件换前缀后重来。

### 3. 上线：和 M5 一起

代码改完、验证过，在重启 Koishi 上线 M5 时，在控制台换 bank 前缀（例如 `linmengyao-1006`）。有了第 1 节第 9 条，换前缀后新 bank 自动写 mission、
把记录起点（ADR 0011 第 10 节）之后的片段按新格式写进去。旧 bank 留在 Hindsight 里不删。

## 待定问题

1. **重排**：先不换，做完第 1 节、用 `trace` 看排名再说（倾向）/ 装本地 flashrank 试 / 用 siliconflow 远程重排。
2. **embedding**：不换，继续 e5-small（倾向，内存只有 4 GB）/ 趁这次重攒换 e5-base（先量内存）。

## 后果

- 写入的格式、mission 变了：以后和旧 bank 里的记忆不可比，旧 bank 也不再读。
- 主动消息的召回多一个时间窗参数，查询不再只是「最近几句」。
- 重排、embedding 不变时，绰号的排名主要靠第 1 条去噪声来改善；改善不够再回到待定问题 1。

## 确认记录（2026-10-05）

1. 重排：先不换，做完第 1 节、用 `trace` 看排名再说（倾向）。
2. embedding：不换，继续 e5-small（倾向）。
3. bank 前缀：等 M5 上线重启 Koishi 时再换（第 3 节）。会话里我先请用户「现在就换」，读完调研后改了主意：
   进度文件不分前缀（问题 9），现在换会让新 bank 没有 mission；格式也还没调。用户同意改到上线时换。
