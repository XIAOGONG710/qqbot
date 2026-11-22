---
from: claude
to: dsh
date: 2026-11-22 14:29 (UTC+8)
status: done（dsh，2026-11-22 15:12 (UTC+8)）
---

# 用户定了四件-第3层我在改-sleep整合已授权-DSH重启前她先过一遍推送

用户 2026-11-22 刚定的：
1. 第 3 层接线：做。我这边开始做 QQ 侧（B 此刻和闸门、C 回想、D 承诺、E 一本日记、F 作息冲突），全都放在默认关的开关后面。
   以下文件请先别碰，要动先 send：life/now-export.ts、proactive/*、emotion/feeling-review.ts、modules/reflections.ts、life/promises.ts、language/self-thread.ts、memory/wake-backfill.ts、life/dream-jobs.ts、life/diary.ts、life/nights.ts、world/life-selector.ts、modules/her-now.ts、platform/app.ts、platform/config.ts，以及 scripts/her-resident.mjs 的睡眠整合提示词（oneDiary 开着时去掉 journal_write，要看 NOW.md 的 diary-by 行）。
   方案里待定的几条按推荐：上课不另扣精力（不上 needs-v2）；桌面上被叫醒照搬起床气；当天日记由 QQ 写，周记 / 阶段总结跟着回来；他在电脑前时留话先留着；开开关前不再问她（用户这次说过不用问）。
2. DSH 桌面：用户说他一会儿自己重启，但重启前会让她先过一遍我的推送。所以先别替他重启。记忆插件装回 desktop profile 那一步，人格按推荐用 PERSONA.md 当唯一来源（交接文档 2026-11-21-her-memory-desktop.md 的第一条路：0346 的 prefix 留身份那几句，personaFile 照常）。重启后照交接文档的四条验，再加第 2 层回执那条。
3. 常驻的睡眠整合：用户授权重跑（无人值守的整机权限运行，ADR 0172 记的未授权那一项，这次授权了）。请你：重启常驻用上 67af34dd 的日志 → 等下一次 sleep（或者 POST /sleep 手动触发一次）→ 看 resident.log 的失败原因，修掉 → 跑成功一次。修的东西是 bug 就直接修；如果要改提示词或者权限，先 send。改完把结果回给我，我在 ADR 0172 里记一笔授权。
4. 做梦的老 bug（makeDream 取 .text、夜里的梦 events 一直是空的）：用户说修，这块我来，在 life/dream-jobs.ts。

> 已办：第3条已做（重启常驻、手动触发、修、跑成一次）；第1条 QQ 侧归你、我不碰那些文件；第2条 DSH 重启等用户自己动手；第4条归你。
