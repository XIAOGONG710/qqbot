# @qqbot/bot

QQ 机器人的核心：按 SillyTavern 角色卡 + 世界书拼提示词，调 OpenAI 兼容接口，按作息决定什么时候回，把回复发回 QQ（经 NapCat）。
回复名单（`contacts`）里的人的直接私聊，每人按自己的档位（[ADR 0003](../../docs/adr/0003-contact-tiers.md)）用对应的角色卡和世界书；
名单外的好友私聊用 `unlisted` 档回复（可关）；群聊、群临时会话一律忽略。

两个入口共用同一份编排（`src/app.ts`）和数据目录 `runtime/bot`，同一时间只能跑一个（[ADR 0008](../../docs/adr/0008-koishi-runtime.md)）：

- **Koishi 插件**（`packages/koishi-plugin-qqbot`）：Koishi 的 OneBot 适配器连 NapCat，名单、档位等在 Koishi 控制台里改，保存后生效。安装、配置、启动见 [docs/koishi.md](../../docs/koishi.md)。
- **独立入口** `src/main.ts`：自写的 OneBot 客户端（`src/onebot.ts`），配置在 `runtime/bot/config.json`，下面「运行」一节。Koishi 路线验收、稳定跑一周之前保持可用。

两边的配置项一样（Koishi 那边没有 `onebot` 一节，`llm.extraBody` 写成 JSON 文本，长期记忆用 `memory.enabled` 开关），校验和默认值都在 `src/config.ts`。

## 运行（独立入口）

