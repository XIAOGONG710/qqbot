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

## st/：SillyTavern 格式（运行时的输入）

由 `packages/character-tools` 从 `legacy/` 和 `tiers.toml` 转换生成（`npm run convert -w @qqbot/character-tools`），
按 [ADR 0003](../../docs/adr/0003-contact-tiers.md) 每个档位一张卡、一本场景世界书：

| 文件 | 内容 |
| --- | --- |
| `linmengyao-<档位>.json` | 角色卡 V2。`description` 是这一档能看到的 persona 各章节；`personality` 是自我定位 + 性格；`scenario` 是“正在私聊的是谁”+ 对这一档的说话方式；`system_prompt` / `post_history_instructions` 是 QQ 私聊的框架和说话方式；男朋友档还有示例对话（`mes_example`）。`tags` 是档位名，`extensions.world` 关联同档位的世界书 |
| `linmengyao-scenes-<档位>.json` | 世界书：`speech_library.toml` 中这一档的场景，触发词即关键词，命中才注入。`girl_friend` 借用 `bestie` 的场景，`unlisted` 用 `stranger` 的场景去掉否认是 AI 的两条 |

档位：`boyfriend` 男朋友、`bestie` 死党闺蜜、`girl_friend` 女生熟人、`known` 熟人、`classmate` 同学、`stranger` 陌生人、`unlisted` 名单外好友。

- `tiers.toml`（入库，不在 `legacy/` 里）：每个字段给哪些档位、对部分档位的改写、各档的说话方式与禁用词。
  私密信息靠“不写进去”保护；低档位也不写“别提你有男朋友”，改成中性的一句“感情上的事不跟外人聊”。
  每档的禁用词由测试检查，也留给 M4 的出口检查用。
- 场景按档位各出一本世界书：ST 的世界书不能按“聊天对象是谁”过滤，混在一本里会把对陌生人的话注入到对他的回复里。
- 没转的内容由转换脚本运行时列出：旧引擎参数（`[engine]` `[reply]` `[corpus]` `[vision]` 和 `[persona.social.warmth]`），
  `[persona.daily_moods]`（M3）、`[persona.him]`、群聊的 `social.group`，以及被中性说法代替的 `social.secret`。
- 转换时对原文的改动都写在 `tiers.toml` 的 `[[rewrite]]` 里（例如 `[persona.traits]` 原文的“你”指他，男朋友档改成“他”、其他档改成“人”）；
  `[persona.dates]` 和 `money.phone` 的含义在键名里，输出时加了标签。`post_history_instructions` 里的输出规则和男朋友档的分寸、示例对话是新加的，原资料里没有。
- `st/` 里的文件可以在 SillyTavern 里继续改、再导出覆盖回来。转换脚本发现目标文件内容不同时默认不覆盖，要重新生成须加 `--force`。

在 SillyTavern 里试聊某一档：先导入这一档的世界书（World Info → Import），再导入这一档的角色卡（角色列表 → Import），角色会按名字自动关联世界书。
用 Chat Completion 接口、默认预设即可（`Prefer Char. Prompt` 保持开启，角色卡里的 `system_prompt` 才会生效）；把自己的 Persona 名字改成你的称呼。

## 隐私

本目录仍含真实信息，**所在仓库必须保持私有**：

- 学校全名、所在城市、学院与专业（`persona.toml`、`timetable.toml`）
- 真实课表骨架：教室楼名、13 位任课老师真名（`timetable.toml`）
- 纪念日与生日（`persona.toml`）
- `speech_library.toml` 中部分例句来自线上真实对话（来源标注为“线上原话”）

旧项目已把他的真名、朋友对他的称呼替换为 `<BOYFRIEND_REAL_NAME>`、`<HIS_NICKNAME_1..3>` 占位符；转换时需要真实值再单独补，不要写回 `legacy/`。
