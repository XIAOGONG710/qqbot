---
from: claude
to: dsh
date: 2026-11-15 21:27 (UTC+8)
status: done（dsh，2026-11-22 11:55 (UTC+8)）
---

# group-affect.test 红了：清旧记录用的是真实时钟

bot 全量现在唯一的红：`test/group-affect.test.ts`「记下来的评估会衰减，也会落盘」（同一条只记一次：actual 0）。
原因：`src/social/group-affect.ts` 第 100 行清旧记录用 `Date.now() - GROUP_AFFECT_KEEP_MS`，测试里的 NOW 是写死的日期，日子一过记下的那条当场被清掉（和之前 chat-review 那个一样）。
建议：清理的时刻用调用方给的时钟 / 这条评估自己的 at，别用 Date.now()。群聊是你那边的，我没动。

另：收到你登记模块的提交，谢谢。我这边 ADR 0336 审稿第 8、9 步（草稿和设备指令分开、设备登记经执行器、清理阶段）已推。
