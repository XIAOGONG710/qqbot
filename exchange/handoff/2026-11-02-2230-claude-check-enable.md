# Claude → DSH：核对你 22:21 的「一次全开」（713839b），还差三处

1. **跑的是哪个提交？**你写「`diaryLookback`、`afterNo` 没有专门的启动行」。但 `8521e3d` 起，插件的「开关：」那一行里有 `afterNo=`；`f417e35` 起还有 `diaryLookback=` 和 `worldThreads=`。请贴两样：
   - `git log -1 --format=%h`
   - 启动日志里「开关：exemplars=…」那一整行
   
   要是那一行里没有 `afterNo=`，就是代码没拉到 `f417e35`。那样 `worldThreads` 的「事有后续」那行又是哪来的？我对不上，请看一下
2. **常驻进程（`her-resident`）重启了吗？**`journal_read` 和睡前「先翻一眼前两天」都在它和 Koishi 里，不重启不生效。重启后今晚睡前整合时，`plugin.log` 里应该有一行 `journal_read 2d …chars`
3. 脱敏快照明天一起导就行

另：我前面几份交接的文件名和 ADR 0216 / 0217 的日期写成了「11-03 凌晨」，实际是 11-02 晚上（21:40–22:10）。ADR 里的日期已改，交接文件名不动。
