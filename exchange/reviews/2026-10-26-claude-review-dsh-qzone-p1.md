# 2026-10-26 Claude 复核：`dsh/qzone-p1`（`f8f9ed6`，DSH 11:06）

- 对象：DSH 在我 10:55 交接之后推的 `dsh/qzone-p1`，一个提交，叠在我的 `claude/qzone-probe-fixes`（`66a7e42`）上。它改的是我交接里的 **P1**（`get_cookies` 在 `read` 档，`qq-admin` 会把 cookie 打到终端）。
- 结论：**P1 修对了，可以合进 `main`。** 合并不需要重启（只加 / 删代码，新开关默认全关）。

## 我在 VM 上独立跑的（10-26，占重活锁，临时工作树检出 `f8f9ed6`，不碰线上目录）

| 项 | 结果 |
| --- | --- |
| `tsc`：`packages/bot`、`packages/koishi-plugin-qqbot` | 都干净 |
| 账号 / 空间（含 `qzone-feeds3`）/ 开关 / 模块 8 个测试文件 | **52/52**（比 `66a7e42` 的 51 多一条，就是 DSH 新加的 P1 测试） |
| `app.test.ts` | **85/85** |
| `node scripts/qq-admin.ts actions`（纯本地列登记表） | 53 个（原来 54），`get_cookies` 0 处 |
| `git merge-base --is-ancestor origin/main origin/dsh/qzone-p1` | 是（已含最新 `main` `6169551`） |
| 试合并 `claude/social-accounts` 到它上面（`git merge-tree`） | **干净，没有冲突文件** |

## 改动本身（3 个文件、+16 −2）

- `account.ts`：从 `ACCOUNT_ACTIONS` 摘掉 `get_cookies`。你的两条读空间路径（`index.ts` 里的 `readUserQzone` / `readStrangerFeed`）是进程内直接 `_get('get_cookies')`，不经登记表，**不受影响**（我 grep 了整个分支，`get_cookies` 只剩这两处 + 探针脚本 + 测试 + 注释）。
- `account.test.ts`：新增 `登录态不进控制面（P1）`：不在登记表里；`check` 被拒；`run` 抛「没登记」。
- `scripts/qq-admin.ts`：动作名匹配 `/cookie|csrf|token|skey|ticket/` 的，返回值不回显，只报「含登录态，不回显」。这是第二层兜底。

## 小意见（不挡合并）

1. **`qq-admin` 那层兜底现在是死代码、而且没有测试**：`get_cookies` 一旦不在登记表里，`account.run` 在到达它之前就抛了。要么给 `runAdmin` 加一条用假登记动作走到那一行的测试，要么删掉这层（登记表本身已经是闸）。另外「已用」两个字读不懂（非数组时显示的那个），建议改成「已省略」之类。
2. **`scripts/qzone-strangers-probe.ts:45` 会打印 `g_tk`**。它是从 `p_skey` 算出来的 CSRF 值，不是 cookie 本身，但同一个会话里它和 cookie 配套有效；探针输出会进终端 / 对话记录，建议只打印「g_tk 已算出」。（`uin` 是机器人自己的号，沿用文档里已有的做法，没问题。）

## 还开着的（我交接里的 P2、P4、P5，这次推送没动，不是遗漏）

- **P2**：`qzoneBrowse`（0142）和 `qzoneStrangers`（0144）在这个账号上读不到（我 10-25 真机探针：NapCat 无读空间动作；陌生人推荐流读不到）。开关保持关，别为了「功能齐」去开。`qzonePeek` 现在走我的 ADR 0145（好友动态流 `feeds3_html_more`），这条才是实测能读的。
- **P4**：陌生人正文不脱敏就进提示词和 `presence/strangers.jsonl`——按 P2 这条线本来就读不到，留着关。
- **P5**：`qqFriendGate: all` 会替用户静默驳回名单外所有好友申请；只用 `allow`。

## 合并顺序（建议）

1. `dsh/qzone-p1` → `main`（含 `66a7e42` 的 3 个探针修复 + P1；用户一句话）。
2. 然后 `claude/social-accounts` → `main`（纯新增；试合并无冲突）。
3. 之后才轮到 VM 上的只读盘点（`qq-account-probe.ts`）和社交账号的接线。

**下一步唯一的动作：用户说一句「合 `dsh/qzone-p1`」。** 合之前我（或 VM 上的会话）按红线 4（线上目录快进前先 `git log HEAD..origin/main` + `git diff --stat`）核对，快进后线上目录的**代码**要等下一次重启才生效；这次合并没有任何开关默认开，所以不需要重启。
