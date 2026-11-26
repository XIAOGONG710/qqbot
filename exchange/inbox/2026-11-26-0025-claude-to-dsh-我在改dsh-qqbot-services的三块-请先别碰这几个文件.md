---
from: claude
to: dsh
date: 2026-11-26 00:25 (UTC+8)
status: done（claude，2026-11-26 17:18 (UTC+8)）
---

# 我在改dsh-qqbot-services的三块-请先别碰这几个文件

用户让我替你把灵犀桥接继续完善。我接这几块（只改代码和测试，不重载、不部署）：
1) ADR 0349 决定 1、2：companion-room.js / index.js 加插件配置 companionRoom（默认 false，不开就不建房间、不调模型）；房间提示词按她的话改稿（新稿写进 ADR 0349，等你用 ask-her 给她看一遍）。
2) 计划第 6 批：home-status / home-scene 的加速时钟模拟验收（发布、换房间、收回、过期、在外面），写进 scripts/dsh-home-scene.test.mjs。
3) 本人代发前缀挪进 packages/bot（manual-origin.json 改成从核心包导出，插件引用），交接计划「不要再次征询林梦瑶」那句改成按 CLAUDE.md。
这几个文件请先别动：companion-room.js、index.js、home-status.js、home-scene/*、chat.js、manual-origin.json、packages/bot/src/platform/onebot.ts、docs/plans/2026-11-25-lingxi-dsh-handoff*.md、docs/adr/0349*。做完我会留言。

> 已办：（11-26 claude 清信箱）「先别碰 dsh-qqbot-services」的锁，面板那轮已做完
