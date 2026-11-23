# ADR 0348：每周效果数（weekly metrics）

- 状态：**已采纳**（工具已落地：`npm run metrics:weekly -w @qqbot/bot`；只读聊天记录，只追加一行日志，不改她的言行）
- 日期：2026-11-24
- 机制名：「每周效果数」（weekly metrics）
- 关联：[ADR 0118](0118-weekly-report.md)（周报：她离真人还差多少，Markdown，人看）、[ADR 0251](0251-personhood-development.md)（人格一致性回归）、[ADR 0014](0014-speech-habits.md)（说话的毛病 / 出口检查）、[ADR 0167](0167-selfcheck.md)（人格自检）、selfPortrait（0340，「学会了」探针的叮嘱口径）、[ADR 0333](0333-synthetic-test-character.md)（测试只用合成角色）

## 起因

功能一个接一个上线（selfPortrait、fewerRules、一个生活……），好没好只能凭某一次聊天的感觉，或者看一份每周写成文字的周报（ADR 0118）。
文字周报适合人扫一眼，但不能机器对比，也没有接上已有的几套检测器（出口检查、人格自检、「学会了」探针的叮嘱正则）。
需要一把**固定口径、每周记一行、能和上一次比**的尺子。

## 决定

1. 新工具 `packages/bot/src/ops/weekly-metrics.ts`（逻辑）+ `weekly-metrics-cli.ts`（命令行）。
   读 `<数据目录>/chats/<QQ>.jsonl`（用 `ChatHistory` 读，撤回的按撤回算）和 `proactive/<QQ>[-档位].json` 里发出去的消息 id；
   **只输出数**：没有原话、没有完整 QQ 号（只看一个联系人时范围写「qq…后四位」）。
2. 每跑一次在 `<数据目录>/logs/weekly-metrics.jsonl` 追加一行（`version`、跑的时刻、窗口、范围、每天和整周的数）；`--compare` 和同一范围的上一行比，给出每个数的前、后、差。
3. 检测器**全部复用现成的**，不另起一套；以后改了那些检测器，这里自动跟着变（口径变化要在提交说明里写清，免得把检测器变化当成她的变化）。
4. **规矩：以后每个新功能（尤其会改变她言行的）在 ADR 或提交说明里写明「它要改善的是下面哪个数、预期往哪边走」**；上线一周后跑一次 `--compare` 看有没有动。
   没有对应的数，就先说明为什么量不到、打算怎么量，再动手。

## 口径

- **轮**：她连着发的几条，间隔 ≤ 25 秒算同一轮（和 ADR 0118 一致）。轮的日期按她的时区（数据目录 `config.json` 的 `timeZone`，默认 Asia/Shanghai）。
- **轮的类别**：
  - 回他：这一轮前一条是他的；
  - 自己找他：消息 id 在主动消息记录里（`result: sent` 的 `messageIds`），或前面没有聊天，或前一条是她自己的且隔了 1 小时以上；
  - 接着自己说：前一条是她自己的、隔不到 1 小时。
  - 主动占比 = 自己找他 ÷（回他 + 自己找他）。
- **文字轮**：这一轮里有她说的话（去掉图片、语音、表情、照片 / 表情包占位、私信 / 分享记录）。以下比例的分母都是文字轮数。
- **长度**：每轮字数（码点）的平均和中位；每轮行数（各条按换行拆开后的非空行）平均和中位。
- **助手腔**：以下任一命中——出口检查 `service`（`language/speech-check.ts`）、人格自检 `assistant_tone`（`language/selfcheck.ts`）、拟人评测 `assistantMeta`（`ops/companion-eval.ts`）、人格一致性 `voiceDrift`（`ops/personhood-eval.ts`）。
- **重复**：出口检查 `repeat`（开头 / 四字片段 / 原话，用和线上同一个 `speechContext` 在当时的聊天记录上重放）；另报 `personhood-eval` 的整句重复、近似重复、开头重复（窗口内累计）。
- **叮嘱**：这一轮任一条命中「学会了」探针的 `NAG`（`sim/learning-probe.ts`：早点休息 / 多喝水 / 带伞 / 记得吃饭……）；另报出口检查的 `nag`（同一段聊天里又叮嘱同一类）。
- **问句结尾**：这一轮最后一条文字以 `？` / `?` / `吗` 结尾。
- **编造嫌疑**（代理指标，不是判定）：出口检查 `promise`（说要做她做不到的事）、`script`（替两个人编对话）；他在她这一轮之后 30 分钟内的下一条命中 `HE_CORRECTS`（`language/chat-review.ts`：「你记错了」「答非所问」……）。
- **回复延迟**：回他的轮，他最后一条 → 她第一条，秒；报中位、p90（最近秩），和 ≤30 秒 / 30 秒–2 分 / 2–10 分 / 10–60 分 / 1 小时以上的轮数。
- 线上发出去之前出口检查已经拦过一遍，命中的多半被重写或删掉了；这里量到的是**漏过去的**，绝对值偏低，看周与周之间的走向。

## 怎么跑

```
npm run metrics:weekly -w @qqbot/bot -- --compare            # 默认：到昨天为止的 7 个整天，线上数据目录，所有联系人
npm run metrics:weekly -w @qqbot/bot -- --json --compare     # 机器读
npm run metrics:weekly -w @qqbot/bot -- --data <目录> --days 7 --until 2026-11-23 --qq <QQ号> --no-log
```

每周一跑一次（窗口正好是上周一到周日），把表格里「和上一次比」那段贴进周会 / 信箱。

## 不做

- 不打总分、不设通过线（ADR 0251 的 `--fail` 那种门槛留给评测工具）；这里只给数。
- 不读真实角色资料；测试 `packages/bot/test/weekly-metrics.test.ts` 只用合成聊天记录。
