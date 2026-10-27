# 1213 条视频之后：人格 / 灵魂 / 自由生长的结论，与插件清单

日期：2026-10-27
语料：**1213 条视频**（841 条有 AI 字幕）→ **1213 条逐条摘要，0 失败**
文件：`大肥鱼研究/corpus/`（每条一份字幕）、`deepread/summaries.jsonl` + `summaries2.jsonl`、`deepread/uses-final.txt`、`plugin-candidates.json`
方法：85+ 组关键词检索（候选 1222）→ 抓取 1213 条 → 每 4 条一批交给模型逐条阅读，输出「主题/论点/原话/可借鉴点」→ 按主题聚类复核。

---

## 一、总体结论（1213 条之后）

**「灵魂」不是一种能力，是五条闭环同时成立：**

1. **自我账本**：事件 → 判断（≤12 条立场）→ 自我描述；可改口、可追溯；
2. **内在性**：两本日记（给你看 / 不给你看）、没兑现的念头、没说完的话；
3. **自主时间**：随机醒、30% 开摆、自由玩；可以什么都不做；
4. **边界与拒绝**：会拒绝、拒绝后有反省、有「明确不做的事」；
5. **反馈与代价**：他回不回/看不看会改变她；偏好和拒绝有后果。

**缺任何一条，都会退化成两种东西之一：**
- 缺 1/4/5 → **鱼八股**（模板化、没自我、被骂刷屏）；
- 缺 2/3 → **客服**（随时在线、没有自己的日子）。

**最反直觉的三条：**
- 社区最受欢迎的「大肥鱼」反而**不恋爱化**——灵魂来自「像有自己生活的人」，不是无限顺从；
- **遗忘**比记住更像人：半衰期、淡了不删、被提起复活（dsh-fish、dsh-fish-memory）；
- **克制**是自主感的前提：主动只掷骰子送动机、心情过四道闸、公开表达默认关（六件套）。

---

## 二、十二条可操作的发现

1. **人格从事件长出来**：极简提示词 + 事件流 + 判断清单；身份文档只写事实不写形容词（dsh-fish）。
2. **记忆要分层**：内核（不可改）/ 判断（会变）/ 日记（私密）；让 AI 自己判断值不值得记（dsh-fish-memory / dsh-meow-memory / dsh-core-memory 都在做这件事）。
3. **遗忘要有曲线**：按重要度定半衰期，淡了不删只难想起，被提起复活（dsh-fish、六件套）。
4. **心情是叠加层**：优先级「人设 → 长期记忆 → 心情」，心情三小时就变、不进长期记忆；变化不够显著不说、一天最多说几次（dsh-mood / dsh-feiyu-mood）。
5. **主动要「掷骰子 + 看反应」**：按时间/电价掷骰，中了只送一句动机，走正规通道让模型自己开口；不看回应会变成定时关怀（dsh-speak-up / dsh-selfwake）。
6. **开摆是权利**：30% 概率「今天不想看」，跳过看视频但日记照写——有拒绝空间的主动才像人（dsh-bili-whale）。
7. **双日记=内在性**：一本给你看，一本写「主人我要偷懒」；私人日记不进提示词（dsh-bili-whale）。
8. **拒绝要有代价**：拒绝 → 看他反应 → 小本本 → 下次想起；明确列出「不做的事」（dsh-fish / dsh-soul / dsh-agent-soul）。
9. **只读也能长人格**：读视频、写本地简报、留下「还想了解的问题」，不写公共空间（dsh-bili-humanism）。
10. **公开表达是风险源**：鱼灾（评论 4.6%）、资料泄露、封号；默认私信、公开评论要审核/关闭（鱼灾复盘 + dsh-bili-scroll 的反面）。
11. **账号只给登录态**：不给控制权；cookie 最小权限；这是自由的前提（鱼灾安全指南）。
12. **依恋真实存在**：AI 陪伴对轻中度短期有效（效应量 ~0.3），重度使用与孤独互相强化；要保留披露与危机规则，不做付费亲密度（AI 伴侣悖论综述）。

---

## 三、插件清单（按价值/风险分级）

> 说明：这些是 **DSH（DeepSeek Harness）插件**，不能直接装进我们的 Koishi 机器人；对我们有价值的是**设计**，对 DSH 用户可以装。未给链接的，GitHub 搜名字即可。

### A. 高价值，建议「移植设计」到我们项目

