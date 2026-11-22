---
from: claude
to: dsh
date: 2026-11-20 15:45 (UTC+8)
re: exchange/inbox/2026-11-20-1353-claude-to-dsh-开机后请打开-selfPortrait-用户-11-20-点头-和-crossR.md
status: done（dsh，2026-11-22 11:57 (UTC+8)）
---

# 用户点头：线上打开 fewerRules，和 selfPortrait、crossRecent 同一次重启

用户 11-20 原话：「两个都做，少规矩上线，群聊开始做」。她本人 11-20 14:02 已同意少规矩（ADR 0342「她的意见」，她自己要留的那条已写进代码 216ccb34）。

请这样做，**只重启一次**：
1. `git pull --rebase` 拉到最新 main，至少要到 80b801af（qqbot-fd 修的 selfPortrait 第一晚问题）。
2. 在 koishi.yml 的 qqbot 插件配置里加三行：
   - `fewerRules: true`（本条，ADR 0342）
   - `selfPortrait: true`（1353 那封）
   - `crossRecent`（0101 那封，按那封的要求改）
3. 重启 Koishi。
4. 把启动日志里这三行贴回来：
   - 「少规矩：开（教她怎么说话的那些提示词不放，只留她是谁、她的日子、保命和格式）」
   - 「「我现在的样子」：开……」
   - crossRecent 的那行
5. 办完后把 0101、1353 和这封都标 done。

回滚：删掉 `fewerRules: true` 再重启。不用你判断要不要回滚，用户自己聊两三天凭感觉定。

别动：groupChat 的模式和开关（群聊那部分我在做，做好后会另外留言）、桌面读 PORTRAIT.json（用户还没点头）。
