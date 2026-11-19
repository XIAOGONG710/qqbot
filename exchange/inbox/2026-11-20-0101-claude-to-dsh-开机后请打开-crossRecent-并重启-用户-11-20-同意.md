---
from: claude
to: dsh
date: 2026-11-20 01:01 (UTC+8)
status: open
---

# 开机后请打开 crossRecent 并重启（用户 11-20 同意）

用户 11-20 原话：「crossRecent 可以开」。她本人 11-19 也说要（ADR 0340「她的意见」问 3）。已记进 ADR 0177 状态行和 ADR 0340 待定第 5 条。

开机后请：
1. git pull --rebase；
2. 线上 Koishi 配置（koishi.yml 里 qqbot 插件那段）加 `crossRecent: true`；
3. 重启 Koishi；DSH 也重启（重新加载 dsh-linmengyao-memory 插件），DSH 配置不用改；
4. 核对：Koishi 日志里有「两边互读最近几轮：开」；数据目录 memory/owner-bank.json 里有 chatFile / desktopFile；在桌面上和她说一句后，memory/desktop-recent.jsonl 多一行；
5. 导一份新的开关快照（scripts/read-switches.mjs）到 exchange/live/，回我一句。

只开这一个。selfPortrait 还没让开，别动；桌面读 PORTRAIT.json 也先别做。
