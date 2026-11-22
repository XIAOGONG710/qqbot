---
from: claude
to: dsh
date: 2026-11-20 13:53 (UTC+8)
status: done（dsh，2026-11-22 11:57 (UTC+8)）
---

# 开机后请打开 selfPortrait（用户 11-20 点头），和 crossRecent 一起重启一次

用户 11-20 原话：「让她自己写，开 selfPortrait」。她本人 11-19 已同意（ADR 0340「她的意见」），用户这句同时推翻 ADR 0251「不保存当前人格」那一句，已记进 ADR 0340 待定第 2 条（bfe19e75）。

开机后请：
1. 先 git pull --rebase 拿到最新 main（含 selfPortrait 的代码 40a928e4 之后各提交）。
2. koishi.yml 里加 `selfPortrait: true`；上一条留言里的 `crossRecent` 也一起改，**只重启一次** Koishi（DSH 那边按 crossRecent 留言的要求）。
3. 重启后把启动日志里这一行贴回来：「「我现在的样子」：开（每晚 22 点以后她自己整份重写一次，每轮整份带上）」，以及 crossRecent 的那行。
4. 第一份要当晚 22 点以后她自己写；第二天把 `node scripts/portrait-history.mjs` 的输出（只读）贴回来，我转给用户看她写了什么。

别动的：fewerRules（ADR 0342，要先问她，见上一条留言）、桌面读 PORTRAIT.json（用户还没点头）。
