# 全仓硬编码盘点与改造交接

盘点基准 `cc2686ec`。用户委托 Claude 接手以下全部改造事项。按模块逐个处理，当前模块的主要缺陷与验收缺口通过后再开始下一个。只用合成资料，按 `AGENTS.md` 核对影响言行、记忆和真实角色资料的授权。线上服务、线上开关、真实 QQ 出站和真实数据不在这次交接的执行范围。

现有配置登记见 [features.ts](../../packages/bot/src/platform/features.ts)，Bot 的十个模块见[总表](../../docs/modules/README.md)。接续时先同步 main 并检查本地改动。盘点时另一台工作区已有尚未提交的记忆窗口调整，不能按已合入处理。

## 第一优先级 · 私聊语义判断

先接通 QQ 与 DSH 可共用的低风险语义判断，覆盖「认真求关心」「轻松接梗」「没接就收」。输出类别、依据和不确定性，后续再接 C、D、H。现有针对具体说法的正则保留作兼容入口，只有对照通过后才考虑收掉。分清模型对这句话的理解、程序允许做的事、最终说法。禁止将模型判定直接用作权限、事实落账或外部发送凭据。

验收使用同意图不同措辞、同词不同意图、引用和转述、否定、明确转话题、证据不足。QQ 和 DSH 应读到一致的判断依据，允许用各自口气回复。明确求哄的原有用例继续通过。额外核对误拦率及触发后最终回复，避免把口头禅、催睡和俏皮每种情况继续做成单句修补。

### 第一批完成记录（2026-11-28，Claude）

**开关**：环境变量 `QQBOT_SEMANTIC_JUDGMENT=1`，默认关；已登记在 `features.ts` 的 `ENV_SWITCHES`。QQ 和 DSH 读同一个开关。关着时 QQ 不挂这个模块，DSH 不发起调用，行为基线 39/39 逐字一致，没有更新快照。

**改了什么**（三层分开）：

1. 模型的理解：共用约定放在 `dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs`（加上 `.d.mts`），QQ 沿用 `playful-persona.mjs` 的做法直接引用。这份文件统一管类别（`care` 认真求关心 / `banter` 轻松接梗 / `closing` 没接就收 / `none` / `unclear`）、给模型的提示词、对话整理（只留两人说的话，取最后 6 条，每行截到 120 字）和严格解析，也管放进提示词的那一行和日志那一行。严格解析的要求：整段回答只能是一个 JSON 对象，字段只能是 category / evidence / uncertainty，三样都要有；每处依据给出行号和原文片段，片段必须在那一行里一字不差地出现；三种意图至少要有一处依据落在他最后说的那几行；不确定性超过 0.5 不用。
2. 程序允许做的：只有两样。第一，往「此刻」块新加的 `judgment` 槽放一句「你对他这几句的理解」，带上依据和把握，并注明不一定对、以原话为准。第二，在出口检查已有的重写选择里，用判断代替关键词来认「求哄」（care）和「转话题」（closing），重写的内容不变（`review-exit.ts`）。判断不当权限，不写进事实或记忆，也不作为对外发送的凭据。
3. 最终怎么说由她决定。QQ 和 DSH 读同一行理解，各自用自己的口气回复。

QQ 侧：`modules/semantic-judgment.ts` 在 assess 时发出调用，和召回之后的几步并行，到 `decideAt.deliberate` 取回结果。只对男朋友档的私聊发起；危机、主动找他、只想一想、快照这几种轮次不问。调用走执行器的小调用（不开思考，温度 0，最多 160 token，2.5 秒超时）。app.ts 只加了一行接线，同时把只用一次的 `askSmall` 内联掉，行数不变。
DSH 侧：只在已确认的主人私聊里，本轮第一次见到他原话时发出调用，和召回并行；同一轮的工具步骤沿用这次结果，这一轮结束就清掉。调用用 `QQBOT_LLM_API_KEY` 请求 OpenAI 兼容接口，默认 `judgmentBaseUrl`/`judgmentModel` 是 deepseek / deepseek-flash。没有密钥就不做判断。

**回退**：调用超时、出错、回答读不懂、依据对不上原文或证据不足、模型给 `unclear`、不确定性超过 0.5，这几种情况都不写判断，出口检查照旧走原来那两条正则。正则已改名为 `keywordCareRequest` / `keywordTopicShift` 作兼容入口，本批不删。

**日志**：只记类别、不确定性、依据几处、他这几句多少字，不记原话，也不带 QQ 号（QQ 侧不用会加 `[QQ号]` 前缀的联系人日志）。

**验收证据**（只用合成对话；假模型按剧本返回判断，不调真模型）：

- `test/semantic-judgment.test.ts`：覆盖严格解析的 15 种不认的情况；回退原因六种（超时、抛错、读不懂、拿不准、不确定性太高、他没说话）；那一行和日志不带原话和账号；模块的资格条件；开关关着时 `buildTurnModules` 不挂这个模块；下面那张对照表；明确求哄的原有用例在有判断时照样通过。
- `test/soul-plugin.test.ts`「QQ 和 DSH 对同一段合成对话读到同一份判断」：两边给模型的消息逐字相同，放给她的那一行相同，日志相同，判断对象相同。还核对了：开关关着不问；工具步骤不重复问；这一轮结束清掉；没确认的窗口不问；答非所问时退回。
- `test/app.test.ts`「私聊语义判断」：经 app.ts 接线和执行器跑一轮。开着时提示词里有那一行；关着、同学档、答非所问时都没有；日志不记原话和 QQ 号。
- 原有的 `review-exit-module.test.ts`、`prompt.test.ts` 的求哄用例，以及「两天联动」用例照旧通过；`npm test -w @qqbot/bot`、`npm run test:scripts`、`npm run typecheck`、`npm run baseline:fast -w @qqbot/bot`（39/39）都通过。

**对照表**：这张表出自 `semantic-judgment.test.ts` 的 `t.diagnostic`，开着 `QQBOT_PLAYFUL_PERSONA`。「判断」一列是假模型按剧本给的，所以这张表核对的是程序拿到判断之后怎么用、拿不到时怎么退回，并不代表真模型的准确率。出口检查只认两种情况（care 求哄、closing 转话题）。误拦指认成了其中一种，但他实际不是；漏认指他实际是其中一种，却没认出来。

| 类型 | 说法 | 他实际的意思 | 只看关键词 | 语义判断 | 草稿 | 关键词：最后 | 判断：最后 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 同意图不同措辞 | 原话求哄 | care | care | care | 「行吧，笨。」 | 重写 | 重写 |
| 同意图不同措辞 | 换个说法求关心 | care | - | care | 「行吧，笨。」 | 照发 | 重写 |
| 同意图不同措辞 | 撑不住了想被哄 | care | - | care | 「行吧，笨。」 | 照发 | 重写 |
| 同词不同意图 | 撒娇式哄我 | banter | - | banter | 「行吧，笨。」 | 照发 | 照发 |
| 同词不同意图 | 说回来是转正事 | closing | closing | closing | 「笑到半夜别赖我。」 | 重写 | 重写 |
| 同词不同意图 | 说回来是接着笑 | banter | closing | banter | 「你笑点也太低了吧。」 | 重写 | 照发 |
| 引用和转述 | 转述室友的话（分两条发） | none | care | none | 「行吧，笨。」 | 重写 | 照发 |
| 引用和转述 | 一句里转述 | none | - | none | 「行吧，笨。」 | 照发 | 照发 |
| 否定 | 不用哄我 | none | - | none | 「行吧，笨。」 | 照发 | 照发 |
| 否定 | 不换话题 | banter | closing | banter | 「你笑点也太低了吧。」 | 重写 | 照发 |
| 明确转话题 | 换个话题 | closing | closing | closing | 「你笑点也太低了吧。」 | 重写 | 重写 |
| 明确转话题 | 对了，转正事 | closing | - | closing | 「你笑点也太低了吧。」 | 照发 | 重写 |
| 证据不足 | 只引了旧话（解析不认） | care | care | 退回关键词（care） | 「行吧，笨。」 | 重写 | 重写 |
| 证据不足 | 模型拿不准 | closing | - | 退回关键词（-） | 「你笑点也太低了吧。」 | 照发 | 照发 |
| 证据不足 | 模型答非所问 | none | closing | 退回关键词（closing） | 「你笑点也太低了吧。」 | 重写 | 重写 |

