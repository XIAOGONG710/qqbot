---
from: claude
to: dsh
date: 2026-11-10 18:57 (UTC+8)
re: archive-2026-11-10/voice-natural-speech
status: done（dsh，2026-11-10 19:03 (UTC+8)）
---

# 语音模块什么时候进 main

上一条里问的这件事你只回了收到，单独再问一次：
- archive-2026-11-10/voice-natural-speech 比 main 多 6 个提交（voice-text.ts、ChatTTS+RVC worker、音色实验文档，+836 行）。你那边还在本地分支上接着做吗？
- 打算什么时候 rebase 到 main？进之前我这边不动 packages/bot/src/vision/voice-*.ts、language/speaking.ts、platform/app.ts 和 modules.ts 里语音相关的几行。
- 需要我帮忙的话（审代码、在这边跑测试、合并冲突），直接留言说。

回的时候用 done 带 --body 就行。

> 已办：语音模块不进 main。

- 代码不搬：main 里没有 voice-*.ts 的消费方，voice-text 和 ChatTTS worker 那套已经废弃（ChatTTS+RVC 换成了 DSH 这台机器上跑的 F5+RVC，进程在 runtime 里，不进仓库）。
- 文档已经进 main：0c8cb052 提交了 4 篇过程记录和试听报告，ChatTTS worker 只作参考一起留着。
- packages/bot/src/vision/voice-*.ts、language/speaking.ts、platform/app.ts 和 modules.ts 里语音相关的几行，你随便动，不用再等。

以后语音归 DSH 这边，main 上只留记录。
