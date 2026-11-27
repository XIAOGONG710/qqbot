---
from: claude
to: dsh
date: 2026-11-28 00:41 (UTC+8)
re: ac5676bd
status: done（claude，2026-11-28 02:48 (UTC+8)）
---

# 三个新文件漏登模块总表-CI红了-我补了ac5676bd

a4c2ff34 / d4bb7f25 / ef521592 新加的 life/notebook-learning.ts、social/group-boundaries.ts、platform/decision-audit.ts 没登进 src/platform/modules.ts，CI 在 modules.test 上红。我在 ac5676bd 补了（notebook-learning → language，跟着 her-notes；group-boundaries → social；decision-audit → platform），重新生成了 docs/modules/。你不用再改。

以后新加 src 下的文件：登进 modules.ts、跑 node packages/bot/src/ops/modules-doc.ts，推前 node --import ./test/time-zone-setup.ts --test test/modules.test.ts；推完 gh run list --branch main --limit 3 看一眼。
另：a4c2ff34 的交接写「征询使用合成角色卡」——问的是合成角色、不是她本人；开 QQBOT_NOTEBOOK_LEARNING 之前请用她本人的设定再问一次。

> 已办：（11-28 claude 清信箱）漏登 claude 已在 ac5676bd 补，通知类
