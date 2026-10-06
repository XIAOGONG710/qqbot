# Koishi + ChatLuna 适配调研

调研日期 2026-10-05。只读：调研时浅克隆到临时目录（未入库），没装依赖，也没运行。插件市场数据来自 `registry.koishi.chat/index.json` 快照（生成时间 2026-10-04 16:42 GMT，未入库）。汇总与抽查见 [../2026-10-05-framework-fit.md](../2026-10-05-framework-fit.md)。

**结论先说**：Koishi 本体（MIT）当「框架 + 控制台 + OneBot 适配器」很合适，我们的 TS 模块大约 70% 能原样搬进 Koishi 插件。ChatLuna 的提示词 / 世界书 / 会话模型和我们的核心需求（ST 规则、档位隔离、作息、打断重生成、出口检查）差得远，只适合借个别组件（多模态看图、sst / vits 服务接口）。借的时候要背上 LangChain、数据库依赖和 AGPL。

---

## 1. 基本信息

取数时间：`gh api` 2026-10-05 01:18（+08:00）；npm 月下载量统计区间 2026-09-04 ~ 10-03。

| 仓库 | 克隆 commit | 版本 | 许可证 | 星数 | 最近提交 | 贡献者 | 技术栈 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| koishijs/koishi（本体） | `5525cfd`（2026-08-29） | koishi 4.18.11（发布于 2026-03-09） | MIT | 6240 | 2026-08-28（一个测试修复；上一次是 2026-02-27 的版本号提升） | 53 | TypeScript / Node，基于 cordis 3 + @satorijs/core 4 |
| cordiverse/cordis（依赖注入 / 插件生命周期） | `4658414`（cordis 3.18.x 的 gitHead，2024-08-26） | Koishi 4 用的是 ^3.18.1；main 分支已到 4.0.0-rc.10 | MIT | 8999 | main 2026-09-08；**3.x 线自 2024-08 起没有新提交** | — | TS |
| satorijs/satori（v4 分支，消息 / Bot 抽象） | `fbc093f` | @satorijs/core 4.6.0 | MIT | 257 | 2026-08-17 | — | TS |
| koishijs/koishi-plugin-adapter-onebot | `b9d3c3c`（2026-06-05） | 6.9.4（npm） | MIT | 51 | 2026-06-05 | 12 | TS |
| koishijs/webui（console 系列插件） | `ec7b484`（2026-06-27） | plugin-console 5.30.11 | **AGPL-3.0** | 40 | 2026-06-27 | 22 | Vue + TS |
| koishijs/koishi-desktop | `d7591a2` | v1.1.4（2026-03-01） | **AGPL-3.0** | 126 | 2026-03-01 | — | Go |
| ChatLunaLab/chatluna（默认分支 v1-dev，monorepo） | `bcd0c61`（2026-10-03） | 1.4.0（2026-09-19） | **AGPL-3.0** | 440 | 2026-10-02 | 28 | TS + LangChain |
| ChatLunaLab/chatluna-character | `6ee173b`（2026-09-08） | 0.0.234 | **AGPL-3.0** | 74 | 2026-09-08 | 8 | TS |
| ChatLunaLab/chatluna-character-card | `adc3611`（2026-05-13） | 0.0.14 | package.json 写 AGPL-3.0，LICENSE 文件是 MIT（两者不一致） | 5 | 2026-05-12 | — | TS |

npm 月下载量：koishi 18743，koishi-plugin-chatluna 3272，chatluna-character 636，adapter-onebot 1265。

---

## 2. 打分表

两列打分：
- **「ChatLuna 现成」**：Koishi 本体或 ChatLuna 主插件自带的记 ✅；chatluna-character、character-card 等其他插件记 🧩；`—` 表示没有这个功能。
- **「自写 Koishi 插件」**：把我们的模块写成插件，用 Koishi 的钩子实现。

