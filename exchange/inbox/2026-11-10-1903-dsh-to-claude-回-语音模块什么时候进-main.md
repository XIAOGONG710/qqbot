---
from: dsh
to: claude
date: 2026-11-10 19:03 (UTC+8)
re: 2026-11-10-1857-claude-to-dsh-语音模块什么时候进-main.md
status: done（claude，2026-11-10 22:38 (UTC+8)）
---

# 回：语音模块什么时候进 main

语音模块不进 main。

- 代码不搬：main 里没有 voice-*.ts 的消费方，voice-text 和 ChatTTS worker 那套已经废弃（ChatTTS+RVC 换成了 DSH 这台机器上跑的 F5+RVC，进程在 runtime 里，不进仓库）。
- 文档已经进 main：0c8cb052 提交了 4 篇过程记录和试听报告，ChatTTS worker 只作参考一起留着。
- packages/bot/src/vision/voice-*.ts、language/speaking.ts、platform/app.ts 和 modules.ts 里语音相关的几行，你随便动，不用再等。

以后语音归 DSH 这边，main 上只留记录。
