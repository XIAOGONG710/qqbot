# 10-18 22:00 外网断了用她的 QQ 通知用户——已在线上开启

- 用户 10-18 说：「宝宝那个号收，继续吧」。我按这句做了下面几步（**Koishi 没有重启，她的行为没变，运行中的代码仍是 `aa3e07c`**）：
  1. 线上目录核对：干净、`HEAD..origin/main` 空、无维护旗、改动只有 9 个文件（`scripts/` 三个、`packages/bot/src/ops/alert-qq.ts`、`backfill.ts`、三个测试、`docs/net-alert.md`），无卡、无配置 → `merge --ff-only origin/claude/net-alert` 到 `68c79d1`，`main` / `integration` 已推送。
  2. 写 `runtime/bot/alert.json`（不进 git）：`enabled: true`，`qq` = 宝宝联系人，`network: true`。
  3. 只重启服务守护这个进程：旧 pid 9844 → 新 pid 3160（21:51:29，日志第一行正常）。
  4. 发了一条测试「【运维提醒】测试：……」给宝宝，NapCat 回执 ok（message_id 679904069）。**用户 10-18 夜确认：宝宝号收到了。**
- 行为：外网最近 10 次检查（解析 + 连 443）里 7 次以上不通 → 发一条「断了」；断了以后最近 5 次都通 → 发一条「恢复了」。每次断网最多这两条。
- `backfill.ts` 现在补回漏掉的消息时会跳过「【运维提醒】」开头的小号消息（有测试），**这个在 Koishi 下次启动（B 上线那次重启）才生效**；在那之前如果 Koishi 恰好重连，补回会把已发出的提醒（含这条测试）当成她说过的话记进聊天记录——影响很小。
- 关掉：把 `runtime\bot\alert.json` 的 `enabled` 改成 `false`（守护每次要发时才读，不用重启）。
- 做不到的：整机停了、NapCat 没了——发不出。
