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

## 全部模块清单

| 模块 | 要改的内容 | 保留的边界与验收 |
| --- | --- | --- |
| 人设、角色卡、DSH preset（第二批已做，见上） | 把散在源码、QQ 专用表达层、DSH preset 前缀和角色卡渲染物里的性格、称呼、表达偏好归到角色资料的一处来源。两端从同一版本渲染。 | 保留按档位披露、诚实说明能力和规则优先级。合成角色验证 QQ 私聊、群聊和 DSH 各只注入自己有权读的内容。入口见 `persona-to-card.ts`、`contact.ts`、`build-presets.mjs`。 |
| 语言与理解（C） | 分开会话意图、软风格规则、硬出口检查。让她判断求关心、拒绝、转场和理解纠正，把自然接法还给生成。风格严厉程度可配置，逐项核对旧正则是否仍有兼容价值。 | 原话、猜测、确认和修正分开。保留事实证据、撤回屏障、风险输出约束与故障兜底。用歧义加隔天澄清、撤回与重放验证两端。入口见 `prompt.ts`、`review-exit.ts`、`understanding.ts`。 |
| 心境与恢复（D） | 将一般情绪的衰减与灵敏度归为参数；让她依据当轮证据判断道歉或解释是否接住了这件事，并自己选措辞。 | 危机规则和固定兜底留在程序，私聊情绪原因不进群。验证道歉不会瞬间清零、自然恢复、私聊隔离。入口见 `affect.ts`、`feelings.ts`。 |
| 生活、兴趣、注意力（F、B） | 作息、兴趣、精力、活动时长归为生活资料；把当下选什么和是否延后交给她在可行选项内判断。 | 程序管时间冲突、进度共享、恢复和幂等。验证忙时延后、查错中断、等待续读、重启后接续。入口见 `life/actions.ts`、`world/life-selector.ts`。 |
| 世界与事实 | 地域日历、日常活动素材和个人偏好归到资料；让她选关注与讲述的真实事件。 | 保留事实源、合法行动、结算和可重放队列。验证不凭一句台词补造行动结果，变更偏好不会改写历史。入口见 `world/festivals.ts`、`world/events.ts`。 |
| 主动、留话、承诺与恢复（G） | 主动频率、冷却、业务期限可配置；话题意愿、承不承诺和如何表述交给她。区分程序状态通知和角色口气。 | 保留明确证据、改口单次结算、出站去重、未决投递与回执、取消后下一件能继续。验证丢回执、跨端、重启及到期。入口见 `proactive.ts`、`outbox.ts`、`promises.ts`、`work-handoff.ts`。 |
| 群聊与关系（H） | 群分寸、公开禁区和普通会话的频率设置归一处；交给她判断该不该接、玩笑接没接住。 | 私聊亲密和矛盾不得泄到群里；保留引用归属、已证实的公开关系和对外发送硬上限。验证熟人与陌生人、转场和跨会话。入口见 `group-boundaries.ts`、`group-self.ts`、`group-chat.ts`。 |
| 记忆、遗忘和技能（I、J） | 统一 QQ 和 DSH 的衰减、保留期、文本预算与超时配置，先对照已提交版本和另一台未提交调参。由她判断相关性、是否引用、哪些有证据的经验值得保留。 | 保留账号隔离、撤回传播、派生摘要失效、来源与旧记录兼容。验证超时仍能聊，换账号读不到，重启后旧摘要不复活，经验只改变对应场景。入口见 `fading.ts`、`cross-recent.ts`、`notebook-learning.ts`。 |
| 视觉、语音、唱歌 | 预算、声音、片段长度可配。由她判断是否需要看、听或调用工具，以及结果怎么说。 | 文件大小硬上限、能力限制、照片审核和出站留在程序。验证超出上限、模型超时或未获审核无越权输出。入口见 `vision/media.ts`、`ai-photo-quality.ts`、`voice-out.ts`、`voice/sing.ts`。 |
| B 站与其他公开平台 | 兴趣主题、可用语言、轮询和普通频率可配；由她选择候选素材与草稿内容。 | 账号授权、平台协议、公开发布审批和审计由程序控制。验证合成草稿不触发实际发布。入口见 `bilibili-feed.ts`、`bilibili-comment.ts`、`bilibili-replies.ts`、`external-drafts.ts`。 |
| Koishi、设备与常驻 | 部署路径、profile、端口、可调资源预算归配置；由她拆分获准任务并选择可用工具。遵循现有指令收敛。 | 主人校验、转发文本无指令权限、设备审批、任务 ID、回执检查留在程序。验证断线、丢回执、重复派发和未经授权零调用。入口见 `instruction-source.ts`、`device-actions.ts`、`her-resident.mjs`。 |
| DSH 桌面、QQ 桥接与手机 | 统一跨端可调的补回预算，地址、面板展示窗口放配置。桌面和手机本地默认值与共享协议分开。 | 配对、防重放、消息和媒体上限、账号及会话游标、取消后零出站留在程序。验证多页断线补回、切号和重复帧。入口见 `dsh-qqbot-services/chat.js`、`memory/backfill.ts`、`chat-bridge`、`mobile-companion`。 |
| 观察、隐私与质量（K） | 把软风格检查和事实、能力越界从配置与报告里分清。口气建议可调，具体表达由她选。 | 保留审计字段白名单、隐私过滤、拦截原因、确认回执。检查日志与导出没有合成私聊标记和账号，出口不通过时零真实出站。入口见 `decision-audit.ts`、`exit-check.ts`。 |
| 运维、备份与恢复 | 服务地址、备份时点、告警接收位置和重启预算归配置。 | 保留启动锁、哈希校验、隔离恢复、符号链接和路径边界、禁止覆写。用临时数据和隔离进程验，不读写生产状态。入口见 `services-watchdog.mjs`、`backup-integrity.mjs`、`restore-drill-state.mjs`。 |

首批从私聊语义判断做起，随后做跨端人设来源和记忆阈值。其余按依赖单独验收与提交。每批记录已改行为、模型判断回退、验收证据、上线待确认项；有意改变行为的快照按仓库规则单独处理。最终以合成数据复跑 QQ、DSH 与常驻的两天联动。
