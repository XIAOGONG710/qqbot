# 林梦瑶（角色资料）

## 来源

从旧项目 `astrbot-linmengyao-main` 原样导入（2026-10-03）。旧项目是给一个自建 Python 引擎（`life_engine`，直连 NapCat）写的“目标仓库”，
代码、数据库、语料都不在压缩包里。

- 原始压缩包：`C:\Users\XG\Downloads\astrbot-linmengyao-main.zip`
- SHA-256：`7e584c5af75f000012165fbb9b6df2e841ba065cf076d9840e7a46ae492b00ff`

**`legacy/` 下的文件与原件逐字节相同，不要原地修改。** 转换成 SillyTavern 格式（角色卡 / 世界书）时，产物另放，`legacy/` 作为对照保留。

## legacy/ 里有什么

| 文件 | 内容 |
| --- | --- |
| `persona.toml` | 人设主体：身份、关系、家庭、宿舍、专业、朋友、钱、心事、口癖、雷区、日常物件、纪念日、今日状态、社交分层与例句 |
| `speech_library.toml` | 场景话术库：118 个场景，按对象档位（陌生人 / 同学 / 熟人 / 闺蜜 / 男朋友 / 群）给出例句，每条标注来源 |
| `books.toml` | 她在读的书：3 本（主 / 副 / 旧）带情节节点与来源，另有 8 本已读作品资料 |
| `interests.toml` | 兴趣种子、口味、信息来源偏好 |
| `schedule.toml` | 一天的作息分段与各时段行为倾向 |
| `timetable.toml` | 一学期 18 周课表（2026-08-31 起）、节次时间、课型档位 |
| `followed_ups.toml` | 她“关注”的 B 站 UP 主（2 个，公众人物） |

### 使用时要注意

- `persona.toml` 里混有旧引擎的运行参数：`[engine]`、`[reply]`、`[corpus]`、`[vision]`，以及 `[persona.social.warmth]` 的数值档位。
  这些是旧引擎的实现选择，**不是角色设定**，转换时不必照搬。
- 注释里提到的 `life_engine/*.py`、`tools/*.py`、`data/life.db`、`evidence/` 都在旧机器的私有工作区里，本仓库没有。
- 注释里“用户裁决”“用户原话”是旧项目当时的决定，适不适用要重新判断。

## 没有导入的

| 文件 | 原因 |
| --- | --- |
| `budget.toml` | 旧引擎的模型、预算、OneBot 端口配置，不是角色资料 |
| `README.md`、`设计稿-自主生活引擎.md`、`交付证明-LifeEngine-P0.md`、`看图能力.md`、`温度按人覆盖.md`、`PUSH-说明.md` | 旧项目的设计观点与交付记录，已过时，不作为本项目依据 |

需要查原文时去看原始压缩包。

## source/：可编辑的资料（ADR 0010）

角色资料的来源。2026-10-05 由一次性脚本从 `legacy/` 和原来的 `tiers.toml` 迁移而来（提交 `a80b240`；迁移前后生成的 `st/` 逐字节相同），
之后 `legacy/` 只作原件对照，`tiers.toml` 已删除（git 历史里还在）。平时在 Koishi 控制台的「林梦瑶」页面里改；直接改 YAML 也行，改完跑
`node packages/character-tools/src/cli.ts` 重新生成 `st/`。文件会被程序改写，**YAML 里的注释不会保留**，说明写在各项的 `note` 里。

| 文件 | 内容 |
| --- | --- |
| `persona.yml` | 人设：身份、性格、说话方式、不接的话题；`traits` 和 13 段（`sections`）里的每个字段写明给哪些档位（`tiers`），某几档用的改写版本写在 `variants`（按顺序取第一条含这一档的）；`social` 是对各档的说话方式 |
| `scenes.yml` | 118 个场景（世界书）：触发词、例句、不要说的话、属于哪个场景档（`tiers`），出处 `source` 不进卡 |
| `schedule.yml` | 作息（ADR 0007）：几点睡、起床、节次、学期、假期、调休、课、空闲活动；课名教室给哪些档（`course_detail`）、每档「她在哪」（`where`）、「他在哪」给哪些档（`partner`） |
| `tiers.yml` | 档位，顺序就是输出顺序：`user_is`（scenario 第一句，正在聊天的是谁）、`knows_him`（description 开头说明「他」是男朋友）、`social` / `social_text`（说话方式：指向人设 `social` 的键，或直接写）、`discreet`（scenario 末尾加文件顶部那句）、`scenes` / `drop_scenes`（世界书用哪个场景档、去掉哪些场景）、`demeanor`（放进 post_history_instructions 的分寸）、`examples`（示例对话，[对方, 她的第一行, 她的后续几行…]）、`banned`（这一档的卡里不能出现的词，也是出口检查的词表）、`pace`（回复节奏系数：冷场时多久看到、打字多久都乘它，ADR 0013；没写是 1）、`proactive`（主动找这一档的人：哪几种时机、每天最多几条、连着几条没回就停，ADR 0011；没写就不主动，名单外不能写） |

