# 用户：「开」——再开 `worldThreads` 和 `diaryLookback`（和 N1–N3 一次做完）

- 时间：2026-11-03 凌晨
- 用户原话：我问「`worldThreads` 和 `diaryLookback` 要不要开」，用户回「kai」（开）
- 代码：`dsh/qq-control` = `f417e35`，比 `8521e3d` 多 ADR 0216、0217
- 上一份「开 N1–N3」（`handoff/2026-11-03-0110-…`）你还没回报。**两份合成一次做，只重启一次**

## 步骤

1. 拉取 `f417e35`
2. 导一份开之前的脱敏 `koishi.yml` 放进 `live/`
3. qqbot 段确认 / 加上这些：
   ```yaml
       # 前提（应该已经开着；没有就加上——worldDrama 是用户 11-02「直接模拟现实世界」那次你开的）
       everydayLife: true
       worldDrama: true
       innerLife: true
       # N1–N3（上一份）
       hisReactions: true
       herGuesses: true
       afterNo: true
       # 这一份
       worldThreads: true
       diaryLookback: true
   ```
   你 19:55 的快照里没有 `worldDrama` 这一行（那时还没做）。**要是现在也没开，`worldThreads` 不起作用**，启动日志会写「要 everydayLife 和 worldDrama 都开着才起作用」。用户 19:57 说的是「直接模拟现实世界」，开 `worldDrama` 就是那件事
4. 重启 Koishi、常驻进程（`her-resident`，`journal_read` 和睡前提示词要它重启）、看门狗
5. 核对启动日志，**原文贴进 `live/`**：
   - 插件「开关：…… hisReactions=true herGuesses=true afterNo=true diaryLookback=true worldThreads=true」
   - 「事有后续：从 YYYY-MM-DD 起生效（已经过完的日子不改）」：第一次开会写明天的日期，存在 `runtime/bot-shadow/world/threads-from.json`
   - 「看他的反应：开……」「她猜的事：开……」
6. 导一份开之后的脱敏 `koishi.yml` 放进 `live/`

## 之后每天在 `live/loops-counts.md` 记的（只记数字）

- 上一份那几项（N1–N3）
- `worldThreads`：那天世界里有没有后续（世界账 `world/` 当天的事件里 `thread_` 开头的有几条，只记条数）
- `diaryLookback`：日志里「想起那天」出现几次
- `journal_read`：`plugin.log` 里 `journal_read` 几次

## 出问题时（后开的先关，一次关一个）

1. `diaryLookback`
2. `worldThreads`（`threads-from.json` 留着；要从头重算就删掉它再开）
3. `afterNo`
4. `herGuesses`
5. `hisReactions`

`journal_read` 没有开关。要撤就 `git revert` ADR 0217 那个提交，它是只读的，不会动任何文件。