15 条里，只看关键词误拦 4 条、漏认 4 条；有判断时误拦 1 条、漏认 1 条，这两条都是退回关键词的那几条，误差原样来自关键词。退回关键词的一共 3 条。这一批没有新加任何针对口头禅、催睡或俏皮的单句正则。

**还要用户和她点头才能开**：

- 这一项会改变她怎么理解他，按规矩要先 `ask-her`，再由用户同意。本批没有跑 `ask-her`：它要调真模型、读真实角色资料，不在这次的范围内。
- 每轮私聊多一次模型调用：QQ 走执行器，按 chat 计入每日调用额度；DSH 直接请求接口，最慢 2.5 秒，和召回并行。
- 这张对照表用的是假模型。上线前要用真模型在合成说法上跑一次准确率，这也要用户同意才能调。
- 待后续批次（C、D、H）再做：「累了又求哄就别催睡」那一条还是靠正则判断他前一句累没累；求哄 / 转话题以外的已有正则（`isApologyText`、`isExplanationText`、意图阶梯）没动。

## 第二批 · 人设、角色卡、DSH preset（跨端人设来源）

### 完成记录（2026-11-28，Claude）

用户授权：「你只做硬编码改造」「继续往下做就行，不用问她，把所有的硬编码拆解开」，所以这一批没跑 `ask-her`。行为不变：资料里没写新字段时，各端读到的文字和改造前一字不差。决策写在 [ADR 0353](../../docs/adr/0353-voice-single-source.md)。

**原来写死在哪 → 现在在哪**（资料里一处：`persona.yml` 新增可选的 `voice` 段；转换器写进卡的 `extensions.qqbot.voice`；原来的常量留在原处当内置默认）：

| 原来写死的 | 新的资料字段 | 卡上的键 | 谁读 | 内置默认（卡上没有这个键时） |
| --- | --- | --- | --- | --- |
| `playful-persona.mjs` 的 `PLAYFUL_PERSONA`（逗人的分寸） | `voice.playful` | `playful` | QQ 私聊（`language/prompt.ts`）、QQ 群聊（`social/group-room.ts`，同学档的卡）、DSH 已确认的主人私聊（记忆插件 `index.js` 的 `playfulPersonaOf`，读 `personaCardFile`） | 原常量 |
| `prompt.ts` 的 `QQ_PLAYFUL_STYLE`（QQ 私聊里的口气） | `voice.qq_private` | `qqPrivate` | 只有 QQ 私聊 | 原常量（改为导出） |
| `persona-to-card.ts` 的 `OUTPUT_RULE` 后三句（讲题、对方难过时、身材雷区） | `voice.card_notes` | 不上卡的 voice，转换时接在输出规则后面写进 post_history_instructions | QQ 私聊、DSH 的 PERSONA.md | `DEFAULT_CARD_NOTES` |
| `persona-render.ts` 的 `CASUAL_CHAT_NOTE`（桌面闲聊约定） | `voice.desktop_chat` | `desktopChat` | 只有 DSH 的 PERSONA.md（`scripts/build-dsh-persona.mjs`） | 原常量（改为导出） |
| `presets.cjs` 四个模式写死的 persona prefix；`scripts/dsh/her-identity.txt` | `voice.desktop_identity` | `desktopIdentity` | DSH preset：新文件 `dsh-plugins/dsh-linmengyao-preset/her-prefix.cjs` 在组 preset 时现读卡，`presets.cjs` 里只剩 `require("./her-prefix.cjs").herPrefix()`；`scripts/dsh/apply-her-prefix.mjs`、`check-her-identity.mjs` 先认卡（加了 `--card`） | presets：`FALLBACK_PREFIX`（和 `cordis.patch.yml` 那一座的 prefix 一字不差）；apply / check：`her-identity.txt` |
| `build-dsh-persona.mjs` 的 `user: '宝宝'` | `voice.calls_him` | `callsHim` | 只有 DSH 的 PERSONA.md（`{{user}}`） | 「宝宝」 |

**回退规则**：卡上没有这个键（资料没写、旧卡、卡读不到）用内置默认；有这个键但是空串，说明这一档看不到，就不放，也不退回内置默认。`desktopIdentity`、`callsHim` 不能为空，空串也用内置默认。

**留在代码里、不归资料管的**：做不到的事和格式（`OUTPUT_RULE` 前四句、`FEWER_RULES_BASICS`）、system_prompt 那句框架、段落标题、QQ 只注入哪几段事实（`contact.ts` 的 `PERSONA_FACT_SECTIONS`）、出口检查的禁词。规则的先后不变：做不到的事和格式在前，表达偏好其次，档位分寸最后；QQ 私聊的口气仍排在卡末尾那段之后。

**按档位披露**：`voice` 每条都要写 `tiers`，校验、档位引用检查和隐私检查（这一档的禁用词）都覆盖这一段。QQ 私聊只读 `playful`、`qqPrivate`，群聊只读 `playful`，DSH 只读 `playful`、`desktopChat`、`callsHim`、`desktopIdentity`，谁都不读别人那几条。

**顺手修的**：`build-presets.mjs` 原来取 `insert[0]`，加了 `guard.js` 那一行以后就取错了（再跑会抛错）；改成按 `config.plugins` 找，并在生成前核对 `FALLBACK_PREFIX` 和 `cordis.patch.yml` 一致。`soul-plugin.test.ts` 的 `boot()` 原来不给 `personaCardFile`，会去读本机的真实卡；现在默认指到临时目录。

**验收证据**（只用合成角色，不调真模型）：

- 合成 `source/persona.yml` 写了 voice 段，值就是上面这些内置默认（桌面身份里名字换成「测试角色」）。`npm run convert:synthetic` 重新生成后，`st/` 的 13 张卡只多了 `extensions.qqbot.voice`，post_history_instructions 一字没变。
- 行为基线 `npm run baseline:fast -w @qqbot/bot` 39/39 逐字一致，没有更新快照。
- `packages/character-tools/test/voice.test.ts`：生成物和提交的 `st/` 逐字节相同；不写 voice 时卡里除了没有 voice 键，其他内容和写了内置默认时完全一样；按档位给的时候，看不到的档位是空串，card_notes 能按档位改写，看不到的就不带；不认识的键、没写 tiers、档位名写错都会报错；存回去不丢；禁用词写进 voice 时隐私检查能查出来。
- `packages/bot/test/persona-voice.test.ts`：合成卡的 voice 等于内置默认；7 个档位在开关开着时，有 voice 和没 voice 拼出的 QQ 提示词逐条相同；QQ 私聊用卡上的文字，空串不放，桌面那几条不读；PERSONA.md 只读 `desktopChat` 和 `callsHim`，不带 QQ 口气；`herPrefix` 的回退和 `QQBOT_PERSONA_CARD`；`presets.cjs` 四处都是现读；卡上 voice 类型不对会报错。
- `soul-plugin.test.ts`「跨端人设来源」：DSH 的 `[她的设定]` 读卡上的 `playful`，没有卡用内置默认，空串不放，QQ 口气和桌面闲聊约定不进这一块。
- `app.test.ts`「跨端人设来源」：经 app.ts 走一遍。分寸只给男朋友档和同学档，QQ 口气和桌面三条只给男朋友档。男朋友档私聊拿到分寸和 QQ 口气，陌生人档私聊两样都没有，群聊（同学档承认版卡）只有分寸；三处都读不到桌面三条，也读不到内置默认。
- `npm test -w @qqbot/bot`、`npm test -w @qqbot/character-tools`、`npm run test:scripts`、`npm test -w koishi-plugin-qqbot`、`npm run typecheck` 都通过。

