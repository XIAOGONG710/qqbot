# B 块：主动性——她什么时候、为什么主动找人

- 日期：2026-10-12 晚；访问日期除注明外均 **2026-10-12**。Claude 代做（任务书原定 DSH），只读，没改代码、没碰 `docs/adr/`。
- 靶子：终极目标那句话。冲突的做法只列、标「与目标冲突」，不推荐。
- 深读对象（我定的，用户没圈）：private_companion（`1cdce640d`，2026-10-11）、MaiBot（`0f94cfa83`，2026-10-11）；AstrBot / ChatLuna 沿用 10-05 的读码结论，不重读。
- 证据等级：**代码**=我读了源码（给文件:行）／**文档**=README、官方文档的宣称／**帖子**=issue、PR、评论，只当线索／**没找到**。

## 1. 别人怎么做（三种）

| 做法 | 谁 | 一行证据 |
| --- | --- | --- |
| **① 钟点 / 沉默计时器型**：到了某个钟点，或对方沉默满 N 之后，随机一个时刻开口 | moonveil、AstrBot `proactive_chat`、Open-LLM-VTuber、Extension-Idle、AstrBot `future_task` | moonveil：早安 9:00±30、晚安 22:30±30、>24h「想念」；偏移按日期哈希每日重掷（同日稳定）；每角色每天≤2、勿扰 0–8 点、距上次聊天≥3h、**错过不补**、默认关 [帖子：PR #37 描述，2026-09-28]。`proactive_chat`：沉默后在 min–max 间隔里随机，`max_unanswered_times`（**0=不限制**）、免打扰 [文档：README]。OLV：「空闲 N 秒后允许」[文档，直读]。`future_task`：用户或 LLM 建的一次性 / 间隔 / 每天任务，官方自称「不是一直运行的自主监控」[文档] |
| **② 候选生命周期型**：生活 / 事件先形成「候选」，再评分、过一串闸门、发送前复核、记账 | private_companion（AstrBot 插件，390★） | 候选来源含日程里的生活事件、重要日期、天气突变、未完话题、内容分享等；评分 = `salience + urgency×0.9 + warmth×0.7`＋档位偏置，随时间衰减、与首选时刻偏离扣分，另有「人格契合度」扣分 [代码：`proactive_engine.py:1712-1780`]；闸门含每日上限、最小间隔、免打扰、休息、繁忙、未回应降速、发送前终审，并记录拦截原因 [文档：README 主动消息一节；代码：`proactive.py:2025-2095,2335-2358`] |
| **③ 模型自排型**：由模型决定「等一会再说 / 下次什么时候醒」 | MaiBot（`wait` 工具）、ChatLuna `chatluna-character`（`wake_up_reply_*`） | MaiBot：模型调 `wait(seconds)`，到点向内部循环投一个 `timeout` 触发；**连续 wait 有上限**（`max_consecutive_wait_count`），到顶「当前对话进入休息」[代码：`src/maisaka/builtin_tool/wait.py`，`src/maisaka/runtime.py:1820-1835,1881-1900`]。**MaiBot 核心里没找到自己决定何时开口的模块**：主动只有一个给插件用的入口 `enqueue_proactive_task(plugin_id, intent)`［代码：`runtime.py:662-708`］；`turn_trigger/*` 管的是「收到消息后要不要进回复循环」，其中 `idle_backoff` 仅群聊生效 [代码：`idle_backoff.py:35-50`]。ChatLuna：模型给自己排醒来时间 [旧码：10-05 `koishi-chatluna.md` I7，`chat.ts:594-770`] |

## 2. 我们现在在哪

- **ADR 0011**（主动消息）：时机 = 早安（起床后 10–40 分钟）／下课（最后一节后 5–20 分钟）／睡前（23:00–00:30，聊过 20 分钟内不发）／冷场（8 小时没说话）／待跟进／重要的日子；每天≤2 条，**她主动发的有 1 条没回就停**（`unanswered_max: 1`）；时刻按「日期＋时机＋联系人」取种子，重启后同一个；**先记后发（至多一次）**、错过不补；没连上模型 15 分钟后重试≤3 次（调整 14）；开关 `off | dryRun | on`；「不抱怨对方没找你」写进每种时机的说明（调整 5）。
- **ADR 0050**（下雨）和 **0057**（她那边刚有件事）：事件驱动，只认真实天气；0057 的事从 `worldNews` 来，**现在只有一件（买相机）**。**ADR 0047**：约好的见面进她当天的安排（状态行、事件账）。
- **线上数字**（`runtime/bot/proactive/` 唯一一份记录文件，一个联系人，10-05 至 10-12；只数条数，没看内容）：共 27 条记录——**发出 11**（睡前 5、待跟进 3、下课 2、早安 1）、跳过 14、失败 2（相机那条遇上 10-11 DNS 掉线，冷场 1 条）。下雨、重要的日子这期间没发出过。
- 读这组数字的结论（事实，不是建议）：**发出去的 11 条里 8 条是作息槽（睡前 / 下课 / 早安），3 条是事（待跟进）**；「她自己的事」作为开口理由目前只有 0057 那一件，且那次没发成。

## 3. 各做法对我们的代价

| 做法 | 实现量 | 风险 | 和哪些 ADR 冲突 |
| --- | --- | --- | --- |
| ① 钟点 / 沉默型 | **≈0**：0011 已经是它，而且比 moonveil 更严（没回就停、先记后发）| 想「加槽 / 提频」就会更像打卡；理由只剩「到钟点了」。moonveil 的「日期哈希同日稳定」我们已有（种子）| 无；加槽要改 0011 的优先级表和每天≤2 |
| ② 候选生命周期型 | **中**：我们已有候选、闸门、先记后发、不发的原因（0011 §7）。缺的是**候选从生活账来**——把 0057 的 `worldNews` 推广成账里的事件类 | 模型编造「事」→ 必须只从账里取事实并过出口检查；private_companion 的教训：**失败的发送没有熔断**，issue #263（QQ 拒收后约 5 秒一次重生成重试，一天 2,227 次 LLM 调用、约 4,800 万 token，59 条里 58 条失败）；报告者建议让失败也占每日上限和最小间隔，修复内容只见到「PR #266 关闭」，具体改了什么**没核实** [帖子，2026-09-27 开、10-02 关] | 0011（每天≤2、优先级）、0020（披露分级：低档位不知道她有男朋友）、0054（生活账进提示词）|
| ③ 模型自排型 | 小～中 | **理由变成模型当场的即兴**，而不是账里的事；难验证、「重启不改史」难保证（计时在模型手里）；0011 的备选方案表已经因「难验证、费钱」否掉过「让模型判断要不要主动」 | 0011 备选方案、0039（重启一致性）|

## 4. 与终极目标冲突的做法（只列不推荐）

| 做法 | 出处 | 为什么冲突 |
| --- | --- | --- |
| **把「对方没回」写成情绪压力**：默认提示词示例写「有点想你了」，并让语气随 `{{unanswered_count}}` 带「不易察觉的失落和困惑」 | `proactive_chat` README 示例提示词 [文档，直读，行 312-328、376-383] | 用愧疚感换回复，直接是目标第 4 条禁的「情绪勒索 / 制造焦虑」。（我们 0011 调整 5 已反向规定「不抱怨对方没找你」）|
| **没回也不停发**：`proactive_unanswered_pause_after` 默认 `0`＝永不暂停；代码注释「未回应只降低频率……不再把已授权用户永久停发」；`max_unanswered_times=0` 也是不限制 | private_companion [代码：`_conf_schema.json`；`proactive.py:2048-2066`]；`proactive_chat` [文档] | 对方不回仍继续找（只是间隔拉长到最多 ×2.2）。不是同龄人的做法，且偏向追黏性 |
| **高频档 / 无上限档**：「持续在线」档位 `max_quota=None`、间隔上限 35 分钟、`unanswered_interval_weight=0`（未回应也不降频）；预设 `live`：每天上限 25、最小间隔 5 分钟、未回应 8 次才开始降频、「不再替用户节省主动成本」 | private_companion [代码：`proactive.py:296-372,508-530`；`_PROACTIVE_DAILY_QUOTA_MAX=25`]（默认预设 `off`）| 明说是在买「更常来找」。默认关，但列出它说明这条旋钮存在 |
| **按钟点的早 / 午 / 晚问候**，窗口内 `random.uniform` 取时刻，默认开 | private_companion `enable_daily_greetings=true` [代码：`proactive_engine.py:8153-8235`；`_conf_schema.json`]；moonveil 的 ±30 分钟 [帖子] | 理由只有「到钟点了」，随机只是为了不准点。**待判**：若时刻锚在她真实起床 / 下课（我们 0011 的做法）就有生活上的原因，若锚在固定钟点就是「为了像人而随机」 |
| 不可控的深夜弹窗 / 带性暗示的自动消息 | 一条 HN 评论转述 Replika 的「thirsty automated messages」[帖子，二手，仅线索]；一篇知乎报道提到深夜暧昧弹窗且拒收选项隐蔽 [帖子，搜索摘要，**未直读**] | 目标第 4 条。证据薄，E 块再核 |

## 5. 一句话建议（Claude 代做的看法，由用户定）

我们的护栏（没回就停、先记后发、错过不补、种子化时刻）已经比读到的所有项目更严，**缺的不是再加槽，而是让「她账里的事」能成为开口的理由**（0057 目前只有一件事）；早安 / 睡前这类作息槽建议保持低权重、不提频。

## 没找到 / 没核实

- **用户直接嫌「每天早安 / 晚安很假」的原文：没找到。** 搜了知乎、B 站、GitHub、V2EX，无命中；小红书 / 贴吧 / 微博需要登录，按规则没碰。Reddit：搜索工具对 reddit.com 返回「不可访问」，未能查；HN：只找到上面一条二手评论，Xiaoice 2020 那个帖子的页面抓取失败。
- **GitHub 上能直接对到「主动消息」的抱怨都是工程故障，不是「假」**：`proactive_chat` issue #67（周二说成周三、主动消息没进聊天记录，已于 2026-09-27 以 PR #107 关闭）[帖子，直读]；PR #86（`unanswered_count` 因会话键不一致永远读成 0，`max_unanswered_times` 完全失效；重载时旧调度器没关，主动消息按错时间点触发；2026-09-24 合并）[帖子，直读]；private_companion #263（见上）。这三类对应我们已有的：**时间要带星期、主动消息要进聊天记录（0011 已做）、重启后不重复 / 不鬼发（先记后发）、失败也占上限（待核对：0011 调整 14 重试≤3 次，但失败是否占当日 2 条上限没写）**。
- MaiBot 官方插件里有没有定时主动的：没查。
- AstrBot `proactive_chat` 的代码我没读，只读了 README 和三条 issue / PR。
- moonveil 的许可证、星数：页面里看不到，没记。

## 来源

- private_companion：https://github.com/menglimi/astrbot_plugin_private_companion （`proactive.py`、`proactive_engine.py`、`_conf_schema.json`，raw，`1cdce640d`）；issue #263 https://github.com/menglimi/astrbot_plugin_private_companion/issues/263
- MaiBot：https://github.com/Mai-with-u/MaiBot （`src/maisaka/runtime.py`、`builtin_tool/wait.py`、`turn_trigger/*.py`，raw，`0f94cfa83`）
- proactive_chat：https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat （README；issue #67；PR #86）
- moonveil PR #37：https://github.com/chemmy-11/moonveil/pull/37
- Open-LLM-VTuber 前端文档：http://docs.llmvtuber.com/en/docs/user-guide/frontend/web/
- AstrBot `future_task` 文档：https://github.com/AstrBotDevs/AstrBot/blob/master/docs/zh/use/proactive-agent.md
- HN：https://news.ycombinator.com/item?id=38287299
- 本仓库：`docs/adr/0011`（含 main 上的调整 9–14）、`0047`、`0050`、`0057`（main `9f1b81c`）；`docs/research/2026-10-05-framework-fit/koishi-chatluna.md`；线上记录计数来自 `runtime/bot/proactive/` 的条数统计。
