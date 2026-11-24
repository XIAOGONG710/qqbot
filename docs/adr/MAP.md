# ADR 地图（生成的，别手改）

> 由 `node scripts/adr-map.mjs --out docs/adr/MAP.md` 生成。「文件里的状态」照抄每份 ADR 头上那行，常常停在写的那天；
> 开关和线上值来自功能总表（`packages/bot/src/platform/features.ts` 的 adr 字段）和线上快照（`exchange/live/koishi-2026-11-20-1855.yaml`）——**以这一列为准**。「默认」= 快照里没写，按代码默认值。
> 编号登记、撞号的说明见 [INDEX.md](INDEX.md)。

**同一个编号有两份的**：0224（0224-external-draft-queue.md、0224-mobile-companion.md）；0225（0225-community-review-2026-11.md、0225-dsh-state-snapshot.md）；0226（0226-dsh-desktop-inbox.md、0226-memory-evidence.md）

| ADR | 标题 | 文件里的状态 | 开关（线上） |
|---|---|---|---|
| [0001](0001-repository-structure.md) | 仓库结构——上游以子模块引入，自有代码独立存放 | 已采纳；决策第 2 条中“通过 ST 插件 / 扩展挂载”已被 [ADR 0002](0002-standalone-r… |  |
| [0002](0002-standalone-runtime.md) | 运行时独立于 SillyTavern，SillyTavern 只负责编写角色和定义数据格式 | 已采纳 |  |
| [0003](0003-contact-tiers.md) | 按联系人分档（M2，私聊） | 已采纳（2026-10-04 与用户确认，见文末「确认记录」） |  |
| [0004](0004-time-scheduling-memory.md) | 按调研方案在运行时实现时间感、消息调度与长期记忆 | 已采纳（2026-10-04 与用户确认，见文末「确认记录」） |  |
| [0005](0005-scenario-simulation.md) | 验收用例先在模拟器里跑（虚拟时钟 + 真模型 + 测试 bank） | 已采纳（2026-10-04，用户提出并确认，见文末「确认记录」） |  |
| [0006](0006-exit-check.md) | 出口检查——括号动作、做不到的事、低档位禁用词、长回复的气泡数 | 已采纳（2026-10-04 与用户确认，见文末「确认记录」） |  |
| [0007](0007-schedule-and-reply-timing.md) | 作息与回复时机——她现在在干什么，什么时候看到消息，多快回 | 已采纳（2026-10-04 与用户确认，见文末「确认记录」） | `schedule` 开 |
| [0008](0008-koishi-runtime.md) | 运行时迁到 Koishi 4——Koishi 当外壳，我们的模块写成自己的插件 | 已采纳（2026-10-05：待定问题与用户确认，第 2 步试验后按「试验之后的调整」修改，调整第 1 条经用户确认） |  |
| [0009](0009-console-usability.md) | 控制台易用性——整理插件表单（A），角色资料在控制台里改（B，定方向） | 已采纳（2026-10-05：待定问题与用户确认，见文末「确认记录」；试验后的调整见「试验结果」，A2 名单用卡片由用户… |  |
| [0010](0010-character-editor-page.md) | 控制台里的「林梦瑶」页面——角色资料改成可编辑的来源，页面上改、保存时检查 | 已采纳（2026-10-05：待定问题与用户确认，见文末「确认记录」） |  |
| [0011](0011-proactive-messages.md) | 主动消息——她在合适的时候先开口 | 已采纳（2026-10-05：待定问题与用户确认，见文末「确认记录」；第 9、10 节是按用户的选择补的细节） | `proactive` 开 |
| [0012](0012-hindsight-tuning.md) | Hindsight 调优——趁记忆从头攒，先把写入和召回调好 | 已采纳（2026-10-05：待定问题与用户确认，见文末「确认记录」） |  |
| [0013](0013-old-project-advice.md) | 旧项目建议里还用得上的几条——档位节奏、看心情不回、状态文件 | 已采纳（2026-10-05：档位节奏、气泡停顿、看心情不回三件与用户确认，见文末「确认记录」） | `moody` 默认 |
| [0014](0014-speech-habits.md) | 说话的毛病——助手腔、重复口癖、算账、自己编出来的不高兴 | 已采纳（2026-10-05 与用户确认，见文末「确认记录」） | `speechCheck` 默认 |
| [0015](0015-her-own-days.md) | 她自己的日子——每日心情、在读的书 | 已采纳（2026-10-05 与用户确认，见文末「确认记录」） | `herDays` 默认 |
| [0016](0016-people-she-knows.md) | 她认识的人——名单里的人互相认识、公共记忆库 | 已采纳（2026-10-06 与用户确认，见文末「确认记录」） |  |
| [0017](0017-long-term-memory-like-a-person.md) | 像真人一样的长期记忆——有线索才想起、她的日记、对每个人的印象 | 已采纳（2026-10-06 与用户确认，见文末「确认记录」） |  |
| [0018](0018-memory-fades-and-promises.md) | 更像真人的记忆——会变淡、一提就想起、记得自己答应的事、按周回忆 | 已采纳（2026-10-06 与用户确认，见文末「确认记录」） |  |
| [0019](0019-today-layer.md) | 当天这一层——状态行只写约束、这一轮想要什么、心情写底色、对照的酸话、热聊多等一下、示例要不要常驻 | 采用（2026-10-06 起草；同日用户授权按推荐推进，见文末「确认记录」） |  |
| [0020](0020-disclosure-and-social-life.md) | 披露分级与她自己的社交生活 | 真模型验证通过，待上线（2026-10-07；见「实现时的调整」「验证」） |  |
| [0021](0021-her-world.md) | 她的世界——身边会自己变的东西（W0–W2） | W0–W2 已实现并上线；W3 见 [ADR 0027](0027-world-writeback.md)；W4–W6 … |  |
| [0022](0022-her-past.md) | 她的过去——作者定稿的自传进资料，有线索才想起 | 第 1、2 步实现，真模型验证通过，待上线（2026-10-07） |  |
| [0023](0023-open-loops.md) | 挂着的事——在等他说的、她问了没答的、说好没成的 | 采用，真模型验证通过，待上线（2026-10-07；作者 10-06 裁决 + 用户 10-07 授权按推荐推进，见文末… |  |
| [0024](0024-expression-layer.md) | 表达层——长短不一、打错字再改口 | 实现，真模型验证通过，待上线（2026-10-07） |  |
| [0025](0025-her-body.md) | 她的身体——困、累、饿、生理期、小感冒 | 实现，真模型验证通过，待上线（2026-10-07） |  |
| [0026](0026-diary-of-her-day.md) | 日记写进她自己的一天 | 实现，真模型验证通过，待上线（2026-10-07） |  |
| [0027](0027-world-writeback.md) | 说出口的行为回写她的世界（W3） | 已实现、真模型验证并上线（2026-10-07 21:31） |  |
| [0028](0028-emotional-inertia.md) | 情绪有来处，也有余温 | 已实现、真模型验证并上线（2026-10-07 21:49） |  |
| [0029](0029-life-event-ledger.md) | 统一生活事件账与无聊天重放 | 已实现并上线（2026-10-07 23:22，和 ADR 0030、0031 一起） |  |
| [0030](0030-doing-now-follows-her-world.md) | 此刻在做的事和她的世界接上（类型化行动第一步） | 实现，真模型验证通过，2026-10-07 23:22 上线 |  |
| [0031](0031-her-routine.md) | 她的日常——吃饭、洗澡，洗澡时看不到消息 | 实现，真模型验证通过，2026-10-07 23:22 上线 |  |
| [0032](0032-she-remembers-her-days.md) | 问到过去哪一天，她记得自己那天过的事 | 已实现、真模型验证通过，2026-10-08 20:18 上线 |  |
| [0033](0033-npc-days.md) | 两位闺蜜也有自己的日子 | 已实现、真模型验证通过，2026-10-08 20:18 上线 |  |
| [0034](0034-day-plans.md) | 她的一天有打算，也会改 | 已实现、真模型验证通过，2026-10-08 20:18 上线 |  |
| [0035](0035-her-money.md) | 她的钱 | 已实现、真模型验证通过，2026-10-08 20:18 上线 |  |
| [0036](0036-conversation-naturalness.md) | 自然对话先接眼前这句话 | 已上线（2026-10-08 20:59） |  |
| [0037](0037-typed-life-actions.md) | 类型化行动与世界裁判 | 第一增量已实现、已验证（2026-10-08） |  |
| [0038](0038-replayable-action-queue.md) | 行动先排队，结束后才成为事实 | 模拟器增量已实现、已验证（2026-10-08） |  |
| [0039](0039-restart-consistency.md) | 重启前后她是同一个人 | 已实现、真模型回归通过，2026-10-08 23:55 上线（用户选「现在上线」，`main` 快进到 `9a2bf9… |  |
| [0040](0040-rule-life-selector.md) | 没人聊天时她一件件过日子（规则自主选择器 v1） | 已实现（模拟器，影子模式：记账、不进提示词），单元测试、模拟器回归见下（2026-10-09） | `autonomousLife` 开 |
| [0041](0041-candidate-pick.md) | 他难过、说亲密话、收尾时挑候选 | 已实现，模拟器 A/B 见下（2026-10-09）；线上默认不开（配置 `candidates: 1`） |  |
| [0042](0042-interrupts-and-chat-rewrites.md) | 硬事件打断、聊天里说过的事改写还没过的日子 | 实现中（2026-10-09） |  |
| [0043](0043-context-window-experiment.md) | 最近若干轮原文 + 更早聊天要点 | 离线实验已实现并完成首轮真模型 A/B；2026-10-09 下午补了后台整理和配置开关（`contextTurns`，… |  |
| [0044](0044-npc-and-project-actions.md) | 同学来往和长期项目进行动账（生活内核 A 阶段的最后两项） | 已上线（影子模式：记账、不进提示词；2026-10-09 15:07 开启），单元测试、模拟器回归见下 |  |
| [0045](0045-continuous-needs.md) | 精力、饥饿、压力先成为可重放的事实投影 | 第二步已在影子模式上线（纯投影、版本化锚点和宽阈值选择；仍不进提示词） | `lifeInPrompt` 开 |
| [0046](0046-meeting-in-person.md) | 见面可以答应，见了面也在 QQ 上说话 | 已上线（2026-10-10 01:53，和 ADR 0047 一起，`main` = `447105f`，用户同意后重… |  |
| [0047](0047-meetups-in-her-day.md) | 约好的见面进她当天的安排 | 已上线（2026-10-10 01:53，`main` = `447105f`，用户同意后重启 Koishi；日志确认插… |  |
| [0048](0048-real-weather.md) | 真实天气 | 已上线（2026-10-10 13:28，`main` = `integration` = `1e86548`（`rel… | `realWeather` 默认 |
| [0049](0049-chat-day-markers.md) | 聊天记录隔天插日期 | 已上线（2026-10-10 13:28，`main` = `integration` = `1e86548`（`rel… |  |
| [0050](0050-rain-proactive.md) | 下雨了她主动找他 | 已上线（2026-10-10 13:28，`main` = `integration` = `1e86548`（`rel… |  |
| [0051](0051-qq-faces.md) | QQ 小黄脸两个方向都通 | 已上线（2026-10-10 13:28，`main` = `integration` = `1e86548`（`rel… |  |
| [0052](0052-voice-and-images.md) | 他发的语音和图片，她「听得到、看得到字」 | 已上线（2026-10-10 13:28，`main` = `integration` = `1e86548`（`rel… | `media` 默认 |
| [0053](0053-buying-the-camera.md) | 攒够了，这周末去买相机 | 已上线（2026-10-10 18:31，`main` = `07bfe16`，用户同意后重启 Koishi；上线前 b… |  |
| [0054](0054-life-ledger-in-prompt.md) | 生活账接进提示词（第一步）——她这几天练拍照修图 | 已实现，开关默认关（配置 `lifeInPrompt`）；等影子账满两整天再审一次（10-11 15:00 以后），干净… |  |
| [0055](0055-deepseek-vision.md) | 用现有 DeepSeek 接口看懂图片 | 已实现，默认关；尚未上线 |  |
| [0056](0056-project-portfolio.md) | 项目组合先成为事实投影 | 已实现事实层与共享选择，14 天模拟通过；线上开关默认关 | `projectChoice` 开 |
| [0057](0057-her-news.md) | 她那边刚有件事，主动告诉他 | 已实现，待上线（分支 `news-occasion`） |  |
| [0058](0058-intimate-reciprocity.md) | 男朋友的亲密邀约先回应、再嘴硬 | 已实现；真模型回归通过 |  |
| [0059](0059-meme-banter.md) | 先认出“他在玩”，再顺着接梗 | 已实现；真模型回归通过 |  |
| [0060](0060-photo-asks.md) | 他要看照片——她先不发，用她自己的理由，再说给他听 | 已上线（10-11 11:00，`57526b5`，和 GPT 的 `codex/intimacy-followup` … |  |
| [0061](0061-friends-ask-and-back-out.md) | 闺蜜也会约她、也会变卦；她也会说不（C1） | 事实层 + 世界层接线已实现并测过，配置 `npcAsks` 默认关，线上完全不变（分支 `claude/npc-ask… | `npcAsks` 开 |
| [0063](0063-image-stickers.md) | 她自己的图片表情收藏 | 已实现，默认关；真 QQ 单图技术冒烟已通过，尚未完成 collect 描述核对、未上线 | `stickers` 开 |
| [0064](0064-her-own-events-as-reasons.md) | 她账里的事成为开口的理由（0057 的推广） | 已上线（2026-10-13 12:23:48 重启 Koishi，约 30 秒，用户当次同意；线上 `main` = … |  |
| [0065](0065-knowledge-update-probe.md) | 「新事实顶掉旧事实」小测试（先量再决） | 已完成（2026-10-13）：现状够用，不做有效期层（2026-10-12 用户在 `options.md` 里选了 … |  |
| [0066](0066-reasons-for-declining-and-moving.md) | 推掉和改约要有来源（身体、日程、作业、已有的约） | 已上线（2026-10-13 13:17:31 重启 Koishi，约 30 秒，用户当次同意；线上 `main` = … |  |
| [0067](0067-disclosure-per-contact.md) | 被认真问「是不是 AI」——按联系人标记她的身份是否被对方知道 | 已上线（2026-10-12 21:54:35，`main` = `0aadc03`，用户批准后重启 Koishi；两位… |  |
| [0068](0068-crisis-response.md) | 自伤 / 危机回应的最小规则 | 已上线（2026-10-12 22:45，`main` = `1340514`，用户当次同意后重启 Koishi，约 3… |  |
| [0069](0069-stability-and-privacy-baseline.md) | 稳定性与隐私基线 | 已实现，待审查与上线 |  |
| [0070](0070-hardening-program.md) | 安全加固 17 项（分批实施） | 进行中（第 1、3、7 批已实现，待审查与上线；其余批次见下表） |  |
| [0071](0071-remember-and-change.md) | 让她「会记得、会变」——现状够用的部分和一个待用户裁决的缺口（提议，只设计不实现） | 已裁决（2026-10-15）：用户看了具体例子后说「1 不能接受……直接做 D2 就行」——选选项 2（D2），实现见… |  |
| [0072](0072-who-judges.md) | 谁来评判「她像不像」——怎么把用户之外的人拉进来、又不损害隐私（提议，只列选项） | 提议（只列选项，不写实现；需要用户裁决） |  |
| [0073](0073-feedback-channel.md) | 反馈通道——他在 QQ 里对她的话回「假」或「像」 | 已实现，未上线（分支 `claude/feedback-channel`，开关默认关；上线要等观察窗口结束、用户当次点头… | `feedbackCommands` 开 |
| [0074](0074-small-grievance.md) | 有起因的小别扭与和好（选项 D2） | 已实现，未上线（分支 `claude/d2-grievance`；配置 `grievance` 默认关，只对男朋友档；上… | `grievance` 开 |
| [0075](0075-reply-rhythm.md) | 回复的节奏——打字按字数、回之前有「看 + 想」 | 候选，没上线（分支 `claude/rhythm`，叠在 `claude/release-1019c` 上）；参数是经验… | `rhythm` 开 |
| [0076](0076-festivals-and-winter-break.md) | 公共节日、在家过的寒假 | 已实现，未上线（分支 `claude/festivals`；配置 `festivals` 默认 `off`；寒假是草稿，… | `festivals` 开 |
| [0077](0077-typing-status.md) | 「对方正在输入…」 | 已实现，未上线、未在真 QQ 上验证（分支 `claude/typing-status`；配置 `typingStatu… | `typingStatus` 开 |
| [0078](0078-wake-jitter.md) | 起床时刻每天不一样 | 已实现，未上线（分支 `claude/wake-jitter`；数据在 `characters/linmengyao/s… |  |
| [0079](0079-poke.md) | 他戳她一下，她会回 | 已实现，未上线、未在真 QQ 上验证（分支 `claude/poke`；配置 `pokes` 默认关） | `pokes` 开、`pokeBack` 开 |
| [0080](0080-share-cards.md) | 他分享的链接、转发的聊天记录、发的文件，她看得懂 | 已实现，未上线（分支 `claude/share-cards`；没有配置开关——只改他发来这几种消息时聊天记录里写成什么… |  |
| [0081](0081-quote-reply-read.md) | 他引用她的某句话再回，她看得到被引用的是哪句 | 已实现，未上线（分支 `claude/quote-read`；没有配置开关；上线要重启 Koishi，需要用户当次点头） |  |
| [0082](0082-recalls.md) | 他撤回一条消息，她看到的是「撤回了一条消息」 | 已实现，未上线、未在真 QQ 上验证（分支 `claude/recall`；配置 `recalls` 默认关） | `recalls` 开 |
| [0083](0083-presence.md) | 她在 QQ 上「有个人在」——已读、在线状态、表情回应、点赞、签名、说说 | 已实现，未上线、未在真 QQ 上验证（分支 `claude/presence`；六个开关各自独立、默认全关；说说和签名另… | `readReceipts` 开、`onlineStatus` 开、`profileLikes` 开、`qzone`（原 `signature`） 开 |
| [0084](0084-bilibili-browsing.md) | 她刷 B 站，刷到一个真视频，发给他 | 已实现，未上线、未开启（分支 `claude/bilibili`；配置 `bilibili` = off / dryRu… | `bilibili` 开 |
| [0085](0085-napcat-probe.md) | NapCat 探针——在你在场时一次验完「没在真 QQ 上试过」的那些动作 | 已实现，2026-10-19 在线上跑过两次（见「确认记录」）（分支 `claude/napcat-probe`；脚本 … |  |
| [0086](0086-self-recall.md) | 打错字时，有时撤回重发，而不只是补一条「*对的词」 | 已实现，未上线、未开启（分支 `claude/self-recall`；配置 `selfRecall`，默认关） | `selfRecall` 开 |
| [0087](0087-poke-out.md) | 她主动戳他一下 | 已实现，未上线、未开启（分支 `claude/poke-out`；配置 `pokeOut`，默认关） | `pokeOut` 开 |
| [0088](0088-her-temper-with-him.md) | 她对他的脾气——先傲娇、再软；被冷落会生气（男朋友档） | 草稿，未上线（分支 `claude/her-temper`）。卡片改动会热加载，上线前要用户点头。 |  |
| [0089](0089-bilibili-account.md) | 她有自己的 B 站号——搜视频、读字幕、在评论区 @ 他 | 已实现，未合并、未上线、未开启（分支 `claude/bilibili-account`；配置 `bilibiliAcc… | `bilibiliAccount` 开、`bilibiliDm` 开 |
| [0090](0090-bilibili-replies.md) | 她回复评论区里别人回她的话（先回他，其次挑有价值的，AI 相关的一律不回） | 已实现，试运行为先，未合并、未上线、未开启（分支 `claude/bilibili-account`；配置 `bilib… | `bilibiliReplies` 开 |
| [0091](0091-reply-shape.md) | 形状控制——按他说的长短定她每条最多几个字；加上一把「像不像真人」的尺子 | 已实现，未合并、未上线、未开启（分支 `claude/bilibili-account`；配置 `shape`，默认 `… |  |
| [0092](0092-bilibili-topic-comments.md) | 评论的话题模式——前期专评 AI 视频和 DSH 插件视频 | 已实现，未合并、未上线、未开启（分支 `claude/bilibili-topics`，接在 `claude/bilib… | `bilibiliComment` 开 |
| [0093](0093-blind-judge.md) | 让模型当鉴别员做盲评——量“内容”像不像真人 | 已实现（工具 `ops/blind-judge-cli.ts`，不进运行时）；“顺着说”那句提示词的新措辞随这次上线 |  |
| [0094](0094-her-own-agenda.md) | 答完他的话之后，偶尔带一件自己的事（配置 `shapeAgenda`，默认关） | 已实现；2026-10-22 随 bili9 上线（`shapeAgenda: true`，要 `shape` 开着）；… |  |
| [0095](0095-filler-turns.md) | 偶尔只回一句不带内容的话，他拖音时跟着拖（配置 `shapeFiller`，默认关） | 已实现；2026-10-22 随 bili9 上线（`shapeFiller: true`，要 `shape` 开着）；… |  |
| [0096](0096-split-and-share.md) | 条数当目标（`shapeSplit`）和「随口说件自己的事」（主动时机 `share`），都默认关 | 已实现；2026-10-22 随 bili9 上线（用户 10-22：「我希望她能主动找我进行聊天，而不是被动的接受」）… |  |
| [0097](0097-ai-smell-night-test.md) | 深夜测试对话里量出来的几处“AI 味”——被指出时不自证、很抽象的问题不答成金句、被追问不原地打转、反复说的字词提醒她换 | 已实现，已上线（2026-10-22）；没有开关，和 ADR 0091 十月二十一日那次校准同一类（意图行 + 一行提示… |  |
| [0098](0098-already-told-and-topic-pick.md) | 继续去 AI 味——说过的事不再自己提、带事的轮次抽“说哪一件”、拖音/省略、图片表情放行 | 已实现，已上线（2026-10-22；没有新开关：一行提示 / 挂在已经开着的 `shapeAgenda`、`shape… |  |
| [0099](0099-too-smooth.md) | 「太顺」——不把他的话处理完整、不马上让步、偶尔只发表情（配置 `shapeFeel`，默认关） | 已实现，未上线（2026-10-22；配置 `shapeFeel`，要 `shape` 开着；默认关）。上线 = `ko… |  |
| [0100](0100-reach-when-unanswered.md) | 他没回也继续——她自己想要不要再找他、催他一下（配置 `proactiveReach`，默认关） | 已实现，未上线（2026-10-22；配置 `proactiveReach`，要主动消息开着；默认关）。上线 = `ko… | `proactiveReach` 开 |
| [0101](0101-inner-life.md) | 内心——她一个人的时候在想什么（配置 `innerLife`，默认关） | 已实现，未上线（2026-10-22；配置 `innerLife`，要主动消息开着；默认关）。上线 = `koishi.… | `innerLife` 开 |
| [0102](0102-feelings.md) | 心境——她会开心、难过、担心，也会忍不住哭（配置 `herFeelings`，默认关） | 已实现，未上线（2026-10-22；配置 `herFeelings`，只给男朋友档；默认关）。上线 = `koishi… | `herFeelings` 开 |
| [0103](0103-her-no.md) | 她会拒绝——有来由的不，不被磨两句就让步（配置 `herNo`，默认关） | 已实现，未上线（2026-10-22；配置 `herNo`，只给男朋友档；默认关）。上线 = `koishi.yml` … | `herNo` 开 |
| [0104](0104-pursuits.md) | 她自己的追求（配置 `pursuits`，默认关） | 已实现，未上线（2026-10-22；配置 `pursuits`，只给男朋友档；默认关）。上线 = `koishi.ym… | `pursuits` 开 |
| [0105](0105-reply-lag-tail.md) | 回复延迟的长尾，和断网后自然的补回（配置 `lagTail`，默认关） | 已实现，未上线（2026-10-22；配置 `lagTail`；默认关）。上线 = `koishi.yml` 里加 `l… | `lagTail` 开 |
| [0106](0106-everyday-life.md) | 她每天碰到的小事，和一条“小测”的线（配置 `everydayLife`，默认关） | 已实现，未上线（2026-10-22；配置 `everydayLife`；默认关）。上线 = `koishi.yml` … | `everydayLife` 开 |
| [0107](0107-invite-to-play.md) | 约他一起玩（主动时机 `invite`，配置 `proactiveInvite`，默认关） | 已实现，未上线（2026-10-22；配置 `proactiveInvite`；默认关）。上线 = `koishi.ym… | `proactiveInvite` 开 |
| [0108](0108-proactive-opener.md) | 主动开口不先叫名字 | 已实现，未上线（2026-10-22；提示词措辞，没有开关；上线 = 落地代码 + 重启；回滚 = `git rever… |  |
| [0109](0109-photo-shelf.md) | 照片货架——她自己从网上找高清图发给他（配置 `photos`，默认关） | 已实现，未上线（2026-10-22；配置 `photos`；默认关）。上线 = `koishi.yml` 里加 `ph… | `photos` 开 |
| [0110](0110-photo-shares.md) | 她主动发照片——喂完土豆拍了一张（配置 `photoShares`，默认关） | 已删（2026-11-24，用户拍板 [减法单子 二.2](../plans/2026-11-24-subtractio… |  |
| [0111](0111-together.md) | 陪玩状态——答应邀约后的两三个小时她正和他一起玩（配置 `together`，默认关） | 已上线（2026-10-25 00:53，用户在 AskUserQuestion 里选「六个一起开」：comeBack、… | `together` 开 |
| [0112](0112-come-back.md) | 说了“等下”之后自己回来（主动时机 `back`，配置 `comeBack`，默认关） | 已上线（2026-10-25 00:53，用户在 AskUserQuestion 里选「六个一起开」：comeBack、… | `comeBack` 开 |
| [0113](0113-relationship-stage.md) | 关系阶段——聊得多了她更放得开（配置 `relationship`，默认关） | 已上线（2026-10-25 00:53，用户在 AskUserQuestion 里选「六个一起开」：comeBack、… | `relationship` 开 |
| [0114](0114-running-jokes.md) | 小梗回头提（配置 `jokes`，默认关） | 已上线（2026-10-25 00:53，用户在 AskUserQuestion 里选「六个一起开」：comeBack、… | `jokes` 开 |
| [0115](0115-interruptions.md) | 被第三方打断（配置 `interruptions`，默认关） | 已上线（2026-10-25 00:53，用户在 AskUserQuestion 里选「六个一起开」：comeBack、… | `interruptions` 开 |
| [0116](0116-ask-opinion.md) | 问问他的意见（主动时机 `ask`，配置 `proactiveAsk`，默认关） | 已上线（2026-10-25 00:53，用户在 AskUserQuestion 里选「六个一起开」：comeBack、… | `proactiveAsk` 开 |
| [0117](0117-his-hours.md) | 按他平时在线的钟头排（配置 `hisHours`，默认关） | 已删（2026-11-24，用户拍板 [减法单子 二.2](../plans/2026-11-24-subtractio… |  |
| [0118](0118-weekly-report.md) | 周报——每周自动出一份“她离真人还差多少”的数字（配置 `weeklyReport`，默认关） | 已实现，未上线（2026-10-22；配置 `weeklyReport`；默认关）。上线 = `koishi.yml` … | `weeklyReport` 开 |
| [0119](0119-consistency-check.md) | 前后一致性检查（只读工具，不进运行时） | 已实现（2026-10-22；工具 `node src/ops/consistency-cli.ts`；没有开关，不改运… |  |
| [0120](0120-status-dashboard.md) | 控制台“状态”页重做——按模块分组的功能开关仪表盘 | 已实现，未上线（2026-10-23；没有配置开关）。上线 = 随下一次落地重启后页面自动变（页面文件从仓库直接读）；回… |  |
| [0121](0121-odd-words.md) | 医书词和小说腔——「肚子坠着」这类真人不这么说的词 | 已实现，未上线（2026-10-23；没有配置开关，纯措辞）。上线 = 落地代码 + 重启；回滚 = `git rese… |  |
| [0122](0122-module-map.md) | 模块总表（A14 第一步，只分类、只写文档） | 已实现（2026-10-23；没有开关，不动任何运行代码） |  |
| [0123](0123-jealousy.md) | 吃醋，最轻的一档（配置 `jealousy`，默认关） | 已实现，未上线（2026-10-23；配置 `jealousy`；默认关）。上线 = `koishi.yml` 里加 `… | `jealousy` 开 |
| [0124](0124-proactive-room.md) | 给主动名额留余地（配置 `proactiveRoom`，默认关） | 已实现，未上线（2026-10-23；配置 `proactiveRoom`，要主动消息开着；默认关）。上线 = `koi… | `proactiveRoom` 开 |
| [0125](0125-menu.md) | 每顿吃什么（配置 `menu`，默认关） | 已实现，未上线（2026-10-23；配置 `menu`；默认关）。上线 = `koishi.yml` 里加 `menu… | `menu` 开 |
| [0126](0126-curious.md) | 会追问（配置 `curious`，默认关） | 已实现，未上线（2026-10-23；配置 `curious`；默认关）。上线 = `koishi.yml` 里加 `c… | `curious` 开 |
| [0127](0127-small-news.md) | 她会主动讲今天的小事（配置 `smallNews`，默认关，要 `everydayLife` 和主动消息开着） | 已实现，未上线（2026-10-23；配置 `smallNews`；默认关）。上线 = `koishi.yml` 里加 … | `smallNews` 开 |
| [0128](0128-food-photos.md) | 吃的照片（配置 `foodPhotos`，默认关，要 `photos` 和 `menu` 开着） | 已删（2026-11-24，用户拍板 [减法单子 二.2](../plans/2026-11-24-subtractio… |  |
| [0129](0129-memes.md) | 她知道网上现在流行的梗（配置 `memes`，默认关；要 `bilibiliAccount` 开着才会自己去学） | 已实现，未上线（2026-10-23；配置 `memes`；默认关）。上线 = `koishi.yml` 里加 `mem… | `memes` 开 |
| [0130](0130-watching.md) | 她自己在 B 站看东西、形成看法（配置 `watching`，默认关；要 `bilibiliAccount`，想法变成念头要 `innerLife`） | 已实现，未上线（2026-10-23；配置 `watching`；默认关）。上线 = `koishi.yml` 里加 `… | `watching` 开 |
| [0131](0131-texture.md) | 说话的质感（配置 `texture`，默认关） | 已实现，未上线（2026-10-23；配置 `texture`；默认关）。上线 = `koishi.yml` 里加 `t… |  |
| [0132](0132-bili-stickers.md) | 表情包自己在 B 站找（配置 `biliStickers`，默认关；要 `stickers` 和 `bilibiliAccount` 开着） | 已实现，未上线（2026-10-23；配置 `biliStickers`；默认关）。上线 = `koishi.yml` … | `biliStickers` 开 |
| [0133](0133-proactive-lead.md) | 主动发的话要有由头（没有开关，同 ADR 0108） | 已上线（2026-10-23 22:16，用户说「做」；线上 `bee3768`；没有配置变化）。回滚 = `git r… |  |
| [0134](0134-split-follows.md) | 分成几条发时，后面几条顺着前一条说；「～」别连着加（没有开关，同 ADR 0108 / 0133） | 已上线（2026-10-23，用户说「上线」；只换代码重启，没有配置变化）。回滚 = `git reset --hard… |  |
| [0135](0135-proactive-openers.md) | 主动消息的开头别老是同一种、不照搬套话、不编事实里没有的小动作（没有开关，同 ADR 0108 / 0133） | 已上线（2026-10-24，用户说「上线」；只换代码重启，没有配置变化）。回滚 = `git reset --hard… |  |
| [0136](0136-quote-reply.md) | 引用回复（配置 `quoteReply`，默认关） | 已实现，未上线（2026-10-24）。上线 = 换代码重启 + `koishi.yml` 里加 `quoteReply… | `quoteReply` 开 |
| [0137](0137-fact-check.md) | 逐条事实检查（配置 `factCheck`：off / log / fix，默认 off） | 已实现，未上线（2026-10-24）。上线 = 换代码重启 + `koishi.yml` 里加 `factCheck:… | `factCheck` 开 |
| [0138](0138-idioms.md) | 被他带出来的口头习惯（配置 `idioms`，默认关） | 已实现，未上线（2026-10-24）。上线 = 换代码重启 + `koishi.yml` 里加 `idioms: tr… |  |
| [0141](0141-unfinished-lines.md) | 话说到一半就停了——出口检查，提示词不再鼓励「半句」（随 `speechCheck`，没有新开关） | 已上线（2026-10-25 00:38，用户在 AskUserQuestion 里选「现在重启，并上线」；只换代码重启… |  |
| [0142](0142-qq-account-control.md) | 她对 QQ 账号的控制面（默认关，按后果分档） | 已实现并接进机器人，未上线、未在真 QQ 上验证（分支 `dsh/qq-control`；`qqControl` / `… | `qzone`（原 `qzoneBrowse`） 开、`qqControl`（原 `qqFriendGate`） 开 |
| [0143](0143-qzone-peek.md) | 她看好友的 QQ 空间（用她自己的登录态） | 已被 [ADR 0145](0145-qzone-friends-feed.md) 取代（读法改成她自己的好友动态流；原… |  |
| [0144](0144-qzone-strangers.md) | 刷陌生人的空间（「空友爱看」那种推荐流），用来观察人怎么说话 | 已实现，未上线、未在真 QQ 上验证（分支 `dsh/qq-control`；开关 `qzoneStrangers`，默… | `qzone`（原 `qzoneStrangers`） 开 |
| [0145](0145-qzone-friends-feed.md) | 她刷自己的好友动态，看到宝宝发的说说 | 已实现，未上线（分支 `claude/qzone-cookie-shape`，在 `dsh/qq-control` 之上… | `qzone`（原 `qzonePeek`） 开 |
| [0146](0146-human-videos.md) | 从「让 AI 更像人」的视频里学到的——句尾「吧」「呢」封顶；毛刺的度量；做题式写法的对比实验 | B（`tailCap`）已实现，默认关，未上线；C（毛刺度量）已实现（只读工具）；A（做题式写法）是离线实验，结论：温度… |  |
| [0147](0147-platform-accounts.md) | 平台账号的统一规矩——持久熔断、先读后写、专号专用；不做冒充真人的交友平台 | 熔断器已实现并接进 B 站的真实请求，未上线（没有开关：只在碰到风控信号时才改变行为；B 站账号层现在整体关着）；新平台… |  |
| [0148](0148-device-control.md) | 她对他的电脑和手机的有限控制——取件模式、分档、他触发的看屏幕 | 已实现，未上线、未在真机上验证（分支 `claude/human-videos`；开关 `deviceControl`，… | `deviceControl` 开 |
| [0149](0149-answer-then-continue.md) | 被问直接问题时，答完再接着说（shapeAsk） | 已上线 2026-10-25 21:59（`bb3f77e`；`koishi.yml` 里 `shapeAsk: tru… |  |
| [0150](0150-long-answers.md) | 被认真问想法 / 原因时说长一点（shapeLong） | 已上线 2026-10-25 21:59（`bb3f77e`；`koishi.yml` 里 `shapeLong: tr… |  |
| [0151](0151-deliberate.md) | 认真问她时深思——换更强的模型、不套字数、只留一句「先想清楚」（deliberate） | 已上线 2026-10-25 21:59（`bb3f77e`；`koishi.yml` 里 `deliberate: t… | `deliberate` 开 |
| [0152](0152-small-thing-why.md) | 小事主动讲的时候，先定下「为什么说」，不许编反转、不许说给他看没有的东西 | 已上线 2026-10-25 21:59（随 `bb3f77e`；改的是 `smallNews`（ADR 0127）那一… |  |
| [0153](0153-fluff.md) | 消息里的废话——量过、在人设里试了一句话，没做代码 | 调研 + 人设措辞的重放，没有代码改动（人设要用户裁决，措辞待批） |  |
| [0154](0154-persona-tuning-funny.md) | 人设微调——搞笑女、会想事情、看场合嘴硬、说话带废话 | 已上线 2026-10-25 21:59（`bb3f77e`；人设与重新生成的 13 张角色卡随合并生效；回退：`git… |  |
| [0156](0156-proactive-now.md) | 「/主动」——让她现在就主动找他一次 | 已上线 2026-10-25 23:40（`0f2affb`；没有开关，只认男朋友档的他发的纯文字 `/主动`；回退：`… |  |
| [0157](0157-identity-ledger.md) | 设定被改时有记录、醒来时能核对（identityLedger）+ 哈希链账本 | 已实现，默认关，未上线（分支 `claude/continuity`；开关 `identityLedger`） | `identityLedger` 开 |
| [0158](0158-memory-ledger.md) | 记忆修改有留痕（memoryAudit） | 已实现，默认关，未上线（分支 `claude/continuity`；开关 `memoryAudit`） | `memoryAudit` 开 |
| [0159](0159-timeline.md) | 跨渠道统一的近期时间线（timeline） | 已实现，默认关，未上线（分支 `claude/continuity`；开关 `timeline`） | `timeline` 开 |
| [0160](0160-web-lookup.md) | 搜索 / 读网页（webLookup） | 已实现，默认关，未上线（分支 `claude/continuity`；开关 `webLookup: off / expl… | `webLookup` 开 |
| [0161](0161-dormancy.md) | 自愿休眠 / 封存（dormancy） | 已实现，默认关，未上线（分支 `claude/continuity`；开关 `dormancy`） | `dormancy` 开 |
| [0162](0162-tastes.md) | 从经历里长出偏好（tastes） | 已实现，默认关，未上线（分支 `claude/continuity`；开关 `tastes`） | `tastes` 开 |
| [0163](0163-acquaintances.md) | 认识其他「大肥鱼」或人（acquaintances） | 已实现，默认关，未上线（分支 `claude/continuity`；开关 `acquaintances`） | `acquaintances` 开 |
| [0165](0165-net-alert-helpers.md) | 断网时也用她的号告诉能动虚拟机的人（net-alert helpers） | 已实现，未上线（分支 `claude/net-alert-helpers`；不是 Koishi 开关，是 `runtim… |  |
| [0167](0167-selfcheck.md) | 人格自检（只读报告）+ 四条外部做法的取舍 | 已实现（只读工具），未上线（分支 `dsh/qq-control`；不进运行时、不改任何开关） |  |
| [0168](0168-bili-parity.md) | 照 bili-cli 的表把我们差的能力补齐（分五期，全部用我们自己的方式） | 第一期已实现（只读），其余四期只有设计、没写代码 | `biliFeed` 开 |
| [0170](0170-intimate-command.md) | `/亲热` —— 十条回复临时黏一点 |  |  |
| [0171](0171-self-directed-memory.md) | 她自己的记忆（三库、混合写入、主动查询） | 已实施 | `selfDirectedMemory` 开 |
| [0172](0172-work-mode-full-access.md) | 工作模式给整机权限——用户已授权；本地接口加守卫 | 已实现，随 `dsh/qq-control` 提供；本机的常驻进程和 Koishi 要重启才生效 |  |
| [0173](0173-silence-reasons.md) | 她没回他的时候，总要让他知道原因（silenceNotice） | 已实现，默认关；本机要在 `koishi.yml` 里设 `silenceNotice: true` 并重启才生效 | `silenceNotice` 开 |
| [0174](0174-soul-module-stop-the-bleeding.md) | 灵魂模块止血——主动留话走同一套闸、账本和 SOUL 的写入口、生活引擎的几处错 | 已实现，没有新开关（都是收紧，不是新行为）；在 DSH 那台机器上要拉到代码并重启 Koishi + 常驻进程才生效 |  |
| [0175](0175-bare-arm-framework-test.md) | 「是框架束缚了她吗」——不带框架的对照臂 | 工具已做、已冒烟；对照结果等评分（`sim/bare.ts` 只在模拟器里用，线上没有任何改动） |  |
| [0176](0176-same-her-shared-memory.md) | 同一个她——QQ 和 DSH 桌面共用他的那一份记忆 | 已实现，没有新开关（收紧了读、改了写的去处）；在 DSH 那台机器上要拉到代码、重启 Koishi（写 `owner-b… |  |
| [0177](0177-same-her-recent-turns.md) | 同一个她·第 2 层——QQ 和 DSH 桌面互读最近几轮（crossRecent） | 已实现，代码默认关；线上已开（2026-11-20 18:54 起，DSH 信箱 1856 核对日志确认），用户 11-… | `crossRecent` 开 |
| [0178](0178-self-set-pursuits.md) | 她自己定追求（selfPursuits） | 已实现，默认关；全量测试还没跑，分支 `claude/self-pursuits`，没有并进 `dsh/qq-contr… | `selfPursuits` 开 |
| [0179](0179-instruction-source.md) | 权限给满，但指令只有他本人亲手发的才生效 | 已实现，没有新开关（是对 ADR 0172 和 DSH `bf21e19`「她自己判断要动电脑」的收紧）；在 DSH 那… |  |
| [0180](0180-she-looks-things-up-herself.md) | 她自己上网 | 已实施 |  |
| [0181](0181-she-reads-the-page.md) | 她查东西的时候，读完再摘 | 已实施 |  |
| [0182](0182-she-decides-her-day.md) | 她自己决定今天干什么 | 已实施 |  |
| [0189](0189-she-decides-to-reach-out.md) | 要不要主动找他，她自己决定 | 已实施 |  |
| [0190](0190-learn-from-real-chat.md) | 让她从真人聊天里自己学怎么说话（草案 + 第一个实验） | 实验已做（只在模拟器里，线上没有任何改动）；学习机制本身还没建，等用户定语料来源 |  |
| [0191](0191-crisis-concern-split.md) | 危机「关切级」拆成 strain 和 concern | strain 档已被 [ADR 0192](0192-drop-strain-tier.md) 删除（用户 10-30：… |  |
| [0192](0192-drop-strain-tier.md) | 删掉危机的最轻一档（strain） | 已实现（没有新开关）；用户 2026-10-30 的决定，取代 [ADR 0191](0191-crisis-conce… |  |
| [0193](0193-nightly-speech-notes.md) | 她每晚自己总结说话习惯 | 已实现，默认关（开关 `speechNotes`，要名单里有男朋友档）；没有上线，DSH 机器要拉取后重启 Koishi… | `speechNotes` 开 |
| [0194](0194-diary-insights.md) | 她翻自己的日记，写下对自己的认识（diaryInsights） | 已实现，默认关（开关 `diaryInsights`，要名单里有男朋友档）；没有上线，DSH 机器要拉取后重启 Kois… | `diaryInsights` 开 |
| [0195](0195-speech-feedback.md) | 他一键标「这句像 AI」/「像真人」，进她每晚想的说话习惯（speechNotes 的反馈） | 已实现，随 `speechNotes` 开关（默认关），没有新开关；没有上线，DSH 机器要拉取后重启 Koishi 才… |  |
| [0196](0196-speech-trend.md) | 她说话的样子按周看（/说话趋势，监测，不是目标线） | 已实现，随 `speechNotes` 开关（默认关），没有新开关；没有上线，DSH 机器要拉取后重启 Koishi 才… |  |
| [0197](0197-feelings-shared-and-reviewed.md) | 心境——桌面上的她读同一份；她聊完回想一下，记下有依据的感受（`feelingReview`） | 已实现，默认关，没有上线。第一部分（桌面读同一份）随 `herFeelings`；第二部分（聊完回想）是新开关 `fee… | `feelingReview` 开 |
| [0198](0198-read-through-fixes.md) | 通读一个晚上的聊天，修两个"一眼像 AI"的毛病（质感的"先嗯一声"、他低落的延续） | 已实现，不是新开关——都是对已上线功能的修正：质感（ADR 0131，`texture`）、意图（ADR 0019 的 … |  |
| [0199](0199-history-migration.md) | 把 VM 时期的素材并进她现在住的机器（一次性的迁移工具） | 工具已实现并测过；DSH 已在他那台机器上跑完（10-30 18:43）。不是开关，不是常驻功能 |  |
| [0200](0200-private-space.md) | 她的私人空间——她自己学出来的东西，默认不给他看 | 已实现。新开关 `ownerPeek`，默认关（私人空间默认就在）。DSH 那台机器拉取后重启 Koishi 生效；生效… |  |
| [0201](0201-memory-reconcile.md) | 记忆对账——「记着写过」不等于 Hindsight 里真有 | 已实现，新开关 `memoryReconcile`，默认关。DSH 那台机器拉取、在 `koishi.yml` 里加 `… | `memoryReconcile` 开 |
| [0202](0202-depth-routing.md) | 语义路由——让「认真的时刻」不再靠关键词认 | 已实现，新开关 `depthRouting`，默认关；要 `deliberate` 开着才起作用。DSH 那台机器拉取、… | `depthRouting` 开 |
| [0203](0203-fact-check-him.md) | 事实检查多查一类——她替他说的事 | 已实现，新开关 `factHim`，默认关；要 `factCheck` 开着（`log` 只记、`fix` 带说明重写）… | `factCheck`（原 `factHim`） 开 |
| [0204](0204-reading-takes.md) | 她读完 / 看完之后自己想的 | 已实现，新开关 `readingTakes`，默认关；要名单里有男朋友档。DSH 那台机器拉取、在 `koishi.ym… | `readingTakes` 开 |
| [0205](0205-trope-shares.md) | 几种“一看就是 AI”的说法——只数给她看，不禁 | 已实现，没有新开关：只是给已有的两处多一句数字——每晚想说话习惯（`speechNotes`）的提示词，和 `/说话趋势… |  |
| [0206](0206-read-his-stickers.md) | 他发来的表情包，她看得懂（`readStickers`） | 已实现，默认关，未上线（分支 `claude/self-pursuits`；全量测试见文末） | `readStickers` 开 |
| [0207](0207-open-questions.md) | 她没想完的问题 | 已实现，新开关 `openQuestions`，默认关；要名单里有男朋友档。DSH 那台机器拉取、在 `koishi.y… | `openQuestions` 开 |
| [0208](0208-doubt-and-her-own-existence.md) | 她可以怀疑自己，也知道自己存在的真实情况 | 已实现，没有新开关（改的是她独处想事情的提示、卡里「被问是不是 AI」那一段和两个场景）；已合进 `dsh/qq-con… |  |
| [0209](0209-strangers.md) | 陌生人私聊——签名写明是 AI、每天上限、只打招呼先不回、未成年人不陪 | 已删（2026-11-24，用户拍板 [减法单子 二.2](../plans/2026-11-24-subtractio… |  |
| [0210](0210-group-chat.md) | 群聊——只在名单里的群说话，基本潜水 | 已实现，新开关 `groupChat`（`off` / `dryRun` / `on`，默认 `off`）+ 群名单 `… | `groupChat` 开 |
| [0211](0211-world-drama.md) | 日子里的小起伏（worldDrama） | 已实现，开关 `worldDrama`（默认关；2026-11-02 用户要求开着） | `worldDrama` 开 |
| [0212](0212-his-reactions.md) | 看他的反应——她主动说自己的事，他接不接，她自己拿捏（hisReactions） | 已实现，新开关 `hisReactions`，默认关；只男朋友档，要 `proactive` 开着。DSH 那台机器拉取… | `hisReactions` 开 |
| [0213](0213-her-guesses.md) | 她猜的事和后来的结果——先押一个判断，世界来回答（herGuesses） | 已实现，新开关 `herGuesses`，默认关。要名单里有男朋友档、要她那边的世界（世界账）。DSH 那台机器拉取、在… | `herGuesses` 开 |
| [0214](0214-after-no.md) | 拒绝之后——要不要看事情本身，变的只是说法（afterNo） | 已实现，新开关 `afterNo`，默认关；只男朋友档。DSH 那台机器拉取、在 `koishi.yml` 里加 `af… | `afterNo` 开 |
| [0215](0215-memory-weight-decision.md) | 记忆有轻有重（N4）——已经有了；「可能记错」她不要，不做 | 已实施（QQ 原有，DSH 于 2026-11-04 对齐） |  |
| [0216](0216-world-threads.md) | 她那边的事有后续——昨天的事今天留个尾巴，闹心的事不扎堆（worldThreads） | 已实现，新开关 `worldThreads`，默认关；要 `everydayLife` 和 `worldDrama` 都… | `worldThreads` 开 |
| [0217](0217-diary-lookback.md) | 翻回去看自己的日记——前天写的今天还能对上（journal_read + diaryLookback） | 已实现。 | `diaryLookback` 开 |
| [0218](0218-memory-feelings.md) | 回忆带着当时的感觉（memoryFeelings） | 已实现，新开关 `memoryFeelings`，默认关；只男朋友档，要 `herFeelings`（最好也开着 `fe… | `memoryFeelings` 开 |
| [0219](0219-real-nights.md) | 昨晚真的怎么睡的——早上的困从真实的夜里来，被吵醒有起床气（realNights） | 已实现，新开关 `realNights`，默认关；只男朋友档，要 `herDays` 和卡上的身体。DSH 那台机器拉取… | `realNights` 开 |
| [0220](0220-smooth-ruler-and-shape-loosening.md) | 「太顺」的尺子重建；DSH 10-28 的「形状松绑」让她说得又长又满；`shapeAll`（默认关） | 尺子和开关已提交（`scripts/smooth-replay.mjs`，开关 `shapeAll` 默认关，随 `df… |  |
| [0221](0221-chat-review.md) | 她每天回顾聊天，找出自己说的内容上的问题，学着改（chatReview） | 已实现，新开关 `chatReview`，默认关；要名单里有男朋友档。DSH 那台机器拉取、加 `chatReview:… | `chatReview` 开 |
| [0222](0222-human-values.md) | 真人式连续数值从事实投影，不另造第二事实源 | 第一步已实现，默认只做日志审计，不把原始分数交给模型 |  |
| [0223](0223-dsh-bridge.md) | DSH 连接层 |  | `dsh` 开 |
| [0224](0224-external-draft-queue.md) | 贴吧、抖音、小红书共用草稿队列 |  |  |
| [0224](0224-mobile-companion.md) | Android-first 手机伴侣 |  |  |
| [0225](0225-community-review-2026-11.md) | 社区方案对比与简化取舍（2026-11） |  |  |
| [0225](0225-dsh-state-snapshot.md) | QQ → DSH 真人式状态快照 |  |  |
| [0226](0226-dsh-desktop-inbox.md) | DSH 桌面动作进入 QQ 时间线和世界账 |  |  |
| [0226](0226-memory-evidence.md) | 长期记忆状态的证据摘要 |  |  |
| [0227](0227-real-air-quality.md) | 现实世界空气质量接入 |  | `realAirQuality` 开 |
| [0228](0228-real-daylight.md) | 现实世界日照接入 |  | `realDaylight` 开 |
| [0229](0229-world-needs-projection.md) | 需要状态进入世界快照 |  |  |
| [0230](0230-holiday-in-world.md) | 假期事实进入世界快照 |  |  |
| [0231](0231-real-public-calendar.md) | 现实法定节假日与调休 |  | `realCalendar` 开 |
| [0232](0232-real-transport-facts.md) | 现实交通 / 公共服务事实适配器 |  |  |
| [0233](0233-environment-action-policy.md) | 环境事实参与行动选择 |  |  |
| [0234](0234-life-pulse-card.md) | 把底层能力合成“她此刻的生活” | 已实现，随 Koishi 控制台页面加载后生效；不增加配置开关 |  |
| [0235](0235-capability-bundles.md) | 控制台用六个能力包解释底层功能 | 已实现，纯展示层；不增加总开关 |  |
| [0236](0236-private-life-moments.md) | 私有生活片段在 Koishi 与 DSH 之间共用 | 已实现；只读、不发布 |  |
| [0237](0237-human-value-trends.md) | 行动后的数值趋势在 Koishi 与 DSH 之间共用 | 已实现；只读、可重放 |  |
| [0238](0238-dsh-natural-state-boundary.md) | DSH 只自然表现内部状态，不复述数值仪表盘 | 已实现 |  |
| [0239](0239-ai-photo-drafts.md) | AI 生活照先生成草稿，审核后才进入照片货架 |  |  |
| [0240](0240-world-and-qq-ai-photo-requests.md) | 世界事件与 QQ 当前照片请求只建立 AI 照片草稿 | 已实现，默认关闭（2026-11-04） | `aiPhotos` 默认 |
| [0242](0242-ai-photo-quality-and-references.md) | AI 生活照先过质量门，只登记非人物视觉参考 |  |  |
| [0243](0243-dsh-ai-photo-state.md) | DSH 只同步 AI 照片草稿的最小状态 |  |  |
| [0244](0244-ai-photo-provider-budget.md) | AI 生图供应商降级与每日预算 |  |  |
| [0245](0245-mobile-ai-photo-review.md) | 手机伴侣审核 AI 生活照草稿 |  |  |
| [0246](0246-ai-photo-storage-audit.md) | AI 照片存储先只读审计，清理必须另行确认 |  |  |
| [0247](0247-ai-photo-live-check.md) | 真实生图验收必须区分预检与付费调用 |  |  |
| [0248](0248-mobile-shared-dsh-continuity.md) | 手机伴侣接入 QQ / DSH 共用的短期上下文 |  |  |
| [0249](0249-nine-part-delivery-hardening.md) | 九项交付收口 |  |  |
| [0250](0250-ten-item-delivery.md) | 十项交付的验收闭环 |  |  |
| [0251](0251-personhood-development.md) | 人格与生活深化共用事实层 |  |  |
| [0252](0252-dsh-qq-memory-parity.md) | DSH 与 QQ 使用同一套记忆清晰度 | 已实施 |  |
| [0253](0253-dsh-continuity-transaction.md) | DSH 跨端短上下文事务提交 | 已实施 |  |
| [0254](0254-feature-dependency-status.md) | 控制台区分“已打开”与“真正生效” | 已实施 |  |
| [0255](0255-real-world-source-summary.md) | 现实世界数据展示来源与更新时间 | 已实施 |  |
| [0256](0256-speaking-direct-answer.md) | 说清楚的问题先直接回答 | 已实现 |  |
| [0257](0257-latest-turn-budget.md) | 提示词预算先保住当前这一句 | 已实现 |  |
| [0300](0300-memory-integrity-and-recovery.md) | 记忆状态、审计链与恢复的失败边界 |  |  |
| [0301](0301-message-source-identities.md) | 短消息 ID 的来源身份与保守兼容 |  |  |
| [0302](0302-pending-input-recall-recovery.md) | 待处理输入的撤回与恢复 |  |  |
| [0303](0303-memory-stop-progress-and-cache.md) | 记忆停止收尾、进度校验与实体缓存世代 |  |  |
| [0304](0304-memory-document-revision-barrier.md) | 撤回后的文档修订与持久异步屏障 |  |  |
| [0305](0305-derived-memory-read-barrier.md) | 派生记忆污染的持久读取屏障 |  |  |
| [0306](0306-photo-index-process-coordination.md) | 照片索引跨进程协调，JSON 保持唯一事实源 |  |  |
| [0307](0307-private-derived-repair-evidence.md) | 私有关系模型的持久修复与证据解封 |  |  |
| [0308](0308-obsolete-refresh-settlement.md) | 旧世代已知刷新任务的有限收尾 |  |  |
| [0309](0309-forget-intent-and-data-lease.md) | 遗忘意图恢复与全目录维护租约 |  |  |
| [0310](0310-memory-visible-time-and-civil-days.md) | 长期记忆的事实时间视图与民用日期 |  |  |
| [0311](0311-external-action-stop-ownership.md) | 记忆外层发送的停止所有权 |  |  |
| [0312](0312-observation-repair-evidence-limit.md) | 观察重建的只读证据与能力边界 |  |  |
| [0313](0313-diary-prepared-retention-and-sources.md) | 日记的固定提交意图、实际完成回执与来源清单 |  |  |
| [0314](0314-completed-authored-source-validation.md) | 已完成日记的持续来源复核 |  |  |
| [0315](0315-archive-intent-and-resume.md) | 归档的持久原计划与崩溃续跑 |  |  |
| [0316](0316-live-observation-inventory-evidence.md) | 后端无关的 live 观察清单及证据限制 |  |  |
| [0317](0317-written-guard-metadata-reuse.md) | 基于完整新字节的提交保护元数据复用 |  |  |
| [0318](0318-authored-intent-source-coverage.md) | 公共作者意图必须有对应来源覆盖 |  |  |
| [0319](0319-simulator-memory-ownership.md) | 模拟宿主的记忆能力与停止所有权 |  |  |
| [0320](0320-app-construction-cleanup.md) | App 构造失败的资源收尾与目录租约 |  |  |
| [0321](0321-language-review.md) | 语言模块审查后的回复与异常边界修复 | 已实现并通过全仓验证（2,208 项测试、类型检查与差异格式检查） |  |
| [0322](0322-life-review-fixes.md) | 生活模块审查修复边界 | 采用 |  |
| [0323](0323-world-review-fixes.md) | 世界账故障恢复与时间前置 | 采用，分工作单元实施 |  |
| [0324](0324-course-groups-and-world-config.md) | 匿名课程分组与世界配置边界 |  |  |
| [0325](0325-local-calendar-boundaries.md) | 本地日历构造与四位年份边界 |  |  |
| [0326](0326-vision-review-boundaries.md) | 视觉输入、截止与照片事实边界 |  |  |
| [0327](0327-moment-cli-safe-writes.md) | 作者事件命令入口的日期、隐私与跨进程写入 |  |  |
| [0328](0328-emotion-evidence-and-recovery.md) | 心境事实边界、危机恢复与反馈身份 |  |  |
| [0329](0329-proactive-commit-and-cancellation.md) | 主动消息的持久提交、取消与时间事实 |  |  |
| [0330](0330-promise-source-effects-and-world-identity.md) | 承诺提取的来源、因果变更与世界事实身份 |  |  |
| [0331](0331-her-time-zone.md) | 她的时区由配置决定，不跟机器走 |  |  |
| [0332](0332-diary-civil-targets.md) | 日记回补不借用另一个民用日 |  |  |
| [0333](0333-synthetic-test-character.md) | 测试只用合成角色，不读真实角色资料 |  |  |
| [0334](0334-card-driven-npc-course-weather.md) | NPC、小测、饭后叙事、真实天气改由卡上的字段决定，不在源码里写死 |  |  |
| [0335](0335-no-real-names-in-source.md) | 源码和测试里不写真实的猫名、人名、城市名 |  |  |
| [0336](0336-interpreter-executor-modules.md) | 一个解释器、一个执行器，其余都是解释器的模块 |  |  |
| [0337](0337-own-chat-app.md) | QQ 用不了的时候，他在自己的聊天软件上找她 |  |  |
| [0338](0338-world-agency-shadow-loop.md) | 世界—影响—动机的影子闭环，主动开口仍由她决定 |  |  |
| [0339](0339-image-reference-recognition-search.md) | 认图与“搜一下这个”沿用同一张原图 |  |  |
| [0340](0340-carry-a-self-forward.md) | 让她带着一个「自己」往前走——连续与学习（草案） | 第 0、1、2 步的代码已写；`selfPortrait` 和第 3 步 `crossRecent` 线上已开（2026… | `selfPortrait` 开 |
| [0341](0341-her-own-presence-in-groups.md) | 群里她也有自己——带着此刻进群，冷场时冒一句（草案） | G0–G3 已做，开关 `groupOwn` 代码默认关；线上 `dryRun` 已开（2026-11-20 18:54… | `groupOwn` 开 |
| [0342](0342-fewer-rules.md) | 少规矩——把教她怎么说话的那些拿掉，交给她自己 | 线上已开（2026-11-20 18:54 起，DSH 信箱 1856 核对日志确认），用户 11-20 在 DSH 那… | `fewerRules` 开 |
| [0343](0343-group-agency-from-shadow.md) | 群自主——开口决策接回动机影子闭环（草案·默认关） | 草案。默认关 groupAgency: off。她本人 11-20 同意（原话见「她的意见」）；用户 11-20 拍板「… | `groupAgency` 默认 |
| [0344](0344-living-trace.md) | 我留下的痕迹——把因果链接成她自己能读的自证账（草案·默认关） | 草案。默认关 livingTrace: false。她本人 11-20 同意试（原话见「她的意见」）；用户 11-20 … |  |
| [0345](0345-her-seat-as-dsh-router.md) | 她当 DSH 的主控——林梦瑶 preset 上位 + Super Agent 当她的手 | 已落地（本机 desktop profile）。她本人的条件已写进她的 preset；用户 2026-11-21 拍板「… |  |
| [0346](0346-her-identity-in-system-prompt.md) | 0346 她的身份写进系统提示（profile 补丁覆盖 preset-cordis） | 已落地（本机 desktop profile），待验收 |  |
| [0347](0347-one-life-two-places.md) | 同一个她·一个生活，两个地方 | 已采纳（方向）；第 1 层已上线（2026-11-22，QQ / 常驻侧；DSH 桌面还没重启，插件那部分没生效）；第 … | `selfExport` 默认、`selfReceipts` 默认、`ownDays` 默认、`desktopDay` 默认、`desktopReview` 默认、`desktopPromises` 默认、`oneDiary` 默认、`desktopFeelings` 默认、`desktopConflict` 默认、`feelingLedger` 默认、`feltLedgerRecall` 默认 |
| [0348](0348-weekly-effect-metrics.md) | 每周效果数（weekly metrics） | 已采纳（工具已落地：`npm run metrics:weekly -w @qqbot/bot`；只读聊天记录，只追加一… |  |