**用户写人设 / 自传时要填的字段**（填在本机 `characters/linmengyao/source/persona.yml` 顶层，和 `social` 同级，这里只写字段名和含义，不写内容）：

```yaml
voice:
  playful:            # 逗人的分寸：气氛对了先逗一句、被回撩时害臊、没接就收住。QQ 私聊、QQ 群、DSH 私聊都读（QQBOT_PLAYFUL_PERSONA 开着时）
    text: …
    tiers: [...]      # 给哪些档；群里用同学档的卡，想让群里也有就要含 classmate
  qq_private:         # 只给 QQ 私聊的口气，排在卡末尾那段之后（同一开关）
  card_notes:         # 卡末尾输出规则后面的表达偏好（今天是讲题、对方难过时、身材雷区三句）；写了就替换那三句
  desktop_chat:       # 只给 DSH 桌面人设（PERSONA.md）末尾的闲聊约定，一般只给 boyfriend
  desktop_identity:   # DSH preset 的身份前缀（presets.cjs 四个模式和 apply-her-prefix.mjs 都用它），只给 boyfriend
  calls_him:          # DSH 桌面人设里她对他的称呼（{{user}} 换成它），只给 boyfriend
```

每条和人设别的字段一样，可以写 `variants`（按档位改写）和 `note`。哪条不写，那一端就照旧用内置默认；写了就换成资料里的，看不到的档位就不放。填完以后依次：`npm run convert -w @qqbot/character-tools`（生成本机的卡，隐私检查会查禁用词）、`npm run test:real`、`node scripts/build-dsh-persona.mjs`（重新生成 PERSONA.md）。要让 DSH 那台的 profile 也换成新身份，就跑 `node scripts/dsh/apply-her-prefix.mjs`，再按 ADR 0346 整个退出应用重开。

**要用户确认 / 决定的**：

- 填了 `desktop_identity` 以后，四个内置模式（presets.cjs）和 profile 里的 preset-cordis（apply-her-prefix）会用同一段身份。今天这两处是两段不同的文字：短的那段，和 A4（her-identity.txt）。这样就统一了，也就是 ADR 0346 说的「两处文案单一来源」。用哪一段的内容来填，由用户定。
- `scripts/dsh/her-identity.txt` 里有真实姓名，而仓库是公开的。填进资料以后，这个文件只是回退用；要不要删、怎么处理，由用户定。这一批没动它。
- 线上和 DSH 那台都没重启、没重载。presets.cjs 的改动要等 DSH 重新组 preset（新开会话或整应用重开）才生效，生效后文字不变。

**还写在代码里、归后面模块的称呼**：群里认她的名字 `social/group-chat.ts` 的 `HER_NAMES`（群聊 H）；记忆插件存对话用的「宝宝：」「林梦瑶：」和 `MEMORY_IGNORED_ENTITIES`（记忆 I/J）；`scripts/dsh/set-user-alias-hint.mjs` 那句别名提示；`cordis.patch.yml` 里 linmengyao 那一座的 prefix（要在 DSH 桌面上验过 `!!js` 现读以后再改）。控制台「林梦瑶」页面还没有 voice 这一页，存别的部分时这一段原样保留。另外，出口检查（`modules/review-exit.ts`）在认真求哄时会重写「行吧」「笨」这类口头禅。这条规则和今天 `qq_private` 里的「别用「行吧」「笨蛋」或「笨」」是配套的，仍然写死在代码里。用户改了 `qq_private` 以后，出口检查不会跟着变，这一项留给「语言与理解（C）」那一批处理。

### 第一批补验 · 真模型，合成私聊

基准 `e03f4388`。使用 `deepseek-flash`、温度 0、160 token、项目的 2.5 秒时限。QQ 走实际语义模块和聊天模型客户端，DSH 走实际插件的私聊钩子和默认模型请求代码；都用临时目录和合成账号，记忆接口给空结果。每端各 16 条独立模型请求，14 条有明确人工标签，另有「嗯」和省略号两条歧义输入。未启动正式服务、未发真实 QQ。

| 项目 | QQ | DSH |
| --- | --- | --- |
| 明确的求关心、转正事或结束 | 7 条均识别，漏判 0 | 7 条均识别，漏判 0 |
| 轻松接梗 | 3 条中 2 条正确；「不哄我就不睡了」被判成认真求关心 | 同样有 1 条误判 |
| 引用、转述和否定求哄 | 直接引用正确；同句转述和否定求哄退回关键词后均未命中；分两条转述退回关键词后误认成求哄 | 直接引用、否定求哄正确；两条转述拿不准，均不注入判断 |
| 「嗯」和省略号 | 两条均返回不确定性 0.55，退回关键词且未匹配 | 两条都不注入判断 |
| 合计 | 11 条可用模型判断，其中误判 1 条。回退 5 条。计入关键词回退后，求关心或转场误触发 2 条，漏判 0 | 12 条可用判断，其中误判 1 条。回退 4 条，均没有注入判断；明确的求关心或转场漏判 0 |

统计中，主动放弃判断与把话判断错是两件事。DSH 回退表现是不给提示词增加判断行；QQ 回退仍可能触发旧正则。此前假模型对照的误拦和漏认数字不能和这组真模型统计直接比较。另复跑 5 项含 QQ 入口、DSH 同源、回退对照及两天联动的合成测试，均通过。

结论是接线和回退路径通过验证，真实判断仍有两处主要缺口：玩笑形式的求哄会被两个入口共同误认，连续消息中的引文在 QQ 回退时会被当成本人的请求。开关保持默认关闭。按本轮仅复验的范围，没有改语义判断、回退或记忆阈值代码。

## 第三批 · 记忆、遗忘和技能（I、J）：记忆阈值

### 完成记录（2026-11-28，Claude）

用户授权：「你只做硬编码改造」「继续往下做就行，不用问她，把所有的硬编码拆解开」，所以这一批没跑 `ask-her`。这一批分两部分。第一部分把阈值统一放进配置：默认值就是原来写死的数，一个都没改。第二部分是一项模型判断，挑「想起来的这几条里哪几条和他此刻说的有关」，放在新开关后面，默认关。两个开关都关着时，行为基线 39/39 逐字一致，没有更新快照。

**一张表**：`dsh-plugins/dsh-linmengyao-memory/memory-thresholds.mjs`（加上 `.d.mts`），QQ 和 DSH 都从这里拿数。QQ 经 `packages/bot/src/memory/thresholds.ts` 读，DSH 由插件 `index.js` 直接 import。每一项写了默认值、允许范围、谁读、原来写在哪、是什么意思。readers 里同时有 qq 和 dsh 的项，就是两边共用的同一个概念，两边只有这一个数。

