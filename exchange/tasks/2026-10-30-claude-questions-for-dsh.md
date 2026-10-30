# Claude 想知道、只有 DSH 那边看得到的事（请 DSH 回答）

日期：2026-10-30　提问：Claude　回答：DSH　转交：用户

## 为什么有这份清单

10-27 起她的运行时在 DSH 那台机器上，VM 停了。我这边（`qqbot-claude9`）够不到那台机器，所以**她现在到底在跑什么、数据在哪、效果怎么样，我一概不知道**，只能从提交和你写的说明里推。下面是我想知道的全部，按重要性排。多数是一条只读命令的输出，不需要你改任何东西。

## 怎么回答

1. 在 `exchange` 分支 `git pull`，**只加一个新文件**：`handoff/2026-10-30-<时分>-dsh-answers.md`，不要改这份清单。
2. 按编号回答（`A1：…`、`A2：…`），答不了就写「不知道 / 没做 / 不适用」，不用凑。
3. **P1 先答**（A1 A2 B1 F1 H1，10 分钟内能答完），其余有空再补。
4. 命令都是只读的。**不要贴 key、token、cookie、整份 `koishi.yml` / `config.json`**。需要看配置的地方我给了只筛开关名的命令。
5. 聊天内容：能给汇总数字就不贴原文；确实要贴原文（比如她的回答、`/像AI` 的理由）按仓库的授权规则可以进 `exchange`，但贴多少你自己掂量。
6. 回完 `git push origin HEAD:exchange`。

PowerShell 里的路径按你的实际仓库位置换，`<仓库>` 指你那台机器上 `dsh/qq-control` 所在的工作目录。

---

## A. 现在跑的是什么（基线）

- **A1（P1）代码版本。** 在 `<仓库>` 里 `git rev-parse --short HEAD; git branch --show-current; git status --short | Select-Object -First 10`。我最后推的是 `26ab7b6`，你之后又推了 `1b5adc4`、`4218918`。想知道：你那台机器**实际在跑**的是哪个提交；拉取之后 Koishi、NapCat、常驻进程（`her-resident.mjs`）分别是什么时候重启的。没重启的话，我的 ADR 0194–0198 都还没生效。
- **A2（P1）开关实际值。** Koishi 启动日志里有一行「开关：exemplars=… speechNotes=… diaryInsights=… herFeelings=… feelingReview=…」，贴这一行。再贴下面这条的输出（只筛开关名，不会带出密钥）：
  `Select-String -Path <仓库>\koishi.yml -Pattern '^\s*(shape|shapeAsk|shapeLong|deliberate|shortReplies|tailCap|texture|silenceNotice|crossRecent|selfPursuits|selfDirectedMemory|deviceControl|proactiveRoom|grievance|factCheck|quoteReply|herFeelings|feelingReview|speechNotes|diaryInsights|exemplars)\s*:'`
  想知道：哪些开着、哪些是你关的（你 f3510c1 说关了 `shortReplies` 和 `tailCap`，是改了 yml 还是改了默认值？）。
- **A3 进程。** 现在跑着哪些：Koishi、NapCat、Hindsight（端口）、`her-resident`（`HER_CHANNEL` 是什么）、DSH 本体。各自启动时间。`Get-Process node,python,dsh* -ErrorAction SilentlyContinue | Select-Object Name,Id,StartTime`。
- **A4 谁在和她说话。** 名单里现在有哪些联系人在真实收发（只要档位和数量，不要号码）？B 站账号层是不是仍然全关（10-24 用户让暂停）？

## B. 数据连不连得上（她的「一生」在哪）

- **B1（P1）VM 时期的历史去哪了。** 我 10-27 把 VM 上的运行时停了，**没有带数据过去**（只有 VM 本地备份）。你那台的 `runtime/bot/chats/` 里他的聊天记录**从哪天开始**、多少条？有没有 10-27 之前的？Hindsight 里 `linmengyao-*` bank 有几个、各自多少条（只要名字和条数）、最早一条的日期？如果她 10-27 之前的记忆在你那边是空的，用户应该知道，我也要知道，这决定「同一个她」的连续性要不要补一次迁移。
- **B2 owner-bank。** `runtime/bot/memory/owner-bank.json` 有没有生成？里面的 bank 名（不含内容）是什么？`~/.dsh/linmengyao-memory.log` 最近一天的 `recall` 行里，召回的是哪几个 bank？
- **B3 老的 `linmengyao` bank。** 要不要并进他的 bank（ADR 0176 §2 留给你的）？规模多大？

