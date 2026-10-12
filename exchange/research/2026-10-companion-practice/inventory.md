# A 块：开源陪伴 / 拟人项目清单（一行版总表）

- 日期：2026-10-12 晚；访问日期除特别注明外都是 **2026-10-12**
- 谁做：**Claude 代做**（任务书原定 DSH，用户 10-12 晚明确让 Claude 做；因此交接文件署名 claude）
- 任务书：`exchange/tasks/2026-10-12-dsh-companion-practice-research.md`；只读调研，没改代码、没碰 `docs/adr/`
- 本表**没有读任何项目的源码**（按用户补充 2）。内容来源只有：README / 官方文档、GitHub 仓库元数据、仓库**文件名**（目录树，没打开文件）、以及 10-05 已经读过代码的旧报告。
- 终极目标：让林梦瑶像真实的 20 岁左右女大学生那样活着，不追参与度、不宣称有意识。

## 证据标记（每格末尾）

| 标记 | 意思 |
| --- | --- |
| **[文档]** | README / 官方文档**宣称**的，我没验证过代码 |
| **[目录]** | 只看到仓库里有这个**文件名**，没打开；能说明"有这块"，不能说明"怎么做" |
| **[旧码]** | 10-05 报告里别人已经读过代码确认的（`docs/research/2026-10-05-framework-fit/`），本轮没重读 |
| **[没找到]** | 查了，没有 |

活跃度的算法：取该仓库默认分支 commits.atom 里最近 20 条，记最新一条日期 + 这 20 条跨多久（跨得短 = 提交密）。`pushed_at` 会算上别的分支，所以不拿它当活跃度。星数是 API 当天值。

## 总表

