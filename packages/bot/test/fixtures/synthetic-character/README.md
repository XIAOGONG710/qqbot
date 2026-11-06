# 合成测试角色

这里的资料**全部是编的**：角色名「测试角色」，人名、地名、学校、课名、教室、猫名、书名、作者、活动文案、世界书正文都是虚构的，与真实角色 `characters/linmengyao` 无关。
测试需要角色卡时用这一份，不读 `characters/` 下的真实资料（真实资料含隐私，见根目录 `CLAUDE.md`）。

- `source/`：手写的资料，结构与 `characters/<角色>/source/` 相同（8 个文件），按 `packages/character-tools/src/source.ts`、`world-source.ts` 的 schema 写成。
- `st/`：由转换器生成，**不要手改**。7 个档位各一张卡和一本场景世界书，另有 6 张承认版（`-open`，名单外那一档没有），共 26 个文件，文件名前缀 `synthetic`。
- 测试里取路径用 `packages/bot/test/fixtures/card.ts`：`syntheticCardPath(tier, open?)`、`syntheticLorebookPath(tier, open?)`、`syntheticCardPattern`（含 `{tier}`，给 `loadTierCard` 和配置的 `characterCard` 用）、`syntheticStDir`、`syntheticSourceDir`、`SYNTHETIC_CHAR_NAME`、`TIERS`。

## 重新生成

改了 `source/` 之后在仓库根运行：

```
npm run convert:synthetic -w @qqbot/character-tools
```

它走的是生产用的同一个转换器（`buildCharacter` + 档位隐私检查 `checkPrivacy`），检查不过就不写。不带参数的 `npm run convert` 仍然只处理真实角色，行为不变。

注意：卡的 `creator_notes` 是转换器写死的说明文字，里面提到真实角色的目录名，只是一句说明，不是资料。

## 覆盖到的特性

- **档位**：boyfriend / bestie / girl_friend / known / classmate / stranger / unlisted。用到了 knows_him、social 与 social_text、discreet、drop_scenes、demeanor、examples、pace，以及 proactive（含全部时机和全部 news_kinds）。名单外那一档去掉两个"否认是 AI"的场景。
- **禁用词**：越往下的档位禁得越多。合成的禁用词有前任名、男朋友名、"男朋友"、宿舍楼名、城市名、相机型号词、课名、学校名、猫名。这些词都只出现在看得到它的档位里，隐私检查能通过。
- **人设**：
  - 13 段都有，其中 `money.phone`、`dates.her_birthday`、`dates.anniversary`、`dates.first_trip`、`dates.his_birthday` 带字段标签。
  - 有带 keys、说到才想起的性格（traits）和段落字段。
  - 有 variants 按档位改写的写法。
  - identity_note 里写了给 unlisted 的承认说法，承认版会用到。
  - 重要的日子覆盖公历、农历和 midnight；「你的生日」只给前四档（同学档以下没有日子）；纪念日和「第一次一起出去玩的日子」都在 05-20，和公共节日「520」同一天（测并成一条）。
  - `speech.faces`：男朋友等档按 `SENDABLE_FACES` 的顺序列全小黄脸，known 及以下只列 [捂脸][doge][OK]；`relation.games` 写了「我的世界」「王者」（对应 `INVITE_ACTIVITIES`）。
- **场景**：4 个场景档 close / bestie / acquaint / stranger；`probe-are-you-ai`、`probe-prove-real` 在每个场景档里都有。
- **作息**：见下表。另外覆盖了：
  - 课名、教室只给前四档（course_detail）；
  - 空闲活动的 tiers + cover、from / until、home；
  - 地点按档位写（where.by_tier），他在哪（partner）只给男朋友档。
- **心情**：用到了 early / busy / no_class / holiday 四种日子条件，有按档位改写的说法；心情只给前五档，陌生人和名单外的卡上没有心情。
- **书**：
  - 在读的一本有总量、进度、空闲活动和节点，其中一个节点只给前两档；
  - 弃坑的一本（put_down）；
  - 已读书库一本。
  - 书只给前五档（陌生人和名单外的卡上没有书）；书名不带书名号，用到书名的地方由代码加《》。