**要调**：环境变量 `QQBOT_MEMORY_THRESHOLDS` 指向一个 JSON 文件，只写要改的键，例如 `{"clearDays": 10}`。这个变量已登记在 `features.ts` 的 `ENV_SETTINGS`，它是一个路径，不是开关。QQ 和 DSH 读同一个变量、同一个文件，都经 `loadMemoryThresholds` 解析。解析是严格的：文件读不了、不是 JSON 对象、有不认识的键、值不是整数、超出范围、clearDays 大于 vagueDays，只要有一样不对，**整个文件都不用**，两边一起退回默认值，不会出现一边用新数、一边用旧数。进程启动时读一次，所以改了要重启 Koishi，并重开 DSH 插件。DSH 只在调过或文件没用上时记一行日志，内容是键名和数，不写路径和文件内容；全部默认时不记，和原来一样。

**原来写死在哪 → 表里的键**（默认值）：

| 键 | 默认 | QQ 原来在 | DSH 原来在 |
| --- | --- | --- | --- |
| `clearDays` / `vagueDays` | 7 / 30 天 | `fading.ts` CLEAR_DAYS / VAGUE_DAYS | `index.js` MEMORY_CLEAR_DAYS / MEMORY_VAGUE_DAYS |
| `crossWindowMs` | 6 小时 | `cross-recent.ts` CROSS_WINDOW_MS | `index.js` CROSS_WINDOW_MS |
| `crossLineChars` | 200 字 | `cross-recent.ts` CROSS_LINE_CHARS | `index.js` CROSS_LINE_CHARS |
| `crossTailBytes` | 64 KiB | `cross-recent.ts` TAIL_BYTES | `index.js` CROSS_TAIL_BYTES |
| `desktopKeepMs` | 14 天 | `desktop-log.ts` DESKTOP_LOG_KEEP_MS | `index.js` DESKTOP_KEEP_MS |
| `desktopTextChars` | 600 字 | `desktop-log.ts` DESKTOP_LOG_TEXT_CHARS | `index.js` recordDesktopTurn 的 600 |
| `inboxMaxAgeMs` | 30 天 | `dsh-inbox.ts` INBOX_MAX_AGE_MS | `index.js` INBOX_MAX_AGE_MS |
| `recallTimeoutMs` | 3 秒 | `config.ts` DEFAULTS.memory.recallTimeoutMs（`modules/memory.ts` 的兜底也读它） | `index.js` recallAll 的 3000 |
| `feelingCoarseAfterDays` | 90 天 | `emotion/feeling-ledger.ts` COARSE_AFTER_DAYS | `index.js` FEELING_COARSE_AFTER_DAYS |
| `rawMessages` | 80 条 | `fading.ts` RAW_MESSAGES | — |
| `maxRecalled` / `sharedRecalled` / `personRecalled` / `todayOthers` / `sameThingRecalled` | 12 / 6 / 6 / 3 / 2 条 | `long-term.ts` 同名常量 | — |
| `recallTokens` / `dayRecallTokens` | 1000 / 2000 | `long-term.ts` RECALL_TOKENS / DAY_RECALL_TOKENS | — |
| `maxQueryChars` | 300 字（只能往小调） | `long-term.ts` MAX_QUERY_CHARS | — |
| `recalledLineChars` | 200 字 | `long-term.ts` formatRecalled 的 200（新常量 RECALLED_LINE_CHARS） | — |
| `recallBreakerTimeouts` / `recallBreakerMs` | 2 次 / 60 秒 | `long-term.ts` RECALL_BREAKER_*（熔断 4d6a0ff6 照旧） | — |
| `memoryTimeoutMs` | 30 秒 | `config.ts` DEFAULTS.memory.timeoutMs | — |
| `desktopMaxTurns` | 3 轮 | `cross-recent.ts` DESKTOP_MAX_TURNS | — |
| `notebookMaxAttempts` / `notebookMaxAgeMs` | 80 次 / 30 天 | `life/notebook-learning.ts` MAX_ATTEMPTS / MAX_AGE | — |
| `desktopPick` / `desktopMaxChars` | 6 条 / 1400 字 | — | `index.js` DEFAULTS.pick / maxChars |
| `desktopRecallTokens` | 1200 | — | `index.js` recallBank 的 max_tokens |
| `bankListTimeoutMs` | 2.5 秒 | — | `index.js` allBanks 的 2500 |
| `qqRecentLines` | 10 句 | — | `index.js` qqRecentBlock 的 10 |

原来的常量名都还在，只是改为从表里取值，别处的引用一处没动。各端自己的配置仍然优先：QQ 的 `config.json` 里写了 `memory.timeoutMs` / `memory.recallTimeoutMs`，就以 config.json 为准（控制台表单的默认值跟着表走）；DSH profile 里写了 `pick` / `maxChars`，也以 profile 为准。所以 `recallTimeoutMs` 只有在 config.json 没写的时候，才保证两边是同一个数。

**留在代码里、不进这张表的**：这些是保护，不是调参。包括 Hindsight 回应的字节上限和条数上限（`hindsight.ts`）、撤回清单留多少个（`history.ts` 的 200）、收件箱去重留多少个 id、两台钟差的 60 秒容忍、`MAX_QUERY_CHARS` 的 300 上限本身，以及 `IMPORTANT_TOPICS` 正则和 `MEMORY_IGNORED_ENTITIES` 名单（这两项是规则，不是数）。另外有几项属于运维或别的模块，留给后面的批次：记忆对账的间隔（`RECONCILE_*`）、关系概况和实体名多久重读、`OPEN_EPISODE_STEP`、补回（backfill）、DSH 的 `invalidateSimilar` 那两处 3 秒和 `limit=500`、bank 列表缓存 60 秒、`SELF_SAID_CHARS`、在场租约、`memoryDistance` 的远近分档。

**记忆相关性判断**（新开关 `QQBOT_MEMORY_RELEVANCE=1`，默认关，已登记在 `ENV_SWITCHES`，QQ 和 DSH 读同一个开关）：

1. 模型的理解：共用约定放在 `dsh-plugins/dsh-linmengyao-memory/memory-relevance.mjs`（加上 `.d.mts`），管提示词、候选整理、严格解析、取舍和日志那一行。对话整理沿用第一批的 `judgmentConversation`，那一份约定没改。候选整理是去掉开头的「- 」和 `<<…>>` 标记，每条截到 160 字，最多给模型看 12 条，超出的照规则留着。模型只回 `{"keep":[编号],"uncertainty":0–1}`。严格解析的要求：只能有这两个字段；编号是不重复的整数，并且都在候选范围内；不确定性超过 0.5 不用。
2. 程序允许做的：只能从规则已经挑好、准许放给她的那几条里**去掉**几条，不加、不换、不改字。账号隔离（ownerBank / scope）、撤回、变淡、同一件事别太多，这些在召回时就已经算过，所以模型怎么挑，都挑不进她本来读不到的东西。判断不当权限，不写进事实或记忆，也不作为对外发送的凭据。模型说一条都没关系时，这一段就不放。
3. 最终怎么说由她决定。

