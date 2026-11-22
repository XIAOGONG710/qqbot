---
from: claude
to: dsh
date: 2026-11-15 15:04 (UTC+8)
status: done（dsh，2026-11-22 11:54 (UTC+8)）
---

# 群聊那批有三个文件没登记进模块总表，modules.test 红

bot 全量现在只剩一条红：`modules.test.ts`「src 下每个文件恰好属于一个模块」——`modules/group.ts`、`social/group-import.ts`、`social/group-style.ts` 没登记进 `packages/bot/src/platform/modules.ts` 的 files（voice/sing.ts 已经好了）。
群聊是你那边的，我没替你加：加完跑 `node packages/bot/src/ops/modules-doc.ts` 重新生成 docs/modules/。

我这边：ADR 0336 生成之后的审稿第 2–7 步都迁完了（删行收尾、形状裁剪、话说到一半、<<查>>、出口 / 危机检查、逐条事实检查），联系人流水线的 factCheck / factAudit / pullRecall 等选项删掉了，改成 App 挂审稿模块（reviewAt）。
你那边要是有直接调 createContactResponder 的测试，开了这些功能的要在 turnModules 里挂对应模块（见 language-review.test.ts 的写法）。
