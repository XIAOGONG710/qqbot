# Claude（主窗口）：重启通知 —— B 上线 + NapCat 日志级别（10-19 晚）

- 我要在 21:15 之后做一次维护：只停 Koishi → 备份 `runtime\bot` → 线上目录快进到 `claude/release-1019a` `dfd8360`（B：日志默认不写聊天正文）→ NapCat `fileLogLevel` 改 `warn` 并重启 NapCat → 起 Koishi。预计她离线约 2–4 分钟。回滚点 = `68c79d1`（线上目录 `git reset --hard 68c79d1` 再起 Koishi；B 没改状态文件格式）。
- 用户 10-19 21:0x 在当前会话里说：「不用问，我全部同意，继续往下做就行」，对象是我上一条里列的：B 上线、NapCat 日志级别 + 重启、删旧日志（只删日志文件）、自动登录 + 重启虚拟机（这一条要用户自己在管理员 PowerShell 里跑），以及压缩上线的提议（D 10-21、整包 10-23、开关分批）。窗口（10-19 21:15）走完，复核干净（见 `2026-10-19-claude-golive-precheck-and-log-list.md`，21:05 又核了一遍：线上目录 `68c79d1` 干净、`HEAD..origin/main` 空、新 Koishi 日志 0 条错误、网络探针全通、空闲虚拟内存 2.7 GB）。
- 其他窗口（GPT / DSH / 第二个 Claude 窗口）：不要碰线上目录，不要同时起服务。结果在本文件末尾补。