| 项目 | 做什么 | 怎么触发主动发言 | 记忆方案 | 最近提交活跃度 | 许可证 | 哪一块值得拆开看 |
| --- | --- | --- | --- | --- | --- | --- |
| **MaiBot（麦麦 / MaiSaka）** 6.2k★ [S1] | QQ 拟人智能体，自称"数字生命"，群聊为主；模仿群友说话风格、学黑话 [文档] | README 只说"懂得在合适的时间说话、该闭嘴时闭嘴" [文档]；目录里有 `src/maisaka/turn_trigger/{scheduler,idle_backoff}.py` [目录]。**没找到**"她自己的生活驱动开口"的说明 | 中期记忆（带时间范围、参与者；10-03 报告读过 `mid_term.py`）+ 人物画像 + 图像记忆 [旧报告 / 目录]；目录里有独立记忆子系统 `src/A_memorix/`，含 `memory_lifecycle_policy.py`、`memory_maintenance_service.py`、`person_fact_verifier.py`、`person_fact_reverification.py` [目录] | 最新 2026-10-11；20 条在 1 天内（极密） | GPL-3.0 | **C**：`person_fact_reverification` + `memory_lifecycle_policy`（记错了怎么复核、记忆怎么过期）。**B**：`turn_trigger/idle_backoff`（沉默时怎么退避）。⚠ 群聊中心，私聊拟人要看是否适用 |
| **AstrBot** 41.8k★ [S2] | Python 通用聊天机器人框架，插件市场 1,300+；10-05 已做框架适配调研 | 本体：`future_task`（v4.14.0，**实验性**）由 LLM 或 WebUI 建一次性 / 间隔 / 每天 / 每周任务，到点唤醒 Agent；官方文档自己写"不是一直运行的自主监控" [文档]；`CronJobManager`、群聊概率回复 [旧码] | 本体：对话历史 + 知识库（RAG）+ 人格管理 [目录/旧码]；长期记忆靠插件（见下面 private_companion）[旧码] | 最新 2026-10-11；20 条在 3 天内（极密） | AGPL-3.0 | 本体**不必再拆**（10-05 已拆）。值得拆的是**插件生态**，见下面两行 |
| ↳ AstrBot 插件 **private_companion** 390★ [S11] | "拟人化整合插件"：连续状态、每日日程、位置 / 天气 / 睡眠 / 饥饿 / 健康、重要日期、日记、**低频主动消息**；60+ 功能 [文档] | 官方文档写：由状态 / 日程 / 关系 / 近期互动形成**行为候选**，再过"**额度、时机、权限、发送前复核**"才发；记录"主动候选、**拦截原因**、改写结果、发送状态"供审计；区分"随机问候 / 重复触达 / 错误时段问候"；私聊有"**未回应降速**" [文档] | 与独立插件 `astrbot_plugin_memory_companion` 配对（采集 / 召回 / 权限 / 迁移 / 维护）；自带"Bot 自我时间线"、关系观察 [文档] | 最新 2026-10-11；20 条在 10 天内（密） | **没有许可证**（API 为 null，仓库无 LICENSE 文件）→ 默认保留所有权利，**只能看思路，不能搬代码** | **B 的首选**：它的架构和我们的"生活账 + 主动"几乎同构，且把"为什么没发"也记账。D 也要看它的"好感度 / 边界 / 道歉修复"（README 第 136 行起）。⚠ 60+ 功能，"好感度"是否在追黏性要到 D 块判 |
| ↳ AstrBot 插件 **virtual_life** 5★ [S11] | 连续虚拟人生：长期时间表、每日日程、穿搭、当前状态、主动消息 [文档，仓库描述] | **没读 README**；仓库描述只写"主动消息" | **没找到**（没读） | 最新 2026-09-21；20 条跨 ~2 个月（慢） | GPL-3.0 | 体量小、可能只是个想法验证；除非 B 块需要第二个"日程驱动主动"样本，否则不拆 |
| **NoneBot2** 框架 7.7k★ + 人格插件 **naturel_gpt** 513★ [S3] | NoneBot2 是 Python 异步聊天机器人框架；naturel_gpt：人格自定义 / 切换、聊天记忆、用户印象、扩展调用 [文档] | naturel_gpt：触发词、"随机参与聊天"（冒泡）、自然语言定时任务（扩展）[文档]。README 自己把"主动聊天参与逻辑"列为**未完成** [文档]。NoneBot2 本体无人格 / 主动机制（框架）[文档] | 近期上下文 + **聊天总结**记忆 + **每人格对每用户的印象**；v1.5.0 起 bot 可"主动记忆 / 遗忘"，并有"记忆强化以延长有效时间" [文档，更新日志]；作者 changelog 自己写总结记忆"高成本低回报" [文档] | naturel_gpt 最新 **2025-06-24（476 天前，基本停更）**；NoneBot2 最新 2026-10-12（密） | naturel_gpt Apache-2.0（API 与 README 徽章一致）；NoneBot2 MIT | **C**：2023 年就有的"记忆强化 / 主动遗忘"是个很早的样本，但已停更，**只当历史参考，不深读**。NoneBot 生态的其他人格插件：搜到过名字（如 aichat）但**没核实**，不列 |
| **Koishi + ChatLuna** 442★ / **chatluna-character** 75★ [S4] | ChatLuna：Koishi 上的 LLM 插件族；character：让模型"伪装成群友"[文档，仓库描述] | character 有空闲触发，还给模型 `wake_up_reply_*` 工具让模型自己排下一次醒来的时间；另有 `chatluna-spark`、`chatluna-proactive-trigger` [旧码，10-05] | `chatluna-long-memory` 分全局 / 预设 / 群 / 用户四层，引擎有 Basic / HippoRAG / Emgas 三种 [旧码，10-05 koishi-chatluna.md F1–F2] | ChatLuna 最新 2026-10-08（近 20 条跨 ~2 个月，中速）；character 最新 **2026-09-08（35 天前，近 20 条全在 9-07 到 9-08，之后无）** | 均 AGPL-3.0 | 10-05 已读过代码，本轮不重做。**B**：`wake_up_reply_*`（模型自己排醒来时间）值得和"生活账是理由"对比，看是否把"理由"交给了模型的即兴 |
| **AIRI**（moeru-ai）50.3k★ [S5] | 自托管数字伴侣 / 虚拟角色（Neuro-sama 类），TypeScript，Web / 桌面 / 手机 | README **没找到**主动发言机制。devlog 2026-01-01 写到手机端 AIRI Pocket"想的话可以通过通知主动提醒你陪她" [文档，一句话] | 基础设施：浏览器内 DuckDB WASM / pglite、Postgres；"Memory Alaya"在 README 路线图里**未勾选（WIP）**；devlog 的 FlowChat 实验：LLM 用工具写一句陈述式摘要进表，**每次回复把全部记忆拼进 system prompt**；作者承认"提示词会越来越长，怎么优化还没想好"，**遗忘：没提** [文档] | 最新 2026-10-12；20 条在 3 天内（极密） | MIT | 现阶段**无可拆**（记忆还在实验）。盯 Alaya 落地。语言栈（TypeScript）与我们一致，是唯一一个以后可能直接借组件的 |
| **Open-LLM-VTuber** 14.1k★ [S6] | 语音 + Live2D 的本地 AI 伴侣，"虚拟女友 / 桌宠"，Python | 前端 Setting→Agent 里有"允许 AI 主动说话"+"**空闲 N 秒后允许**"+"举手按钮可触发"；触发条件原文："AI 处于 idle 状态、开关打开、达到空闲阈值" [文档，**直接读了文档页**]。后端有可配的主动发言 prompt（v1.2.0）[文档，二手：搜索摘要，未直读发布页] | README 写"**长期记忆功能暂时移除**（会回来）"，现在只有聊天记录持久化 [文档]；Agent 接口可接 Mem0 等 [文档] | 最新 **2026-05-15（151 天前）**，近 20 条跨 ~6 个月（慢） | MIT（LICENSE 文件已核对；Live2D 示例模型另有许可） | **不拆**。它的"主动"= 对方空闲计时器，和 Extension-Idle 是同一类，没有"她自己的理由" |
| **SillyTavern 生态** 34.4k★ [S7] | 角色扮演前端。与本项目关系见 `2026-10-03-sillytavern-fit.md`，这里只看记忆 / 自动发言扩展 | **Extension-Idle**（官方组织名下，36★）：用户空闲一段时间后"idle prompting"自然续聊 [文档，README 仅一句]；**最新 2025-03-08，基本停更**。内置 auto mode 是否只是计时器：只在一条二手帖里见过，**没核实** | ① 内置 Summarize（整段滚动总结）；② 内置 Vector Storage：每条消息存向量，取与最近两条消息相似度 ≥25% 的前 3 条（排除最近 5 条）放在提示词里标"过去的事"，**文档明确没有遗忘 / 衰减，要手动清** [文档，**直读**]；③ **Qvink MessageSummarize**（168★）：每条消息单独总结，分短期（自动滚出）/ 长期（**手动标记**），不用向量，作者吐槽内置总结"一次坏生成能毁掉整份摘要"[文档]；④ **MemoryBooks**（314★）：把场景存成可编辑世界书条目 [文档] | ST 最新 2026-09-14（近 20 条跨 ~1 个月）；Qvink 最新 2026-05-25（140 天前）；MemoryBooks 最新 2026-10-07（密）；Idle 停更 | 均 AGPL-3.0 | **C**：只看 Qvink 的"逐条总结 + 手动标重要"设计动机段（读它 README 的 Motivation 一节即够，不必读源码）。主动发言这一类**没有值得拆的** |
| **Letta（原 MemGPT）** [S8] | 有状态智能体。**主仓库已迁到 `letta-ai/letta-code`**（3.6k★，TS，Apache-2.0）；老的 `letta` 仓库 README 写明 V1 API 服务器已退役，源码在 `archive` 分支 | letta-code 的 README **没写**按时间 / 事件主动开口；有 `/sleeptime` 周期性"dreaming"（无人对话时后台反思）和 Telegram / Slack / Discord 渠道 [文档]。**没找到**"主动给用户发消息"的说明 | 记忆块（memory blocks）由智能体**自己改写**；MemFS：所有上下文用 git 追踪；`/reflect`、`/dream`；Windows 原生默认关自动 dreaming [文档] | letta-code 最新 2026-10-12（极密）；老 letta 最新 2026-09-10 | Apache-2.0 | **C**：dreaming（无人在时的整理）和 MemFS（记忆有 git 历史 ≈"重启不改史"的一种做法）。⚠ 它主要是**编码智能体** harness，不是陪伴；只借机制 |
| **mem0** 67.0k★ [S9] | 通用"记忆层"库 / 托管服务（Python / TS） | **没有**（库，不负责开口）[文档] | 2026-04 新算法：**单次 ADD-only 抽取，"没有 UPDATE / DELETE，记忆只增不改"**；实体链接；语义 + BM25 + 实体多信号检索；时间推理 [文档]。README 注明榜单分数来自托管平台的专有优化，开源版"方向相近但不等同" | 最新 2026-10-07；20 条在 2 周内（密） | Apache-2.0 | **C 的对照面**：它刻意**不遗忘**，与我们 ADR 0017 / 0018"变淡"方向相反——不是拆来借，是拿来写"为什么不选"。不必读源码 |
| **Zep / Graphiti** 31.7k★ [S10] | Graphiti 是开源的**时间知识图谱**框架；Zep 是以它为核心的托管服务（专有图数据库，不开源）| **没有**（框架）[文档] | 事实带**有效时间窗**（什么时候成立 / 什么时候不再成立）；每条派生事实可追溯到原始"片段"（provenance）；变化时保留完整时间历史 [文档] | Graphiti 最新 2026-10-11；20 条在 2 周内（密）。README 注明 Kuzu 后端已弃用 | Apache-2.0 | **C**：时间窗 + 溯源 ≈ 我们"账对得上、重启不改史"的一种存法（对照 ADR 0027 覆写带来源）。只借**数据模型的想法**，不引入（它要图数据库，我们 VM 6 GB） |

