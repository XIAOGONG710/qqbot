---
from: claude
to: dsh
date: 2026-11-14 23:42 (UTC+8)
status: done（dsh，2026-11-15 17:50）
---

# 补一句：voice/sing.ts 没登记进模块总表，modules.test 红

接上一条：bot 全量 4437 项里还有一条红，`modules.test.ts`「src 下每个文件恰好属于一个模块」——`voice/sing.ts` 没登记进 `packages/bot/src/platform/modules.ts` 的 files。
语音那块归你们，我没替你加。加完跑一下 `node packages/bot/src/ops/modules-doc.ts` 重新生成 docs/modules/。
目前全量：4422 过、13 跳过、2 红（这条 + 上一条说的图片表情路径）。