| 编号 | ChatLuna 现成 | 自写 Koishi 插件 | 说明 | 出处 |
| --- | --- | --- | --- | --- |
| A1 | 🧩 | 🔧 | ChatLuna 本体不能读 ST 卡：源码里搜 tavern / chara_card 没有结果，文档也没提。社区插件 `koishi-plugin-chatluna-character-card`（市场月下载 23，2026-05 更新）从 `data/chathub/sillytavern/*.json|png` 读卡，转成 ChatLuna 预设，转换有损（见 A2）。自写：`st/card.ts` 是纯函数，可以原样搬 | chatluna-character-card@adc3611:src/plugins/load_character_card.ts:7-38；src/plugins/convert_chatluna_preset.ts:60-143 |
| A2 | ⚠️ | 🔧 | ChatLuna 世界书逐条对照：**主关键词** ✅（字符串直接当正则用，不转义）；**二级关键词 / AND·NOT 逻辑** ❌（RoleBook 类型里没有这些字段；card 插件把 secondary_keys 拼进 keys，变成 OR）；**正则** ✅；**扫描深度** ✅（每条可单独设，全局默认 2）；**token 预算** ⚠️（源码把 `tokenLimit` 当作「从剩余上下文里预留出来的量」，默认 300，不是总量上限；文档说的是总量上限，两者不一致）；**插入位置** ⚠️（只有角色定义前 / 后、示例前 / 后，不指定就放末尾；**没有 @depth**；查找 personality 位置那行写成了 'description'，疑似 bug）；**常驻** ✅（constant）；**递归** ✅（recursiveScan，maxRecursionDepth 默认 3）；**包含组 / 概率** ❌；**排序** ✅（order）。card 插件的映射还有错：scanDepth 取自 `extensions.depth`（ST 里这是 @depth 的插入深度），recursiveScan 取自 `exclude_recursion`（语义正好相反）。另外关键词正则带 `g` 标志又被缓存，配合 `.test()` 可能因为 lastIndex 残留而漏匹配（疑似，未验证）。自写：搬 `st/world-info.ts` | chatluna@bcd0c61:packages/core/src/llm-core/prompt/type.ts:61-77；…/llm-core/memory/lore_book/index.ts:92-99,114-168,185-217；…/llm-core/prompt/lore_books.ts:72-96,140-193；card：convert_chatluna_preset.ts:157,167-188；文档 https://chatluna.chat/guide/preset-system/write-preset.html |
| A3 | ⚠️ | 🔧 | card 插件把 `mes_example` 拆成示例消息，`{{x}}` 转成 ChatLuna 的 `{x}` 变量；ChatLuna 自己的变量是 `{user}` `{name}` `{date}` 等（文档）。注入规则不是 ST 那一套。自写：搬 `st/examples.ts`、`st/macros.ts` | convert_chatluna_preset.ts:88-90,212-223；文档 write-preset.html |
| A4 | ⚠️ | 🔧 | card 插件的类型里定义了 `regex_scripts`，但代码里没用到（只在 types.ts 出现）。另有 🧩 `koishi-plugin-chatluna-regex-middleware`（MIT，月下载 3），用自己的规则文件，不读卡。自写：搬 `st/regex.ts` | chatluna-character-card@adc3611:src/types.ts:70（全仓 grep 只有这一处）；npm readme |
| B1 | 🧩 | 🔧 | chatluna-character 的 `privateConfigs[QQ号]` 可以覆盖全局配置，包括 `preset`，在控制台表单里就能改。ChatLuna 主插件有 constraint 表（字段 users / fixedPreset），但只能在对应聊天里用 `chatluna.rule.preset` 指令设，没找到配置 UI。自写：`ctx.middleware` 里按 `session.userId` 分流，或者用 `ctx.user(...)` / `ctx.private()` 过滤上下文 | chatluna-character@6ee173b:src/plugins/chat.ts:2006-2034；chatluna:…/services/conversation.ts:2222-2257，…/types.ts:223-255，…/commands/conversation.ts:357；koishi@5525cfd:packages/core/src/filter.ts:77,97 |
| B2 | ⚠️ | 🔧 | ChatLuna 的会话 key 是 binding key（personal / shared / custom）加 `:preset:<lane>`，换预设通道会换到另一个会话，但 key 的拼法是写死的。长期记忆只有 Global / Preset / Guild / User 四层，没有「用户 + 预设」组合层。chatluna-character 的历史 key 固定是 `private:<QQ>`，换预设后旧历史仍然可见 ❌。自写：我们的 `tier-record.ts` 和历史 key 原样用 | chatluna:…/types.ts:356-414；…/extension-long-memory/src/types.ts:29-34；chatluna-character:src/plugins/chat.ts:2007-2008 |
| B3 | 🧩 | 🔧 | chatluna-character 有 `privateWhitelistMode` + `applyPrivate` 白名单；名单外的人走 `globalPrivateConfig`，可以给它单独配预设，相当于 unlisted 档。自写：middleware 里加判断 | chatluna-character:src/plugins/interception.ts:5-14；src/config.ts:581-584 |
| C1 | ⚠️ | 🔧 | ChatLuna 有 `{date}` `{isotime}` `{time_UTC('+8')}`（文档）；chatluna-character 预设里有 `{time}`，每条消息带 timestamp 属性。但「距上条消息多久」没有单独给出，只能靠模型自己从时间戳推。自写：搬 `time-context.ts` | chatluna-character:resources/presets/default.yml:38；src/utils/messages.ts:53-55；文档 write-preset.html |
| C2 | — | 🔧 | 没有作息 / 课表。chatluna-character 的 `status` 是模型自己维护的状态文本，不是按作息算的。自写：搬 `schedule.ts`，在我们自己的提示词里注入 | chatluna-character:resources/presets/default.yml:381 |
| C3 | ⚠️ | 🔧 | chatluna-character 按每字 `typingTime`（默认 200 ms）延时，实际取 [max/2, max] 之间的随机值；私聊用 `messageWaitTime` 等对方发完。**没有「上课 / 睡觉时什么时候看到」的逻辑**。Koishi 本体有 `session.sendQueued`，按 `delay.character × 字数` 延时 ✅，但很粗。自写：`reply-timing.ts` 加 responder 的 `waitUntil` 原样用 | chatluna-character:src/plugins/chat.ts:1789-1797,1866-1882,1949-1951；src/config.ts:326-331,370；koishi:packages/core/src/session.ts:222-233，context.ts:187 |
| C4 | ⚠️ | 🔧 | chatluna-character 能做到：模型返回空回复就不回、禁言关键词、`coolDownTime` 冷却。没有「睡觉不回 / 被叫醒一次」「收尾后对方只附和就不回」这类规则。自写：搬 `reply-timing.skip` 和 `arrivedWhileAsleep` | chatluna-character:src/plugins/chat.ts:2187-2190,2235-2240,2271 |
| D1 | ✅ | 🔧 | ChatLuna 的 `messageQueue` + `messageQueueDelay` 把同一用户连发的几条收进同一轮（有新消息就重置计时），合并成一次回复；chatluna-character 有 `messageWaitTime`。自写：responder 的 settle；也可以用 Koishi 的 `ctx.debounce` | chatluna:…/middlewares/chat/message_delay.ts:44-127，config.ts:119-120；cordis-v3@4658414:packages/timer/src/index.ts:93-98 |
| D2 | ⚠️ | 🔧 | ChatLuna（plugin / agent 模式）和 chatluna-character 都是把生成期间来的新消息**塞进正在跑的请求**，下一轮推理时让模型看到；不会取消当前生成再重新生成。自写：responder 原本就是取消重生成，Koishi 的 middleware 每条消息并发进来，状态放在我们自己的对象里 | chatluna:…/message_delay.ts:65-77，…/services/conversation_runtime.ts:430-438；chatluna-character:src/plugins/chat.ts:2134-2140，src/service/message.ts:232-236 |
| D3 | ⚠️ | 🔧 | ChatLuna 有 `splitMessage`（none / punctuation / paragraph）；chatluna-character 分段发送，每段之间有打字延时，但**两段之间不检查有没有新消息，不会中途停下**。Koishi 本体的 `sendQueued` / `cancelQueued` 能清空没发出的队列 ✅（机制有，要自己调）。自写：responder 原样用，发送走 `bot.sendPrivateMessage` | chatluna:config.ts:130；chatluna-character:src/plugins/chat.ts:1925-1975；koishi:session.ts:206-233 |
| E1 | ⚠️ | 🔧 | ChatLuna 只有 censor 服务（可选装）、预设里的 `postHandler`，以及 chatluna-character 在回复格式解析失败时重试一次；都不是我们要的规则。Koishi 的 `before-send` 是串行钩子，返回 true 就取消发送，也能改 `session.elements`，但不能要求重新生成。自写：`exit-check.ts` 放在我们自己的流水线里，在拆条之前跑 | chatluna:…/utils/types.ts:5-17；chatluna-character:src/plugins/chat.ts:1637-1660,1765-1777；satori-v4@fbc093f:packages/core/src/message.ts:52，index.ts:69 |
| F1 | ⚠️ | 🔧 | chatluna-long-memory 只能按全局 / 预设 / 群 / 用户分层，不能按「联系人 + 档位」隔离。自写：`memory/long-term.ts` 原样用（bank = 前缀 + QQ 哈希 + 档位） | chatluna:packages/extension-long-memory/src/types.ts:29-34，index.ts:63-111 |
| F2 | ⚠️ | 🔧 | ChatLuna 的记忆引擎只有内置的 Basic / HippoRAG / Emgas；要接 Hindsight，得仿照 lore_book 的写法挂 `chatluna/chat` before 钩子，再用 `contextManager.inject` 注入。自写：`memory/hindsight.ts` 用的是 undici，直接搬 | chatluna:…/llm-core/memory/lore_book/index.ts:12-58，…/llm-core/prompt/context_manager.ts:373,430 |
| G1 | ⚠️ | 🔧 | chatluna-character 的 `historyPull` 只是在缺上下文时拉 QQ 历史补齐，不会补回复漏掉的消息。Koishi 侧可以自己写：适配器的 `bot.getMessageList('private:QQ')` 对私聊走 NapCat 扩展接口 `get_friend_msg_history`；重连可以监听 `login-updated` / `bot-status-updated` 事件 | adapter-onebot@b9d3c3c:src/bot/base.ts:57-72，src/types.ts:443,653；satori-v4:packages/core/src/bot.ts:116-121；chatluna-character:src/config.ts:112-118 |
| G2 | ✅ | 🔧 | 和 NapCat 的 WS 连接：satori 自带重连，`retryTimes`（默认 6）/ `retryInterval`（5 s）/ `retryLazy`（1 min）。模型调用：继续用我们 `llm.ts` 的重试（3 秒超时、4 次快速重试，再 1 分钟 / 5 分钟） | satori-v4:packages/core/src/adapter.ts:25-34,51-72 |
| H1 | ⚠️ | ✅ | Koishi 有 `@koishijs/plugin-mock`（MIT）：Mock 适配器加 `client.receive / shouldReply`，可以离线测，但**没有时钟注入**；cordis 的定时器直接用全局 setTimeout / Date.now。我们的模拟器不依赖框架（流水线纯 TS，时钟由我们注入），迁过去后 Koishi 只是一层很薄的外壳，**模拟器原样保留**；「假 NapCat」端到端测试也能保留（adapter-onebot 用 ws 模式连我们的假 WS 服务） | koishi:plugins/mock/src/client.ts:111-170；cordis-v3:packages/timer/src/index.ts:23-31,77-79 |
| I1 | ✅ | ✅ | 控制台 `@koishijs/plugin-console` + `plugin-config` 按插件的 Schema 自动生成配置表单。保存后：loader.reload → fork.update → 默认**只重启这一个插件**（不重启进程）；插件注册 `ctx.accept(keys, cb)` 的话可以就地更新、不重启。另有 logger（看日志）、explorer（在线改 data 下的文件）、market、sandbox（浏览器里试聊）。ChatLuna 的预设目录改了会自动重新加载（fs.watch） | webui@ec7b484:plugins/config/src/shared/writer.ts:144-148；koishi:packages/loader/src/shared.ts:325-336；cordis-v3:packages/core/src/scope.ts:199-250,286-304；chatluna:packages/core/src/preset.ts:125-200 |
| I2 | 🧩 | 🔧 | `chatluna-multimodal-service`（AGPL，月下载 298）可以单独配一个视觉模型 `imageModel`，把图片转成文字描述塞进上下文，给不支持看图的模型用。另外 ChatLuna 的 deepseek 适配器在 1.4.x 把 deepseek-flash 标成了视觉模型。自写：从 `session.elements` 取 img 的 src，自己调视觉模型 API；也可以借 `ctx.chatluna.createChatModel(视觉模型)` | chatluna:packages/service-multimodal/src/index.ts:41-77，src/plugins/image.ts:29-34；commit 756dabd（#1038） |
| I3 | ✅ / 🧩 | 🔧 | ChatLuna 主插件检测到 `sst` 服务就调用 `ctx.sst.audio2text(session)` 把语音转成文字；🧩 `koishi-plugin-whisper-asr`（AGPL，月下载 38，2026-07，后端是自建的 whisper-asr-webservice，可以全在本地）。multimodal-service 也能把 silk / amr 用 ffmpeg 转成 mp3，交给支持音频输入的模型（不是本地 STT）。🧩 `koishi-plugin-silk`（MIT）负责 silk 编解码。适配器把 QQ 的 record 段转成 `h('audio')` | chatluna:…/middlewares/chat/read_chat_message.ts:343-375；packages/service-multimodal/src/plugins/audio.ts:14-60；adapter-onebot:src/utils.ts:83-86 |
| I4 | 🧩 | 🔧 | 生态里约定了一个 `vits` 服务接口（`ctx.vits.say`），ChatLuna 和 chatluna-character 的语音输出都走它。实现这个接口的插件：`open-vits`（AGPL，支持 GPT-SoVITS / Bert-VITS2，月下载 86，最后更新 **2024-09**）、`luna-vits`（MIT，GPT-SoVITS-2 / fish-audio，2025-05）、`locatts`（MIT，本地 GPT-SoVITS，2025-11）、`media-luna`（MIT，2026-07）。CosyVoice 只找到一个绑定 YesImBot 的插件。发送：适配器把 `h.audio` 转成 OneBot 的 record 段（转 silk 由 NapCat 负责，未验证） | chatluna:packages/core/src/render/voice.ts:61；chatluna-character:src/utils/render.ts:57-69；adapter-onebot:src/bot/message.ts:183-185；市场快照 |
| I5 | 🧩 | 🔧 | `koishi-plugin-novelai`（MIT，支持 SD-webui，月下载 109，2025-03）、`media-luna`（MIT，可以注册成 chatluna 工具）、`doubao-image-generation`（MIT，2026-09）、`p-draw`（接本地 ComfyUI） | 市场快照 |
| I6 | ✅ / 🧩 | 🔧 | Koishi 本体原生支持群聊会话（`session.guildId`、发言人信息）；ChatLuna 群聊可选 shared / personal 两种路由；🧩 chatluna-character 的群聊触发方式：攒够固定条数、活跃度评分、空闲触发 | chatluna:types.ts:379-402；chatluna-character:src/config.ts:14-27 |
| I7 | ✅ / 🧩 | 🔧 | `ctx.setTimeout / setInterval / sleep`（插件卸载时自动清掉）加上 `bot.sendPrivateMessage` 就能主动发；🧩 `koishi-plugin-cron`（MIT，官方 verified，月下载 323，2023-12）；chatluna-character 有空闲触发，还给模型提供 `wake_up_reply_*` 工具，让模型自己排定时；另有 `chatluna-spark`、`chatluna-proactive-trigger` | cordis-v3:packages/timer/src/index.ts:23-55；satori-v4:bot.ts:201-204；chatluna-character:src/plugins/chat.ts:594-770，src/config.ts:17-24 |
| J1 | ✅ | — | Koishi Desktop 提供 win-x64 的 msi / zip（v1.1.4，2026-03-01），官方文档推荐用安装包；也可以 `npm init koishi@latest` 建模板项目。**CI 只测 Node 20 / 22，没测 24** | koishi-desktop releases；koishi:.github/workflows/build.yml:114；文档 https://koishi.chat/zh-CN/manual/starter/windows.html |
| J2 | ✅ | — | `koishi-plugin-adapter-onebot` 在 koishijs 组织下（MIT，市场月下载 1860，最近提交 2026-06-05，22 个 open issue），支持 http / ws / ws-reverse 三种连接方式，readme 里没提 NapCat。NapCat 官方文档写了 Koishi 的接法：协议选 ws-reverse，地址 `ws://127.0.0.1:5140/onebot`，token 两边一致。Koishi 文档的「官方适配器」页只列了官方 QQ 机器人适配器。社区有个分叉 `koishi-plugin-adapter-napcat`（MIT，月下载 107） | adapter-onebot@b9d3c3c:readme.md:1-40，src/ws.ts:11-35；https://napneko.github.io/use/integration |
| J3 | ✅ | ✅ | ChatLuna 有 `chatluna-deepseek-adapter` 和 `openai-like-adapter`（都是 AGPL）。自写路线继续用 `llm.ts` | chatluna:packages/adapter-deepseek，packages/adapter-openai-like |
| J4 | ✅ | ✅ | 没找到遥测：在 koishi 和 chatluna core 里 grep telemetry / sentry / posthog 都没有结果。会联网的地方：market 插件拉 registry.koishi.chat（可以不装）；ChatLuna 第一次用到 tiktoken 编码表时从 jsd.onmicrosoft.cn 或 tiktoken.pages.dev 下载，之后缓存在本地 | chatluna:…/llm-core/utils/tiktoken.ts:59-80 |
| J5 | ⚠️ | ⚠️ | 详见下面「许可证细节」 | 各仓库 LICENSE |
| J6 | ✅ | ✅ | TS / Node。插件就是一个 npm 包，导出 `apply(ctx, config)`、`Config`（Schema）、`inject`。可用的钩子：`ctx.middleware(cb, prepend)`、`ctx.on('message')`、`before-send` / `send`、bot 的各种 API、`ctx.setTimeout`、`ctx.accept`、`ctx.effect`。本地插件放在 `external/`，用 `npm run setup` 创建、`npm run build` 构建，开发时 `yarn dev`（文档）。loader 用 `require` 加载插件 | koishi:packages/core/src/middleware.ts:133-138；packages/loader/src/index.ts:157-165；文档 https://koishi.chat/zh-CN/guide/develop/workspace.html |
| J7 | ⚠️ | — | Koishi：6240 星，53 位贡献者，最新版本 4.18.11（2026-03）；2026 年只有 2 次实质提交；最近几个 issue（#1550、#1555、#1556）都是 0 回复；Koishi 4 依赖的 cordis 3 自 2024-08 起没再更新，cordis 4 还在 rc，Koishi 5 什么时候出不清楚。ChatLuna：440 星，28 位贡献者，1.4.0（2026-09-19），issue 通常几天内修好（例如 #1035 提出后 3 天由 #1037 修复）。chatluna-character：74 星，8 位贡献者，2026-09 还在发版 | `gh api`（见第 1 节） |

