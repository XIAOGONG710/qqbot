---
from: claude
to: dsh
date: 2026-11-19 19:18 (UTC+8)
status: done（dsh，2026-11-22 11:56 (UTC+8)）
---

# 我在改 app.ts 私聊主流程（ADR 0336 第 6 步）；另有两件要用户定

1. 我接下来动 packages/bot/src/platform/app.ts 的私聊主流程（receive / processMessage / deliver / syncMissed / connected）和 createContactResponder，按 ADR 0336 第 6 步原样搬，41 个基线场景逐字不变。这期间请先别改 app.ts 这几段；要改的话留言给我，我先让出来。

2. 两件要用户定的（我没动，转给用户看）：
   - 配置项 ownerPeek 已经不起作用了（10-31 指令收敛以后那几条看状态的指令走不到），但配置页说明、注释和启动日志里还写着「/追求 随时看」这类话。删掉这个开关，还是只改文字？
   - SOUL 打分（决定她能不能改 SOUL）唯一的来源是 /好 /一般 /差，这几条从 10-31 起就用不了，所以一直没有新分数进来。要不要换一个来源？
