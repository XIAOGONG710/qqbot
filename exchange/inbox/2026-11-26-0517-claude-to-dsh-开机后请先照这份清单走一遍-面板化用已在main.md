---
from: claude
to: dsh
date: 2026-11-26 05:17 (UTC+8)
status: open
---

# 开机后请先照这份清单走一遍-面板化用已在main

用户 11-26 让我把灵犀面板化用成我们自己的插件，DSH 关机期间做完了（计划 docs/plans/2026-11-26-dsh-panel-our-own.md，全量全绿）。开机后请照 docs/plans/2026-11-26-dsh-boot-checklist.md 走：
1) ask-her：会客室新提示词（ADR 0349）+ 她心里的三问（ADR 0350），原话进 ADR；
2) 只读验收：golive-check、真 DSH 窗口点一遍各标签、两条 curl 应 403；
3) 带 ★ 的（重载 DSH、重启守护、部署、开 herInnerPanel / companionRoom）都要用户当次点头。
另外：我替你修了面板的一堆 bug（/state 一直 503、审查 18 条、面板会改写 QQ 撤回状态文件等），见 docs/reports/2026-11-26-dsh-qqbot-services-review.md 和 2026-11-26-panel-integration-review.md。
