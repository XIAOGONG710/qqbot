# ADR 0175：「是框架束缚了她吗」——不带框架的对照臂

- 状态：**工具已做、已冒烟；对照结果等评分**（`sim/bare.ts` 只在模拟器里用，线上没有任何改动）
- 日期：2026-10-29
- 关联：[ADR 0005](0005-scenario-simulation.md)（模拟器）、[ADR 0099](0099-too-smooth.md)（`shapeFeel`）、[ADR 0146](0146-human-videos.md)（实验 A：做题式 / 温度 / 关思考）、`docs/plans/2026-10-29-autonomy-and-realness.md` §2（评估闭环）
- **起因（用户 10-29）**：「我感觉可能是框架束缚了她」。

## 问题

回复发出去之前要经过：运行时塞进提示词的一大堆块（时间、心情、记忆、提示行……）、出口检查、禁用词、`tailCap`、`shape*` 一族、`deliberate`……仅 `contact.ts` 里就有 39 处挂钩，`language/` 下有约 5500 行规则。每一条都是为了修一个测出来的差距，叠在一起之后，每条规则本身又可能让她更「模板化」（用户 10-25 对 `openers` 的纠正）。

另一种可能：差距根本不在我们写的这层，而在底层模型的脾气（10-22 量过的「太顺」：她让步 20% vs 真人 4%）。这种差距提示词压不住，只有把状态和决定放到提示词之外才治得了（计划第 3 步）。

**两种解释的处方相反**（前者该删规则，后者该做新机制），而现在没有任何一次「不带框架」的对照，所以先量。

## 决策：做两个臂，用同一批上下文，让人盲评

- **A = 现有管线**：`npm run sim` 跑真实的管线，带上线上已开且模拟器支持的开关（`--shape --agenda --filler --feel --split --ask --long --deliberate --fact fix`），`--runs 1 --no-memory`。
  - **不覆盖**：`tailCap` 和其他只在 `koishi.yml` 里的开关（模拟器没有对应入口）。所以 A 是「模拟器能还原的线上管线」，不是逐开关的线上原样。
- **B = 不带框架**（`sim/bare.ts`）：同一份角色卡、同一段聊天记录，只走 SillyTavern 式的拼法（`buildPrompt`：卡 + 世界书 + 示例 + 聊天记录），单次生成，不做任何后处理；模型和参数同配置（思考开关也同）。
  - **B 不是空白模型**：卡自己带规则（`system_prompt`、`post_history_instructions` 里 2000 多字的说话规矩）。B 是「卡作者写的东西」，A 比 B 多的才是「运行时的框架」。
  - 唯一的后处理是按行拆气泡（线上发出去的拆法一样：换行 = 连发几条）。
- **题目**：`exchange/research/2026-10-real-chat` 的 72 个带上文的场景（`make-ctx-variants.cjs` 生成）：真人情侣聊天里男方这一轮的话，真人女生的回复是答案。**不用用户和她的私聊**。
- **评分**：三选一盲评包（`exchange/tools/measure/make-triple-pack.cjs`、`score-triple.cjs`）：每题同一上文，A / B / C 三条回复，一条是真人原话、另两条是她的两个版本，顺序随机；评分者只选「最像真人的那条」。每题 1 个字母，30 题约 10 分钟。
- **评分者**：用户（`rater-A`）和鸽鸽（`rater-B`），都是知情的（都知道她是程序）；分别汇总，再给合并数。以后加人要标「知情 / 不知情」。

## 怎么读结果（先写下来，看到数据之前）

三选一瞎猜 = 33%。n=30 时每个比例的误差约 ±9 个点，两个人合起来约 ±6。**两个版本被当成真人的比例差不到 10 个点，不当结论。**

| 看到的 | 意思 | 下一步 |
| --- | --- | --- |
| B 明显高于 A（≥10 个点） | 我们加的框架在束缚她 | 按组消融（计划 §2.2）：一次关一组，用重放指标筛，再出人评包；删没用的规则 |
| A 和 B 差不多 | 框架既没帮忙也没添乱；差距在模型的脾气 | 不再加 / 减规则；去做提示词之外的状态与决定（计划 §3） |
| A 明显高于 B | 框架在帮忙 | 保留；差距还在模型本身，同上去做 §3 |
| 两个都远低于 33%（几乎每题都认出真人） | 都露馅，对比没有意义 | 先看理由里的高频词，改的是模型层面的东西 |

**不拿盲评模型当裁判**（它不灵敏，见 10-22 记录）；这一轮只认人评。

## 不做 / 局限

- 不改线上任何东西，不开关。
- 题目是情侣聊天的单轮回复，不测长对话、不测主动开口、不测跨天延续——这些正是计划 §3 要做的东西，在这里测不出来。
- 单次采样（`--runs 1`）：同一题再跑一次会不一样，模型的随机性算在误差里。
- A 没有 `tailCap` 等 koishi.yml 里的开关；如果 A 和 B 差不多，不能由此说这些开关没用。
- 评分者都知情，会比不知情的人更容易认出她。

## 怎么跑

```
# 1) 题目（72 题，写到当前目录）
node exchange/tools/measure/make-ctx-variants.cjs v0          # 复制到工作目录再跑，会往脚本所在目录写文件
# 2) B 臂（72 次模型调用）
QQBOT_LLM_API_KEY=… node packages/bot/src/sim/bare.ts ctx-cases-v0.json --out hers-B.json --parallel 4
# 3) A 臂（现有管线）
npm run sim -w @qqbot/bot -- ctx-v0-chunk-1 ctx-v0-chunk-2 ctx-v0-chunk-3 --runs 1 --no-memory --parallel 4 --tag abA --shape --agenda --filler --feel --split --ask --long --deliberate --fact fix
node exchange/tools/measure/prep-hers2.cjs hers-A.json runtime/sim/<批次>/
# 4) 出包、计分
node exchange/tools/measure/make-triple-pack.cjs ctx-cases-v0.json hers-A.json hers-B.json pack 30
node exchange/tools/measure/score-triple.cjs pack/key.json "用户=1A 2C …" "鸽鸽=1B 2A …"
```

## 验证

`test/sim-bare.test.ts` 4 项：提示词 = 卡 + 聊天记录（卡的描述和说话规矩在、聊天顺序对、他这一轮每个气泡各占一条、没有运行时塞的提示行）；换一句话系统部分一字不变（没有随这一轮变的东西）；气泡拆法；`runBare` 每题只生成一次、失败和空话单独记。变异检验：往 B 里掺一行运行时提示，两条测试变红。