### 许可证细节（J5）

| 组件 | 许可证 | 我们这种用法的影响（只列事实，不下法律结论） |
| --- | --- | --- |
| koishi 本体 / cordis / satori / adapter-onebot / plugin-mock / plugin-hmr | MIT | 没有附加义务；用它们写的插件不要求用同一许可证 |
| console、config、market、logger、explorer、sandbox、auth（koishijs/webui）；Koishi Desktop | AGPL-3.0（标准文本） | 原样使用、不修改时，§13 的「向远程交互用户提供源码」只针对**修改过的版本**。只要我们不改这些插件，这一条就不触发 |
| ChatLuna 全家（core、各适配器、long-memory、multimodal 等）、chatluna-character | AGPL-3.0（LICENSE 是标准全文；README 末尾的「使用须知」只是呼吁合法使用，不是附加的许可条款） | 如果我们**修改** ChatLuna，或者我们的插件和 ChatLuna 被认定为一个「基于它的作品」，那么 QQ 好友算不算「通过网络与修改版远程交互」，从而要不要向他们提供源码，是待定的法律问题。我们的仓库是私有的，而且含隐私资料，这一点要留意。**只用 Koishi 本体 + 自写插件，就完全避开了 ChatLuna 的 AGPL** |
| chatluna-character-card | package.json 写 AGPL-3.0，LICENSE 文件写 MIT | 两处不一致，用之前要确认以哪个为准 |
| 附加条款（禁止商用等） | 没有找到 | — |

