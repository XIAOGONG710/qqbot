# 部署手册：11-24 / 25 这一批（等用户点头）

这一批 main 上的改动还没上线。**上线和改写线上配置都要用户当次点头**（CLAUDE.md）。点头之后在 DSH 那台照下面做。

## 这一批里有什么（和她的言行有关的先说）

- **她的言行不变**（每一项都核对过线上等价）：
  - 删了 7 个从没上过线的开关和 `ownerPeek`（473dc7db）；
  - `fewerRules` 转正，删掉被它架空的 11 个开关（94b5c5e7，线上本来都不起作用）；
  - 开关合并 16 组（136 → 74），app 只读新键（4f8cfaed..756427cf）。差分核对：线上两份输入 66 个读处逐项一致（docs/reports/2026-11-25-switch-merge-review.md）。
- **会变的、DSH 自己那几条**：群聊接话（85ea9004）、桌面私聊的玩笑和直说（49c3e563、0e5256da）——各自的 ADR 记了她的话和用户同意。
- **修复**：热重载时新实例等旧实例收尾再起（5ca1d681、3de153aa，11-23 19:49 停收的可能原因）；fewerRules 下不再建口头习惯的学习（30901fd1，每天省一次带思考的调用）；承诺账只隔离说不清的旧片段（f0f0290f）。
- **配置**：重启后 Koishi 插件会把 koishi.yml 里已合并的旧键**改写成新键**（`migrateSwitches`，值等价）；新键表达不了的旧键组合会让插件停在「配置有误」（a2eb17c6）。
- **新东西（不改她）**：提示词指纹清单 v2（群 / 审稿重写 / 挑候选）、`simulateWorld` 缓存（只为快）、DSH 服务管理面板（还没接进 profile）。

## 步骤

1. **先备份**：`runtime/koishi/koishi.yml` → `runtime/koishi/koishi.yml.bak-2026-11-25`（原样复制）。
2. **出一份新快照**（部署前的线上开关）：`node scripts/read-switches.mjs exchange/live/koishi-<日期-时分>.yaml`，提交推上来。
3. **快进前检查**：`npm run golive-check -- --live <线上目录> --fetch`
   - 「开关合并：……新键表达不了」是挡路的：先在控制台按新键改掉那一组，再跑一遍。
   - 「重启后插件会把 koishi.yml 里这 N 组旧键改写成新键」是预期的；核一眼「一个生活」那组应该是 `oneLife`（11-20 快照只开互读 = read；之后补开了 selfExport / selfReceipts / desktopDay = desktop）。
   - 其余按它列的（48 小时、角色卡、监听地址……）。
4. **快进**线上目录到 main，`npm install`（这一批没加依赖，但跑一下无妨）。
5. **重启 Koishi**（照旧在 `exchange/handoff` 写一行「我要在 hh:mm 重启，原因」，`npm run restart-log` 记一笔）。
6. **重启后核对**（看 runtime/bot-shadow/logs 当天的日志和 Koishi 日志）：
   - 有一行「迁移配置：……并进 X=…，行为不变」，然后插件按新配置再起一次；之后 koishi.yml 里不再有那些旧键（`git diff` 不到，koishi.yml 在 runtime/ 里，直接看文件）。
   - 没有「配置有误」「插件没有启动」。
   - 「口头习惯：fewerRules 开着，段落不放，学习也不跑」。
   - 她能正常回私聊（找他一句、看回复）。
7. **再出一份新快照**（迁移后的）提交推上来，信箱告诉 claude「部署完了、迁移日志那一行贴这里」。
8. **48 小时观察**：`npm run metrics:weekly -w @qqbot/bot -- --compare`（第一次跑就是基准），`npm run inventory:live -w @qqbot/bot -- --manifests runtime/bot-shadow/logs`。

## 回退

- 代码：线上目录 `git checkout <上线前的提交>`，重启。
- 配置：用第 1 步的备份覆盖 koishi.yml（迁移后的新键旧代码不认，所以**回退代码时必须一起回退 koishi.yml**），重启。