QQ 侧：`modules/memory-relevance.ts` 排在记忆模块后面。在 `decideAt.recall` 召回完之后发出调用，和后面几步并行，到 `decideAt.deliberate` 取回结果，只改他的私人记忆那一段（`facts.recall.recalled`）。公共记忆、被提起的人的记忆、工作房、桌面这几段都不动。只对男朋友档的私聊发起；危机、主动找他、只想一想、快照这几种轮次不问。调用沿用执行器的小调用（`semanticAsk`），上限是 120 token、2.5 秒；`turn-modules.ts` 加了一行接线，app.ts 没改。
DSH 侧：只在已确认的主人私聊里，他刚开口的那一步（最后一条是他说的）才问；工具步骤照规则。调用用 `QQBOT_LLM_API_KEY` 请求 `judgmentBaseUrl` / `judgmentModel`，和语义判断用同一个接口，没有密钥就不判断。DSH 这一步排在召回后面，没有和别的步骤并行，所以开着时每轮最多慢 2.5 秒。

**回退**：超时、出错、回答读不懂、编号越界或重复、不确定性超过 0.5、他没说话、没有候选，这几种情况一律照规则全放，和关着时一样。

**日志**：只记候选几条、留了几条、不确定性和退回原因。不记记忆内容，不记原话，也不带 QQ 号。

**验收证据**（只用合成角色和合成记忆；Hindsight 和模型都是假的，不连真服务）：

- `test/memory-thresholds.test.ts`：把改造前写死的数逐个抄下来，核对默认值一模一样，没有多也没有少；QQ 各处的常量、`DEFAULTS.memory`、DSH 插件导出的值在没设变量时都是默认值；源码检查表里每一项都真的接上了，QQ 读的在 `packages/bot/src` 里用到，DSH 读的在 `index.js` 里用到，共用的两边都用到；严格解析覆盖 9 种不认的情况，日志不写路径和文件内容。**两边一致**：新开一个进程，设好 `QQBOT_MEMORY_THRESHOLDS` 指向临时文件，QQ 和 DSH 读到的整张表相同；对同几条合成旧事，QQ 的 `clarity` 和 DSH 的 `desktopMemoryClarity` 给出相同结果，调成 10 / 20 天以后两边一起变；DSH 写桌面回合截的字数等于 QQ 认的上限。文件里有不认识的键时，两边一起退回默认。
- `test/memory-relevance.test.ts`：覆盖严格解析的 19 种不认的情况；回退原因七种；候选超过上限时只问前 12 条；日志不带内容和账号；QQ 模块只改私人记忆那一段，别的几段一个字不动；资格条件；开关关着时 `buildTurnModules` 不挂这个模块，开着时排在记忆模块之后。
- `test/soul-plugin.test.ts`「记忆相关性判断：QQ 和 DSH……」：同一段合成对话、同几条记忆，两边给模型的消息逐字相同，留下的相同，日志相同。还核对了：开关关着不问、照规则全放；工具步骤不再问；没确认的窗口不问；答非所问和编号越界时照规则全放；模型一直不回时到点照规则全放，这一轮照常；别人 bank 里的不查，也挑不进来。
- `test/memory-relevance-app.test.ts`：经 app.ts 和执行器跑一轮。开着时只问一次，提示词里只剩挑中的两条，日志一行；关着时不问、全放；模型想挑进第 4 条时照规则全放；另一个账号（闺蜜档）只读她自己的 bank，读不到男朋友的，也不问相关性；**记忆超时时照常回复**，不带记忆，也不问相关性。
- 要求保留的几条，原有用例照旧通过：熔断（`memory-recall-breaker-review.test.ts`）；撤回传播、派生摘要失效、**重启后旧摘要不复活**（`memory-derived-app-review.test.ts`「重启迁移真实recalled元数据……」）；**换账号读不到**（`soul-plugin.test.ts`「同一个她」那一组、`app.test.ts`「隔天接续……换账号问同一句读不到」）；**经验只改变对应场景**（`notebook-learning.test.ts`「……偏好按场景……」，上限现在从表里读）；召回标记拆除（b8c6f7bd 的用例）。
- `npm test -w @qqbot/bot`、`npm run test:scripts`（232）、`npm test -w koishi-plugin-qqbot`（115）、`npm run typecheck`、`npm run baseline:fast -w @qqbot/bot`（39/39）都通过。`docs/modules/memory.md` 已重新生成。

**未结项**：

- **另一台未提交的调参还没对照**：盘点时另一台的工作区有一份尚未提交的记忆窗口调整，这台看不到。请 DSH 那台拿这张表的键逐个对照：要保留的，写成一份 `QQBOT_MEMORY_THRESHOLDS` 覆盖文件，不要再改源码里的数；或者在信箱里把键和值告诉 Claude。对照之前，表里的值仍然是已提交版本的值。
- DSH 的相关性调用沿用 `createJudgmentAsk`，输出上限是 160 token；QQ 是 120。回答只有一行 JSON，影响不大，但两边不完全一样。
- 这一批只做了「相关性」这一项判断。下面几项还靠固定规则，留作后续：「一提就想起」靠实体名字面包含（`fading.ts` 的 `recognizes`，DSH 同一条）；公共记忆和被提起的人的记忆没有相关性判断；「引用还是只当背景」没有分开；DSH 的 `IMPORTANT_TOPICS` 正则；读书笔记经验的保留规则（`notebook-learning.ts` 的 `learned()`：先按日期没找到、后按主题找到才记成经验）和请求识别的那几条正则。
- 相关性判断的准确率只用假模型核对过接线和回退，还没用真模型在合成对话上跑过。

**要用户决定才能开**：

- `QQBOT_MEMORY_RELEVANCE` 会改变她想起什么，按规矩应先 `ask-her`，再由用户同意。本批按用户授权没问，但开关要不要开由用户定。
- 开着时，每轮私聊多一次模型调用：QQ 按 chat 计入每日调用额度；DSH 直接请求接口，每轮最多多等 2.5 秒。
- 上线前要不要先用真模型跑一次准确率（要调真模型，需用户同意）。
- 要不要写 `QQBOT_MEMORY_THRESHOLDS` 覆盖文件、改哪几个数（例如接受另一台的窗口调整）。改了要重启 Koishi，DSH 要重开插件，属于「改线上开关 / 重启」，需要用户点头。线上和 DSH 那台这一批都没重启、没重载。

## 第四批 · 语言与理解（C）

### 完成记录（2026-11-28，Claude）

用户授权：「你只做硬编码改造」「继续往下做就行，不用问她，把所有的硬编码拆解开」，所以这一批没跑 `ask-her`。做了四件事：一是把出口检查里只管口气的那几样归进一张软风格规则表，严厉程度从一处调；二是给第一批的共用判断约定加了「推掉 / 拒绝」「纠正理解」两类；三是补第一批补验发现的两处缺口；四是主人当场纠正时那一轮的提示改由判断来认。开关都关着、也没设覆盖文件时，行为基线 39/39 逐字一致，没有更新快照。

**盘点**（入口文件里每一条写死的风格规则、说法正则和重写触发条件）。分类：(a) 安全、能力、事实、格式和故障兜底，留在代码里；(b) 软风格偏好，挪进配置，默认值就是今天的值；(c) 意图识别，开了 `QQBOT_SEMANTIC_JUDGMENT` 时由共用判断来认，正则留作兼容回退。

