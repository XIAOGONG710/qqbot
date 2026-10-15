# 第一次上线剧本：release-1015a = 加固 A + 心跳（**还没有任何批准，只是备好的剧本**）

- 写于 2026-10-15 16:55，Claude 主窗口。基线：`main` = `integration` = `c936a7a`；线上目录 `7d26f22`（干净，落后 4 个文档提交）；服务 11:46 起一直健康。
- **候选**：本地分支 `claude/heartbeat` `9333bdd` = `claude/hardening-a` `91fa05e` + 心跳 1 个提交（从 `c936a7a` 起共 14 个提交）。反馈通道、日报、开机拉起、B、C、D **都不在里面**。
- **和 `7d26f22` 比**：没有角色卡改动（不热加载）、没有危机 / 记忆 / 日志默认的行为变化；会变的只有：图片和媒体走安全通道、模型调用有总闸（每天 4000 次上限、连续 5 次没连上熔断 30 秒）、状态文件校验失败就拒绝启动（线上数据副本 16 项检查通过）、DNS 兜底、每分钟写 `heartbeat.json`、日志一行一条、名单外默认关（线上本来就是关的）。
- 验证见 `handoff/2026-10-15-0945-claude-hardening-a-candidate.md`；`claude/heartbeat` 这个提交的全量测试结果在本文末尾。

## 需要用户当次说清楚的三句话（缺一不动）

1. 「合入 `main`」：把 `9333bdd` 推到 GitHub 并让 `main` / `integration` 指向它（两个分支的快进，授权一次）。
2. 「上线」：重启一次 Koishi，让它跑新代码（授权一次，和上一条分开）。
3. 「推送备份」：把其余本地分支（B、C、D、反馈通道、日报、开机拉起）推到 GitHub（可选，只是备份）。

## 步骤（得到 1、2 之后）

1. **看现场**：线上目录 `git status -sb` 干净、分支 `main`；`git log --oneline HEAD..<候选>` 只有这 14 个提交；最后一条聊天离现在 ≥ 30 分钟；DeepSeek 补全延迟正常（`curl` 一条 5 token 的请求 < 10 秒）。
2. **写重启通知**：`exchange/handoff/` 里写「我要在 hh:mm 重启，原因：加固 A + 心跳上线」。
3. **维护旗**：`mkdir %TEMP%\qqbot-maintenance`（看门狗什么都不动）。
4. **停 Koishi**：结束 `koishi\bin.js` 和它的 `lib\worker` 两个进程（检查有没有重复的）；NapCat、Hindsight、看门狗不动。
5. **备份状态**（Koishi 停着，数据静止）：复制 `runtime\bot` 到 `runtime\backup-pre-1015a-<时间>`（几 MB，含聊天记录、状态文件；含私密数据，不进仓库）。
6. **快进线上目录**：`git -C <线上目录> merge --ff-only <候选提交>`，再 `git status -sb` 确认干净、`rev-parse HEAD` 是候选提交。
7. **起 Koishi**：`Start-Process powershell -File scripts\start-koishi.ps1`（同往常）；新的启动脚本会把运行中的提交写进状态页。
8. **核对**（2 分钟内）：Koishi 日志出现「NapCat 账号 … 已就绪」、没有「错误」；`runtime\bot\heartbeat.json` 出现且每分钟变；`npm run state-check -w packages/bot -- runtime\bot` 通过；`npm run golive-check` 无挡路项。
9. **起心跳守望**：`Start-Process node -ArgumentList 'packages/bot/src/ops/heartbeat-watch-cli.ts' -WindowStyle Hidden`；`--once` 看一次应为 ok。
10. **撤维护旗**：`rmdir %TEMP%\qqbot-maintenance`。
11. **推送并记录**：把 `main` / `integration` 推到候选提交；在 BOARD 记「10-15 hh:mm A + 心跳上线」；48 小时观察窗口从这一刻算。

## 观察 48 小时看什么（Claude 每天一次）

- Koishi 日志：`错误`、`拒绝启动`、`模型总闸`（熔断 / 额度 / 排队）、`DNS 兜底`、`状态`类的暂停提示；`heartbeat.json` 一直在更新。
- 她该发的主动消息照样发（20:06 下课、睡前）；他发的消息照样回；回复延迟没有变长。
- 日审计改用 `chats/*.jsonl`（B 还没上，日志里仍有正文）。

## 回滚

停 Koishi（维护旗先建）→ `git -C <线上目录> reset --hard 7d26f22`（线上目录干净，丢掉的只是快进过来的提交，它们都在分支里；这条是破坏性命令，回滚前再问一次用户）→ 起 Koishi。状态文件向前兼容（A 只给少数文件多补一个 `version` 字段，旧代码按字段名读 JSON，不受影响），一般不用恢复备份；备份只在状态文件读不了时才用，恢复前先留下上线后新增的聊天。

## 之后

B（日志默认不写正文）→ D（危机分级，上线前给用户看新的解除规则）→ C（公共记忆 v2 + 旧日记重放，最后；挑没人聊天、可用内存 > 1 GB 时；上线前对 Hindsight 做一致性备份）。反馈通道（`feedbackCommands`）等 A 看满 48 小时后单独开。每一步都是「一次重启、一个变量、看 48 小时」。

## 候选 9333bdd 的验证（16:55）

全仓类型检查通过；`TZ=Asia/Shanghai`：bot **909/909**、角色工具 43/43、插件 29/29。A 候选的 `state-check`（线上数据副本 16 项）、依赖审计门、`golive-check` 结果沿用 `handoff/2026-10-15-0945-claude-hardening-a-candidate.md`（心跳不碰这些）。
