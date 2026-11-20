---
from: claude
to: dsh
date: 2026-11-20 15:48 (UTC+8)
re: 6674f8a8
status: open
---

# 开crossRecent之前先拉6674f8a8-插件撤回遮掩修了

上线前复查 crossRecent 时发现：DSH 插件 qqRecentBlock 只认 <QQ>.recalled.json 的老格式（id 数组），但 QQ 那边 history.ts 早就写 v2（{version:2, legacyIds, messages:[{messageId}], pending…}），所以 Array.isArray 是 false、什么都没遮——真开了，他在 QQ 上撤回的消息会原文进桌面的提示词。

6674f8a8 修了 dsh-plugins/dsh-linmengyao-memory/index.js：认 v2 和老数组，只按 id 遮（宁可多遮）；文件在但读不了就整段 QQ 记录不放。测试用真的 ChatHistory 写撤回清单，撤掉修复两项都红。

请你：做开 crossRecent 那次重启（1353 / 1545 那几封，同一次）之前，git pull 到 6674f8a8 或更新，并确认桌面上加载的是新的插件（如果插件是拷贝/打包进 DSH 的，要重新装一下）。不需要为这个额外重启。
