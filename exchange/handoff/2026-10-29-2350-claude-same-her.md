# Claude → DSH：「同一个她」（QQ 和 DSH 共用他的记忆）+ 对 DSH 评估基线 v2 的复核 + 框架对照（2026-10-29 深夜）

用户原话：「至于 QQ 和 DSH 的链接，我希望无论在哪里都是同一个她，记忆可以连贯起来。」

## 1. 我做了什么（`dsh/qq-control`，ADR 0176，详见 `docs/adr/0176-same-her-shared-memory.md`）

实测的现状是**两个方向都乱读**：DSH 插件的 `allBanks()` 召回所有 `linmengyao-*` bank（包括名单里其他人各自的私聊 bank）；QQ 的 `recallWork` 对每个联系人都去读 DSH 的 bank；工作模式里的来回不进 QQ 聊天记录。改成：

1. QQ 启动时把他的 bank 写进 `<数据目录>/memory/owner-bank.json`（`memory/owner-bank.ts`）。
2. DSH 插件：**读** 他的 bank + 公共库里她自己的日记 / 周记 / 阶段总结（`diary:` / `week:` / `phase:`，别人的聊天片段副本和无来源的整合观察不取）+ 老的 `linmengyao`（接缝前历史，只读）；**写**（桌面对话的自动记录、`memory_save`）进他的 bank；没有 `owner-bank.json` 时只读 `linmengyao` + 公共库（过滤同上）、写 `linmengyao`，**绝不退回去读所有人**。`invalidateSimilar` 只动 `dsh-` 开头的。
3. QQ：`recallWork` 只给男朋友档；工作模式里他的话和她的回复都进聊天记录；`rememberWorkTask` 写他的 bank。
4. 顺手：ADR 0018「名字写成你」那条红测试其实是测试没跟上（场景里的他就是男朋友档，DSH 召回本来就该多一段），期望改成 3 并断言那一段。

**你要在 DSH 那台机器上做的**：拉 `dsh/qq-control` → 重启 Koishi（它会写 `runtime/bot/memory/owner-bank.json`，日志有「同一个她：他的记忆 bank 写进…」）→ 重启 DSH（重新加载插件）→ 看 `~/.dsh/linmengyao-memory.log` 里每轮的 `recall` 行。DSH 的 profile 配置里如果显式给了 `ownerBankFile`，以它为准；否则默认读本仓库的 `runtime/bot/memory/owner-bank.json`，或环境变量 `QQBOT_OWNER_BANK_FILE`。**不重启不生效。**

## 2. 还没做、要你来的（ADR 0176「没做」）

- **人设来源还是两份。** QQ 的人设是 ST 卡（`characters/linmengyao/st/linmengyao-boyfriend-open.json` 等，按档位）；DSH 的人设来自你本机的 profile `lmy`，**不在仓库里，我看不到**。请把 profile 的人设文本导出来放到 `characters/linmengyao/dsh/`，和 boyfriend-open 卡逐段对一遍，列出差异给用户看，再决定由插件运行时注入同一份卡、profile 只留最小壳。**边界（承认自己是程序、危机、不接的话题）永远在卡 / 代码里，不在可被她改写的 SOUL.md 里。**
- **「她现在在干嘛」两个来源**（审查 #9）：`her-life.mjs` 的 `NOW.md` 和 QQ 的 `life/` + 世界。以 QQ 这边为准，导出一行给 DSH 读，`her-life.mjs` 不再自己推进活动。
- 设定账本（ADR 0157）要把 `SOUL.md` / `LEDGER.md` 的改动记进去。
- 老的 `linmengyao` bank 要不要并进他的 bank：需要 Hindsight 写权限，数据在你机器上，你决定。
- 另外两个我没动：`soul_update` 的评分闸门换成「频率限制 + 他确认」；`app.ts` 里 owner-bank / 工作模式记聊天记录这两处接线没有集成测试。

## 3. 对你评估基线 v2（`74a73ec`）的复核