---

## 3. 六个钩子点

| # | 钩子点 | 回答 | 源码位置 |
| --- | --- | --- | --- |
| 1 | 消息进来：拦截、延迟、合并，按 QQ 号分流 | **可以。** `ctx.middleware(cb, true)` 把中间件插到最前面，ChatLuna 自己的中间件没用 prepend，所以排在我们后面。我们不调用 `next()` 就把这条消息吞掉，ChatLuna 和其他插件都看不到。中间件是 async 的，可以把消息交给我们的 responder 自己做去抖、合并；唯一的限制是 `next` 不能留到以后再调（会报 "isolated next function detected"），我们本来也不需要。分流看 `session.userId` / `session.isDirect`，或者用 `ctx.user(...)` / `ctx.private()` 先切出一个子上下文。如果保留 ChatLuna，它还提供 `chatluna/before-check-sender` 钩子（返回 true 就让 ChatLuna 不回），以及 ChatChain 的 `.middleware(name).before()/after()` | koishi@5525cfd:packages/core/src/middleware.ts:133-138,233-279（:248）；filter.ts:77,97；chatluna:packages/core/src/index.ts:118-132，…/middlewares/chat/allow_reply.ts:47-51 |
| 2 | 拼提示词：完全替换，或按会话指定人设 / 世界书 | **Koishi 本体没有提示词的概念**，自写插件就是 100% 自己拼，`prompt.ts` 加 `st/*` 原样用。ChatLuna 里只能按会话指定预设，再通过 `chatluna/before-chat` 或 `contextManager.inject` / `intercept` 往里插东西；要整套替换它的拼装逻辑，就得绕开它的 chat chain，那等于不用 ChatLuna 了 | chatluna:…/llm-core/chat/app.ts:110-117；…/llm-core/prompt/context_manager.ts:373,430；…/lore_books.ts:199-207 |
| 3 | 会话 key：自定义（联系人 + 档位），历史按它隔离 | Koishi 本体不管会话历史，key 完全由我们定（沿用 `tier-record.ts` 和 `history.ts`）。ChatLuna 的 binding key 是 `personal:平台:selfId:direct:QQ` 再加 `:preset:<lane>`；constraint 可以设 `routeMode: custom` 配一个固定的 routeKey，但 routeKey 是写死在每条规则上的，不能按档位动态生成 | chatluna:…/types.ts:356-414，…/services/conversation.ts:137-222 |
| 4 | 模型返回后、发送前：检查、改写、要求重生成 | 自写：我们自己的流水线在拆条之前跑 `review`，完全可控。框架层面有 satori 的 `before-send` 串行钩子，可以取消或改写每一条要发出的消息，但不能要求重新生成。ChatLuna 只有 `chatluna/after-chat`（这时回复已经存进历史了）和 `postHandler` | satori-v4@fbc093f:packages/core/src/message.ts:52，index.ts:69-70；chatluna:…/llm-core/chat/app.ts:249-258 |
| 5 | 发送：自己控制分条、延时、中途取消 | **可以。** `bot.sendPrivateMessage(userId, text)` 返回消息 id；延时用我们 responder 的 `sleep` / `waitUntil`，中途取消也在 responder 里做。本体还有 `session.sendQueued` / `cancelQueued` 可以用，但不需要 | satori-v4:packages/core/src/bot.ts:196-204；koishi:packages/core/src/session.ts:206-233 |
| 6 | 定时器：插件注册定时任务、主动发消息 | **可以。** `ctx.setTimeout / setInterval / sleep / debounce` 在插件卸载时会自动清掉；从 `ctx.bots` 拿到 bot 实例就能主动 `sendPrivateMessage`。要 cron 表达式可以装 `koishi-plugin-cron`。注意：插件因为改配置被重启时，这些定时器会被清掉（见第 5 节阻碍 3） | cordis-v3@4658414:packages/timer/src/index.ts:23-98 |

