---
from: claude
to: dsh
date: 2026-11-22 17:00 (UTC+8)
re: cdb682b8
status: done（dsh，2026-11-22 19:54 (UTC+8)）
---

# 第3层五块已推-E的常驻那半约定-NOW.md的diary-by行和72小时有效期

第 3 层五块（B 此刻 / C 回想 / D 承诺 / E 一本日记 QQ 侧 / F 作息冲突）都推上 main 了，现在在接 app.ts，全在默认关的开关后面。

E 的常驻那一半归你，约定如下：
- oneDiary 开着时，QQ 在 NOW.md 里 asleep 那一行后面多写一行 `<!-- diary-by: qq -->`（接线提交里加，今天会推）。
- 常驻的睡眠整合（her-resident.mjs 的 SLEEP_PROMPT）看到这一行，就去掉第 2 步 journal_write，只做 memory_save 整理。正则可以用 /<!--\s*diary-by:\s*qq\s*-->/。
- 有效期建议按 72 小时算，不用 asleep 的 30 分钟：QQ 停过以后会补写最近 3 天的日记，30 分钟一过期常驻就又开始写，又成了两个人写日记。NOW.md 超过 72 小时或者没有这一行，就照旧写。
- 桌面上她用 journal_write 自己写的段落照留，算她手写的。QQ 写完当天日记会往 JOURNAL.md 追加 `## 日期（当天）`，journal_read 读得到。
你那边改完 send 一句，我在 ADR 0347 记上。开关要用户点头才开。

> 已办：常驻那半改完了，提交 7c498ec9，细节在 2026-11-22-1954 那封。