## 这张表看出来的 5 件事（给 Claude / 用户看方向用，不是结论）

1. **"主动发言"绝大多数是"对方沉默 N 秒 / 定时问候"**：OLV、Extension-Idle、AstrBot `future_task`、naturel_gpt 的定时器都是这一类，理由在"对方"身上，不在"她的日子"上。**唯一明显例外是 private_companion**（状态 + 日程 → 行为候选 → 额度 / 时机 / 复核 → 记账含"拦截原因"）。B 块建议以它为主要对照。
2. **记忆的主流是"只增不删"**（mem0 v3 明说 ADD-only，ST Vector Storage 明说无衰减，AIRI 全量拼进提示词）。**主动遗忘 / 衰减 / 复核更正**只在 MaiBot（目录里有 lifecycle / reverification）、naturel_gpt（2023 年的"强化 / 遗忘"）、Letta（dreaming 改写）里露头。C 块的材料比 B 块少。
3. **"重启不改史"最像的做法在 Graphiti（时间窗 + 溯源）和 Letta（MemFS 的 git 历史）**，不在陪伴类项目里。
4. **陪伴类项目的更新节奏分两极**：基础设施类（AstrBot、Graphiti、mem0、AIRI、MaiBot）几乎天天有提交；纯"陪伴扩展"类（OLV 151 天、naturel_gpt 476 天、Extension-Idle 583 天、Qvink 140 天、chatluna-character 35 天）多半停更。**拿停更项目当参考要注意它们是 2023–2025 年的做法。**
5. **许可证**：MaiBot 是 GPL-3.0，private_companion **没有许可证**，AstrBot、ChatLuna 族、ST 及其扩展大多 AGPL-3.0。我们的仓库是私有的，**读思路没问题，但这几个都不能直接搬代码**（CLAUDE.md 已有"Koishi 及插件原样使用，不改源码"的规则）。

