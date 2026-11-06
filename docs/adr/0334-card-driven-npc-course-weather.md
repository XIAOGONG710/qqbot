# ADR 0334：NPC、小测、饭后叙事、真实天气改由卡上的字段决定，不在源码里写死

状态：接受，2026-11-06。

## 问题与证据

ADR 0333 让测试只用合成角色，但 bot 源码里还按真实角色写死了几处逻辑，合成 NPC 只好沿用真实 NPC 的 id：

- `src/life/everyday.ts` 的日常小事按 NPC id `su_yutong`、`chen_jianing` 认人；`src/world/npc-asks.ts` 的 `DEFAULT_ASKS` 也按这两个 id 给约的配置。
- `src/world/world.ts` 按事件 id `lunch_with_friend` 判断「开了约就不再随机吃这顿」，`world.ts` 和 `life-selector.ts` 按 `lunch_with_friend` / `spicy_noodles` / `notes_for_friend` 判断哪些 NPC 事件附在饭或课上。
- `everyday.ts` 用两条课名正则（按真实课表写的）决定哪些课出小测、算数学类还是专业课。
- `src/world/weather.ts` 写死了她学校和家所在城市的名字、坐标和缓存键。

这些既是隐私痕迹（真实 NPC 名字的拼音、真实城市、真实课表），也是耦合：换角色、改 NPC、改课表，这些功能会悄悄失效，而且不报错。

## 决定

源码不认具体的人、事件、课和城市，只读卡上的字段。转换器（`packages/character-tools`）校验并输出这些字段，bot 的读卡校验同步检查：

| 字段（`source/*.yml`） | 卡上 | 用在哪 |
| --- | --- | --- |
| `world.yml` people[].`role`：`nearby`（同校、能一起吃饭自习）/ `faraway`（外地、只在微信上来往），每种最多一个人 | `people[].role` | 日常小事按 role 挑人；`DEFAULT_ASKS` 改为按 role 给配置（`asksByPerson` 把它映射到人的 id） |
| `world.yml` events[].`attach`：`meal` / `class`（要有 person） | `events[].attach`，世界快照的事件也带上 | 和朋友一起吃的那顿 / 上课时帮忙的事附在那个行动上；其余 NPC 事件单独占一小段 |
| `world.yml` events[].`asks_instead: true`（要 `attach: meal`） | `events[].asksInstead` | 开了约（ADR 0061）就只通过约发生 |
| `schedule.yml` courses[].`quiz`：`math` / `core` | `courses[].quiz`，只在看得到课名的档位上有 | 小测的一条线（ADR 0106）；课程对象上不可枚举，不进快照 |
| `world.yml` weather.`places`：`tiers` + `school` / `home`（id、name、经纬度；id 是缓存文件名） | `weather.places`，只在 places.tiers 的档位上有 | 真实天气（ADR 0048）取哪里；卡上没写就不取，按日期生成 |

- **行为不变**：真实资料补上这些字段时取的就是源码原来写死的值——两个 NPC 的 role、三个事件的 attach（午饭那条另加 asks_instead）、14 门课里 8 门的 quiz（原正则命中的那几门）、两个地点的 id / 名字 / 坐标（id 仍是 `jinan` / `qingdao`，数据目录里的缓存文件照旧能读）。NPC 和事件的 id 不变，所以按 id 取的哈希（谁哪天生病、约在哪天、结果如何）不变。
- **places 只给前四档**：和 ADR 0007 之后「城市只给 BFGK」一致。真实天气用名单里最亲、卡上有世界的那一档（`app.ts` 的 `worldCard`）；如果在用的档位只有同学及以下，真实天气不开（日志写明「卡上没写 weather.places」）。
- **日常小事的 id 不改**：`ed_jn_*`、`ed_yt_*` 里的缩写来自真实 NPC 的名字，但 id 进哈希、也进事件账，改名会改写已经过完的日子，不值得。
- **合成角色**：两个 NPC 改用虚构的 id `roommate`（nearby）、`friend`（faraway），补上同样的字段，地点是虚构的 `school-town` / `home-town`。id 进哈希，所以测试里钉的日期跟着挪了：`npc.test.ts` 室友感冒改为 9-26 起，`occupation.test.ts` 10-18 那天的回顾换成那天实际发生的事，`world-npc-review.test.ts` 两人约撞在同一天的日子改为 2028-04-17；`world-asks.test.ts`「改约后照样去」的那一条原来限定图书馆（只是因为当时样本里只有它），改为「不跟着饭点走的那一种」。这对 id 是挑过的：学期里约的各种结果都至少出现一次，见合成资料的 `README.md`。测试里手搭的世界、课表、天气缓存同步补上 role / attach / quiz / places。

## 验证（11-06）

- 转换器：真实卡与改动前相比，去掉新增字段后逐张深比较完全一致（16 张有变化，0 张有别的差异）；同学档及以下的卡上没有 places、quiz、role。`npm run test:real` 43 项通过（一处课程断言补上 `quiz: 'core'`）。
- 行为指纹：真实卡 7 个档位 × 约开/关 × 2026-09-01 到 2027-01-31 每天 6 个时刻，`worldAt` / `describeWorld` / `recapDay` / `dayBusy` / `chooseAt` 的输出（去掉新增的 attach）在改动前后的哈希一致（各档位与总哈希逐一相同；没接真实天气，地点那部分由 id 不变和 `weather.test.ts` 保证）。
- 全仓 `npm test`：bot 3442 项通过 3435 项，失败的 6 项仍是 Claude 应用沙箱里的 `EPERM`（ADR 0333）；character-tools 18、koishi 插件 51、移动服务 40、PWA 4 全过。全仓类型检查、`git diff --check` 通过。

## 后果

- 换角色时，这些功能靠卡上的字段打开；卡上没写就安静地不做（没有 role 的人不出日常小事和约，没有 quiz 的课不出小测，没有 places 不取真实天气），不会认错人。
- 源码里仍有真实资料的痕迹，留给下一步（ADR 0333 后果一节；11-06 由 ADR 0335 处理）：注释和文案里的真实 NPC 全名、真实猫名、城市名；`LifeEvent.actor` 的字面量；`sim/*.json` 场景里的真实日期描述（它们跑真实卡，不受这次改动影响）。