- 原则（原 `tiers.toml` 开头）：私密信息靠「不写进去」保护。低档位的卡里只放这一档允许知道的事，也不放「别说你有男朋友」这种提醒——提醒本身就暴露了事实。
- 档位一律写名字：`boyfriend` 男朋友、`bestie` 死党闺蜜、`girl_friend` 女生熟人、`known` 熟人、`classmate` 同学、`stranger` 陌生人、`unlisted` 名单外好友（除注明的以外与 `stranger` 相同）。
- 改写：原来是对 `legacy/` 原文逐字打补丁（原文一改就报错），迁移时套用了一遍，存成各档的最终文字；改通用文字时，各档的改写版本不会跟着变，要分别看。
- 作息：转换器按档位裁剪，写进卡的 `extensions.qqbot.schedule`；运行时按它算「她现在在干什么」放进时间块，也按它决定什么时候看到消息。
- 重要的日子（ADR 0011）：`persona.yml` 的 `dates` 每条可以有 `day`（名字、公历 `date`、农历 `lunar`，都是 MM-DD；`midnight` 当天零点就主动祝），
  档位跟着那句文字的 `tiers`，转换器写进卡的 `extensions.qqbot.dates`。运行时提前 7 天起在时间块里提醒，当天主动提；公历、农历都写时，农历那天只在时间块里提一句。
- 回复节奏（ADR 0013）：`tiers.yml` 档位上的 `pace`（0.5–3）写进卡的 `extensions.qqbot.pace`；越疏越慢，男朋友 1、同学 1.6、陌生人和名单外 2.2。
- 主动设置（ADR 0011）：`tiers.yml` 档位上的 `proactive` 写进卡的 `extensions.qqbot.proactive`；真发不发由插件配置的「主动消息」开关（关 / 试运行 / 开）决定。
- 没迁移的：转换器没用到的 `legacy/` 内容（书、兴趣、关注的 UP 主、每日心情、`him`、旧引擎参数、作息分段的权重、课的老师 / 简称 / 备注），要用再从 `legacy/` 迁。

## biography/：她的自传（还没接进程序）

2026-10-06 由 DSH 侧和用户访谈写成：`autobiography-v1.md`（作者定稿，正文不改）和 `interview.md`（逐字访谈记录，自传的事实源）。
**不要整篇进提示词**；接进来的方案（切块、有线索才召回）和它与 `source/persona.yml` 的对照见
[docs/research/2026-10-06-dsh/README.md](../../docs/research/2026-10-06-dsh/README.md)「自传和资料的对照」。里面有具体住址和他的名字，进卡之前先过隐私检查。

## st/：SillyTavern 格式（运行时的输入）

由 `packages/character-tools` 从 `source/` 生成，**不要手改**（会被覆盖；有测试要求 `st/` 和 `source/` 生成的一致）。
按 [ADR 0003](../../docs/adr/0003-contact-tiers.md) 每个档位一张卡、一本场景世界书：

| 文件 | 内容 |
| --- | --- |
| `linmengyao-<档位>.json` | 角色卡 V2。`description` 是这一档能看到的 persona 各章节；`personality` 是自我定位 + 性格；`scenario` 是“正在私聊的是谁”+ 对这一档的说话方式；`system_prompt` / `post_history_instructions` 是 QQ 私聊的框架和说话方式；男朋友档还有示例对话（`mes_example`）。`tags` 是档位名，`extensions.world` 关联同档位的世界书 |
| `linmengyao-scenes-<档位>.json` | 世界书：`scenes.yml` 里这一档的场景档的场景，触发词即关键词，命中才注入。`girl_friend` 借用 `bestie` 的场景，`unlisted` 用 `stranger` 的场景去掉否认是 AI 的两条 |

- 低档位也不写「别提你有男朋友」，改成中性的一句「感情上的事不跟外人聊」（`tiers.yml` 的 `discreet`）。每档的禁用词由测试检查，也是出口检查的词表。
- 场景按档位各出一本世界书：ST 的世界书不能按「聊天对象是谁」过滤，混在一本里会把对陌生人的话注入到对他的回复里。
- `dates` 段和 `money.phone` 的含义在键名里，输出时加了标签（代码里的 `FIELD_LABELS`）。`post_history_instructions` 里的输出规则和男朋友档的分寸、示例对话是新加的，原资料里没有。
- 想在 SillyTavern 里改着试：改完别导出覆盖 `st/`，把改动搬回 `source/`（或页面）再生成。转换脚本每次都按资料覆盖 `st/`；档位隐私检查（每档进提示词的文字、作息、世界书正文里不能有本档禁用词和脱敏占位符）不过就什么都不写。

在 SillyTavern 里试聊某一档：先导入这一档的世界书（World Info → Import），再导入这一档的角色卡（角色列表 → Import），角色会按名字自动关联世界书。
用 Chat Completion 接口、默认预设即可（`Prefer Char. Prompt` 保持开启，角色卡里的 `system_prompt` 才会生效）；把自己的 Persona 名字改成你的称呼。

## 隐私

本目录仍含真实信息，**所在仓库必须保持私有**：

- 学校全名、所在城市、学院与专业（`legacy/persona.toml`、`legacy/timetable.toml`，以及 `source/` 里对应的字段）
- 真实课表骨架：教室楼名（`legacy/timetable.toml`、`source/schedule.yml`）、13 位任课老师真名（只在 `legacy/timetable.toml`，没迁移进 `source/`）
- 纪念日与生日（`legacy/persona.toml`、`source/persona.yml`）
- 部分例句来自线上真实对话（`legacy/speech_library.toml`、`source/scenes.yml`，来源标注为「线上原话」）

旧项目已把他的真名、朋友对他的称呼替换为 `<BOYFRIEND_REAL_NAME>`、`<HIS_NICKNAME_1..3>` 占位符；转换时需要真实值再单独补，不要写回 `legacy/`。