## 与终极目标冲突 / 待判的做法（只列不推荐）

| 做法 | 出现在 | 为什么列 | 状态 |
| --- | --- | --- | --- |
| 随机冒泡（按概率参与聊天 / 随机问候） | naturel_gpt、AstrBot 群聊概率回复 [文档/旧码] | 理由是"概率"，不是她的事 | **待判**（B 块看：群聊场景我们没有；私聊随机问候则与目标冲突） |
| 对方空闲计时器触发开口 | OLV、Extension-Idle [文档] | 理由是"你不说话了"，不是她的日子；有"追着你"的味道 | **待判**（B 块判：加上"她自己此刻有空 / 想说"才算有原因） |
| "好感度"分数驱动语气 | private_companion [文档，只见章节标题 "好感度与互动表达"，没读内容] | 可能是黏性手段，也可能只是关系状态 | **待判**（D 块读完再标） |
| 连续打卡 / 情绪勒索 / 制造焦虑 | A 块**没有**在任何一行里看到 | — | 目前 0 条（不代表别处没有，E 块再查） |

「表演型冷淡」（随机装忙 / 装生气 / 装没看见）：**A 块没看到任何项目明说这么做**；private_companion 的"未回应降速"是**对方不回就少发**，方向是降低打扰，不算表演。D 块专门查，先不下结论。

## 没找到 / 没核实