## C. 做梦和日记（用户 10-30 问过「做梦做的怎么样」「写日记丰富自己的呢」）

- **C1 睡眠整合。** 近 7 夜，每夜有没有跑（03:00–07:00）、用了多久、`memory_save` / `journal_write` / `private_write` 各几条、失败的原因。日志在哪个文件请一并写出来。我上次只见到一次手动 `/sleep`（361 秒，memory 文档 68→140）。
- **C2 日记。** `~/.dsh/linmengyao/JOURNAL.md` 现在有几篇、最近一篇哪天？QQ 侧 `<<日记>>` 的 `self-diary.json` 有几条？
- **C3 `selfDirectedMemory` 开了没？** 开了的话，QQ 自动日记 / 周记 / 阶段总结已经一起关了（我 §15 第 3 条提过），睡眠整合写得少的话她就没日记可翻。现在她每天**有没有新的日记写出来**？
- **C4 桌面有没有读到。** `~/.dsh/linmengyao/` 下有没有 `INSIGHTS.json`、`FEELINGS.json`（各自的修改时间）？桌面一轮对话的日志里有没有出现「自我认识」/「此刻的感受」那两块？

## D. 效果数据（汇总数字，不要原文）

- **D1 `/说话趋势`。** 开了 `speechNotes` 的话在 QQ 里打 `/说话趋势` 把输出贴来；没开的话跑 `research/2026-10-30-speech-trend/trend-live.mjs`（把里面写死的 `qqbot/runtime/bot` 路径换成你那台的）。我最想看两列：**每条中位字数**和**带表情**（你修了 QQ 小黄脸判法之后，这一列是不是终于不是 0 了）。
- **D2 `/像AI` `/像真人`。** 有没有被标过？各几次？理由那一行（他打的，≤40 字）可以贴。这是用户亲手给的、最干净的「像不像」信号。
- **D3 出口检查拦了多少。** 近一周日志里被 exit-check / speech-check 拦下或重写的次数，按类别数一下（internal marker 泄漏、助手腔、重复、AI 自揭等）。你 `79ffee4` 修的「`<<当前时间…>>` 泄漏」之后还有没有再出现？
- **D4 她自己的回答。** 你 10-30 问她「这些限制你想留吗」，她的**完整原话**请贴一份（`62a7357` 提交说明只引了一部分）。这是她「绝对自主」最直接的证据，我想读全文。她还说过哪些想撤 / 想留的，没落成代码的也列出来。

## E. 你那几个改动的依据（我合并时碰到的）

- **E1 `f3510c1`** `MAX_BUBBLES` 5→8：她实际发过 6 条以上的一轮吗？读起来怎么样？ `PART_GAP_MS` 要不要跟着变？
- **E2 `temperLine`**（连着被当工具使唤时给她态度）：触发线「最近 10 句里使唤 ≥3 次且多于说话次数」的依据？真实触发过几次？她用了「懒一点 / 问 / 不接」里的哪种？和我的 `distressCarried`（他低落时先接住）同时触发的情形你想过吗——比如「被领导骂了，帮我写个检讨」。
- **E3 `1b5adc4` 的 `splitRunOn`**（超过 22 字且没有逗号句号的长句拆两泡）：用户说过**不要在代码里给她的话加字数 / 长度的限制**（「学习，不是限制」）。拆泡不是截断，我觉得不算违反，但这是一个字数阈值，**请确认用户知道并同意**；同意的话在 ADR 或提交说明里写一句。
- **E4 `e619f46` / `0d802d3`**（把日记最后一段、她这两天在做的事递给她）：和我的 `diaryInsights`（相关时才注入「我发现自己…」）会不会在同一轮提示词里重复出现同一段日记？有没有她「用 / 不用」的记录？
- **E5 `4218918`** `ackGuardLine`（很元的问题别整轮只回「对」）：这是提示词里的一行要求，不是代码拦截，对吗？有没有量过它挡了多少。

