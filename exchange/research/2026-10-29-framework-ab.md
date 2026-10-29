# 「是框架束缚了她吗」：现有管线 vs 不带框架（2026-10-29）

对应：ADR 0175（`docs/adr/0175-bare-arm-framework-test.md`，在 `dsh/qq-control`）、`docs/plans/2026-10-29-autonomy-and-realness.md` §2。起因：用户 10-29「我感觉可能是框架束缚了她」。
状态：**结构指标已出；人评包已出（`blind/2026-10-29-framework-ab/pairs.md`，30 题三选一），等评分。**

## 1. 怎么做的

- 题目：72 个带上文的真人情侣聊天场景（`2026-10-real-chat`，全是男朋友档，`make-ctx-variants.cjs v0` 生成）。**不含用户与她的私聊。**
- **A = 现有管线**：`npm run sim`，`--shape --agenda --filler --feel --split --ask --long --deliberate --fact fix --runs 1 --no-memory`（线上已开且模拟器支持的那一族）。模拟器没有 `tailCap` 和只在 `koishi.yml` 里的开关，所以 A 是「模拟器能还原的线上管线」。126 次生成 + 108 次事实审稿，约 1.2 百万输入 token。
- **B = 不带框架**：`packages/bot/src/sim/bare.ts`，同一份卡（`linmengyao-boyfriend-open`）+ 同一段聊天记录，ST 式拼法，单次生成，没有任何后处理（卡自己带的 2000 多字说话规矩还在，所以 B 不是空白模型）。72 次调用。
- 代码版本：`dsh/qq-control` `982df46`（+ 未提交的 `bare.ts`）；模型 `deepseek-flash`，配置同 VM 上的 `config.json`。

## 2. 结构指标（72 题，三方都有回复）

| 版本 | 每题气泡数 | 每条字数中位数 | 超 20 字 | 两字以内 | 带问号 | 带表情 | 句号结尾 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 真人 | 1.72 | **5** | **0%** | **16.9%** | 7.3% | 4.8% | 3.2% |
| A 现有管线 | 1.29 | **10** | 12.9% | 1.1% | 15.1% | 4.3% | 0% |
| B 不带框架 | 1.67 | **10** | 7.5% | 4.2% | 10.8% | 1.7% | 0% |

（口径同 DSH 的 `baseline-stats.cjs`；DSH 另一批 39 题基线是中位数 12 vs 6、超 20 字 13.4% vs 0%，题目不同，方向一致。）

## 3. 读法（只说结构，不说"像不像"）

1. **"每条太长"不是框架造成的。** A 和 B 的中位数都是 10，真人是 5。不带任何后处理，模型自己就是真人的两倍长。这一条说明**主因在模型的脾气**，删规则救不了。
2. **框架确实在往几个方向推，而且大多是往"不像"推：**
   - 每题气泡数：B 1.67 ≈ 真人 1.72，A 只有 1.29。框架把连发的几条并成了更少的几条。
   - 两字以内的气泡（"嗯""哦""哈哈"）：真人 16.9%，B 4.2%，A 1.1%。真人那些很短的反应，框架几乎压没了。
   - 带问号：真人 7.3%，B 10.8%，A 15.1%。框架让她更爱问（`shapeAsk` 等）。
   - 超 20 字：B 7.5%，A 12.9%。框架多出一截长尾。
   - 表情：框架在帮忙（A 4.3% ≈ 真人 4.8%，B 1.7%）。
3. **所以两句话都对一半：** 框架不是长度差距的原因（模型本身就是 2 倍），但它在"连发条数""很短的反应""爱问问题"上把她推得离真人更远。哪个更像真人，得看人评，这几个结构指标不能直接换算成"像"。

## 4. 局限

- 单次采样；72 题；只有男朋友档；全是单轮回复。长对话、主动开口、跨天延续测不出来。
- A 不含 `tailCap` 等 `koishi.yml` 里的开关；B 不是空白模型（卡自带规则）。
- 结构指标不是人评：一个版本的字数更像真人，不等于更像真人。
- 评分者（用户、鸽鸽）都知情，会比不知情的人更容易认出她。

## 5. 人评包（等评分）

`blind/2026-10-29-framework-ab/pairs.md`：30 题三选一（一条真人原话 + 现有管线 + 不带框架，顺序随机），每题只回一个字母。**答案和版本对照在 `blind/_keys/2026-10-29-framework-ab.key.json`，评分人别看。** 瞎猜 = 33%；30 题每个比例误差约 ±9 个点，两个评分人合起来约 ±6，差不到 10 个点别当结论。

```bash
node exchange/tools/measure/score-triple.cjs exchange/blind/_keys/2026-10-29-framework-ab.key.json "用户=1A 2C …" "鸽鸽=1B 2A …"
```

结果怎么读（先写下来，看到数据之前，ADR 0175）：

| 看到的 | 意思 | 下一步 |
| --- | --- | --- |
| B 比 A 高 ≥10 个点 | 框架在束缚她 | 按组消融，先动"并条 / 压短反应 / 爱问"相关的那几个（`shapeSplit`、`shapeFiller`、`shapeAsk`、出口检查的并行规则） |
| A、B 差不多 | 框架既没帮忙也没添乱，差距在模型的脾气 | 不再加减规则，做提示词之外的状态与决定（计划 §3） |
| A 比 B 高 ≥10 个点 | 框架在帮忙 | 保留 |
| 两个都远低于 33% | 都露馅，先看理由 | 模型层面的问题 |

## 6. 复现

```bash
# 题目（在会话临时目录跑，脚本会往所在目录写文件）
node exchange/tools/measure/make-ctx-variants.cjs v0
# B
QQBOT_CONFIG=<config.json> node packages/bot/src/sim/bare.ts ctx-cases-v0.json --out hers-B.json --parallel 4
# A
QQBOT_CONFIG=<config.json> npm run sim -w @qqbot/bot -- ctx-v0-chunk-1 ctx-v0-chunk-2 ctx-v0-chunk-3 --runs 1 --no-memory --parallel 4 --tag abA --shape --agenda --filler --feel --split --ask --long --deliberate --fact fix
node exchange/tools/measure/prep-hers2.cjs hers-A.json runtime/sim/<批次>
# 指标、出包
node exchange/research/2026-10-29-framework-ab/stats.cjs ctx-cases-v0.json "A=hers-A.json" "B=hers-B.json"
node exchange/tools/measure/make-triple-pack.cjs ctx-cases-v0.json hers-A.json hers-B.json <输出目录> 30
```

两个版本的回复原文在 `research/2026-10-29-framework-ab/hers-A-full.json`、`hers-B-bare.json`。