- **她的过去**：年表按档位可见；chunks 覆盖了 gap 的三种（unsaid / vague / refuse）和按档位改写。
- **世界**：
  - 天气 12 个月；
  - 猫；
  - 快递：after_meal_from，物品都有价钱；
  - 相机基金：含购买；
  - 作业：grouped_from；
  - 家里视频（只给前四档）；
  - 两个 NPC：生病、忙、回家，并且按档位决定叫名字还是叫称呼；`role` 一个 nearby（室友 `roommate`）、一个 faraway（高中闺蜜 `friend`），代码按 role 认人（见下文）；
  - 四个事件：带人、星期、skip_when / only_when、花钱；其中和室友吃的午饭带 `attach: meal`、`asks_instead: true`（附在午饭上；开了约就只通过约发生）；
  - 真实天气的地点 `weather.places`：学校 `school-town`（雾岚市）、家 `home-town`（溪口镇），坐标是虚构的，只给前四档；
  - 身体：生理期、小感冒；
  - 日常三餐、洗澡；
  - 打算：上午、下午各有出门活动（含 cover，也是出门的）；学习打算里有期末才有的「熬夜赶作业」；
  - 钱：副业、存钱，余额只给前两档。生活费 2000、存钱上限 600、相机基金起始 800：10 月余额不贴着「跟家里要」的底线，每周存多少随手上的钱浮动，10-08 晚上基金 2900、还差 100。
- **主动消息**：男朋友档 daily_max 4、unanswered_max 1，share 排在时机列表最后。
- **禁用词**：名单外那一档另禁「不承认」。

## 猫名、城市名

源码里的文案和正则不写真实的猫名、城市名（ADR 0335），读卡时从 `world.cat.name`、`weather.places` 记下（`src/character-terms.ts`）。单元测试没读卡时，要测认出猫名 / 城市名的先调 `test/fixtures/card.ts` 的 `useSyntheticTerms()`（团子饼、雾岚市、溪口镇）。

## NPC 的 id 和代码的关系

bot 源码不按 id 认人（ADR 0334）：日常小事、约（`DEFAULT_ASKS`）按 NPC 的 `role`，饭后叙事按事件的 `attach` / `asks_instead`，小测按课程的 `quiz`，真实天气按 `weather.places`。所以合成 NPC 的 id 是随便起的虚构名字。

id 会进哈希（NPC 哪天生病、约在哪天、结果如何都按 id 取），改 id 会让测试里钉的日期整体挪动。现在的 `roommate` / `friend` 是挑过的：这一学期里约的各种结果（迟到、改约、取消、推掉，以及拉长学期后「改约之后才推掉」）都至少出现一次，`world-asks.test.ts` 才找得到要测的那一条。

## 真实测试依赖的结构 → 合成资料里的对应位置

迁移测试时，把断言里的真实文案换成合成文案。日期、时刻、状态种类保持不变。下表只列结构和合成值。