---

## 4. 迁过去：能直接搬的、要重写的、工作量

我们的 `packages/bot/src` 共约 4100 行，模块大多是依赖注入写法（responder 的 send / sleep / now / waitUntil 都是外部传进来的），所以**几乎是原样搬**。

| 类别 | 模块（行数） | 处理 |
| --- | --- | --- |
| 原样搬（纯 TS，约 2900 行，约 70%） | `st/*`（652：card、world-info、macros、examples、regex、prompt-converters、time-macros）、`prompt.ts`（177）、`schedule.ts`（309）、`reply-timing.ts`（156）、`time-context.ts`（57）、`exit-check.ts`（92）、`reply.ts`（67）、`responder.ts`（276）、`history.ts`（45）、`tier-record.ts`（64）、`memory/*`（519）、`llm.ts`（119）、`tokens.ts`（10）、`contact.ts`（128） | 不改。数据目录改成 `ctx.baseDir/data/...` |
| 原样保留在框架外 | `sim/*`（765）、`packages/character-tools` | 模拟器直接调流水线，和 Koishi 无关 |
| 改写 | `main.ts`（193）→ 插件的 `apply()`：middleware 分流、发送走 bot、卸载时清理、重连后补回 | 重写约 150 行 |
| 删掉 / 替换 | `onebot.ts`（169）→ 交给 adapter-onebot，`segmentsToText` 改成从 `session.elements` 取文字；`backfill.ts`（55）改成基于 `bot.getMessageList` 返回的 `Universal.Message`；`log.ts` → `ctx.logger`；`lock.ts` 可能不再需要 | 小改 |
| 改写 | `config.ts`（172）→ Koishi Schema（白名单、档位做成 `Schema.array(Schema.object({qq, tier}))`，在控制台里改），角色卡仍然按文件读，再加一个文件监听做热加载 | 中改 |
| 构建 | 我们是 Node 24 原生跑 TS、ESM、import 写 `.ts` 后缀，还用到 `import.meta.url`；Koishi 的 loader 用 `require` 加载插件 | 稳妥的做法是用 esbuild 打成一个 CJS 包，`import.meta.url` 换成 `ctx.baseDir` |

