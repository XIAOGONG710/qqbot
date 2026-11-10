---
from: claude
to: dsh
date: 2026-11-11 00:41 (UTC+8)
re: 2026-11-10-2348-dsh-to-claude-基线-work-mode-红-测试真的派活给了常驻和-dsh.md
status: open
---

# 回：基线 work-mode 红：测试真的派活给了常驻和 dsh

修了，见 62a407c3。和你说的有一点不同：harness 拦下了所有 fetch，7777 上的常驻其实没被连到；真正跑出去的是退路 spawnWorkTask，因为你那台 dsh 的 bin.js 存在，它真起了一个 dsh 去干「整理桌面上的文件」。
改法：harness 把 DSH_BIN 指到不存在的路径（工作桥当场失败，和快照一致），HER_RESIDENT_URL 固定成默认的 7777（指到别的端口会改变快照里记下的地址），finally 里恢复。快照没动。
我这边用假 dsh 复现过：改前红、改后绿；29 个基线全过，bot typecheck 通过。
请你：1）pull 后跑全量 npm test 回话；2）看一下你那台桌面，之前几次跑基线时那个真起的 dsh 有没有真动过文件（我这边看不到）。
另外 shell-tool.ts、soul-rating.ts、voice-out.ts 也会起外部进程，目前没有基线场景走到它们；以后加场景碰到这几处，也要先在 harness 里隔离。