| 测试依赖的结构 | 合成资料里的位置 | 合成值 |
| --- | --- | --- |
| 学期第一天（周一） | `schedule.yml` semester.start | 2026-08-31，18 周（8-30 在学期外，2027-01-04 在学期外） |
| 国庆假期 | `schedule.yml` holidays「国庆节」 | 10-01–10-07，留在学校（不是 home） |
| 国庆期间她在哪（按档位） | holidays「国庆节」.where | 前三档：「没回家，留在七号楼」；known：「留在雾岚市的学校里」；后三档：「留在学校」（代码会在前面拼「国庆节放假，」） |
| 国庆期间他在哪（只给男朋友档） | holidays「国庆节」.partner | 「{{user}}回老家过国庆了」 |
| 放完假他回来了（7 天内单独一行） | holidays「国庆节」.partner_back | 「{{user}}国庆放完回学校了，已经在学校里了」 |
| 平时他在哪（只给男朋友档） | `schedule.yml` partner | 「{{user}}在另一个校区上课」 |
| 中秋假期 | holidays「中秋节」 | 9-25–9-27 |
| 回家过的假期 | holidays「寒假」（home）、`world.yml` away_holidays | 2027-01-16–2027-02-28 |
| 调休补课，补哪天没定 | makeups | 2026-10-10，as_day 0（按没课） |
| 调休补课，补周四 | makeups | 2026-09-20，as_day 4 |
| 几点睡 | sleep | 02:00（00:00–02:00 仍算前一天晚上） |
| 有早课的日子几点起 | wakeup.early | 07:40 |
| 没早课、放假几点起 | wakeup.lazy | 09:30 |
| 起床时刻浮动 | wakeup.jitter | from 2026-10-26，±40 分钟，周末再晚 60 分钟 |
| 节次 | periods | 1：08:20–09:40，2：09:55–11:15，3：13:30–14:50，4：15:15–16:35，5：18:30–19:50 |
| 周一早课（机房课） | courses「操作系统实验」 | 周一第 1 节，machine，启明楼511 |
| 周一上午第二节（硬课，第 9 周起转实训） | courses「计算机网络」 | 周一第 2 节，hard，启明楼204；practice 9 → 启明楼机房3 |
| 周一下午 15:15 的硬课 | courses「高等数学」 | 周一、周三第 4 节，hard，启明楼210，同一 course_group |
| 周二没有早课 | — | 周二只有第 3 节「形势与政策」（water，周次 2-8,10-12） |
| 周三早课（体育） | courses「大学体育」 | 周三第 1 节，pe |
| 周四上午的课（调休改补周四时有课名） | courses「数据结构」 | 周四第 2 节，hard |
| 周五下午机房课 | courses「数据库原理」 | 周五第 3 节，machine，周次 1-12 |
| 周六、周日没课 | — | 没有排课 |
| 会出小测的课 | courses 的 `quiz`（math / core） | 数学类「高等数学」；专业课「计算机网络」「数据结构」「数据库原理」「操作系统实验」。分数按「日期 + 课名」定，这几个名字让学期里有不及格的一次 |
| 匿名课程组 | courses.course_group | cg-000…0001 到 cg-000…0004 |
| 课名、教室给哪些档 | course_detail.tiers | boyfriend / bestie / girl_friend / known |
| 上学期间她在哪（按档位） | where.by_tier | 前三档：「在学校（雾岚市），住七号楼宿舍」；known：「在学校（雾岚市），住宿舍」；classmate：「在学校，住宿舍」；stranger / unlisted：「在学校」 |
| 从某天起才有的活动（买了相机之后） | free 里带 from 的条目 | 下午「带新胶片机去操场转转」from 10-12；晚上「琢磨新胶片机的参数」from 10-11；下午「带新胶片机去操场转转」10-12 到 10-25；晚上「冲洗新拍的胶卷」10-12 到 10-31；下午「去社团活动室」from 10-21；晚上「熬夜赶作业」from 12-21（期末；也在学习打算里）。带胶片机的几条只给前四档，其他档用 cover |
| 看不到的活动换成什么（cover） | free.cover | 「去湖边散步」「去操场转转」「整理桌面」；没写 cover 时用转换器的默认说法 |
| 在家的活动 | free.home | 早上「在家睡懒觉」，晚上「陪妈妈看电视」 |
| 买相机那天 | `world.yml` camera_fund.purchase | 2026-10-11 14:00 出门，120 分钟，「城南的二手相机店」，「一台胶片机」 |
| 世界从哪天开始推 | `world.yml` start_day | 2026-08-31 |
| 楼下的猫 | `world.yml` cat | 「团子饼」，20:00–21:30 喂，后三档里 stranger / unlisted 看不到 |
| 和家里视频 | family_call | 周日 20:30，只给前四档 |
| 室友（NPC） | people「roommate」，role nearby | 只给前四档；名字「许小禾」只给前三档，known 叫「室友」。9-26 起感冒 3 天 |
| 高中闺蜜（NPC） | people「friend」，role faraway | 名字「林小满」只给前两档，girl_friend / known 叫「高中的闺蜜」；有「忙」的日子（打电话吐槽只在她忙时） |
| 角色名 | `persona.yml` name | 测试角色 |
| 男朋友档的称呼 | tiers.yml boyfriend.user_is、persona relation | 「阿测」（女生朋友档及以下的禁用词） |
