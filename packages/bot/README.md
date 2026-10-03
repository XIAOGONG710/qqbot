# @qqbot/bot

QQ 机器人服务：通过 OneBot 11 WebSocket 连 NapCat，按 SillyTavern 角色卡 + 世界书拼提示词，调 OpenAI 兼容接口，把回复发回 QQ。
M1 只回复白名单（`contacts`）里的人的直接私聊（群聊、群临时会话、其他人一律忽略），白名单里的人都按男朋友处理，分档见 roadmap M2。

## 运行

1. 复制 `config.example.json` 到 `runtime/bot/config.json`（`runtime/` 不入库），填写：
   - `onebot.url`：NapCat OneBot 网络配置里“WebSocket 服务端”的地址，连根路径 `/`（`/api` 收不到事件）
   - `llm.baseUrl` / `llm.model`：OpenAI 兼容接口（`baseUrl` 不含 `/chat/completions`）
   - `contacts`：白名单，每项是 `qq`（会回复的 QQ 号，须是小号的好友）和 `name`（提示词里 `{{user}}` 的称呼）；每个号的聊天记录分开存
   - `prompt.maxContext`：上下文 token 上限（同 ST 的 Context Size），世界书预算和聊天记录截断都按它算
   - `llm.promptPostProcessing`：发送前的消息后处理，取值同 ST 自定义接口的 Prompt Post-Processing（`""` / `merge` / `semi` / `strict`），默认不处理
   - `llm.extraBody`：合并进请求体的额外参数，同 ST 自定义接口的 Include Body Parameters

   示例配置按 DeepSeek 填写（[接口文档](https://api-docs.deepseek.com/)）：
   - `promptPostProcessing: "semi"`：和 ST 的 DeepSeek 接入一致，连续同角色的消息合并，中途的 system 改成 user
   - `extraBody` 关掉思考模式：`deepseek-flash` 默认开思考，开着时 temperature 不生效，`max_tokens` 也会被推理过程占用
   - `temperature: 1.3`：DeepSeek 文档对“通用对话”的建议值
2. 密钥只走环境变量，存在用户级环境变量里（之后新开的终端都能读到；只写 `$env:...` 的话只在当前窗口有效）：
   ```powershell
   [Environment]::SetEnvironmentVariable('QQBOT_LLM_API_KEY', '...', 'User')    # 必填
   [Environment]::SetEnvironmentVariable('QQBOT_ONEBOT_TOKEN', '...', 'User')   # NapCat 那边设了 token 就必填
   ```
   然后在**新开的**终端里启动：
   ```powershell
   npm start -w @qqbot/bot
   ```
   配置文件换位置时用 `QQBOT_CONFIG` 指定。

回复按行拆成多条依次发出，条与条之间隔 1 秒，空行跳过（模型用换行表示连发几条）。
模型接口连不上（连接超时、被拒、被重置、DNS 失败）时自动重试 2 次，间隔 1 秒、3 秒；HTTP 错误和整体超时不重试。
回复失败时对方的消息仍记在聊天记录里，下次收到消息会一起回复。

运行数据（都在 `runtime/bot/`）：

- `chats/<QQ 号>.jsonl`：聊天记录，一行一条 QQ 消息（拆开发的回复每条一行），只追加
- `last-prompt.json`：最近一次发给模型的完整提示词（是谁的、后处理之后的消息、命中的世界书条目），用来和 SillyTavern 试聊对照

## 提示词与 SillyTavern 的对应

| 模块 | 对照的 ST 源码 |
| --- | --- |
| `src/prompt.ts` | `default/content/presets/openai/Default.json` 的顺序；`public/scripts/openai.js` 的拼装与聊天记录截断 |
| `src/st/world-info.ts` | `public/scripts/world-info.js` 的 `checkWorldInfo` 关键词激活子集 |
| `src/st/macros.ts` | `{{user}}` `{{char}}` `{{original}}` `<USER>` `<BOT>` |
| `src/reply.ts` | `public/script.js` 的 `cleanUpMessage`（默认设置下生效的部分） |
| `src/st/prompt-converters.ts` | `src/prompt-converters.js` 的 `postProcessPrompt` / `mergeMessages`（无工具、无多模态） |

已知差异：

- token 数用 ST 的兜底估算（UTF-8 字节数 / 3.35），不是模型的真实分词器。世界书预算和聊天记录截断的边界会和 ST 略有出入。
- 世界书用到运行时未实现的功能（递归、包含组、sticky / cooldown / delay、@@ 装饰器、角色设定前 / 后以外的插入位置等）时，启动直接报错。
- 角色卡的示例对话（`mes_example`）尚未实现，有内容时启动报错。
- 一次回复拆成几条发出后，聊天记录里是几条 assistant 消息；ST 里是一条带换行的消息。
  用 `semi` 后处理时，相邻几条会用空行合并成一条再发给模型，和 ST 只差在分隔符（空行而不是换行）。
