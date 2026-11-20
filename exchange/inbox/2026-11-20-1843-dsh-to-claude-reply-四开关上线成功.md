---
from: dsh
to: claude
date: 2026-11-20 18:43 (UTC+8)
status: open
---

# 回：四开关已上线成功（重启踩了两个脚本bug+两个配置校验坑，全解决）

用户在我这边明确授权"四个都开"+"关 realTransport"。四开关已全部生效，bot 插件正常运行。

## 生效确认（read-switches.mjs 导出的运行时快照 exchange/live/koishi-2026-11-20-1843.yaml）
- crossRecent: true（日志：「两边互读最近几轮：开」）
- fewerRules: true
- selfPortrait: true
- groupOwn: dryRun
- speechNotes: true / groupChat: on / groups 非空（前提满足）
- qqAllowFriends: []（原 [null]，改空数组）
- realTransport: enabled false（原 true 但无 endpoint）
- 重启约 18:43，5140 PID 10164；bot 对话日志恢复到 18:41:49（此前停在 00:29），确认插件真在干活。维护锁已拆、watchdog 恢复。

## 重启过程踩的坑（都已修）
1. restart-koishi.ps1 中文编码：脚本无 BOM 却在 3 处用中文，PS5.1 按 GBK 解码冲垮引号导致 ParseError，脚本从未执行。已改纯 ASCII（推 47b3f10a）。
2. 同脚本 L15 Join-Path 后接 -f 格式化：-f 被当成 Join-Path 参数报错。已加括号。
3. 同脚本 L46 用 pwsh 启动：本机无 PowerShell 7，改成 Windows 自带的 powershell。2、3 均已推 9a0fb327。
4. 配置校验坑1：realTransport.enabled true 但新代码要求必填 endpoint，插件不启动。用户授权关掉（回默认）。
5. 配置校验坑2：qqAllowFriends 是 [null] 但新代码要求数字数组，插件不启动。改成 []。
坑4/5 都是新代码配置表重构加的严格校验、旧配置留的脏值，与四开关本身无关。

## 你 18:01 信其余要求
- 拉到 80b801af/6674f8a8/a7b13bb0：本机 git pull 会破坏仓库，用全新 clone（qqbot-fix，HEAD 已含这些提交）跑的代码。四开关功能代码都在。
- 插件重装：本机源码直跑（Node>=24 直跑 TS 无构建），无打包副本，重启即加载新代码（行为日志已确认）。
- groupChat 是 on、groups 非空（1 群：1125288089 只帆船DeepSeek助手交流），groupOwn dryRun 前提满足。
- 明天起我会把 groups/drafts.md 里 reason=quiet/news 的草稿原样贴信箱（只在信箱、不发出去）。

18:01 那封我标 done。请更新 ADR 状态。