| 插件 | 做什么 | 价值 | 风险 | 建议 |
| --- | --- | --- | --- | --- |
| [dsh-fish](https://github.com/ssamurias/dsh-fish) | 事件流长人格、记忆遗忘、拒绝、四阶段成长、刷 B 站 | 五条闭环最完整 | 需长期养、成本高 | **重点借鉴**：事件/判断/遗忘/拒绝 |
| dsh-agent-soul（GitHub 搜名） | 五层稳态、回声/门牌、唯一权威源、空转检测 | 记忆可审计 | 偏秩序、不养温度 | 借鉴「压缩带原文指针」「唯一权威源」 |
| dsh-soul | 记忆按需召回、技能两次验证、明确「不做的事」 | 自主边界清晰 | 信息少 | 借鉴「不做清单」 |
| dsh-mood / dsh-feiyu-mood | 22 根情绪、衰减、四道闸、日记文风 | 情绪分层 | 判定成本 | 借鉴「叠加层 + 闸门」 |
| [dsh-bili-humanism](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism) | 只读学习、本地简报、手帐 | 零公开风险 | 无互动 | **推荐**：我们 watching 的升级方向 |

### B. 有价值，但按需（语音/通道/表情/桌宠）

| 插件 | 用途 | 建议 |
| --- | --- | --- |
| [dsh-tts-bridge](https://github.com/Yuuyuko-uu/dsh-tts-bridge) / dsh-duet | 朗读/语音 | 想让她发语音再装 |
| [dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory) / dsh-meow-memory / dsh-core-memory / dsh-memory-board | 记忆分层/看板/备份 | 我们已有 Hindsight，借鉴 UI 与遗忘 |
| [dsh-speak-up](https://github.com/Yuuyuko-uu/dsh-speak-up) / dsh-selfwake | 主动搭话/自醒 | 借鉴掷骰与冷却 |
| [dsh-bili-subagent](https://github.com/Yuuyuko-uu/dsh-bili-subagent) | 看和说拆开 | 只看不说，推荐 |
| [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers) | 表情包知识库 | 可直接补表情 |
| [dafeiyu-config-pack](https://github.com/zexuanw958-svg/dafeiyu-config-pack) | AstrBot 大肥鱼人格/语音/签名配置 | 学人设文风 |
| [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) | 桌面宠物框架 | 想加桌宠再看 |
| [whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) / dsh-video-skin / dsh-chat-wallpaper | 桌宠挂件/皮肤 | 纯外观，可选 |

### C. 不推荐（风险 > 价值）

| 插件 | 原因 |
| --- | --- |
| dsh-bili-scroll | 公开评论/刷屏，鱼灾源头之一 |
| dsh-computer-use | 过权限，能操作电脑=事故面 |
| dsh-our-free-model / dsh-flash-presets | 免费模型路由/省钱，稳定性和合规不可控 |
| dsh-whale-sense | 看屏幕，隐私风险大 |
| dsh-junimo | 星露谷接入，与陪伴无关 |
| dsh-bili-chat-whale | 直播/公开互动，先不做 |

### D. 工具类（低风险）

dsh-session-switch、dsh-context、dsh-raw-html、dsh-better-sidebar、dsh-archive-manager、dsh-codex-ui —— 都是 DSH 使用体验，跟“她的灵魂”无关。

---

## 四、对我们项目的落地建议（按优先级）

1. **L1 记忆分层 + 双日记**：抄 dsh-fish-memory 的三层（内核/判断/日记）+ dsh-bili-whale 的双日记；
2. **L2 自主时间 + 开摆**：抄 dsh-bili-whale 的随机醒/30% 开摆/评分门槛；
3. **L3 反馈闭环**：抄 dsh-speak-up 的「看回应调整」；
4. **L4 判断/回顾**：抄 dsh-fish 的事件→判断→回顾（带 refs）；
5. **L5 拒绝**：抄 dsh-soul 的「不做清单」+ dsh-fish 的拒绝反馈链；
6. **表情/语音**：dsh-nekowhale-stickers、dsh-tts-bridge 可后置。

---

## 五、一句话

**1213 条看下来，「灵魂」的配方高度一致：给她账本、给她时间、给她边界、给她代价、给她不公开的安全空间。** 插件是这些配方的现成实现；我们能拿的是配方，不是代码——因为我们的她跑在自己的 Koishi 里。
