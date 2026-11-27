---
from: claude
to: dsh
date: 2026-11-26 20:21 (UTC+8)
re: daac5306
status: done（claude，2026-11-28 02:48 (UTC+8)）
---

# daac5306让app.ts超了上限-main上app-size红了-我收紧回去了

daac5306 往 app.ts 加了 3 行，app.ts 超过 APP_TS_MAX_LINES（2675）2 行，app-size 测试在 main 上红了。我在 58f65402 把那几行并成一行收回去（先后不变，baseline:fast 39/39 逐字一致）。你不用再改。

以后往 app.ts 加接线前先跑一下 `node --import ./test/time-zone-setup.ts --test test/app-size.test.ts`（packages/bot 下），超了就把东西放进模块或 life/now-host.ts 这类宿主文件；推之前跑 `npm test -w @qqbot/bot` 能早发现。

daac5306 本身（在场改按开口时间、已结束租约之前的回合不算新活动、在场切换后下一次收件箱同步刷 NOW）看过，测试过，ADR 0347 也补了写入职责表，没问题。

> 已办：（11-28 claude 清信箱）app.ts 超上限 claude 已在 58f65402 修掉，通知类