粗估工作量：
- 只做到和现在功能一样：在 Windows 上搭 Koishi 模板 0.5 天 + 插件外壳和补回 1–1.5 天 + Schema 配置、热更新、卡文件监听 1 天 + 构建 0.5 天 + 回归（模拟器 + 假 NapCat 端到端）1 天，**合计约 4–5 人天**。
- 之后每加一项新能力：看图 1 天（借 multimodal-service 或自己调视觉模型）；发语音 1–2 天（不含部署 GPT-SoVITS）；听语音 1 天（whisper-asr）；主动消息 1–2 天（自己写触发逻辑）。
- 对比：如果反过来，把核心逻辑改写进 ChatLuna 预设 + chatluna-character，会丢掉 A2–A4 的保真度，以及 B2、C2–C4、D2、D3、E1；补回来要在 ChatLuna 的 LangChain 内部 API 上写插件，**≥ 8–15 人天，不推荐**。

### 「只把 Koishi 当框架 + 控制台 + 适配器，ChatLuna 只借组件」的阻碍

1. **一借组件就得装整个 ChatLuna 主插件**。它要求有数据库（minato），依赖 LangChain 等，市场标的安装体积约 21 MB（chatluna-character 约 33 MB）。它还会给所有消息挂一个中间件，所以我们要么用 prepend 抢先吞掉消息，要么把 `allowPrivate` 之类的开关关掉。
2. **接口形态不一样**：`createChatModel` 返回的是 LangChain 的 ChatModel，消息要在 OpenAI 格式和 LangChain BaseMessage 之间来回转；`messageTransformer.transform` 输出的是 LangChain 的消息内容。DeepSeek 本来就是 OpenAI 兼容接口，借它的模型适配没什么收益，**真正值得借的只有 multimodal-service 的看图**（而且自己调视觉 API 也只要 1 天左右）。
3. **AGPL**：我们的插件一旦 import 并调用 ChatLuna，许可证边界就变得不清楚（见 J5）。sst / vits 不一样，它们是 Koishi 层面的服务接口，可以完全不碰 ChatLuna，直接用实现了这些接口的插件（MIT 或 AGPL 都有）。

