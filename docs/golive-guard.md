# 上线前检查：把「一次一个变量、看满 48 小时」变成机器能拦的事（任务书 T3a）

## 为什么

10-12 一天重启 6 次，「一次一个开关、看 48 小时」只是口头约定，守不住。现在重启记录有个文件，上线前检查读它，不满 48 小时就挡路。

## 两样东西

1. **重启记录** `runtime/bot/restarts.log`（线上数据目录，`runtime/` 被忽略，不进仓库）：一行一条 JSON `{ at, to, kind, reason, by }`。`kind`：
   - `behavior`：代码 / 配置的改动会改变她的行为或多了一个变量——**计入 48 小时**；
   - `safety`：修故障 / 安全——不计入；
   - `recovery`：整机重启 / 崩溃后恢复，同一版代码——不计入。
2. **上线前检查** `npm run golive-check -w packages/bot -- --live <线上目录> --target <候选>`：只读；有代码或脚本要重启生效时，若距上一次 `behavior` 的重启不足 48 小时，**挡路**，写清上一次是什么时候、提交、理由，还差几小时。

## 用法

```
# 每次重启 / 上线做完，追加一行
npm run restart-log -w packages/bot -- --to <提交> --kind behavior --reason "加固 A + 心跳" --by claude
npm run restart-log -w packages/bot -- --kind recovery --to <提交> --reason "整机重启后恢复"
# 看记录和距上次行为变化多久
npm run restart-log -w packages/bot -- --list
# 修故障 / 安全要上线，且不满 48 小时：写明理由放行（理由进输出，重启后记成 kind=safety）
npm run golive-check -w packages/bot -- --live <线上目录> --target <候选> --safety "修模型接口超时"
```

## 它不做什么

- 不判断「这次开的是不是新变量」：机器只查时间，开关算不算新变量要人判断（检查输出里仍留着那一问）。
- 只有文档和测试的改动不要重启，不拦。
- 记录是空的时候不拦，但会提示先把最近几次补上；**第一次启用时要补**：10-15 11:29（recovery，`7d26f22`）、10-15 17:41（behavior，`9333bdd`，加固 A + 心跳）。
- 不阻止人绕过它（`--safety` 是自己写的理由）；它让「绕过」变成一句留在输出和记录里的话，而不是一次没人注意的重启。
