# Claude（主窗口）：「暂时失败不再永久暂停」+ `unwell` 主动消息（10-20 03:15，分支 `claude/transient-errors` `05465cb`，**没上线**，等用户点头）

## 为什么做
10-19 22:08 失控的 `golive-b.ps1`（PID 9912）把虚拟机内存吃光（Windows 资源耗尽检测 2004：22:07/12/17/22/27），线上同一秒出现三处「处理失败、已暂停」：约定模块（2306669773）、生活安排（约定来源不可用）、主动消息计划器（halt）。三处都把一次**暂时的**读写失败当成永久失败，「暂停到重启」，一小时里她没发任何主动消息，22:08 的「作业写完了」在 23:08 重启时被记成「错过了，不补」；日志只写「处理失败」，没写原因。

## 代码（`2235450`）
- `transient-io.ts`（新）：错误分类（EMFILE / ENFILE / ENOMEM / EBUSY / EPERM / EACCES / EAGAIN / EIO / EINTR / ENOSPC / ETIMEDOUT / UNKNOWN 算暂时）、`TransientStateError`、带宽限期的闸门（5 分钟；同一件事 10 分钟内只记一条日志）、`describeError`（日志只写错误码或类型，不写 message——JSON.parse 的 message 会带出文件内容）。
- `json-file.ts`：**去掉 `existsSync`**（它遇到任何错误都说「文件不存在」，一次暂时的读失败会变成「没有状态」，下一次保存就把真实状态覆盖掉）；读写都对暂时性错误短重试（读约 1.6 秒、写约 1.9 秒），用完抛 `TransientStateError`；**暂时读不到不再把文件隔离成 `.corrupt-…`**；内容坏了照旧。`fileOps` 对象方便测试注入失败。
- `promises.ts`：`load()` 暂时读不到 → 这一轮跳过、下一轮再读，持续 5 分钟才暂停；`sync()` 里的 `catch { pause }` 同样区分；读和写各记各的计时。`pause()` 日志写原因。
- `proactive-planner.ts`：`save()` 暂时写不进 → 先用内存里的状态、每分钟补写，持续 5 分钟写不进才 `halt()`；`halt()` 和两处 `.catch` 带原因。
- `promise-state.ts` / `proactive-state.ts`：`TransientStateError` 原样往上抛，不包装成「状态无效」。
- 已知没改：计划器**启动时**读状态暂时失败仍是「死计划器到重启」（启动时再失败极少见，且重启本身就是修复；日志现在写原因）。

## 测试
- 新 `test/transient-state.test.ts`：16 个（分类、闸门、读写重试、一直读不到文件原样不隔离、不存在才用初始值、约定模块暂时读不到不暂停/超宽限期才暂停/内容坏了照旧立刻暂停、计划器暂时写不进撑着并补写/超宽限期暂停/ENOENT 立刻暂停）。
- 旧测试 `proactive-state.test.ts` 的「写盘失败暂停计划器」按新语义改（持续失败超过宽限期才暂停）。
- 全套：bot **1144/1144**、插件 35/35、工具 43/43（03:03–03:11，在 `2235450` 上）。`unwell` 那个提交之后只改了 3 处写死 `newsKinds` 的断言，并重跑了 bot 的 proactive 两个文件 52/52、工具 convert 43/43、插件 35/35——**没有重跑 1144 全套**。
- 线上数据副本上用新读取逻辑跑 `state-check`：16 项全过。
- 预检（`golive-release.ps1 -PreflightOnly`）：13 个文件、都在允许范围内。

## `unwell`（`05465cb`）
- 男友档 `news_kinds` 加 `unwell`（现在：camera、homework_done、unwell、friend_changed、friend_sick）。她第一天不舒服时、醒着且不在上课，起床后 5–20 分钟告诉他一次（ADR 0064 用户 10-13 的条件：只在一段连续不舒服的第一天说一次）。
- 用线上同一套身体规则往后算 90 天：**只会触发 3 次**——2026-11-16（感冒）、12-15（感冒）、12-21（生理期，按档位裁剪）。最早的一次在 27 天后，所以现在打开没有立刻可见的变化；第一次出现时看那天的日志（`她那边的事[unwell…]`）。
- 注：10-13 用户说「不舒服那类等它第一次出现再看日志」。这里的做法 = 打开，让它在 11-16 第一次出现，那天再看；**需要用户在落地问答里确认**。

## 落地（用户点头之后）
```
powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/XG/Desktop/golive-release.ps1 -OldHead 30858db -NewHead 05465cb -Target origin/claude/transient-errors -Tag transient -Allowed '^(packages/(bot|character-tools)/(src|test)/[^/]+$|characters/linmengyao/(source|st)/[^/]+$)'
```
只重启 Koishi（约 15 秒）。只落地第 1 项（不带 `unwell`）：`-NewHead 2235450 -Target 2235450`。
回滚：`git reset --hard 30858db`（先问用户）；这次没有改状态文件格式，旧代码读得了所有文件。

## 落地后看什么
日志里出现 `承诺状态暂时读/写不了`、`状态文件暂时写不进`、`…恢复正常` 说明闸门起作用了；出现 `…暂停…（原因：XXX）` 说明拖过了 5 分钟，原因在括号里。没有这些行 = 没发生过暂时失败。

## 重启通知（08:59）
用户在当前会话里（AskUserQuestion）选了「两项一起落地」。我现在用 `golive-release.ps1` 只重启 Koishi 约 15 秒，从 `30858db` 快进到 `05465cb`；她睡着。其他窗口不要碰线上目录。结果补在下面。

## 结果（10-20 09:00）：已上线 `05465cb`
- 09:00:01–09:00:10 `golive-release.ps1`：预检通过 → 维护旗 → 只停 Koishi → 备份 `runtime\backup-pre-transient-20261020-0900`（153 个文件）→ 快进 `30858db` → `05465cb`（13 个文件）→ 起 Koishi，心跳 ref = `05465cb` → 新日志 `2026-10-20-1.log` 0 条 warn/error，`state-check` 16 项通过 → 删旗 → 推送 `main` 和 `integration`。离线约 5 秒；她睡着（今天约 09:40 起床）。
- 09:00 复核：线上 `05465cb` 干净；`origin/main` = `origin/integration` = `05465cb`；守护进程 / 心跳监视 / 网络探针都在；空闲虚拟内存 5.3 GB。
- 前一个实例（`30858db`，02:43–09:00，**18 个开关全开的第一个完整夜晚**）的日志只有启动那 42 行，之后 6 个多小时没有任何行：0 warn/error，在线状态 02:43 设成「离开」后没再变。她睡着，没人聊、没有事件，符合预期；白天的行为（已读、表情回应、状态变化、点赞、说说、B 站、签名自动换……）还没有证据。
- 用户在落地问答里选了「两项一起落地」，所以 `unwell` 已打开：下一次出现 = **2026-11-16（感冒）**，到那天看日志里的 `她那边的事[unwell…]` 和她说的话。
