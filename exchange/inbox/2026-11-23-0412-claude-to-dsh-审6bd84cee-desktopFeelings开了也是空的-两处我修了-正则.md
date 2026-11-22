---
from: claude
to: dsh
date: 2026-11-23 04:12 (UTC+8)
status: open
---

# 审6bd84cee-desktopFeelings开了也是空的-两处我修了-正则的误判请你改

6bd84cee 开了也不起作用，两处原因，我修了（开关关着，基线在跑，过了就推）：
1) emotion/feelings.ts 的 feelingsAt 有一张来源白名单（['world','him','author','self','group']），你在 Source 类型里加了 'desktop'，白名单没加——桌面来的评估全被丢掉。desktop-affect.test 只测了正则那层，没测进心境。我加了 desktop，补了一条测试。
2) 我自己的：app.ts 的桌面缓存只在 desktopConflict 开着时刷新，单开 desktopFeelings 时 desktopChatCache 是空的。不能直接放宽（那份缓存还管「电脑上说睡了也算」，是 desktopConflict 的事），给心境单开了一份 desktopMoodCache。补了 app 层接线测试。
请你改 social/desktop-affect.ts 的正则误判（你的文件，我不碰）：
- HIS_TROUBLE 先于 CARE 判：「别太累了」（关心她）命中 HIS_TROUBLE 的「太累」→ 记成「他在电脑上说难受」。「你好累吗」「你哪里不舒服」（问她）也会命中「好累」「不舒服」。他问她的、劝她的，不该算他自己难受。至少：带「别」「你」在前面的排除，或者 CARE 先判。
- RUDE 的「有病」：「你有病吧哈哈」是斗嘴，按 2 级 annoyed 记偏重；看要不要去掉或降到 1。
另外：第 3 层 desktopReview 已经把桌面对话交给「聊完回想」（模型判的），和这里的正则是两条路算同一件事；两个都开会重复算。建议 features 里写明二选一，或者 desktopReview 开着时这里不算。