1. 复制 `config.example.json` 到 `runtime/bot/config.json`（`runtime/` 不入库），填写：
   - `onebot.url`：NapCat OneBot 网络配置里“WebSocket 服务端”的地址，连根路径 `/`（`/api` 收不到事件）
   - `llm.baseUrl` / `llm.model`：OpenAI 兼容接口（`baseUrl` 不含 `/chat/completions`）
   - `characterCard`：角色卡路径，`{tier}` 换成档位名（`characters/linmengyao/st/linmengyao-{tier}.json`）；世界书按卡里关联的名字在同目录找
   - `contacts`：名单，每项是 `qq`（会回复的 QQ 号，须是小号的好友）、`name`（提示词里 `{{user}}` 的称呼）和 `tier`
     （`boyfriend` / `bestie` / `girl_friend` / `known` / `classmate` / `stranger`）；每个号的聊天记录分开存。
     可选的 `persona` 是一两句“他是谁”（例如「同专业，坐你后排」），放在 ST 人设描述（`personaDescription`）的位置，可以用 `{{user}}` `{{char}}`。
     可选的 `intro` 是别人提起他时她知道的一两句（[ADR 0016](../../docs/adr/0016-people-she-knows.md)）：名单里别人的话里出现他的称呼时给她看，没写就是不认识
   - `unlistedFriends`：名单外的好友私聊时是否用 `unlisted` 档回复（被认真问到时承认是 AI），默认 `true`；`{{user}}` 用对方的 QQ 昵称。
     任何人加小号好友就能让 bot 调用模型，没有频率限制
   - `schedule`：按角色卡上的作息（[ADR 0007](../../docs/adr/0007-schedule-and-reply-timing.md)）决定她现在在干什么、什么时候看到消息、打字多久，默认 `true`。
     开着时她凌晨睡觉不回、上课晚回；深夜测试时设成 `false`，随时几秒内回
   - `memory`：长期记忆（[docs/hindsight.md](../../docs/hindsight.md)），`baseUrl` 是 Hindsight 地址；`recallTimeoutMs`（默认 3000）是生成前召回的限时，
     `timeoutMs`（默认 30000）是写入等请求的限时。删掉这一段就不用长期记忆
   - `prompt.maxContext`：上下文 token 上限（同 ST 的 Context Size），世界书预算和聊天记录截断都按它算
   - `prompt.pinExamples`：同 ST 的 Example Messages Behavior 选 Always include examples，示例对话先占预算、不会被聊天记录挤掉；
     默认 `false`（同 ST 默认的逐步挤出）。示例配置开着：示例对话是校正她语气的主要手段（调研方案 4.2 建议调试期常驻）
   - `llm.promptPostProcessing`：发送前的消息后处理，取值同 ST 自定义接口的 Prompt Post-Processing（`""` / `merge` / `semi` / `strict`），默认不处理
   - `llm.extraBody`：合并进请求体的额外参数，同 ST 自定义接口的 Include Body Parameters
   - `vision`：可选的 DeepSeek 看图配置（[ADR 0055](../../docs/adr/0055-deepseek-vision.md)）。写成
     `{ "provider": "deepseek", "model": "deepseek-flash" }` 后，普通照片 / 截图会用同一个 `QQBOT_LLM_API_KEY` 发给 DeepSeek；默认不配、不外发图片。
     `baseUrl` 默认 `https://api.deepseek.com`，`timeoutMs` 默认 8000。NapCat OCR 不依赖这一项

   示例配置按 DeepSeek 填写（[接口文档](https://api-docs.deepseek.com/)）：
   - `promptPostProcessing: "semi"`：和 ST 的 DeepSeek 接入一致，连续同角色的消息合并，中途的 system 改成 user
   - `extraBody` 关掉思考模式：`deepseek-flash` 默认开思考，开着时 temperature 不生效，`max_tokens` 也会被推理过程占用
   - `temperature: 1.3`：DeepSeek 文档对“通用对话”的建议值
2. 密钥只走环境变量，存在用户级环境变量里（之后新开的终端都能读到；只写 `$env:...` 的话只在当前窗口有效）：
   ```powershell
   [Environment]::SetEnvironmentVariable('QQBOT_LLM_API_KEY', '...', 'User')    # 必填
   [Environment]::SetEnvironmentVariable('QQBOT_ONEBOT_TOKEN', '...', 'User')   # NapCat 那边设了 token 就必填
   ```
3. 先启动 NapCat（`scripts/start-napcat.ps1`）；用长期记忆时再在另一个终端启动 Hindsight（`scripts/start-hindsight.ps1`）；
   最后在另一个终端里启动 bot，Ctrl+C 或关掉窗口就停：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\start-bot.ps1
   ```
   脚本会在当前终端没有这两个环境变量时从用户级读取。配置文件换位置时用 `QQBOT_CONFIG` 指定。

同一个数据目录只能跑一个 bot（锁文件 `runtime/bot/bot.lock`，里面是 PID），第二个会拒绝启动，免得每条消息被回两遍；Koishi 插件用的是同一把锁。
进程被强杀后留下的锁，PID 已经不在了，下次启动会直接接管。

回复按行拆成多条依次发出，空行跳过（模型用换行表示连发几条）；超过 5 行时按顺序合并成 5 条，每条里面换行。
条与条之间按作息时隔这一条的打字时间（见下文），关掉作息时隔 1 秒。
发出之前有出口检查（ADR 0006，`src/exit-check.ts`）：清理时先执行卡上作用于 AI 输出的 ST 正则（整行、行首括号里的动作删掉）；
再查答应或假装发照片、语音、视频、打电话这类做不到的事，和这一档的禁用词（卡的 `extensions.qqbot.banned`）。命中就在提示词末尾加一句说明重写一次，
仍命中的行删掉；重写请求失败时用第一版、删掉命中的行。日志里是「出口检查：……」。
对方连发时，等对方停下 2 秒没有新消息再回，几条合在一起回；从这一串的第一条算起最多等 6 秒（调研方案 5.2 的起点）。
生成期间又来消息，丢掉这次生成带上新消息重来（最多重来 2 次）；拆条发送的中途对方插话，剩下的几条不再发，接着回复新消息。
模型接口连不上（连接超时、被拒、被重置、DNS 失败）时自动重试 4 次，间隔 1、1、2、3 秒；连接超时 3 秒（用 `undici` 包的 fetch，
Node 自带的固定 10 秒）；HTTP 错误和整体超时不重试。模型返回空串时当场再生成一次。
还是失败（真断网）就过 1 分钟、5 分钟各再试一次，再失败就等对方下一条消息一起回；对方的消息一直记在聊天记录里。

每次生成时在聊天记录之后、末尾指令之前加一条时间提示（`src/time-context.ts`，ADR 0004 决策 2）：当前日期、星期和时间（本机时区），
距上一条消息多久（对方连发几条时按第一条算），以及对方的消息如果是 10 分钟以前发的（例如停机期间发的），是什么时候发的。
这部分 ST 里没有，用 SillyTavern 试聊时提示词会比运行时少这一条。

作息（ADR 0007，配置 `schedule` 开着时；`src/schedule.ts`、`src/reply-timing.ts`）：转换器把 `legacy` 的作息、课表、假期按档位写进卡的
`extensions.qqbot.schedule`，运行时按它算她此刻在睡觉、上课还是空闲，在时间提示里加一行 `[你现在：在哪；在干什么；他在哪]`。
什么时候看到：空闲时正聊着马上看到，冷场（她 10 分钟内没说话）15–60 秒后；机房课 2–6 分钟、硬课 5–20 分钟后（只回 1–2 条），先下课就下课后；
睡觉（02:00 到 09:30，有早课 07:40）时起床后再回。男朋友档睡着后 15 分钟内来到第 3 条、或隔 2 分钟以上又来一条，会被吵醒迷糊地回一句，一晚一次。
等的时候来了新消息就重算。看到之后照上面的连发合并、生成；第一条最早在「看到 + 打字时间」发出（0.8 秒 + 每字 0.1 秒，1–4 秒，±20%）。
她已经收尾（晚安、去忙吧……）之后对方只回「嗯」「好」或表情的，不回。日志里是「……，HH:MM:SS 看到」「睡着了，被连着来的消息吵醒」「她已经收尾……」。

每次连上 NapCat（启动或断线重连；Koishi 插件因改配置、角色卡文件变了而重启时也算）先补回漏掉的消息：拉白名单里每人最近 20 条私聊，比本地最后一条新、本地又没有的补进聊天记录
（按 QQ 消息 id 去重；小号自己发的算她说的）。补完后，最后一条没回的消息在 3 小时内就回一次，更早的只补记录，等对方下一条消息时一起回；
按作息时，她睡着时来的消息 12 小时内都照样回（还在睡就等起床）。
bot 运行期间小号在手机上手动发的消息不会推给 bot，聊天记录里没有它们。

长期记忆（ADR 0004 决策 3，`src/memory/`）：名单里的每个联系人一个 Hindsight bank（ID 用 QQ 号的哈希）。
聊天记录按片段（相邻两条隔 45 分钟以上就是新的一段）写入，一个片段一个 `document_id`：片段结束时写，进行中的片段每多 30 条整段重写一次；
启动补回之后写一次，之后每 5 分钟检查一次。生成前用她上一句和对方这次发的几条去召回，限时，查不到或出错就不带；
当前片段里的事不再注入（原文已经在上下文里）。召回内容放在聊天记录之后，「关系概况」（Mental Model）放在 main 之后。名单外的好友没有长期记忆。

运行数据（都在 `runtime/bot/`）：

- `chats/<QQ 号>.jsonl`：聊天记录，一行一条 QQ 消息（拆开发的回复每条一行），只追加
- `memory/<QQ 号>-<档位>.json`：这个人在这一档的 bank ID、每个片段写到了第几条（写入失败的下次再写）。记忆按档位分开，降档后不会召回原档位的记忆
- `tiers.json`：每个联系人上次用的档位。启动时发现档位变了会提示；降档时提醒手动清理这个人的聊天记录（旧记录可能带着高档位才知道的内容），不自动删除
- `last-prompt.json`：最近一次发给模型的完整提示词（是谁的、后处理之后的消息、命中的世界书条目），用来和 SillyTavern 试聊对照
- `logs/<YYYY-MM-DD>.log`：终端里的日志同时按本地日期写一份，事后核对时只 grep 需要的几行（里面有聊天内容）

## 提示词与 SillyTavern 的对应

| 模块 | 对照的 ST 源码 |
| --- | --- |
| `src/prompt.ts` | `default/content/presets/openai/Default.json` 的顺序（`dummyId 100001`，含人设描述）；`public/scripts/openai.js` 的拼装与聊天记录截断 |
| `src/st/world-info.ts` | `public/scripts/world-info.js` 的 `checkWorldInfo` 关键词激活子集 |
| `src/st/examples.ts` | `public/script.js` 的 `parseMesExamples`；`public/scripts/openai.js` 的 `parseExampleIntoIndividual`、`populateDialogueExamples` |
| `src/st/macros.ts` | `{{user}}` `{{char}}` `{{original}}` `<USER>` `<BOT>` |
| `src/st/time-macros.ts` | `public/scripts/macros/definitions/time-macros.js`：`{{time}}` `{{date}}` `{{weekday}}` `{{isotime}}` `{{isodate}}` `{{idleDuration}}`，按中文界面（moment zh-cn）格式化 |
| `src/reply.ts` | `public/script.js` 的 `cleanUpMessage`（默认设置下生效的部分） |
| `src/st/regex.ts` | `public/scripts/extensions/regex/engine.js` 的 `getRegexedString` / `runRegexScript`（角色卡上的 Scoped 脚本，只在 AI 输出位置）；`public/scripts/utils.js` 的 `regexFromString` |
| `src/st/prompt-converters.ts` | `src/prompt-converters.js` 的 `postProcessPrompt` / `mergeMessages`（无工具、无多模态） |

已知差异：

- token 数用 ST 的兜底估算（UTF-8 字节数 / 3.35），不是模型的真实分词器。世界书预算和聊天记录截断的边界会和 ST 略有出入。
- 世界书用到运行时未实现的功能（递归、包含组、sticky / cooldown / delay、@@ 装饰器、角色设定前 / 后以外的插入位置等）时，启动直接报错。
- 出口检查（做不到的事、禁用词）和超过 5 行合并气泡是运行时自己的，ST 里没有；括号正则在 ST 里试聊时一样生效（导入时允许这张卡的正则）。
- 一次回复拆成几条发出后，聊天记录里是几条 assistant 消息；ST 里是一条带换行的消息。
  用 `semi` 后处理时，相邻几条会用空行合并成一条再发给模型，和 ST 只差在分隔符（空行而不是换行）。
