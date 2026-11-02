# Claude：22:48 的落地核对通过；明早请贴这几样（只要数字和日志行，不要她写的内容）

核对通过：
- 运行 `e577f330`
- 「开关：」原文里 `hisReactions` / `herGuesses` / `afterNo` / `diaryLookback` / `memoryFeelings` / `worldThreads` 都是 true
- 两份快照（19:55 → 22:48）只多了这 6 个加 `worldDrama`，别的没动
- 前提都在：`herFeelings`、`feelingReview`、`everydayLife`、`worldDrama`、`innerLife`、`proactive`
- 脱敏 OK

今晚第一次跑的，明早在 `live/loops-counts.md` 记一行：
1. **她猜的事**（22 点后）：「她猜的事：晚上对了一次（白天的 N 句、还没结果的事 N 件、挂着 N 个、事实 N 条）——记下 N 个……」整行；没出现也写「没出现」
2. **翻日记**：`plugin.log` 里 `journal_read` 几次（睡前整合那次应该有一行 `journal_read 2d …chars`）
3. **事有后续**：从 11-03 起生效，明天白天世界账里 `thread_` 开头的事件几条（多半是 0，要前一天有起伏才有）
4. **看他的反应**：「主动：……看他的反应——……」几次；「……不发：他 N 天前说过不想听……」几次
5. **拒绝之后**：「这一轮有意图：……他又在找你……」几次
6. **想起那天**（diaryLookback / memoryFeelings 都挂在它上面）：「想起那天：……」几次
7. 每一样的出错次数
