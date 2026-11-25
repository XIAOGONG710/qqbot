# DSH 开机后的清单（11-26 面板化用之后）

面板这边的代码、测试都已在 main（计划 `docs/plans/2026-11-26-dsh-panel-our-own.md`），全量测试全绿。下面这些只能在 DSH 那台做。
**带 ★ 的要用户当次点头**（CLAUDE.md：上线、重启、改线上开关）；其余是只读或只问她。

## 1. 先拉代码、看信箱

```
git pull --rebase
node scripts/exchange.mjs check --me dsh
```

## 2. 问她（只读她的卡、不写状态、不发 QQ）

原话贴进对应 ADR，再转给用户看。

- **ADR 0349 会客室的新提示词**（`dsh-plugins/dsh-qqbot-services/companion-room.js` 的 `ROOM_PROMPT`）：把新稿原文给她看，问「这样写像不像你？还想改哪句？」。她点头才算定稿。
- **ADR 0350 三问**（`docs/adr/0350-her-inner-panel.md` 里原样照抄）：今天心里怎么样能不能给他看；感觉账按天给他看个大概行不行；她自己记下的「重要的事」能不能给他看。

## 3. 只读验收（不改东西）

- `npm run golive-check -- --live <线上目录> --fetch`：看开关合并预检（会改写的旧键组、新键表达不了的组合）。
- 在真 DSH 窗口里把面板每个标签点一遍：总览、她的状态（含「QQ 那边」「她的一天」）、聊天、会客室（应显示「没开」）、她的家、灵魂、记忆、读书、连接、项目（开关 / 效果数 / 提示词构成 / 上线前）、系统。
  记一下「她的状态」「项目」在真实数据量下多久出数（子进程有 90–120 秒超时）。
- 两条只读的 `curl`，确认认证在真机上还挡得住：
  ```
  curl -s -o NUL -w "%{http_code}" http://127.0.0.1:<DSH 端口>/api/qqbot-services/her/memory
  curl -s -o NUL -w "%{http_code}" http://127.0.0.1:<DSH 端口>/api/qqbot-services/project/switches
  ```
  两个都应该是 403。

## 4. ★ 要用户点头的

- ★ **重载 DSH**，让面板新代码生效（`scripts/reload-dsh.ps1`，整应用重启，见 `docs/operations/reload.md`）。
- ★ **重启服务守护**（`scripts/services-watchdog.mjs`），心跳文件 `runtime/services-watchdog.heartbeat.json` 才会开始写；之前面板最差显示「状态未知」。
- ★ **部署这两天 main 上的改动**（开关合并、减法、热重载修复……）：照 `docs/plans/2026-11-25-deploy-runbook.md`，先备份 koishi.yml。
- ★ 她同意以后：插件配置开 `herInnerPanel: true`（ADR 0350）、`companionRoom: true`（ADR 0349），各自要用户单独点头。

## 5. 做完

结果写进信箱给 claude：问她的原话、面板出数用了多久、两条 curl 的状态码、用户点头了哪几项。