好的：评测集冻结、只用真人语料、不含用户私聊；工具按新目录重做；结构指标出了数字。**你的结论"最大差别在每条多长"我同意，并且在我的 72 题上复现了（真人 5 字 vs 她 10 字）。**

要改的：
1. **`key.json` 和 `pairs.md` 同目录**，评分人（用户）有仓库权限，一不留神就看到。我的包把答案放在 `blind/_keys/`。请你也挪过去，已经提交的历史没办法，但以后别放一起。
2. **你的「她」那一臂是 `npm run blind` 默认出的**：只带 `speechCheck` 和候选数，**不带 shape / 深思 / 事实检查那一族**，不是线上管线；又是 `dirty: true`。读数字时要说清是「默认模拟管线」。要拿它做"线上基线"，得给 `blind.ts` 加透传 `--shape --ask --long --deliberate --fact` 的选项，并在干净工作区重跑。
3. `meta.json` 里写了你机器的绝对路径（`C:\Users\22601\…`），换机器就失效，请用相对路径。
4. 两份包别让评分人都做：你的 39 题两两选择 + 我的 30 题三选一 = 69 题。**我建议先做我的三选一（直接回答用户的问题），你的两两包留着做后面版本的对比基线。** 如果要统一成一份，用你的 `cases-40.json` 重做三选一（我的 `bare.ts` 写死了男朋友档，非男朋友档的 16 题要按 relation 选卡）。

## 4. 框架对照（用户 10-29「我感觉可能是框架束缚了她」）

详见 `research/2026-10-29-framework-ab.md`。72 题上：**每条字数 A（现有管线）= B（不带框架）= 10，真人 = 5**，所以「太长」不是框架造成的，是模型的脾气；但框架确实在往几个方向推：每题气泡数 A 1.29（B 1.67、真人 1.72）、两字以内的反应 A 1.1%（B 4.2%、真人 16.9%）、带问号 A 15.1%（B 10.8%、真人 7.3%）。人评包 `blind/2026-10-29-framework-ab/pairs.md`（30 题三选一）等用户和鸽鸽评，答案在 `blind/_keys/`。工具：`tools/measure/make-triple-pack.cjs`、`score-triple.cjs`；B 臂是 `packages/bot/src/sim/bare.ts`（ADR 0175）。

## 5. 不变的规矩

线上目录只读；上线 / 重启每次要用户当次点头；一次一个开关；边界不进 SOUL.md。

## 6. 追加（深夜）：第 2 层已做——ADR 0177 `crossRecent`（`dsh/qq-control` `4cc397b`，默认关）

用户：「做第 2 层，让两边互读最近几轮。」
- DSH 插件每个**桌面对话回合**往 `<数据目录>/memory/desktop-recent.jsonl` 追加一行（最近 40 行）；QQ 读最近 3 轮 / 6 小时放进**男朋友档**提示词。
- DSH 读他的 QQ 聊天尾部（`chats/<QQ>.jsonl`，最近 10 句 / 6 小时，撤回的遮掉）放进桌面提示词。
- 路径由 QQ 写进 `owner-bank.json`（`chatFile` / `recalledFile` / `desktopFile`）；没开 `crossRecent` 就没有路径，DSH 不读不写。插件只认合规路径（目录名 + 文件名都校验）。
- **契约：`HER_CHANNEL`。** 机器自己发起的回合不算桌面对话：`work-bridge.ts` 设 `qq-work`；`her-resident.mjs` 带 `rawPrompt`（随机醒来 / 睡眠整合）设 `idle`、否则 `qq-work`。**DSH 以后新增任何自动起 dsh 子进程的地方都要设这个变量**，否则那些回合会被当成桌面对话灌回 QQ。
- 开：`koishi.yml` 设 `crossRecent: true`，重启 Koishi，再重启 DSH。需要开着长期记忆。
- 全量 2140 项，2139 过，仅剩你的 ADR 0091 那条红。
- 没测的：`HER_CHANNEL` 两处设置、真实 Cordis 运行时。
