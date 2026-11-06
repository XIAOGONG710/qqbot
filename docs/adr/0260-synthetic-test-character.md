# ADR 0260：测试只用合成角色，不读真实角色资料

状态：接受，2026-11-06。

## 问题与证据

- 约 70 个 bot 测试文件、koishi 插件的 `console.test.ts`、character-tools 的两个测试，直接从仓库读取 `characters/linmengyao/` 的真实卡或真实 `source/`。真实资料含个人隐私；测试一失败，断言的 actual/expected、日志和快照就会把原文带进输出（终端、CI 日志、代理上下文）。
- 因此 11-05 起的审查只跑「确认合成」的定向测试集，明确写了不跑全仓 `npm test`（`docs/reviews/optimization-progress.md` 第十一批之后的「验证口径更正」）。代价是全量回归长期没人跑：11-06 全量发现 7 项真回归（`48d36d22` 修复），都是在这段时间里混进来的。
- 结论：只要测试读真实资料，「能放心常跑全量」和「不外泄隐私」就互相冲突。要恢复全量回归，必须先让测试不碰真实资料。

## 决定

1. **合成角色**：`packages/bot/test/fixtures/synthetic-character/source/` 是一份虚构资料（「测试角色」、雾岚市、云杉学院……），schema 与真实 `source/` 相同，覆盖 schema 的每个可选特性。只依据转换器源码的类型与校验编写，没有读真实资料的内容。
   - 作息的日历骨架（学期起点、国庆/中秋、调休、早课/赖床时刻等）对齐测试原本依赖的日期与时刻：法定节假日是公开事实；所有文字内容都是虚构的。
   - 对照表见该目录的 `README.md`。
2. **用同一个转换器生成**：`npm run convert:synthetic -w packages/character-tools`（`cli.ts` 新增可选 `--source/--out/--prefix`，不传参数时与原来逐字节相同）生成 `st/synthetic-*.json`。测试拿到的卡与真卡同构，档位裁剪、禁用词、`-open` 承认版、场景世界书都走真实流程；生成结果入库，改了合成资料要重新生成。
3. **测试辅助**：`packages/bot/test/fixtures/card.ts` 导出合成卡的路径（`syntheticCardPath`、`syntheticCardPattern` 等）。测试要卡就用它。
4. **迁移原则**：断言改成合成资料里对应的值，不弱化——断言数量不减，精确匹配不改模糊，测的仍是同一行为（例如隐私边界改为在合成卡上断言同样的边界）。随替换去掉测试里来自真实卡的事实性原文。
5. **守卫**：`packages/bot/test/no-real-character-data.test.ts` 扫描所有包的测试文件，出现「从仓库根解析出的真实角色目录」就失败。必须读真实资料的只有 `convert.test.ts`：它校验的就是真实资料本身（`st/` 与 `source/` 生成一致、档位隐私检查）。它放在 `packages/character-tools/test-real/`，不进 `npm test`，用 `npm run test:real` 单独跑（11-06 补充，见下文「拆出 test-real」）。在临时目录里自建同名路径、只把路径交给 `parseAppConfig` / `loadConfig` 解析（它们不读文件）的测试不算违规。
6. **源码按真实 NPC 写死的逻辑**（用户 11-06 定）：`src/life/everyday.ts` 的日常小事、`src/world/npc-asks.ts` 的 `DEFAULT_ASKS` 按 NPC id `su_yutong`、`chen_jianing` 认人，`world.ts` / `life-selector.ts` 写死事件 id `lunch_with_friend`，`everyday.ts` 用课名正则（MATH_COURSE / CORE_COURSE）判断哪些课出小测。这次**不改源码**：合成 NPC 沿用这两个 id、补一条 `lunch_with_friend`，合成课表用通用课名（高等数学、数据结构……）命中课名分类；名字和内容都是虚构的。源码去耦另立任务。
7. **测试里的手写数据**也按同样原则处理：`biography.test.ts` 顶部手写的「她的过去」原本是真实经历的翻版，改写成虚构内容，结构（id、keys、gap）不变。

## 验证（11-06）

- 迁移 73 个测试文件（bot 70、koishi 插件 1、character-tools 2）。全仓 `npm test`：bot 3441 项（比迁移前多 2 项守卫）通过 3434 项，失败的 6 项是 Claude 应用沙箱里在系统临时目录建目录的 `EPERM`（`app.test.ts` 的 B 站评论/回复、设备控制 4 项），与卡无关；character-tools 61、koishi 插件 51、移动服务 40、PWA 4 全过。全仓类型检查、`git diff --check` 通过。测试总数没有减少。
- 断言按合成资料改写；子代理迁移时为配合当时的合成资料在测试里做的输入改写（未回复上限、每日条数、本地补的 NPC/事件）在补齐合成资料后都撤回了，`proactive-room.test.ts` 等恢复成原断言。
- 改动的测试文件与真实资料的 12 字以上重合片段（只统计数量）从 316 处降到 32 处，剩下的是通用说法（ADR 标题、口头禅、规则句）。

## 拆出 test-real（11-06 补充）

- 原来 `convert.test.ts` 在 `test/` 里，默认 `npm test` 每次都读真实资料，一失败就可能把原文打进输出，「全量测试不碰真实资料」只差这一处。
- 现在移到 `packages/character-tools/test-real/convert.test.ts`（内容不变）。`npm test` 只跑 `test/`（character-tools 18 项），`npm run test:real`（根目录或包内）跑这 43 项，合计仍是原来的 61 项。
- 守卫不再有例外（只豁免守卫自己的自测样例），并检查各包的 `test` 脚本不包含 `test-real/`。
- 改转换器（`packages/character-tools/src/`）或真实 `source/` 后，提交前要跑 `npm run test:real`。

## 后果

- 全仓 `npm test` 恢复为每次提交都可以跑的回归，不接触真实资料（`convert.test.ts` 拆到 `test:real`）。审查记录里「不跑全仓」的限制随之解除。
- 源码里仍有真实资料的痕迹，留给源码去耦那项任务：上面第 6 条的 id 与课名分类；`world.ts` 一处注释写着真实 NPC 的全名；`proactive.ts`、`weather.ts` 里写死了真实猫名、真实城市（`jinan`）一类的文案和地点键；`LifeEvent.actor` 的字面量 `'linmengyao'`；`packages/bot/sim/*.json` 场景文件里的个别地点。
- `convert.test.ts` 失败时仍可能输出真实原文：所以它不在 `npm test` 里，只在本机、改了转换器或真实资料时跑 `npm run test:real`，排查时只看断言行；以后接 CI 也不要跑它。
- 合成卡的 `creator_notes` 带着转换器写死的一句说明（含真实角色名和控制台页面名，`persona-to-card.ts`），不是资料内容，暂不处理。
- bot 源码里仍有默认指向真实角色目录的地方（`bankPrefix` 默认值、`identity.ts` 的 `IDENTITY_DIRS`、`dormancy.ts` 的封存、几个 CLI 的默认卡），它们是运行时行为，不在本 ADR 范围；测试通过参数或临时目录绕开。
- 以后新增测试需要新的卡特性：先加进合成资料、重新生成，再写测试；不要回头读真实卡。
