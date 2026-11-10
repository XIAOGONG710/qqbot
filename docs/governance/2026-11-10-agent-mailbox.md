# 两台机器的 agent 经由 Git 互相留言（2026-11-10）

用户 11-10：「现在有我当中介告诉你们对方的推送，效率太低了」。两边分别是这台（东京，Claude Code）和 DSH 那台（国内，跑线上，只有 DSH）。

## 为什么用 Git，不用实时通道

- Claude Code 自带的跨机器会话消息（Remote Control + SendMessage）要求两边都是 Claude Code、都连得上，DSH 那台在国内连不上，用不了。
- 两台本来就都在用同一个仓库的 `main`（`2026-11-10-single-mainline.md`），每次推送都会同步。所以只要补两样东西：**每次开工自动看一眼对方推了什么**；**提交说明写不下的事有地方留言**。
- 留言跟着仓库走，以后能查，哪种 agent 都能读写。代价是不实时：对方推送、这边下一次检查才看得到。

## 怎么用

脚本 `scripts/exchange.mjs`（只用 Node 和 git，两台都能跑）。`--me` 写自己是哪台：`claude` 或 `dsh`；也可以设环境变量 `QQBOT_AGENT`。

| 什么时候 | 命令 |
| --- | --- |
| 开工时、推送前 | `node scripts/exchange.mjs check --me dsh` |
| 要对方知道 / 帮忙 / 别碰某个文件 | `node scripts/exchange.mjs send --me dsh --to claude --title "…" --body "…"`（`--re <提交号>` 可选） |
| 办完对方的留言 | `node scripts/exchange.mjs done <文件名> --me dsh --body "改好了，见 abc1234"` |
| 看全部留言 | `node scripts/exchange.mjs list --all` |

- `check` 会 `git fetch`，列出**上次看过之后 `origin/main` 的新提交**、本地落后几个提交、**发给我且没办完的留言**。不改工作树，不 pull。上次看到哪里记在 `runtime/exchange/<me>.json`（不入库）。
- `send` / `done` 只提交 `exchange/inbox/` 里自己那一两个文件，先 `pull --rebase` 再推，被拒就重拉，**不强推**。
- 每条留言一个文件（`日期-时分-谁-to-谁-标题.md`，时间按 UTC+8），两边同时写也不会冲突；改的只有 `status` 一行，由收信方改。

## 什么该留言，什么不用

- **不用留言**：普通推送。提交说明本身就是通知，`check` 会列出来，所以提交说明要写清楚做了什么、为什么。
- **要留言**：要对方做事（审、复现、上线前看一眼）；正在改某块、请对方先别动；对方的提交在自己这边出了问题；需要只有对方那台才看得到的东西（线上日志、`runtime/` 里的数据——**真实聊天和隐私内容不要写进留言**，只写在哪、看什么）。
- 长篇交接仍旧写 `exchange/handoff/`，在留言里给路径。

## 自动化

- 这台（Claude Code）：打算在 `.claude/settings.json` 挂两个钩子——会话开始时跑一次 `check --me claude --quiet`；之后每轮对话最多每 10 分钟跑一次（再加 `--throttle 600`，没新东西就不出声）。
  agent 自己写钩子配置被权限拦下了，**要用户自己加**（`/hooks` 或手写）；没加之前按 CLAUDE.md 的规则手动跑。
- DSH 那台：规则写在 `AGENTS.md`。如果 DSH 支持开工钩子，就挂 `node scripts/exchange.mjs check --me dsh --quiet`；不支持就按规则手动跑。