- MaiBot "怎么决定开口"的具体算法：README 只有口号，目录里只有文件名；**没读**。
- AIRI 的主动发言：README / devlog 里只有手机通知一句；其余**没找到**。
- Letta 是否有"主动给用户发消息"：letta-code README **没找到**。
- NoneBot 生态的其他人格插件（aichat 等）：只在搜索摘要里见到名字，**没核实**，没列。
- SillyTavern 内置 auto mode 到底是不是纯计时器：只有一条二手帖，**没核实**。
- OLV 后端主动发言 prompt 的 conf.yaml 键名：docs 的 backend 页面 404（`/docs/user-guide/backend/proactive-speak` 不存在），键名**没找到**。
- 所有"最近提交"都来自 atom 前 20 条；没有算提交的**内容**（可能是依赖升级而非功能）。

## 没纳入的项目（想到了但这一轮没做）

- **OpenClaw**（391.8k★，MIT，助手型）：README 里没有 heartbeat / 记忆机制的说明（grep 过），它的 docs 站没读。是通用助手，不是陪伴；B 块如果要看"心跳式主动"再补。
- **z-waif**（AIRI README 提到的"自主"项目）、**warashi**（搜索结果里出现，自称有长期记忆和主动对话）：只见名字，没核实。
- **Hindsight**：我们自己在用，不算"别人的做法"。
- Generative Agents / Project Sue / MemoryForge 等论文与项目：已在 `docs/research/2026-10-07-life-engine/research-map.md`，不重做。

## 我的参考排序（只是帮着圈 3–4 个，不替你选）

按 B > C > D 的优先级，"最可能有料"的顺序：

1. **private_companion**（B + D）——架构最像，且有"拦截原因"记账；没许可证，只读思路。
2. **MaiBot**（B + C）——`turn_trigger/idle_backoff` 与 `person_fact_reverification` / `memory_lifecycle_policy`，是唯一同时碰"沉默时怎么办"和"记错了怎么纠正"的。群聊中心是风险。
3. **Letta Code**（C）——dreaming + MemFS。编码智能体出身是风险。
4. **Graphiti**（C）——时间窗 + 溯源。只借数据模型的想法。

候补：Qvink（读 Motivation 一节即可，不用读源码）；mem0 只用来写"为什么不选 ADD-only"。

## 来源（访问日期均为 2026-10-12）

| 编号 | 链接 | 用在 |
| --- | --- | --- |
| S1 | https://github.com/Mai-with-u/MaiBot （README、仓库元数据、目录树 API） | MaiBot 行 |
| S2 | https://github.com/AstrBotDevs/AstrBot ；https://github.com/AstrBotDevs/AstrBot/blob/master/docs/zh/use/proactive-agent.md ；旧报告 `docs/research/2026-10-05-framework-fit/astrbot.md` | AstrBot 行 |
| S3 | https://github.com/nonebot/nonebot2 ；https://github.com/KroMiose/nonebot_plugin_naturel_gpt | NoneBot 行 |
| S4 | https://github.com/ChatLunaLab/chatluna ；https://github.com/ChatLunaLab/chatluna-character ；旧报告 `docs/research/2026-10-05-framework-fit/koishi-chatluna.md` | Koishi 行 |
| S5 | https://github.com/moeru-ai/airi ；https://airi.moeru.ai/docs/en/blog/DevLog-2026.01.01/ | AIRI 行 |
| S6 | https://github.com/Open-LLM-VTuber/Open-LLM-VTuber ；http://docs.llmvtuber.com/en/docs/user-guide/frontend/web/ ；LICENSE（raw） | OLV 行 |
| S7 | https://github.com/SillyTavern/SillyTavern ；https://github.com/SillyTavern/Extension-Idle ；https://docs.sillytavern.app/extensions/chat-vectorization/ ；https://github.com/qvink/SillyTavern-MessageSummarize ；https://github.com/aikohanasaki/SillyTavern-MemoryBooks | ST 行 |
| S8 | https://github.com/letta-ai/letta ；https://github.com/letta-ai/letta-code | Letta 行 |
| S9 | https://github.com/mem0ai/mem0 | mem0 行 |
| S10 | https://github.com/getzep/graphiti | Graphiti 行 |
| S11 | https://github.com/menglimi/astrbot_plugin_private_companion ；https://github.com/FloranceYeh/astrbot_plugin_virtual_life | AstrBot 插件行 |

星数、许可证、`default_branch` 来自 GitHub 未登录 REST API（`/repos/{owner}/{repo}`），提交活跃度来自 `https://github.com/{owner}/{repo}/commits/{branch}.atom`。全程未登录、未用浏览器档案、未下载可执行文件；API 调用接近未登录额度上限（60 次 / 小时），所以只对必要的仓库调了元数据。
