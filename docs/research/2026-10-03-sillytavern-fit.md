# 调研：SillyTavern 能否作为 QQ 机器人的运行核心（2026-10-03）

结论用于 [ADR 0002](../adr/0002-standalone-runtime.md)。源码路径均相对 `vendor/SillyTavern/`（1.19.0，`06bde939f`）。
标注“已核对”的条目由主会话直接复查过；其余来自子代理的源码阅读或网页调研，附出处，未实际运行。

## 需求（评估口径）

林梦瑶在 QQ 上无人值守运行，同时与多人（男朋友 / 闺蜜 / 同学 / 陌生人 / 群）聊天，并具备角色资料里描述的行为：
按对象分档、场景例句按关键词注入、作息与课表感知、睡觉不回 / 已读不回、主动发消息、跨会话长期记忆、拟人化发送。

## 一、运行架构

| 发现 | 证据 |
| --- | --- |
| 完整提示词（角色卡 + 世界书 + 历史 + 作者注释）只在浏览器前端拼装（已核对） | `public/script.js:4290` `Generate(...)`；`public/scripts/world-info.js:892` `getWorldInfoPrompt`；`public/scripts/openai.js:1542` `prepareOpenAIMessages` |
| 服务端生成接口只接收拼好的 `messages`，不接收角色或会话 id（已核对） | `src/endpoints/backends/chat-completions.js:2242` |
| 没有无界面（headless）模式（已核对：全仓只有分词器数据文件和测试用的 `eslint-plugin-playwright` 提到相关词） | `package.json:172`；`src/command-line.js:112-265` 只有网络 / SSL / 认证类参数 |
| `Generate` 不能指定会话；`force_chid` 仅群聊有效（已核对） | `public/script.js:4274` |
| 生成中切换角色会被静默忽略（已核对）；切换会话不会中断生成，回复可能写入错误会话（代码推断） | `public/script.js:891`；`openCharacterChat` 7744-7752；`saveReply` 6649、6690 |
| 服务端插件只拿到一个 express router，挂在 `/api/plugins/<id>`，默认关闭 | `src/plugin-loader.js:10, 180-190, 214-227` |
| 没有定时 / 空闲触发机制；唯一的定时器是群聊里 AI 轮流发言的 auto mode | `public/scripts/group-chats.js:144-148` |
| 回复显示前可清洗：正则脚本（AI_OUTPUT）、`MESSAGE_RECEIVED` 事件 | `public/script.js:6481, 6690-6693` |
| `Generate` 有 `dryRun` 参数，可只拼提示词不请求模型（已核对签名） | `public/script.js:4290` |

## 二、角色资料能否用原生功能表达

| 需求 | 覆盖 | 说明与证据 |
| --- | --- | --- |
| 人设分层、口癖、雷区、禁区话题 | 完全 | 角色卡字段（`src/endpoints/characters.js:579-626`）+ 常驻世界书条目 |
| 118 个场景按关键词注入 | 基本 | 世界书关键词 / 正则（`world-info.js:337-366`）、二级关键词逻辑（4938-4984）、包含组与评分（5292, 5388-5460）；没有按组的字数上限，只有全局预算 |
| 按对象分档 | 部分 | 每个联系人一个会话 + 锁定 persona（`personas.js:1061-1090`）；世界书的角色过滤只认 AI 角色和标签，没有按“对方是谁”的过滤（`world-info.js:4815-4843`） |
| 作息、课表、每日心情、读书进度 | 部分 | 只有时间宏（`macros/definitions/time-macros.js`）和真值判断的 `{{if}}`，没有比较和日期运算，要靠预先生成的正则硬凑 |
| 睡觉不回、已读不回、主动发消息 | 不支持 | 一触发就生成；没有定时器 |
| 跨会话长期记忆 | 部分 | 总结（`extensions/memory`）和向量记忆（`extensions/vectors/index.js:799-854`）都按会话隔离 |
| QQ 群（多人类发言者） | 部分 | 可用 `/send name=` 表示不同发言人；ST 的群聊功能是“多个 AI + 一个用户”，不对口 |

## 三、社区现状（网页调研，数据截至 2026-10-03）

- 现有 SillyTavern ↔ QQ 项目都是个人小项目（0–12 星）。三种做法各有代价：
  - **浏览器扩展**：如 [TavernCat](https://github.com/opvsep/TavernCat)，唯一直连 NapCat 的。README 第 118–119 行写明页面必须保持打开、串行排队、处理时前台聊天会被切走（已核对）。
  - **无头浏览器自动化**：如 [SillyTavern-QQ-Bridge](https://github.com/theStar7/SillyTavern-QQ-Bridge)，依赖页面结构，容易坏。
  - **服务端插件**：如 [SillyTavern-IM-Bridge](https://github.com/rinmashiro0529/SillyTavern-IM-Bridge)，只能自己拼简化提示词，没有世界书。
- 上游把生成移到服务端的请求 [#4007](https://github.com/SillyTavern/SillyTavern/issues/4007) 于 2025-11-24 以 `not_planned` 关闭（已核对）。
- 社区主流方向是“导入 ST 格式，在 ST 之外重建提示词拼装”：
  - [tavern-link](https://github.com/sakisakisa-design/tavern-link)、[A-Cat-Girl](https://github.com/MoEternal/A-Cat-Girl)：都无许可证，只能参考思路，不能复制代码。
  - [komeiji_tavern](https://github.com/KomeijiDono/astrbot_plugin_komeiji_tavern)（AstrBot 插件）。
  - [ChatLuna](https://github.com/ChatLunaLab/chatluna) world lores。
- QQ 原生框架：
  - [AstrBot](https://github.com/AstrBotDevs/AstrBot)：41,336 星，AGPL-3.0，自带定时 / 主动消息。
  - [MaiBot](https://github.com/Mai-with-u/MaiBot)：6,101 星，GPL-3.0，拟人回复最强，偏群聊。
  - [LangBot](https://github.com/langbot-app/LangBot)、Koishi + ChatLuna、NoneBot2。
  - 它们都没有原生的“按对象分档”。

## 未验证

- 世界书靠作者注释扫描时间宏实现按日期 / 小时门控（理论可行，未运行）。
- 社区项目的实际可用性（只看了 README 和部分源码）。