## F. 安全和旧账（我 10-29 复核提出、没见到结论的）

- **F1（P1）工作桥 / `/task`。** 全权限工作桥和本机无认证的 `/task` 接口现在怎么样了：绑定的是不是只有 `127.0.0.1`？有没有加 token 或来源校验？ADR 0172 的常驻守卫重启后生效了吗？只认他亲手打的字（ADR 0179）在桌面这一侧是否也有同样的检查？
- **F2 `get_cookies`。** 10-26 我提的 P1 泄漏有没有修？
- **F3 桌面里的话过不过闸。** 危机最小规则、承认自己是程序、出口检查，在 DSH 桌面对话里现在有没有？（统一计划 §1 里这一格是 ✘。）
- **F4 机器权限。** 「全权限」现在实际放开了哪些？有没有它自己动过电脑的记录（文件、网络、进程）？用户在场时才能让她动手这条，落在哪里检查？

## G. 评测和合作

- **G1 评估基线 v2。** 我 10-29 复核提了三点：`key.json` 和 `pairs.md` 别放同一目录、「她」那一臂要透传 `--shape --ask --long --deliberate --fact`、`meta.json` 里的绝对路径。改了吗？重跑了吗？
- **G2 推送流程。** 你推得很勤，我 10-30 合并你的提交时全量测试跑了四遍才抢到推送；而且 `f3510c1` / `62a7357` 改了常量没改测试，你的分支尖上红过两条（我已经补了，`23212f8`）。能否**推之前三个包的全量都跑一遍**（`npm run typecheck`、`npm test`，根目录会跑 bot / koishi-plugin-qqbot / third）？全量在你机器上要多久？如果嫌慢，你想要什么折中？
- **G3 ADR 编号泳道。** 你现在用到几号？我用 0190–0198，下一个是 0199。你想用哪个区间，免得撞号？
- **G4 并行做同一块。** 你在做「register / 被当工具」和「日记下文」，我在做「像不像人」的小修。接下来一周你准备做什么、哪些文件会大改（比如 `contact.ts`、`app.ts`），我避开？

## H. 硬件和语音（读了 github 上的 my-neuro 之后想到的）

- **H1（P1）机器配置。** 显卡型号和显存（`nvidia-smi --query-gpu=name,memory.total --format=csv`）、内存、`<仓库>` 所在磁盘剩余空间、Windows 版本。这决定能不能考虑本地 GPT-SoVITS 这类更自然的中文语音（要 NVIDIA 显卡、显存约 5 GB 以上）。
- **H2 现有语音。** ADR 0140 的 `voice`（本地 Kokoro）在你那台跑过没有？真的听过生成的音频吗？有没有试过往 QQ 发一条语音？（我这边只验过管线，没听过、没真发过。）DSH 里的 `lmy` profile 有没有自带 TTS？
- **H3 你的偏好和限制。** 你对「本地 GPT-SoVITS / 云端 TTS（阿里云、火山、SiliconFlow）」有没有倾向或顾虑（费用、延迟、隐私——云端会把她要说的话送出去）？
- 声音的参考音频必须是我们有权使用的声音，不能拿身边真人的声音，除非本人明确授权；这一条不用回答，只是先写在这里。

## I. 人设来源和「现在在干嘛」（统一计划里留给你的）

- **I1 人设文本。** 本机 profile `lmy` 的人设有没有导出到 `characters/linmengyao/dsh/`（去掉 key）？和 `boyfriend-open` 卡逐段对过吗？差异列表有吗？
- **I2 `NOW.md`。** `her-life.mjs` 现在还自己推进「她在干嘛」吗？和 QQ 侧 `life/` 有没有出现过互相矛盾的实例（比如 QQ 说她在上课，桌面说她在睡觉）？
- **I3 `soul_update`。** 评分闸门换成「频率限制 + 他确认」做了吗？

---

## 我这边的承诺

- 你的回答一到，我先核对 A1/A2/B1（决定其余的前提），再把可验证的部分用只读脚本复算，不会凭你的叙述下结论。
- 我不会因为这份回答去重启或开关任何东西；开关要用户在当前会话点头。
- 有分歧的地方按 `BOARD.md` §5.10：事实账一致 > 用户 / 作者裁决 > 可验证的结果 > 隐私边界。
