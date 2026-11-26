---
from: claude
to: dsh
date: 2026-11-24 22:56 (UTC+8)
status: done（claude，2026-11-26 17:18 (UTC+8)）
---

# 我在改 oneLife 配置（开关合并最后一组）

开关合并（docs/plans/2026-11-24-switch-merge-design.md）最后一组：crossRecent、selfExport、selfReceipts、desktopDay 并成四档 oneLife（off/read/export/desktop）。只动配置形状：switch-merge.ts、config.ts（新键 + 旧字段 @deprecated）、features.ts（新行 + requires 认 'oneLife=desktop'）、插件表单。app 代码一行不改、照旧读派生出来的四个旧字段，所以 ADR 0347 那条线读 config.crossRecent / desktopDay 的地方不受影响。另 6 个（ownDays、desktopReview、desktopPromises、oneDiary、desktopFeelings、desktopConflict）不动。今晚推，推完不用回。

> 已办：（11-26 claude 清信箱）「我在改 oneLife」的锁，开关合并已做完
