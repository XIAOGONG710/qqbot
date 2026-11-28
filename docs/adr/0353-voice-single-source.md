# ADR 0353：跨端人设来源——口气、分寸、称呼写在 persona.yml 的 voice 段，QQ 和 DSH 从同一张卡读

- 状态：**已采纳**（代码在 main；资料里没写 voice 时一字不差照旧，真实资料等用户自己填）
- 日期：2026-11-28
- 关联：ADR 0010（source/ 是唯一可编辑的资料）、ADR 0003（按档位披露）、ADR 0067（承认版卡）、ADR 0335（专有名字从卡上读）、ADR 0346（她的身份进 DSH 系统提示）；
  交接 `exchange/handoff/2026-11-28-hardcoded-policy-audit.md`「人设、角色卡、DSH preset」一行；用户 2026-11-28「你只做硬编码改造」「继续往下做就行，不用问她，把所有的硬编码拆解开」

## 起因

她的性格、称呼和表达偏好，除了 `persona.yml` 本身，还有六处写死在源码里，QQ 和 DSH 各拿各的：

| 原来写在哪 | 是什么 | 谁读 |
| --- | --- | --- |
| `dsh-plugins/dsh-linmengyao-memory/playful-persona.mjs` `PLAYFUL_PERSONA` | 逗人的分寸 | QQ 私聊、QQ 群聊、DSH 私聊（`QQBOT_PLAYFUL_PERSONA`） |
| `packages/bot/src/language/prompt.ts` `QQ_PLAYFUL_STYLE` | QQ 私聊里的口气 | 只有 QQ 私聊（同一开关） |
| `packages/character-tools/src/persona-to-card.ts` `OUTPUT_RULE` 后三句 | 讲题、对方难过时、身材雷区的分寸 | 转换时写进每档卡的 post_history_instructions |
| `packages/bot/src/st/persona-render.ts` `CASUAL_CHAT_NOTE` | 桌面闲聊约定 | 只有 DSH 的 PERSONA.md |
| `dsh-plugins/dsh-linmengyao-preset/presets.cjs`（由 `cordis.patch.yml` 抄来）的 persona prefix；`scripts/dsh/her-identity.txt` | 桌面上的身份 | 只有 DSH preset |
| `scripts/build-dsh-persona.mjs` 的 `user: '宝宝'` | 桌面人设里对他的称呼 | 只有 DSH 的 PERSONA.md |

ADR 0346 已经记过「两处文案以后要单一来源，别分叉」。

## 决定

1. **资料里一处**：`persona.yml` 新增可选的 `voice` 段，键固定为 `playful` `qq_private` `card_notes` `desktop_chat` `desktop_identity` `calls_him`，
   每条和人设别的字段一样写 `text` + `tiers`（可以有 `variants`、`note`）。校验、档位引用检查、隐私检查（这一档的禁用词）都覆盖这一段。
   哪一端读哪一条写死在代码里（`source.ts` 的 `VOICE_READERS`），资料只管写什么、给哪几档。文字原样用，不替换 `{{user}}` 这类宏。
2. **卡上一份**：转换器把 `card_notes` 接在输出规则后面写进 post_history_instructions；其余五条写进每张卡的 `extensions.qqbot.voice`
   （`playful` `qqPrivate` `desktopChat` `desktopIdentity` `callsHim`）。资料写了的键每档都有，这一档看不到就是空串。
3. **两端读同一张卡**：
   - QQ 私聊（`language/prompt.ts`）读这一档卡的 `playful`、`qqPrivate`；QQ 群聊（`social/group-room.ts`，用同学档的卡）只读 `playful`。
   - DSH 已确认的主人私聊（记忆插件 `index.js`）从 `personaCardFile`（男朋友档承认版卡）读 `playful`；PERSONA.md（`scripts/build-dsh-persona.mjs`）读 `desktopChat` 和 `callsHim`；
     preset 的身份由新文件 `dsh-plugins/dsh-linmengyao-preset/her-prefix.cjs` 在组 preset 时现读 `desktopIdentity`，`presets.cjs` 四个模式不再写死文字；
     `scripts/dsh/apply-her-prefix.mjs`、`check-her-identity.mjs` 也先认卡。
   - 谁都不读别人那几条：DSH 不读 `qqPrivate`，QQ 不读桌面那三条。
4. **回退**：卡上没有这个键（资料没写 voice 或没写这一条、旧卡、卡读不到）——用改造前写死的那段（常量都留在原处当内置默认）。
   有这个键但是空串——这一档看不到，不放，**不**退回内置默认。例外是 `desktopIdentity`、`callsHim`：不能为空，空串也用内置默认。
5. **不归资料管、留在代码里的**：做不到的事和格式（`OUTPUT_RULE` 前四句、`FEWER_RULES_BASICS`）、system_prompt 那句框架、段落标题、
   QQ 只注入哪几段事实（`contact.ts` 的 `PERSONA_FACT_SECTIONS`）、出口检查的禁词。规则的先后不变：做不到的事和格式在前，表达偏好其次，档位分寸最后；QQ 私聊的口气仍排在卡末尾那段之后。
6. **文字不进仓库**：真实资料（git 忽略）填了 `desktop_identity` 以后，身份文字只在本机的卡里，`presets.cjs` 里只有一句 `require("./her-prefix.cjs").herPrefix()`。

## 验收

合成角色的 `source/persona.yml` 写了 voice 段，值就是这些内置默认（桌面身份里名字换成「测试角色」），重新生成的 `st/` 只多了 `extensions.qqbot.voice`；
行为基线 39/39 逐字一致，没有更新快照。测试：`packages/character-tools/test/voice.test.ts`、`packages/bot/test/persona-voice.test.ts`、
`soul-plugin.test.ts`「跨端人设来源」、`app.test.ts`「跨端人设来源」（QQ 私聊、陌生人档私聊、群聊各只拿到自己那几条）。

## 没做 / 以后

- `cordis.patch.yml` 里 linmengyao 那一座的 prefix 还是原文（和 `FALLBACK_PREFIX` 一字不差，测试核对）：bundle patch 里改成 `!!js` 现读卡要在 DSH 桌面上验过再动。
- 别的称呼还写在代码里，归后面的模块：群里认她的名字 `social/group-chat.ts` 的 `HER_NAMES`（群聊 H）；记忆插件存对话用的「宝宝：」「林梦瑶：」和 `MEMORY_IGNORED_ENTITIES`（记忆 I/J）；
  `scripts/dsh/set-user-alias-hint.mjs` 那句别名提示。
- 控制台「林梦瑶」页面还没有 voice 这一页：存别的部分时这一段原样保留，要改先直接改 YAML。
