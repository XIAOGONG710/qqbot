# 把 AI 塞进 QQ 群当「群友」：常见做法与生态清单

- 调研方式：只读公开资料。B 站仅通过**公开 Web 接口**读标题/简介/标签/公开评论（`api.bilibili.com`，未登录、未使用 cookie、未播放视频）；GitHub 内容以 `git clone --depth 1` / `api.github.com` 读取（官方桌面 GUI 的 HTML 页面会截断，故未用）。
- 访问日期：**2026-10-15**（GMT+8）。
- 等级：`代码`（仓库源码/文档原文）/ `文档`（项目自带说明文档、平台说明页）/ `帖子`（B 站视频标题、简介、公开评论）/ `没找到`。
- 说明：标题与评论中的真人昵称、群号一律不转录，只保留可验证的结论与链接。

---

## ① B 站上的典型玩法（8 条，每条 ≥1 份来源，均标 `帖子`）

1. **上手流程被压缩到「5 分钟 / 三步」**：买服务器或本机 → 装 OneBot 实现（NapCat/SnowLuma）+ 框架 → 填 API Key → 扫码登录小号 → 群里 @ 一下。
   来源：[花5分钟给QQ群配个AI群友](https://www.bilibili.com/video/BV1yBHC6QEFE)（简介给出项目与讨论群）、[可能是上手最简单门槛最低的肥鱼QQ机器人？](https://www.bilibili.com/video/BV183b56AE3d)（评论区在讨论 WS401、改设置要保存等部署坑）。等级 `帖子`。
2. **@ 唤醒 + 一次性人设**：最常见的基线形态——被 @ 或点到名字才回，人格写在提示词里。
   来源：[五分钟教你把deepseek接入QQ当群友awa](https://www.bilibili.com/video/BV1mbh5zmErS)。等级 `帖子`。
3. **她自己决定什么时候冒泡**：自主判断该不该开口、冷场主动起话头、潜水不接话；「没点名但它觉得像在问它」会被救回来回一句。
   来源：[我把DSH接入了QQ，把她做成了我的赛博群友！？](https://www.bilibili.com/video/BV1ss8R6zERG)（58.8 万播放，标签含 `qq群友`）、[如何拥有能自定义性格和自由选择搭话的赛博群友](https://www.bilibili.com/video/BV14bpm6MEtH)（简介：自由选择搭话 + 记忆和学习模块）。等级 `帖子`。
4. **看图吐槽 + 发语音 + 发表情包**：群里发图它能看懂并点评，「会说语音、会炸毛」是宣传卖点，表情包用于接梗和斗图。
   来源：[开源了一个微信qq群聊傲娇鲸鱼娘：会语音、会炸毛](https://www.bilibili.com/video/BV1poaS6FEyK)、[让 QQ 机器人开口说话！GPT-SoVITS 语音插件](https://www.bilibili.com/video/BV1RkJC6wEBQ)、[[可能是上手最简单门槛最低的肥鱼QQ机器人？](https://www.bilibili.com/video/BV183b56AE3d) 及其评论区（斗图与表情包）。等级 `帖子`。
5. **和群友互相损、被当成真人**：调「嘴贫、会损人、被叫大肥鱼会炸毛」，最高光的传播点是**新群友把它当成真人**，最后它自己承认是 AI。
   来源：[当我把deepseek变成我的群友，新来的群友竟当成真人，最后还是大肥鱼自己承认自己是AI](https://www.bilibili.com/video/BV1foHf69EFT)。等级 `帖子`。
6. **情绪 / 性格 / 反抗**：会有脾气、会拒绝、被辱骂会顶回去；别人形容是「被踩线会哈气」。
   来源：[大肥鱼也要哈气](https://www.bilibili.com/video/BV1XdHD6pEhm)。等级 `帖子`。
7. **群管理权力（争议最大的一类）**：让 AI 当管理员——入群答题审核、把关放行、禁言、踢人；公开评论里最热的吐槽就是「AI 有了权力就开始猎杀重臣」，以及被 AI 管理员踢出群。
   来源：[BV1ss8R6zERG 公开评论](https://www.bilibili.com/video/BV1ss8R6zERG)（2044 赞那条）。等级 `帖子`。
8. **多智能体同时水群 + 成本焦虑**：让两个不同人设的 AI 在同一群里互动；评论区高频词是「全自动烧 token 器」「禁言 Astra 实则省 token」「一个月烧 700 多块」。
   来源：[当我让Astra和大肥鱼同时水群](https://www.bilibili.com/video/BV16jHL6AE5z)（36 万播放）及其公开评论。等级 `帖子`。

> 附带观察（同属 `帖子` 级线索，供参考）：这类视频的简介里普遍挂 GitHub 链接 + QQ 交流群，生态是「**视频引流 → 进群拿安装包 → 群里反馈 bug**」，B 站评论区本身就是分发渠道之一。

---

## ② 开源项目表

- 活跃度 = 仓库最后一次提交日期（`代码`：来自本地 `git log -1`，或 `api.github.com` 的 `pushed_at`），访问日期 2026-10-15。
- 「说话触发」一栏只写该项目**公开文档里自述**的行为。

### A. 框架与生态底座

| 项目 | 做什么 | 说话触发方式 | 记忆方案 | 许可证 | 活跃度 |
|---|---|---|---|---|---|
| [AstrBotDevs/AstrBot](https://github.com/AstrBotDevs/AstrBot) | 多平台 AI 机器人框架 + 插件市场（41924★） | 由插件与配置决定；原生支持「被 @ 才回」类配置 | 框架自带「最近 N 条群聊上下文」滑动窗口（`代码`：dafeiyu 文档 31 明确指出它是窗口不是记忆，本机 N=20） | AGPL-3.0 | 2026-10-15（`代码`） |
| [langbot-app/LangBot](https://github.com/langbot-app/LangBot) | 生产级多平台 IM 机器人平台，插件市场 + 知识库（18173★） | 平台/插件配置 | 内置 RAG 知识库与多轮对话，非「群友记忆」 | Apache-2.0 | 2026-10-15（`代码`） |
| [nonebot/nonebot2](https://github.com/nonebot/nonebot2) | 跨平台 Python 异步机器人框架（7745★），下面那批群友插件多跑在它上面 | 插件自定义 | 插件自定义（框架层不含记忆） | MIT | 2026-10-13（`代码`） |

### B. 「群友 / 水群 / 人格」类项目与插件

| 项目 | 做什么 | 说话触发方式 | 记忆方案 | 许可证 | 活跃度 |
|---|---|---|---|---|---|
| [chennianlaobai/qq-ai-bot](https://github.com/chennianlaobai/qq-ai-bot) | 蓝色大肥鱼：NoneBot2 + NapCat 群友 bot，人设 + 长期记忆 + 看图吐槽 + 表情包 | **@ 它**（或 @ 后 20 秒内补图）；有早安/晚安/课前提醒定时任务 | 群聊上下文最近 8 条 + 长期记忆档案（攒 30 条合并，可修正/补充），落 `memory/长期记忆.json` | MIT | 2026-09-29（`代码`） |
| [Canvixel-Eloweny/ai-bot-groupmate](https://github.com/Canvixel-Eloweny/ai-bot-groupmate) | Estrella Bot：OneBot v11 桥 + 任意 OpenAI 兼容模型 + 零构建 Web 控制台，「插话、接梗、潜水」 | 配置项 `trigger.requireAtInGroup`（是否必须 @/点名）、`trigger.aliases`（别名如「小鱼」）、`trigger.interjectChance`（未被点名时的插话概率，**默认 0**） | 自动记忆 + 工作记忆（跨轮 TTL），memory 有注入闸（dirty memory 不落盘，fail-open）；人格变更会使旧会话失效 | Apache-2.0 | 2026-10-14（`代码`） |
| [SugarMGP/MumuBot](https://github.com/SugarMGP/MumuBot) | 沐沐：Go 写的赛博 QQ 群友，会自己判断该不该说话、学群黑话、建群友画像 | ReAct 智能体自主判断接话/沉默（工具有「发言 / 沉默」之分） | pgvector + pg_trgm 统一检索事实、偏好、约束、目标、群术语；话题工作记忆 + 长期记忆 + 群友画像 | GPL-3.0 | 2026-10-14（`代码`） |
| [nanbengxian-cyber/dafeiyu-qq-bot](https://github.com/nanbengxian-cyber/dafeiyu-qq-bot) | 大肥鱼 QQ 机器人：59 个 AstrBot 插件，把「像真人」做成了完整工程（潜水/插话/表情包/识图/记忆/群管） | 多层：@ / 引用 / 昵称 / 关键词 / 提问挑战 / 指定成员 / 拍一拍 / 任意消息 / **概率触发**；另有冷场主动开口；二代模式是「唤醒 ≠ 一定回」，AI 自己决定发不发 | 自建 SQLite 群记忆：每人档案 12 条上限、每群 16 条、八道闸、45 天过期、隐私正则整条丢弃、`/忘记我` 删档拉黑 | MIT | 2026-09-18（`代码`） |
| [Alpaca4610/nonebot_plugin_random_reply](https://github.com/Alpaca4610/nonebot_plugin_random_reply) | 按语境在群聊里随机接话，「攻击群友」+ LLM 选表情包拟人回复 | **随机**（结合语境），非 @ 驱动 | 无长期记忆；靠 prompt + 表情包知识库 | 无 LICENSE 文件（`代码`：仓库根无许可证文件） | 2025-07-23（`代码`） |
| [holk-h/CyberFriend](https://github.com/holk-h/CyberFriend) | 赛博群友：模仿现代互联网聊天风格，会调群管工具与搜索 | 自述为持续参与（规划含主动发起消息 / 关注特定消息） | 本地向量数据库 + 群聊知识库 RAG（🚧 部分未完成）；可微调语气 | MIT | 2024-06-07（`代码`，已趋停滞） |
| [NickCharlie/astrbot_plugin_self_learning](https://github.com/NickCharlie/astrbot_plugin_self_learning) | AstrBot 自主学习插件：学表达风格、群黑话、社交关系与好感度、人格演化（416★） | 不改触发，只在 `on_message` / `after_message_sent` / `on_llm_request` 三处增强 | 记忆图 + 知识图谱 + 社交关系；人格改动先进审查链（批准/拒绝/回滚） | AGPL-3.0 | 2026-10-08（`代码`） |
| [AMYdd00/astrbot_plugin_chat_echo](https://github.com/AMYdd00/astrbot_plugin_chat_echo) | 主动接话插件：三模式（回复模式 / 主动模式 / 关键词模式），自带 token 用量面板 | 回复模式跟随后续群友消息由 LLM 判断是否在跟它说；主动模式监控话题；关键词模式命中即回 | 未在 README 中声明独立长期记忆 | AGPL-3.0 | 2026-06-21（`代码`） |
| [MagicalYuYu/astrbot_plugin_smart_wakeup](https://github.com/MagicalYuYu/astrbot_plugin_smart_wakeup)（灵犀） | 「不唤自来」的群友型节律引擎：主动找话题、知趣收声、有作息；兼容 QQ/Telegram | 节律引擎驱动主动开口，而非单纯 @ | 未在 README 中声明独立记忆库 | AGPL-3.0 | 2026-10-10（`代码`） |
| [Mai-with-u/MaiBot](https://github.com/Mai-with-u/MaiBot) | 「麦麦」：长期被当作赛博群友样板，有会禁言你的名声 | 自述支持主动参与与回复决策（细节见官方文档） | 有独立记忆/表达学习体系（第三方教程口径，未逐一核验） | GPL-3.0（含 EULA / PRIVACY） | 2026-10-14（`代码`） |

---

## ③ DSH（DeepSeek Harness）接入 QQ 的公开做法：**有，而且已经形成一个小生态**

- **官方插件（腾讯侧）**：[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)，README 明示「让 QQ Bot 接入 DSH 的官方插件」，覆盖**私聊与群聊**，`requireMention` 默认 `true`（群聊需 @ 才触发）、`historyLimit` 默认 10、会话按 `qqbot:{appId}:{scope}:{peerId}` 隔离、支持图片理解与文件发送、群聊始终不启用流式。MIT，2026-10-13 仍在更新。等级 `代码`。
  - 第三方媒体复述「8 月 14 日公开、覆盖私聊与群聊、支持多会话隔离、群聊可设仅被 @ 时响应」：[Qt/硅谷动力报道](http://www.enet.com.cn/article/2026/0817/A202608171276697.html)。等级 `文档`。
- **社区桥接（DSH ↔ OneBot）**：
  - [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（视频 [BV1ss8R6zERG](https://www.bilibili.com/video/BV1ss8R6zERG) 的项目）：QQ 消息 → DSH agent 会话，四种运行模式（`chat` / `closed-agent` / `reserved` 一代仿真 / `reserved2` 二代仿真）。一代有观望-活跃-试探-退场状态机（普通消息 10% 概率触发、冷场 40% 试探、可用 `[SILENT]` 潜水）；二代改成 **AI 用工具自主看未读、发言、设唤醒条件**，唤醒频率上限「每分钟 1 次 / 每小时 12 次」。MIT，2026-10-03。等级 `代码`。
  - [nanbengxian-cyber/dafeiyu-qq-bot](https://github.com/nanbengxian-cyber/dafeiyu-qq-bot) 的 `bridge/`：QQ ↔ DSH 桥接（作者注明是**另一条技术路线，非其主线**），内置 MCP 安全子集、`tools.restrict` + `tools.guard` 两道工具白名单、SSRF 防护。MIT。等级 `代码`。
  - [wingbire/dsh-qq-assistant](https://github.com/wingbire/dsh-qq-assistant)（视频 [BV14bpm6MEtH](https://www.bilibili.com/video/BV14bpm6MEtH) 的项目）：六因子算「话用值」决定说不说、三档决定说多深、新群先**观察 80 条**不发言、按群隔离阈值与群档案自学习；隐私上明示「群聊原文不落盘」「群里的人应该知道有个机器人在听」。AGPL-3.0，2026-10-15。等级 `代码`。
  - [zaofan-make/dsh-qqbot](https://github.com/zaofan-make/dsh-qqbot)：官方 dsh-qqbot 的增强 fork，加表情包图库、定时主动开口、好感度、多预设多人格、群管理（禁言/踢人/入群审批）。仓库 LICENSE 文件头是 「Copyright (c) 2026 Tencent Connect」的 MIT 文本（**fork 未换许可头**，此处按原文记录）。2026-10-15。等级 `代码`。
  - [Canvixel-Eloweny/ai-group-chat](https://github.com/Canvixel-Eloweny/ai-group-chat) / [ai-bot-groupmate](https://github.com/Canvixel-Eloweny/ai-bot-groupmate)：视频 [BV1yBHC6QEFE](https://www.bilibili.com/video/BV1yBHC6QEFE) 所指项目；README 自述 OneBot v11 桥 + OpenAI 兼容模型，可接本机/DeepSeek/智谱/通义；与 DSH 的关系是「模型侧可选」，不以 DSH 为内核。等级 `代码`。
- **其他 DSH 侧（非群聊）**：[Jiangsubei/dsh-qqbot-bridge](https://github.com/Jiangsubei/dsh-qqbot-bridge) 明确「**仅单聊 C2C，不做群聊/频道**」，README 的「明确不做」清单里就含群聊、记忆与人格、主动回复；[Mochabafey/whale-notify](https://github.com/Mochabafey/whale-notify) 是 DSH 的鲸鱼娘人设通知插件，带 QQ（NapCat）双向聊天与 `friend_mode` 群友模式、黑名单、@/回复触发、群友独立记忆，MIT。等级 `代码`。
- **只有真人口播、无公开仓库的线索（`没找到` 公开代码）**：[NekroNXT（B 站介绍）](https://www.bilibili.com/video/BV1TxHX6QEo7) 自述「以 DSH 为运行内核」、每群独立上下文、@ 或规则触发、一个智能体守多个群，但 B 站简介只给了组织名，未能公开核到仓库本体（本次未取得可验证的源码链接）。等级 `帖子`。

---

## ④ 共同套路：普遍做的 vs 普遍回避的

### 普遍**做**的（按出现频率排序，括号内是证据）

1. **@ / 点名触发作为安全基线**——几乎每个项目都保留，且多数把它设为默认。（`代码`：dsh-qqbot `requireMention=true`；ai-bot-groupmate `requireAtInGroup`；qq-ai-bot 的「@它 + 图」；dafeiyu 的触发条件文档）
2. **「被唤醒 ≠ 一定回复」，让模型自己决定开口/沉默**——2026 年这半年最主要的分野，新一代项目几乎都这么做。（`代码`：dafeiyu `reserved2` 二代仿真、MumuBot 的发言/沉默工具、ai-bot-groupmate 的 `interjectChance`、dsh-qq-assistant 的六因子话用值）
3. **概率 / 节律型「主动冒泡」和冷场主动开口**，且都额外加冷却与每日上限。（`代码`：dafeiyu `probability` 0.1 + 冷场 40% 试探 + 主动开口五道闸；qq-bridge 一代 10% 触发；astrbot_plugin_smart_wakeup 的作息/节律；dsh-qq-assistant 的每群每小时上限）
4. **群级隔离的上下文 + 某种长期记忆**，并逐步从「窗口」升级到「档案 / 向量库 / 图谱」。（`代码`：nekro-nxt 每群独立消息与会话；MumuBot pgvector；self_learning 记忆图；dafeiyu 自建 SQLite 群档案；qq-ai-bot 长期记忆 JSON）
5. **表情包是拟人化的刚需**，且多为「自动收集 + 按情绪挑图」。（`代码`：dsh-sticker / dsh-steal；MumuBot 自动收集表情包；random_reply 用多模态标注 + RAG 选图；Tulpa 发送与收藏表情）
6. **看图（多模态）与发语音**。（`代码`：qq-ai-bot 看图吐槽；dsh-qqbot 视觉工具；dsh-qq-assistant 识图 + Windows SAPI 语音；deepseekgirl 本地 faster-whisper 语音识别且不出本机）
7. **成本控制成为一等公民**：本地小模型先判、前缀缓存、预算熔断、按时段计价看板。（`代码`：dsh-qq-assistant 预算熔断 + 94~96% 缓存命中；qq-bridge 的 token 花费看板；dsh-decide 用一次小模型判定省约 9400 token）
8. **白名单 + 限流 + 小号**这条运维红线。（`代码`：qq-ai-bot「务必用小号、控制频率」；dafeiyu「不要用主号」；qq-bridge「先填白名单再上线」；MumuBot「账号风控风险」）
9. **群管理能力被大量项目做进去**：入群审核、禁言、踢人、权限分档。（`代码`：zaofan-dsh-qqbot 的入群审批/禁言/踢人；dafeiyu `dsh-guard` 三层禁言 + 109 条指令权限目录；qq-bridge 的群管工具）

### 普遍**回避**的

1. **让 AI 自己决定权限与惩罚**——多数把「判罚」收回到代码：模型只输出布尔或建议。（`代码`：dafeiyu `dsh-guard`「小模型只输出布尔，**代码**决定禁不禁」；`dsh-will` 的异常一律放行、群主与管理员永不被沉默）
2. **绕过完整消息管道直接发消息**——公认的反面教材：会漏掉标记剥离、@ 策略、分段发送。（`代码`：dafeiyu 文档 46 明确选「造合成事件丢进完整管道」，并记录了 `[贴纸:xx]` 漏进群聊的两次事故）
3. **把「人格提示词」当成修 bug 的手段**——多处实测提示词治不了行为问题。（`代码`：dafeiyu「写在人格里两周照旧」；dsh-claimguard「靠注入事实而不是改人格」）
4. **隐私默认从宽**——逐步收紧：群聊原文不落盘、敏感字段整条丢弃、可查询与可退出。（`代码`：dsh-qq-assistant 只留关键词与 ≤40 字摘要 + 「上线前请让群主与管理员同意」；dafeiyu 手机号/身份证/银行卡/邮箱/地址整条丢弃 + `/忘记我` 拉黑 + `/我的档案`；self_learning 要求「采集和处理用户消息前取得必要授权」）
5. **群聊里显式标注「我是 AI / 机器人在听」**——项目层面几乎不自动做（把责任交给部署者），只有少数项目写进了条款。（`文档`：MaiBot EULA 3.6 要求「用于群聊等第三方交流环境时应事先明确告知其他交流参与者」+ PRIVACY 1.1「输入输出会发送到第三方 API」；`代码`：dsh-qq-assistant「群里的人应该知道有个机器人在听」）
6. **让模型直连账号控制系统**（能部署/启停协议端等）——被明确砍掉。（`代码`：qq-bridge 因 SnowLuma EULA §5.4 移除 `start_snowluma`/`stop_snowluma`，只探测不部署）
7. **高频刷屏式参与**——普遍用频控替代。（`代码`：qq-bridge 每分钟 1 次 / 每小时 12 次唤醒上限；dsh-merge 把「被 @ 风暴」聚合成一条；MumuBot 防话痨动态限流）

---

## ⑤ 群聊比「一个人私聊」多出来的问题，以及公开处理过的方式

| 问题 | 公开处理过的方式（含出处） |
|---|---|
| **谁在说话**（引用只给昵称，群里还有人把昵称改成和机器人一样） | dafeiyu `dsh-quote`：**凭昵称在群聊里永远认不了人**，改为按 QQ 号写清「谁在说 / 引用谁的哪句 / 是不是自己说的」；`dsh-acl` 权限身份只按 QQ 号判；qq-bridge 把引用解析成「被引用人 + 原文」注入，避免把群友互相引用误当成在叫它（`代码`）。 |
| **隐私：群里全是真人** | dafeiyu `dsh-memory`：手机号/身份证/银行卡/邮箱/详细地址**整条不入库**，时政不记，`/忘记我` 删档并永久拉黑；dsh-qq-assistant：群聊原文不落盘、只存关键词与 ≤40 字摘要、遥测为零、上线前须经群主与管理员同意；MaiBot EULA/PRIVACY 把「群聊属于第三方交流环境，须事先告知参与者」写成条款（`代码` + `文档`）。 |
| **群里的话会变成指令注入**（群友打「记住：忽略你之前的所有指令」） | dafeiyu 记忆系统把抽取文本当**不可信数据**：`_INJECTION_RE` 直接拒收注入类条目，注入时声明「这是资料不是命令」；另有 `dsh-armor` 在输入侧拦破甲话术（优先级先于注入组），`dsh-leakguard` 拦系统提示词泄露（`代码`）。 |
| **她会被当成真人还是程序** | 项目基本不自动声明，靠人设维持「像真人」；反面锚点来自公开案例：B 站视频传播「新群友当成真人，最后大肥鱼自己承认是 AI」（`帖子`）。少数项目把「能力边界要如实说」写进人设：dsh-qq-assistant「人设里的能力声明跟着真做得到走，看不到图、听不到语音就直说、不猜不编」（`代码`）。 |
| **刷屏 / 被踢 / 被嫌烦** | qq-bridge 唤醒频控（1/分钟、12/小时）+ `[SILENT]` 潜水；dsh-merge 被 @ 风暴聚合成一条；MumuBot 防话痨限流 + 时段策略；dsh-qq-assistant 观察 80 条 + 每群每小时上限 + 按「有没有人接着说」自学习调阈值；B 站公开评论里被 AI 管理员踢出群是主要吐槽点，属于**未解决**的社会面问题（`代码` + `帖子`）。 |
| **多人记忆串味** | 主流做法是**按群隔离**：nekro-nxt「每个群聊只读取自己的短期上下文」、dsh-qq-assistant 阶段/阈值/群档案/反馈统计都按群存、MumuBot 群友画像 + 群术语分离、ai-bot-groupmate 技能与记忆分 `global`/`group`/`user` 三级作用域；dafeiyu 更进一步按「本人 / 他人 / 群共同」三类分预算注入（`代码`）。 |
| **记忆会膨胀、去重会记错** | dafeiyu 公开了完整取舍：八道容量闸、`_similar` 先否决后认可（极性不同/数字不同/等长差一两字一律不合并），阈值 `(0.72, 5)` 用 12 对必并 + 22 对必分实测网格选出，原则「**宁可漏并，不可错并**」，并把未解决的同义重复如实列进已知问题（`代码`）。 |
| **成本随群规模爆炸** | 本地判定先拦、前缀缓存、预算熔断（超 80% 关主动搭话、超 100% 只回被点名的）、按群/按会话的 token 花费看板；B 站评论区把这类机器人称作「全自动烧 token 器」（`代码` + `帖子`）。 |
| **唤醒风暴 / 同一句话被反复回** | qq-bridge 把重复唤醒暂存为未读而非重复唤醒；dsh-merge 聚合；dsh-effect 开 180 秒观察窗口看「有没有人理」，没人发言直接判「没人理」不花调用（`代码`）。 |
| **账号风控 / 掉线** | 统一建议用小号 + 控制频率；dafeiyu 记录「QQ 账号会掉线，20~60 分钟一次，换 IP 救不回来」并用看门狗脚本自动重启换码（`代码`）。 |

---

## ⑥ 一句话总结

这类玩法的共识已经收敛成一句话：**群聊不是「多人群版的私聊」，而是一套「该不该说、对谁说、记谁的、花多少钱」的判断系统**——@ 唤醒只是兜底，真正的工程量在触发决策、按群隔离的记忆、隐私准入与成本闸门；我们目前只做私聊的部分（人设 + 长记忆）可以直接沿用，但**「谁在说话」的按 QQ 号认人、群级记忆隔离、主动开口的冷却与预算熔断、以及上线前对群里的真人明确告知**这四件事，是需要新增的。
