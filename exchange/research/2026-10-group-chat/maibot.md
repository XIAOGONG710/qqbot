# MaiBot（麦麦 / MaiSaka）群聊行为设计机制清单

**调研对象**：`Mai-with-u/MaiBot`（GitHub，GPL-3.0，★6.2k，`pyproject.toml` 版本 `1.3.8`，2026-10-15 仍在推送）
**调研方式**：只读公开资料。raw.githubusercontent.com 直连在本机被阻断，改用 `gh-proxy.com` 镜像与 GitHub 公开 REST API 读原始文件。未登录账号、未用 cookie、未下载可执行文件。
**访问日期**：2026-10-15
**证据等级**：`代码` = 我读了源码文件并给出路径；`文档` = 官方文档站 / 仓库内 md；`帖子` = 博客、Issue 正文（只当线索）；`没找到` = 公开资料里没有。
**重要口径**：Issue 正文是「用户声称」，不等于我复现；我把它标为「帖子/Issue 声称」。

---

## ① 一句话它是什么

一个 Python 写的 QQ/多平台群聊「拟人化」Agent：把「要不要说话」交给一个 Planner 模型决策、把「怎么说」交给 Replyer 模型生成，宣称目标是「最像而不是好」的群聊生命体，而不是功能齐全的助手（README 设计理念一节，`文档`：[README.md](https://github.com/Mai-with-u/MaiBot/blob/main/README.md)）。

---

## ② 说话时机机制（逐条 + 证据）

1. **两段式架构**：Planner（决策+工具调用，正文不展示）→ `reply` 工具才真正发言。提示词明确写「你无法不调用 reply 工具直接回复」（`代码`：`prompts/zh-CN/maisaka_chat.prompt` L18）。
2. **@ 必回复**：`chat.reply_timing.inevitable_at_reply` 默认 `True`；命中后置 `_forced_turn_enabled`，**绕过频率阈值**直接进入 Planner（`代码`：`src/config/official_configs.py` L520、`src/maisaka/runtime.py` L1352-L1395）。@ 触发也占动态门控额度（`代码`：`src/maisaka/turn_trigger/scheduler.py` L76-L84）。
3. **提及（叫名字/别名）可配置必回**：`mentioned_bot_reply` 默认 `False`；`is_mentioned_bot_in_message()` 用 `bot.nickname + alias_names` 扫文本，也认适配器注入的 `mention_bot` 段（`代码`：`src/config/official_configs.py` L506、`src/chat/utils/utils.py` L145-L177）。
4. **关键词/正则规则**：命中不直接发消息，只给 Planner **追加一段固定反应提示**（`reaction`），由模型决定要不要开口（`代码`：`src/config/official_configs.py` L4365-L4459）。
5. **两种触发模式**：`reply_trigger_mode = "frequency"`（默认）或 `"dynamic"`（`代码`：`src/config/official_configs.py` L534）。
6. **频率模式 = 消息数阈值**：`threshold = ceil(1 / talk_value)`，即 `talk_value=0.5` 就要攒到 2 条新消息才思考；`talk_value` 0–1，群聊/私聊各一份（`代码`：`src/maisaka/runtime.py` L1194-L1199、`src/config/official_configs.py` L472-L504）。
7. **空窗补偿（沉默也会到场）**：新消息不足阈值时，按「最近 30 分钟平均消息间隔」把沉默时间折算成等效消息数；但**折算量硬上限为 threshold-1，且 pending=0 一律不触发**，即必须至少有一条真实新消息（`代码`：`src/maisaka/turn_trigger/gates.py` L213-L252）。
8. **动态模式 = 拟合概率 + 1 小时预算**：用 logistic 回归估计「这批消息进 Planner 后会不会 reply」（特征含是否提及、是否 @ 别人、有无问号、是否纯表情占位、近 5 分钟自己的发言占比、近 5 分钟消息数、距上次发言秒数、待处理条数；权重是离线拟合的硬编码常量）（`代码`：`src/maisaka/turn_trigger/reply_likelihood.py` 全文）。
9. **动态门控只保预算不放纵**：1 小时滑窗内 `目标回复数 = talk_value × 预计回复数`，反推 `keep_ratio` 概率阈值；且**只收紧不放宽**（防止一波消息过后系统性偏多）；窗口评分不足 20 条时用离线静态阈值表（`代码`：`src/maisaka/turn_trigger/dynamic_gate.py` L32-L56、L87-L211）。
10. **空闲退避（没人理就退场）**：连续 N 次（默认 2）整轮不回复后，等待 15s 起、指数翻倍、封顶 300s；新消息攒到 6 条（可配）立刻打断退避（`代码`：`src/maisaka/turn_trigger/idle_backoff.py` 全文；配置 `official_configs.py` L580-L644）。
11. **连续 wait 上限**：`max_consecutive_wait_count` 默认 3，达上限后 `wait` 工具拒绝继续等待，本轮进入休息（`代码`：`src/config/official_configs.py` L566、`src/maisaka/builtin_tool/wait.py` L36-L48）。
12. **连续打断上限**：`planner_interrupt_max_consecutive_count` 默认 0（`代码`：`official_configs.py` L551）。
13. **静默消费而非积压**：`talk_value=0` 时不回复，但把待处理消息直接「静默消费」进上下文，不会事后补答（`代码`：`src/maisaka/turn_trigger/scheduler.py` L67-L75）。
14. **没有「每分钟上限」这种显式闸门**：我没找到按分钟计数的硬限流；限流语义由「频率阈值 + 动态门控 1 小时预算 + 空闲退避 + 连续 wait 上限」组合承担（`没找到`：`grep` 全仓未命中 per-minute 限流配置）。
15. **回复拆条上限**：一次回复最多拆成 `max_split_num` 条（默认 3），单条 `max_length` 512，单次最多 8 句（`代码`：`official_configs.py` L4649-L4687）。
16. **快速反应模式（默认关）**：开启后思考中收到新消息立刻打断重来，`wait` 也可被打断，「不等待静默窗口，也不限制连续打断次数」（`代码`：`official_configs.py` L919-L930）。
17. **不说话不消耗对话**：Planner 决定不开口就不调工具、结束本轮；另有一层「写了要回复却没调工具」的规则兜底，最多提醒重试一次（`代码`：`src/maisaka/planner_reply_guard.py`、`official_configs.py` L958-L969）。

**已知反例（重要）**：低活跃群（说话人少）下空窗补偿曾导致「逢消息必回 + 冷场自言自语（唠叨王）」，Issue #1786 声称该问题自 1.0.0 系列架构落地即存在，同日有修复 PR #1787（`帖子/Issue`：[#1786](https://github.com/Mai-with-u/MaiBot/issues/1786)、[#1787](https://github.com/Mai-with-u/MaiBot/pull/1787)）。

---

## ③ 人格 / 表情包

**人格**
- 人设是**纯文本配置**，存在配置系统里（Pydantic `ConfigBase` + WebUI 表单），不是角色卡文件：`personality`（人格设定）、`behavior_style`（行动准则）、`reply_style`（表达风格）、`multiple_reply_style`（备用风格列表）、`multiple_probability`（随机启用备用风格的概率，默认 0）（`代码`：`src/config/official_configs.py` L158-L249）。
- **人格给 Replyer，行为风格给 Planner**：测试显式断言 `personality` 只能出现在 Replyer 提示词里、`behavior_style` 只能出现在 Planner 提示词里（`代码`：`pytests/maisaka/test_behavior_style_prompt.py` L10-L30）。
- **多个人格/切换**：我没找到「多套人格配置、按群切换」的一等公民机制；`multiple_reply_style` 只是**本次回复**的随机风格注入。Issue #1461（已关）声称多个人格/表达风格切换时会被历史聊天记录带偏（例如猫娘人格下历史「喵」权重更高），并给出改 `build_personality_prompt` 的民间补丁（`帖子/Issue`：[#1461](https://github.com/Mai-with-u/MaiBot/issues/1461)）。
- **口癖**：没有「口癖」独立字段，靠 `reply_style` 文本描述；另有一条「错别字生成」后处理链（`ChineseTypoConfig`，`代码`：`official_configs.py` L4501 起）。
- **黑话/表达学习**：从群聊里学「黑话」和「表达方式」，写入向量索引 `data/expression_selection/expression_vector_index.json`，写前先让 LLM 评估是否合适（`适合/不合适` JSON），召回后交表达选择器（`代码`：`prompts/zh-CN/expression_evaluation.prompt`、`official_configs.py` L3996-L4123、`src/maisaka/builtin_tool/reply.py` L144-L179 的 `expression_intent` 结构化意图）。

**表情包**
- 库里最多 `max_reg_num`（默认 64）个；**会从聊天里自动收集别人发的表情**（`steal_emoji=true`，可关，有大小上限与内容过滤），满额时替换旧的（`代码`：`official_configs.py` L4243-L4362）。
- 每个表情有 LLM 生成的**描述 + 情绪标签**；选表情是按情绪标签做相似度取 top10 再随机（`代码`：`src/emoji_system/emoji_manager.py` L843-L868、L1280 起）。
- **两种发送路径**：旧路径由独立选择器按情绪挑；新路径（`use_new_send_logic`）把 20 个候选拼成一张带序号的网格图给模型看，模型回 `{"emoji_index":1,"reason":"..."}`，然后在文字之后发送（`代码`：`prompts/zh-CN/emoji_selection.prompt`、`src/emoji_system/maisaka_tool.py` L123-L286、`src/maisaka/builtin_tool/reply.py` L208-L213 的 `attach_emoji`）。
- 表情选择前后有插件 Hook（`emoji.maisaka.before_select` / `after_select`），可改写情绪、上下文、采样数，也可直接指定 `selected_emoji_hash`（`代码`：`maisaka_tool.py` L138-L200）。

---

## ④ 记忆（群记忆 vs 个人记忆）

- **短期**：群聊上下文默认 40 条、私聊 60 条（`代码`：`official_configs.py` L768-L798）；「聊天回想」把历史压缩成摘要消息回填，最多保留 10 条（`代码`：`official_configs.py` L800-L829、`src/maisaka/memory/mid_term.py`）。
- **长期 = 内置子系统 A_Memorix（v2.0.0）**：向量 + 图谱双路检索，元数据落 SQLite；工具集含 `search_memory`（参数 `chat_id` / `person_id` / `mode=search|time|hybrid|episode|aggregate`）、`get_person_profile`、`ingest_summary` 等（`文档`：`src/A_memorix/README.md`）。
- **群记忆与个人记忆是两套键**：记忆条目带 `chat_id`（如 `group:dev`）与 `person_id`；检索默认**只搜当前聊天流 + 配置的共享组**（`global_memory_sharing_enabled` 默认 `false`）；`shared_memory_groups` 才决定哪些群互相共享检索范围，写入时仍保留原 `chat_id`（`文档`：`src/A_memorix/CONFIG_REFERENCE.md` L357-L389）。
- **读写白/黑名单**：`filter.enabled` + `blacklist/whitelist`，支持 `group:<id>` / `user:<id>` / `private:<id>` / `stream:<id>`（`文档`：同上 L318-L349）。
- **谁在跟谁说话**：人物画像由「发送者 / @ 对象 / 被回复消息的发送者」三类候选解析出 `person_id` 后注入（`代码`：`src/maisaka/memory/person_profile.py` L17-L120）。
- **衰减/清理**：`memory.half_life_hours=24`、`prune_threshold=0.1`、`revive_threshold=0.15`、`freeze_duration_hours=24`；访问强化 α=0.05（冷却 60 分钟），显式强化 α=0.5，弱化 α=0.5；孤儿实体保留 7 天；**只有显式设置 `expires_at` 的临时段落会自动删**，永久段落与带 external ref 的段落跳过回收（`文档`：`CONFIG_REFERENCE.md` L421-L445；`代码`：`src/A_memorix/core/utils/memory_lifecycle_policy.py`）。
- **边界**：**人物画像目前是全局聚合，不按群隔离**（原文说明，`文档`：`CONFIG_REFERENCE.md` L355）。多平台同一用户会共享一个人物画像与聊天流（Issue #2125 提出，`帖子`）。

---

## ⑤ 多人语境判断

- **判定是否点名**：`is_at`（@ 本体）/ `is_mentioned`（昵称、别名、适配器 `mention_bot` 段）；`@` 解析已改为**按 QQ 号优先**，未知用户保留原始号码（`代码`：`src/chat/utils/utils.py` L145-L200；修复说明见 [#1919](https://github.com/Mai-with-u/MaiBot/pull/1919) 修复 [#1715](https://github.com/Mai-with-u/MaiBot/issues/1715)）。
- **发言者标识**：上下文里每条消息带 `user_cardname / user_nickname / user_id`，显示名回退到 ID（`代码`：`src/maisaka/context/messages.py` L178、L308、L398）。
- **「这句是不是对我说的」**：不靠规则，靠 Planner 判断 + `reply_reference` 字段（要求写清「当前聊天状态、人物关系、事实信息、回忆信息」，`代码`：`src/maisaka/builtin_tool/reply.py` L130-L137），可 `attach_at` 指定回复谁（L214-L219）。
- **不打断别人**：没有「某人正在说话就闭嘴」的独立机制。群提示词写的是软约束：「不用刻意回复其他人的表情包」「不要每个人都回，优先回你感兴趣的或主动提你的」「必须考虑不同群友发言之间的交互，免得啰嗦」（`代码`：`official_configs.py` L698-L713，群聊提示词默认值）。
- **被 @ 别人时降权**：动态门控把「@ 了麦麦以外的人」当作负权重特征（-1.1157），把「全是表情占位」也当负权重（`代码`：`reply_likelihood.py` L36-L44）。
- **冲突/争吵**：`没找到` 任何专门的冲突检测、劝架、话题冷却机制；只有 `behavior_style` 文本里让你自己写「何时保持安静」。
- **禁言/退群/被踢**：`没找到` 内置策略。相近的只有：命令权限名单（`allow_users` / `allow_chats`，`代码`：`official_configs.py` L5842-L5896）、Focus 白名单（L1054-L1065）、适配器入站白名单（`adapter_policy`）。**注意**：Issue #2146 声称 `adapter_policy` 白名单只拦入站，bot 仍会主动回复被 block 的群（出站无校验 + 空窗补偿消费旧缓存），2026-10-12 提出并已关（`帖子/Issue`：[#2146](https://github.com/Mai-with-u/MaiBot/issues/2146)）。

---

## ⑥ 工程与配置

- **技术栈**：Python ≥3.12；**不是 NoneBot2**，走自研 `maim-message` 消息协议 + 各平台 Adapter 进程；官方适配器含 NapCat（QQ）、SnowLuma、Telegram、Discord、Android 等（`代码`：`pyproject.toml` 依赖列表；`文档`：README 友链/致谢一节与 `MaiBot-Napcat-Adapter` 仓库）。
- **关键依赖**：`faiss-cpu`（向量）、`maibot-plugin-sdk`、`mcp`、`maibot-dashboard`（WebUI 已作为 pip 依赖引入，旧 dashboard 仓库已 archived）（`代码`：`pyproject.toml`）。
- **配置**：Pydantic 配置类 + WebUI 表单（`src/config/official_configs.py` 6000+ 行、`src/config/file_watcher.py` 热重载）。运行时不再只有一份 TOML，字段带 `zh_CN/en_US/ja_JP` 标签与 `x-widget` 控件提示（`代码`：同文件全文结构）。
- **插件机制**：插件带 `_manifest.json`（manifest_version 2，声明 `capabilities` 如 `send.text`、`emoji.get_random`，`host_application.min_version / sdk.min_version`，依赖与权限），插件可注册 Hook 介入模型请求、表情选择等环节（`代码`：`plugins/hello_world_plugin/_manifest.json`、`src/plugin_runtime/`）。
- **部署**：官方一键包 `MaiBotOneKey` + 启动器；有 `docker-compose.yml`；文档站 `docs.mai-mai.org`（`文档`：README 快捷链接、仓库内 `docker-compose.yml`）。
- **许可证**：GPL-3.0，另附 EULA 与 PRIVACY 两份单独协议；EULA 第 3.3/3.5 条把知识库/记忆库/日志内容的合法性与第三方插件合法性**全部推给部署者自行承担**（`文档`：`EULA.md` L54-L61、`PRIVACY.md`）。
- **隐私**：明确写入「会收集输入输出并发送到第三方 API」「会构建仅存本地的知识库与记忆库」「日志仅存本机」，遥测默认上报客户端 UUID、版本、OS、按平台/会话类型聚合的消息量与在线时长（`文档`：`PRIVACY.md` L1-L30）。

---

## ⑦ 它公开承认的翻车点

1. **唠叨王 / 空窗补偿过度触发**：低活跃群里频率远超配置、无新消息也自我唤醒；Issue #1786 明确写成「先天设计问题」，同日修复 PR #1787（`帖子/Issue`）。
2. **重复触发与连发**：「单条消息触发多次 Timing Gate 导致重复回复」（#1663）、「同一用户消息重复触发多条回复」（#1861）、「私聊 wait 不能被打断」（#1492）——均已关（`帖子/Issue`）。
3. **长期静默后连发同义回复**：Issue #2127（**open**，1.3.5）声称主动回合把 38 小时前的旧提问当回复锚点，7 分钟内向用户连发 4 条语义相似回复（`帖子/Issue`）。
4. **认错人 / 点错对象**：@ 解析曾把已退群或黑名单 QQ 显示成别的群友昵称（#1715 → 修复 PR #1919）；另有 #1689「AI 分不清你我，短时间重复回复」；#2125 提出多平台同一用户共享同一人物画像与聊天流（`帖子/Issue`）——这与「人物画像全局聚合、不按群隔离」的文档说明一致（`文档`）。
5. **人格受历史干扰**：多套人格/表达风格切换时，历史记录里的旧口癖权重压过当前人格（#1461，已关）（`帖子/Issue`）。
6. **模型行为泄漏进群**：Replyer 把工具调用 XML/JSON 复读成聊天消息（#1882）；思考内容泄漏进可见回复（#2153）；回复后处理后则误删数学公式括号（#2146 同期 #2148-#2150）（`帖子/Issue`）。
7. **工程稳定性**：heartflow 内存泄漏（#1662，附复现脚本）、A_Memorix 向量通道指纹死锁 / 无限重试（#2010、#2106）、插件运行时 16 MiB 单帧硬编码导致大消息被静默拒收（#2170-#2172）、SQLite `busy_timeout` 不对等导致群消息被静默丢弃（#2151）（`帖子/Issue`）。
8. **隐私**：官方文档口径是「输入输出会发往第三方 API」，本地库与日志不上传，遥测只上报聚合统计、不还原聊天内容（`文档`：`PRIVACY.md`）。仓库内有「疑似 key 泄露（未经证实）」Issue #1739（已关，`帖子`）。
9. **我没找到的**：没有找到官方承认的「被群友讨厌 / 被踢出群 / 因拟人化引发社群反弹」的正式记录；社区群的「闲聊群」存在只能当线索，不作为证据（`没找到`）。

---

## ⑧ 哪些机制值得抄 / 哪些千万别抄

| ✅ 值得抄（机制骨架，与「不追参与度」的底线兼容） | ❌ 千万别抄（或必须反向设计） |
| --- | --- |
| **决策与表达分家**：Planner 只决定「说不说、对谁说」，Replyer 只负责「怎么说」；说与不说都不污染人设文本。对应我们的 bot/core 分层（`代码`：`src/maisaka/` 与 `src/chat/replyer/` 分离、`test_behavior_style_prompt.py`） | **空窗补偿**：把「冷场时长」折算成发言触发量，等于用沉默本身当参与度信号，会制造自我唤醒与唠叨；MaiBot 自己按 threshold-1 封顶并禁止 pending=0 触发，仍翻过车（#1786）。我们要的是「没人说话就更安静」 |
| **「不回复」是一等公民**：不发言就不调工具、直接结束本轮，不占上下文、不事后补答（`代码`：`scheduler.py` 静默消费分支、`planner_reply_guard.py`） | **用「预计回复数 → 实际回复数」的预算闭环去追目标回复量**：它本质是 engagement target，`talk_value` 再小也是个 KPI，还会把 @ 强制触发折算成预算项（`代码`：`dynamic_gate.py`）。我们的底线是「不追参与度」，这一层应当整块砍掉 |
| **简单可解释的频率阈值**：`threshold = ceil(1/frequency)`，一看就懂、一调就灵（`代码`：`runtime.py` L1194-L1199） | **把逻辑回归拟合权重硬编码进源码**：权重来自离线脚本拟合、改数据要改常量与离线阈值表（`reply_likelihood.py` 头部注释）。这是「模型调参」伪装成「机制」，可维护性差且不可审计 |
| **指数退避 + 上限**：连续判定不回复就 15s→300s 指数等待，新消息攒够 6 条才打断（`代码`：`idle_backoff.py`）。这是「被冷落就退场」的正确方向，只需把触发源从「消息量」换成「明确叫我」 | **默认 @ 必回 / 提及必回**：`inevitable_at_reply=True` 让 @ 绕过一切门控。私聊可以，群聊里这等价于「谁点我我就必须开口」，容易被当工具人或被刷屏带节奏 |
| **连续 wait / 连续打断双重上限**：`max_consecutive_wait_count=3`，`planner_interrupt_max_consecutive_count` 默认 0（`代码`：`official_configs.py` L551-L578、`builtin_tool/wait.py`）。防止「等待」变成无限占用 | **快速反应模式**：新消息立刻打断重来、「不限制连续打断次数」（`official_configs.py` L919-L930）。开在群聊里就是上下文雪崩 + 话痨放大器 |
| **表情包走「情绪标签 + 索引网格」而不是自由生成**：情感标签做 top10 相似度再随机选一个，新逻辑用编号网格让模型 `{"emoji_index":1}`；选择前后留 Hook（`代码`：`emoji_manager.py` L843-L868、`emoji_selection.prompt`、`maisaka_tool.py`） | **自动偷群友表情库**：`steal_emoji=true` 从聊天里自动收集他人表情并入库、满额替换（`official_configs.py` L4319-L4362）。这是别人的内容资产，隐私与授权都站不住 |
| **记忆按 `chat_id` / `person_id` 双键隔离 + 显式共享组**：默认只搜当前聊天流，跨群共享必须显式配置（`文档`：`CONFIG_REFERENCE.md` L357-L389） | **人物画像全局聚合、不按群隔离**：文档明说画像当前不分群（`CONFIG_REFERENCE.md` L355），跨群身份串味（#2125）。群友画像必须按群/按人隔离，或者干脆不做画像 |
| **半衰期 + 冻结/回收 + 只删显式过期内容**：`half_life 24h`、`prune 0.1`、只自动删有 `expires_at` 的临时段落（`文档`：`CONFIG_REFERENCE.md` L421-L445） | **以「像人」为目标去学习群里的黑话和表达**：表达/黑话学习 + 向量索引 + 自动写入（`official_configs.py` L3996-L4165）。对陪伴型角色这是人格漂移，还会把群里的烂梗带进私聊 |
| **Hook 化扩展点**：表情选择、模型请求前后都能被插件接管与中止（`代码`：`manifest` 的 capabilities + `invoke_hook` 调用点） | **遥测上报运行统计**（`PRIVACY.md` L1-L30 的心跳/统计条目）。我们的仓库保持私有、联系人只有 2 个，任何出网统计都应当默认关闭并写进 ADR |
| **回复拆条硬上限**：一次回复最多 3 条、单条 512 字（`代码`：`official_configs.py` L4649-L4687）——防刷屏的最后一道物理闸门 | **把「多群高并发拟人」当作默认运行形态**：它为此引入了 Focus 模式、对话流租约、空闲退避、动态门控一堆状态机（`src/maisaka/focus/`、`turn_trigger/`），复杂度与 bug 面（#2146、#2151、#2127）随群数线性增长 |

---

### 一句话总判断

MaiBot 值得抄的是**「说不说」与「怎么说」的分离**、**清醒的退避与上限**、**可解释的频率阈值**；千万别抄的是它整套**以参与量（预计回复数/冷场折算/自动学群梗）为目标的闭环**——那正好与林梦瑶「不追参与度、只 2 个联系人」的底线相反。
# 报告完