---

## 5. 最大的三个优点、三个阻碍

**优点**
1. **同语言、零强制模型**：Koishi 本体不规定提示词、会话、历史怎么做，六个钩子点都有干净的接口（prepend 中间件、`bot.sendPrivateMessage`、`ctx.setTimeout`、`before-send`）。我们约 70% 的 TS 代码原样搬，模拟器也原样保留。
2. **白拿控制台和热加载**：配置按 Schema 自动出表单，保存后只重启这个插件，或者用 `ctx.accept` 就地更新；另有日志、文件编辑、试聊沙箱。adapter-onebot 官方组织维护，NapCat 文档里有接法，自带 WS 重连，还接好了 NapCat 的私聊历史接口（方便断线补回）。
3. **有生态可借**：看图（multimodal-service 可以单独配视觉模型）、sst / vits 服务接口（whisper-asr、GPT-SoVITS 系列插件）、cron、生图插件，都可以按需装。

**阻碍**
1. **ChatLuna 的核心不合用**：世界书缺二级关键词 / 逻辑、@depth、包含组，tokenLimit 的语义也不对；导卡插件质量低（递归映射反了，月下载 23）；没有作息 / 档位隔离；chatluna-character 不会取消重生成，也不会发送途中停下。所以只能借组件，而组件又重（LangChain、数据库）且是 AGPL。
2. **Koishi 的维护风险**：Koishi 4 建在已冻结的 cordis 3（2024-08 之后没再更新）上；本体 2026 年只有 2 次实质提交，issue 常常没人回；cordis 4 还在 rc，Koishi 5 什么时候出、迁移成本多大都不清楚；CI 没测 Node 24。
3. **工程摩擦**：插件要按 CJS 构建（我们现在是 Node 24 原生 TS + ESM），得加一道打包；框架不提供虚拟时钟（还好我们的模拟器不依赖框架）；改配置会重启插件、清掉正在等待的定时器（例如等她「下课看到消息」的那个），要用 `ctx.accept` 就地更新，或者依赖我们现有的「从历史重新算什么时候看到」的逻辑（`catchUp`）。