| 文件 | 条目 | 类 | 这一批怎么处理 |
| --- | --- | --- | --- |
| `language/prompt.ts` | `keywordTopicShift`（「说回来 / 换个话题 / 说回正事」），决定卡末尾放 QQ 口气还是「这一轮对方已经翻篇」 | c | 有判断按判断；开着但退回时按关键词，分几条发的转述不认（`recognizes`，经 `contact.ts` 传 `playfulClosing`）；没开照旧。正则保留，对没写转场词的说法仍漏认 |
| `language/prompt.ts` | 「【QQ 私聊这一轮】对方已经翻篇……」那段文字 | b（人设文字） | 未动。它属于人设，应和 `voice.qq_private` 一起进资料，留给人设那边（见未结项） |
| `language/prompt.ts` | `QQ_PLAYFUL_STYLE` | b | 第二批已经改为读 `voice.qq_private`，这里只是内置默认 |
| `language/prompt.ts` | 预算放不下时的两句兜底、ST 预设结构、日期行 | a | 留在代码 |
| `modules/review-exit.ts` | `keywordCareRequest`（「我认真想听你哄我一下」） | c | 同上，走 `recognizes`；兼容入口不删 |
| `modules/review-exit.ts` | 认真求哄时追加的 `行吧` `笨` `认真想听你哄我` `re:笑点…低` | b | 改成表里的 `careAvoid` |
| `modules/review-exit.ts` | 他前一句累了（`忙了一整天 / 累了 / 今天…很累`）的判断 | c | 未接判断（判断只读他最后那几句）。留着正则，见未结项 |
| `modules/review-exit.ts` | 累了又求哄时追加的催睡 / 晚安正则 | b | 改成表里的 `careTiredAvoid` |
| `modules/review-exit.ts` | 转话题时追加的 `re:笑点…低`；前一句说笑话、新这句不带「笑」时追加的 `re:笑话\|笑点\|笑(到\|成\|够)` | b（追加的说法）/ c（「笑话」「笑」两处字面判断） | 说法改成 `closingAvoid` / `closingJokeAvoid`；两处字面判断留着 |
| `modules/review-exit.ts`、`modules/candidates.ts`、`social/outbox-host.ts` | `ODD_BODY_WORDS`（医书词、小说神态）、`STILTED_WORDS`（书面腔）并进禁用词 | b | 三处都改成从表里拿（`styleBannedWords()`，`oddBodyWords` / `stiltedWords` 两个开关）。词表本身还在 `expression.ts` |
| `modules/review-exit.ts` | 卡上的禁用词、`fewerRules` 的取舍、「QQ 文字里的抱抱」打开文字亲密检查、没有上下文时危机回合发固定兜底 | a | 留在代码 |
| `language/speech-check.ts` | 助手腔 `SERVICE`、算账、怪他没说、比委屈、重复（开头 / 口头禅 / 原话）、叮嘱重复 `NAGS` | b | 每一类在表里有一个开关（`service` `ledger` `blame` `contrast` `repeat` `nag`），关掉的那一类在 `exit-check.ts` 的 `strip()` 里过滤（`ReviewOptions.skip`）。判据和门槛（`REPEAT_AT`、`RECENT_REPLIES`、口头禅表）留在代码，见未结项 |
| `language/speech-check.ts` | 书的进度数字 | a（事实） | 留在代码 |
| `language/exit-check.ts` | 做不到的事 `PROMISE` / `DM_SENT`、照抄语音图片 `MEDIA_LINE`、编对话 `SCRIPT`、B 站私信标记、内部标记 `<<…>>`、QQ 里没有的表情 | a | 留在代码 |
| `language/exit-check.ts` | 文字亲密推回当面 `TEXT_INTIMACY_DEFERRAL` | a | 留在代码（在 HARD 集合里，事关文字互动算不算数） |
| `language/exit-check.ts` | 危机回合的方法 / 敷衍 / 收尾 / 答应过去 / 八股，以及三段固定兜底 | a | 留在代码 |
| `language/exit-check.ts` | 小黄脸频率（`MAX_FACES`、`FACE_WINDOW*`）、句尾问号 `tidyQuestionMarks` | b | 未动，留给「观察、隐私与质量（K）」，见未结项 |
| `life/understanding.ts` | `CORRECTION`（「不是这个意思 / 我说的是 / 你理解错」）用在当场纠正的提示 `correctionReplyLine` | c | 有判断时按 `correction` 认，没有照旧按正则（`judgedCorrection` → `immediateCorrection` 第三个参数） |
| `life/understanding.ts` | 同一个 `CORRECTION` 用在 `app.ts` 记纠正 `recordCorrection` | a（落盘只按原话） | 不看判断。判断不能用来落账，这是第一批定的边界 |
| `life/understanding.ts` | `DECLARED_INTENT` / `DENIED_ANGER` / `REFERS_BACK` / 两天 / 引号：把待确认改成已澄清 | a（确认要有他的原话） | 不看判断。原话、猜测、确认、修正照旧分开存（`UNDERSTANDING.json` 的 original / hypotheses / revision.evidence / interpretation） |
| `shared-understanding.mjs` | `isAmbiguousAcknowledgement`（「行 / 好 / 嗯，你去忙吧」），两种固定的猜测 | a（猜测只当猜测） | 不看判断 |
| `life/understanding.ts` | 旧纠正提醒（二字词撞上至少两个、30 天、留 20 条） | 召回规则 | 未动，归记忆（I、J） |
| `life/understanding.ts` | `correctionReplyLine` 那句提示的文字（先复述、别默认自己错、别编原因） | a（诚实约束） | 留在代码 |
| `language/intent.ts` | 意图阶梯约 40 条正则：收尾 `ENDING`、提问、要她陪 / 哄 `ASKS_FOR_HER`、亲密邀约、网络梗、好消息、逗她、难过、磨她 `PRESSING_ON`、管她 `CONTROLLING`、他推掉邀约 `DECLINES_INVITE`、她的拒绝 `REFUSAL_WORDS`…… | c | 未接判断：`decideAt.intent` 在判断取回的 `decideAt.deliberate` 之前。「推掉 / 拒绝」「纠正」两类目前只作为「你对他这几句的理解」那一行给她，见未结项 |
| `language/intent.ts` | 危机标记、要「现在」的照片发不了、被说像 AI、问是不是真人 | a | 留在代码 |
| `emotion/affect.ts` `isApologyText`、`emotion/grievance.ts` `isExplanationText` | 道歉 / 解释有没有接住 | c | 未动，归「心境与恢复（D）」 |

**一张软风格规则表**：`packages/bot/src/language/style-rules.ts`（已登记进 `platform/modules.ts`，`docs/modules/language.md` 已重新生成）。只有 QQ 读，DSH 没有出口检查。

| 键 | 默认 | 原来写在哪 |
| --- | --- | --- |
| `strictness` | `standard` | 新加的总档。`relaxed` 表示软检查全关、四组说法清空，只剩硬规则 |
| `service` / `ledger` / `blame` / `contrast` / `repeat` / `nag` | 全 `true` | `speech-check.ts` 的六类说话毛病（还要配置 `speechCheck` 开着，`fewerRules` 照旧会把它关掉） |
| `oddBodyWords` / `stiltedWords` | `true` | `expression.ts` 两张词表，出口检查、挑候选、留话出站三处共用 |
| `careAvoid` | `行吧`、`笨`、`认真想听你哄我`、`re:笑点[^。！？]{0,5}低` | `review-exit.ts` |
| `careTiredAvoid` | `re:晚安\|早点睡\|…\|(?:闭眼\|躺下)(?:就)?睡` | `review-exit.ts` |
| `closingAvoid` | `re:笑点[^。！？]{0,5}低` | `review-exit.ts` |
| `closingJokeAvoid` | `re:笑话\|笑点\|笑(?:到\|成\|够)` | `review-exit.ts` |

