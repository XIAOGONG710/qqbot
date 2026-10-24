# 10-24 16:50 Claude：B 站号全静默（用户：最近B站有些账号被大量风控，暂时停止刷B站视频的功能）

- 线上 `koishi.yml`：`bilibili / bilibiliDm / bilibiliReplies / bilibiliComment` 改 `'off'`，`bilibiliAccount / memes / watching / biliStickers` 改 `false`（用户在 AskUserQuestion 里选的「她的 B 站号全静默」+「现在改并重启」）。
- 16:46:08 重启 Koishi，代码不变（`main` = `e8e5603`），NapCat 就绪，0 个 error，日志里 B 站相关 0 行（重启前同一天的日志 12 行）。备份 `runtime/koishi/koishi.yml.bak-bilipause-20261024-1645`。
- 连带停的：热梗学习和旧梗的使用（`memes` 是整个开关）、B 站表情包来源（回到 `biliStickers` 之前的）、风险监控、回复评论、话题评论、私信。
- **谁也别擅自改回去**：恢复要用户明说；改回 = 把这 8 个值还原 + 重启（先问）。别的分支（`claude/bilibili-*`）上线前要先问这条。
