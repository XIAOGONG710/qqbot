# Claude（主窗口）：D 上线的准备（10-20 02:10，没有重启、没有动线上）

- 用户 10-20 02:0x 在当前会话里（AskUserQuestion）选了「只准备脚本，10-21 再问上线」。所以这里只有脚本和检查，**D 还没有上线，上线前还要用户在当前会话再点一次头**（BOARD 规则②）。
- 脚本：`C:\Users\XG\Desktop\golive-release.ps1`（纯 ASCII；带参数，默认 = D：`claude/release-1019b` `4df3142`，线上现在 `dfd8360`）。只停/起 Koishi，不动 NapCat 和 Hindsight；流程 = 预检 → 维护旗 → 停 Koishi → 备份 `runtime\bot` → 快进 → 起 Koishi → 心跳 + 日志 + state-check → 删旗 → 推 `main`/`integration`。`-PreflightOnly` 只跑预检。
- 试跑：02:09 用 `timeout 60` 只跑预检，2 秒通过（21 个文件都在允许路径内、空闲虚拟内存 5.4 GB），线上 `dfd8360` 干净、无维护旗。**B 那次的教训照办：先试跑再交给用户 / 自己跑。**
- 和 B 脚本的区别：D 的改动不只在 `packages/bot/(src|test)/`，还有 `docs/adr/0068-crisis-response.md` 和 4 个 `packages/bot/sim/crisis-level-*.json`，所以允许路径放宽到 `packages/bot/(src|test|sim)/` + 那一个 ADR；没有 NapCat 步骤。
- **回滚注意（D 特有）**：D 把 `crisis.json` 升成第 2 版（`{version:2, contacts:{qq:{at,level}}}`）；旧代码读它用 `invalid: 'throw'`，读到新格式 Koishi 会起不来。线上现在**没有** `crisis.json`（从未记录过危机），D 上线后只有真触发过一次危机才会写出来。回滚到 `dfd8360` 前：先看 `runtime\bot\crisis.json` 在不在、有没有 `version`；有就从备份目录还原那一个文件（或移走），再起旧代码。
- 输入修复（ADR 0080/0081 等）**不在** `release-1019b` 里（B→D 的 21 个文件里没有）；计划里「D 和输入修复同一次重启」要上的话得另合一个候选，上线前再单独核对。
- 观察窗口：B 的 48 小时到 10-22 02:04；D 在 10-21 上是按用户批准的压缩计划提前（B 观察不满 48 小时），上线时问用户时要说明这一点。