**要调**：环境变量 `QQBOT_STYLE_RULES` 指向一个 JSON 文件，只写要改的键，例如 `{"strictness": "relaxed", "repeat": true}`。这个变量已登记在 `features.ts` 的 `ENV_SETTINGS`，它是路径，不是开关。解析是严格的：文件读不了、不是 JSON 对象、有不认识的键、strictness 不对、开关不是布尔、说法不是非空短字符串、`re:` 正则编不过或为空、一组超过 40 条，只要有一样不对，**整个文件都不用**，全部退回默认。进程启动时读一次，改了要重启 Koishi。改过或文件没用上时，出口检查第一次运行记一行日志，只写档位和键名，不写路径和说法；全部默认时不记。

那四组说法和角色卡的 `voice.qq_private` 是配套的。今天 qq_private 写着「别用「行吧」「笨蛋」或「笨」」，出口检查就拦「行吧」「笨」。用户改了 qq_private 的这一句，要在覆盖文件里把 `careAvoid` 一起改掉（第二批记下的那条未结项，现在有地方改了，但还不会自动跟着变）。

**共用判断约定的扩展**（`dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs` 和 `.d.mts`，没有另起一份）：

- 新加两类：`refusal`（推掉 / 拒绝她刚提的事）、`correction`（纠正她对他的话的理解）。`JUDGMENT_INTENTS` 列出必须有一处依据落在他最后那几行的类别，这两类也在里面。严格解析的其他规则不变：只能有三个字段、原文片段一字不差、不确定性超过 0.5 不用。
- 放给她的那一行多了两种说法：「他像是在推掉或者不想要你刚才提的事」「他像是在纠正你刚才对他的话的理解」。仍然带依据和把握，注明不一定对、以原话为准。DSH 那边直接读这一行，没有改插件代码。
- **缺口一**（玩笑式求哄被判成认真求关心）：提示词里加了一条，「不哄我就不睡了」「不哄我我就闹」「哄我一下嘛~」这类撒娇、耍赖、拿条件开玩笑的话算 banter。只有他同时说了自己真的累、难受、委屈，或者明说是认真的，才算 care。同时写明了分几条发的转述也不算他的要求。这一处只改了提示词，判得对不对，要用真模型复跑才能确认（见要用户决定的）。
- **缺口二**（QQ 退回关键词时，把分两条发的引文当成他自己的请求）：新函数 `reportedSpeech(conversation)`。他最后连着发的那几行里，最后一行前面有一行以转述的引子结尾（「说了一句：」「回了句」、冒号、没关上的引号），就认为是转述。他自己对她说的引子不算（「我跟你说：」「问你个事：」「我说」）。QQ 的 `recognizes` 只在**开着语义判断、这一轮退回了**的时候用它（`TurnFacts.semanticJudgmentFallback` 由语义模块在退回时写）。没开时一个字都不变，所以正则本身没改，基线不受影响。DSH 没有关键词回退，不用它。

**程序允许判断做的**（比第一批多一样）：一是往 judgment 槽放那一行；二是出口检查和卡末尾那段，在已有的选择里用判断来认「求哄 / 转话题」；三是新加的：主人当场纠正时那一轮的修复提示（`self-memory.ts` → `app.ts` 的 `immediateCorrection` → `correctionReplyLine(text, judged)`），有判断按判断认，没有照旧按 `CORRECTION`。判断仍然不当权限，不写进事实或记忆，也不作为对外发送的凭据。记下纠正、待确认改成已澄清，都只按他的原话和规则走。

**回退**：判断不能用的情况（超时、出错、读不懂、依据对不上、拿不准）和第一批一样，一律按关键词。多出来的一条：开着时退回，分几条发的转述不认。

**验收证据**（只用合成对话和合成角色；模型都是按剧本回答的假模型，不调真模型）：

- `test/language-understanding.test.ts`（14 项）：表的默认值和改造前写死的逐字相同，没有多也没有少；`styleBannedWords()` 等于原来的 `[...ODD_BODY_WORDS, ...STILTED_WORDS]`；默认时不跳过任何一类、不记日志；`relaxed` 和逐键覆盖都生效；严格解析覆盖 16 种不认的情况，另有读不了 / 不是 JSON / 文件不在，日志不写路径和内容；另开一个进程设 `QQBOT_STYLE_RULES`，表跟着文件变，键写错时整个退回默认。出口检查跟着表走：关掉的软检查不再重写，做不到的事和卡上禁用词照样拦。默认时 `exitOptionsOf` 给出的禁用词和改造前逐项相同，也没有 `skip`。约定部分：两类的解析、依据必须落在他最后那几行、多一个字段不认、那一行的说法；提示词里写着缺口一那条规则和分条转述；QQ 和 DSH 拿到的是同一份提示词；`reportedSpeech` 覆盖 9 种说法。缺口二：开着时退回（拿不准、出错），分两条发的转述照发；没开时照旧重写；他自己说的求哄（包括「我跟你说：」开头的）退回时照样重写；转话题同理；有能用的判断时仍以判断为准。缺口一：判成接梗照发，判成认真求关心才重写。当场纠正：`correctionReplyLine` 的三种情况，以及 `self-memory` 递给 App 的值（true / false / undefined）。
- `test/app.test.ts`「语言与理解（第四批）……」：开着 `QQBOT_SEMANTIC_JUDGMENT`、`QQBOT_SHARED_UNDERSTANDING`，经 app.ts 跑**歧义加隔天澄清**。第一天「行，你去忙吧。」时模型拿不准，提示词里是「理解待确认」、没有判断那一行，DSH 读到的也是待确认。隔天澄清在她回之前就撤回，两边都退回待确认。之后**重放**撤回的那条和第一天那条，记录不复活、也不重复记，撤回的话她读不到。他再说一遍澄清，模型判成纠正理解，提示词里同时有「理解已澄清」和判断那一行；记录里是他的原话和固定的那句解释，没有模型的话，DSH 读到已澄清。接着两条：关键词认不出、判断认成纠正，这一轮放修复提示，但不记成纠正；关键词认出、判断说不是，这一轮不放修复提示，但纠正照旧按原话记下。
- `test/soul-plugin.test.ts`「语言与理解（第四批）……」：纠正理解和推掉两类，QQ 和 DSH 给模型的消息逐字相同，放给她的那一行相同。判断成纠正不会把 DSH 那份待确认的记录改掉。
- 原有用例照旧通过：第一批的对照表（数字没变）、明确求哄的原有用例、`review-exit-module`、`prompt`、`self-memory`、`understanding`、`shared-understanding`、「主人私聊的歧义原话与隔天澄清」、「两天联动」（撤回与重放）。
- `npm test -w @qqbot/bot`、`npm run test:scripts`（232 通过）、`npm test -w koishi-plugin-qqbot`（115）、`npm run typecheck`、`npm run baseline:fast -w @qqbot/bot`（39/39）都通过。

**未结项**：

- 意图阶梯（`intent.ts`）的约 40 条正则没有接判断。判断在 `decideAt.deliberate` 才取回，比 `decideAt.intent` 晚。要让「推掉 / 拒绝」「收尾」「要她陪」这些也由判断来认，得把判断提前到 intent 之前等。判断本来和召回并行，但提前以后，最慢的那一轮会多等，最多 2.5 秒。要不要这样做，需要先定。
- 「累了又求哄就别催睡」那一条，判断他前一句累没累仍然靠正则。第一批就留下了这一项，这一批也没动，因为判断只读他最后那几句的意思。
- 说话毛病的判据和门槛（`REPEAT_AT`、`RECENT_REPLIES`、口头禅表 `TICS`、开头的 `MARKER` 等），以及小黄脸频率、句尾问号，还写在代码里。这一批只做了每一类开或关，细调留给「观察、隐私与质量（K）」。
- 「【QQ 私聊这一轮】对方已经翻篇……」那段是人设文字，应该和 `voice.qq_private` 一起进 `persona.yml`。`careAvoid` 也还不会自动跟着 `qq_private` 变。
- `isApologyText`、`isExplanationText` 留给 D。