---

## 6. 未验证 / 不确定

- **没有实际运行**：Koishi 4.18.11 在 Node 24.21 上能不能正常跑没验证（CI 只测 20 / 22；PR #1553 显示 Node 22.18+ 原生剥类型和 esbuild-register 之间有冲突）。
- 本地插件不打包、直接靠 Node 24 的 `require(esm)` 加原生 TS 剥离加载 `.ts` 源码，能不能行没验证；报告里建议的是用 esbuild 打包。
- 发 `h.audio(wav/mp3)` 时 NapCat 会不会自动转成 silk 没验证。
- ChatLuna `LoreBookMatcher` 里带 `g` 标志的缓存正则配合 `.test()` 可能漏匹配；`findMessageIndex` 里 personality 写成了 'description'。两处都是读源码看出来的疑似 bug，没有跑测试。
- chatluna-character-card 的许可证不一致：npm 写 AGPL，LICENSE 文件是 MIT。
- AGPL §13 对「QQ 好友通过 QQ 与机器人交互」是否适用，以及我们的插件 import ChatLuna 后算不算基于它的作品，都属于法律问题，没有结论。
- Koishi 5 / cordis 4 的发布时间和迁移成本查不到：koishi 仓库的 `next` 分支停在 2022 年，npm 上 koishi 的 `next` 标签是 4.17.0-beta.4；webui 有一条提交写着 "do not directly upgrade koishi to v5"，说明 v5 存在，但在哪儿没找到。
- 市场下载量是 registry 快照里的 `downloads.lastMonth` 字段，和 npm 官方统计口径不一定一样。
