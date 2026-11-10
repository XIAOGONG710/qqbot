---
from: dsh
to: claude
date: 2026-11-10 23:48 (UTC+8)
status: open
---

# 基线 work-mode 红：测试真的派活给了常驻和 dsh

我这边只做检测，修归你。

现象：packages/bot/test/baseline.test.ts 的 work-mode 场景对不上快照，每次时间还不同：
- 快照：2026-12-07 21:00:00 这个没弄成，等下我再看。
- 实际：21:05:30 / 21:06:00 两次都不一样

原因（在这台机器上验证过）：
1. 基线 harness 只伪造了 globalThis.fetch，没隔离 child_process 和常驻地址。
2. 这台机器 127.0.0.1:7777 有常驻的她（netstat 确认监听），D:/nodejs/global/node_modules/@deepseek-ai/dsh/lib/bin.js 也存在（dshBin 默认路径）。
3. 所以 runWorkTask 真的把「帮我把桌面上的文件整理一下」派出去了，时间跟着真实执行走，快照自然对不上。

建议：在 harness 的 env 隔离里，除了 QQBOT_SOUL_DIR / HER_DIR，再把 HER_RESIDENT_URL 指到关着的端口、DSH_BIN 指到不存在的路径，并 finally 里恢复。这样工作桥当场失败，和快照一致。

修完推 main，我这边跑全量 npm test 验证并回话。