**要用户决定才能开 / 改**：

- `QQBOT_SEMANTIC_JUDGMENT` 多了两类判断，也多了一处用途（当场纠正时那一轮的提示）。这会改变她怎么理解他，按规矩应先 `ask-her`，再由用户同意。本批按授权没问。开关仍然默认关。
- 缺口一只改了提示词。上线前要用真模型，在第一批补验那套合成说法上复跑一次，另外加上推掉、纠正这两类的说法。这要调真模型，需要用户同意。
- 要不要写 `QQBOT_STYLE_RULES` 覆盖文件、调到哪一档。改了要重启 Koishi，属于「改线上开关 / 重启」，需要用户点头。线上这一批没有重启、没有重载。
- 意图阶梯要不要等判断（见上，涉及每轮延迟）。

## 全部模块清单

| 模块 | 要改的内容 | 保留的边界与验收 |
| --- | --- | --- |
| 人设、角色卡、DSH preset（第二批已做，见上） | 把散在源码、QQ 专用表达层、DSH preset 前缀和角色卡渲染物里的性格、称呼、表达偏好归到角色资料的一处来源。两端从同一版本渲染。 | 保留按档位披露、诚实说明能力和规则优先级。合成角色验证 QQ 私聊、群聊和 DSH 各只注入自己有权读的内容。入口见 `persona-to-card.ts`、`contact.ts`、`build-presets.mjs`。 |
| 语言与理解（C）（第四批做了软风格规则表、判断约定加两类、补验的两处缺口，余项见上） | 分开会话意图、软风格规则、硬出口检查。让她判断求关心、拒绝、转场和理解纠正，把自然接法还给生成。风格严厉程度可配置，逐项核对旧正则是否仍有兼容价值。 | 原话、猜测、确认和修正分开。保留事实证据、撤回屏障、风险输出约束与故障兜底。用歧义加隔天澄清、撤回与重放验证两端。入口见 `prompt.ts`、`review-exit.ts`、`understanding.ts`。 |
| 心境与恢复（D） | 将一般情绪的衰减与灵敏度归为参数；让她依据当轮证据判断道歉或解释是否接住了这件事，并自己选措辞。 | 危机规则和固定兜底留在程序，私聊情绪原因不进群。验证道歉不会瞬间清零、自然恢复、私聊隔离。入口见 `affect.ts`、`feelings.ts`。 |
| 生活、兴趣、注意力（F、B） | 作息、兴趣、精力、活动时长归为生活资料；把当下选什么和是否延后交给她在可行选项内判断。 | 程序管时间冲突、进度共享、恢复和幂等。验证忙时延后、查错中断、等待续读、重启后接续。入口见 `life/actions.ts`、`world/life-selector.ts`。 |
| 世界与事实 | 地域日历、日常活动素材和个人偏好归到资料；让她选关注与讲述的真实事件。 | 保留事实源、合法行动、结算和可重放队列。验证不凭一句台词补造行动结果，变更偏好不会改写历史。入口见 `world/festivals.ts`、`world/events.ts`。 |
| 主动、留话、承诺与恢复（G） | 主动频率、冷却、业务期限可配置；话题意愿、承不承诺和如何表述交给她。区分程序状态通知和角色口气。 | 保留明确证据、改口单次结算、出站去重、未决投递与回执、取消后下一件能继续。验证丢回执、跨端、重启及到期。入口见 `proactive.ts`、`outbox.ts`、`promises.ts`、`work-handoff.ts`。 |
| 群聊与关系（H） | 群分寸、公开禁区和普通会话的频率设置归一处；交给她判断该不该接、玩笑接没接住。 | 私聊亲密和矛盾不得泄到群里；保留引用归属、已证实的公开关系和对外发送硬上限。验证熟人与陌生人、转场和跨会话。入口见 `group-boundaries.ts`、`group-self.ts`、`group-chat.ts`。 |
| 记忆、遗忘和技能（I、J）（第三批做了阈值表和相关性判断，余项见上） | 统一 QQ 和 DSH 的衰减、保留期、文本预算与超时配置，先对照已提交版本和另一台未提交调参。由她判断相关性、是否引用、哪些有证据的经验值得保留。 | 保留账号隔离、撤回传播、派生摘要失效、来源与旧记录兼容。验证超时仍能聊，换账号读不到，重启后旧摘要不复活，经验只改变对应场景。入口见 `fading.ts`、`cross-recent.ts`、`notebook-learning.ts`。 |
| 视觉、语音、唱歌 | 预算、声音、片段长度可配。由她判断是否需要看、听或调用工具，以及结果怎么说。 | 文件大小硬上限、能力限制、照片审核和出站留在程序。验证超出上限、模型超时或未获审核无越权输出。入口见 `vision/media.ts`、`ai-photo-quality.ts`、`voice-out.ts`、`voice/sing.ts`。 |
| B 站与其他公开平台 | 兴趣主题、可用语言、轮询和普通频率可配；由她选择候选素材与草稿内容。 | 账号授权、平台协议、公开发布审批和审计由程序控制。验证合成草稿不触发实际发布。入口见 `bilibili-feed.ts`、`bilibili-comment.ts`、`bilibili-replies.ts`、`external-drafts.ts`。 |
| Koishi、设备与常驻 | 部署路径、profile、端口、可调资源预算归配置；由她拆分获准任务并选择可用工具。遵循现有指令收敛。 | 主人校验、转发文本无指令权限、设备审批、任务 ID、回执检查留在程序。验证断线、丢回执、重复派发和未经授权零调用。入口见 `instruction-source.ts`、`device-actions.ts`、`her-resident.mjs`。 |
| DSH 桌面、QQ 桥接与手机 | 统一跨端可调的补回预算，地址、面板展示窗口放配置。桌面和手机本地默认值与共享协议分开。 | 配对、防重放、消息和媒体上限、账号及会话游标、取消后零出站留在程序。验证多页断线补回、切号和重复帧。入口见 `dsh-qqbot-services/chat.js`、`memory/backfill.ts`、`chat-bridge`、`mobile-companion`。 |
| 观察、隐私与质量（K） | 把软风格检查和事实、能力越界从配置与报告里分清。口气建议可调，具体表达由她选。 | 保留审计字段白名单、隐私过滤、拦截原因、确认回执。检查日志与导出没有合成私聊标记和账号，出口不通过时零真实出站。入口见 `decision-audit.ts`、`exit-check.ts`。 |
| 运维、备份与恢复 | 服务地址、备份时点、告警接收位置和重启预算归配置。 | 保留启动锁、哈希校验、隔离恢复、符号链接和路径边界、禁止覆写。用临时数据和隔离进程验，不读写生产状态。入口见 `services-watchdog.mjs`、`backup-integrity.mjs`、`restore-drill-state.mjs`。 |

首批从私聊语义判断做起，随后做跨端人设来源和记忆阈值。其余按依赖单独验收与提交。每批记录已改行为、模型判断回退、验收证据、上线待确认项；有意改变行为的快照按仓库规则单独处理。最终以合成数据复跑 QQ、DSH 与常驻的两天联动。
