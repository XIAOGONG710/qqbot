# 重载 DSH 让插件改动生效

面板插件的代码在 `dsh-plugins/dsh-qqbot-services/`，profile 里通过 Junction 指过来，磁盘一改就绪，但**运行中的进程不会自己换代码**。

## 为什么不能热重载

插件在 host 的 web server 上注册一个前缀路由 `/api/qqbot-services`。这个注册在进程内撤不掉：

- 用 `plugin_manager` 把 `include:dsh-qqbot-services` 禁用再启用，会报
  `webserver: duplicate prefix route "/api/qqbot-services"`，条目 `fiberPhase` 停在 `failed`；
- 这时 `GET /api/qqbot-services/state` 仍然回 403，说明旧路由还占着这个前缀，新代码挂不上去；
- 前端刷新、重开窗口都没用，跑的还是内存里的旧代码。

只有新的 host 进程才能干净地注册一次。所以改完插件要退掉整个应用重开——关窗口不算，得把进程结束。

## 怎么做

最省事的是脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reload-dsh.ps1
```

它延迟十秒结束主进程，等八秒重新拉起，四十五秒后探一次端口，全程写 `runtime/log/dsh-reload.log`。

需要脚本在宿主被杀之后继续跑时，用独立进程启动：

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "E:\qqbot-dsh-control\scripts\reload-dsh.ps1"'
}
```

手工也行：托盘或任务栏退出 DeepSeek Harness，再启动它。

## 重启之后

1. 端口会变，本次实测从 `58842` 变成 `63264`，以侧栏里显示的地址为准。
2. 从左侧会话列表点回原来的对话，会话是持久化的，上下文都在。
3. 跑一遍真机巡检：

```powershell
cd E:\qqbot-dsh-control
node --import tsx scripts/dsh-panel-live-check.mjs
```

期望 19 个只读请求全部 200。脚本只打印状态码和错误码，不打印内容。

## 注意

- 重启属于「重启线上服务」，要用户点头再做；`scripts/reload-dsh.ps1` 只是把动作自动化，不改变这个前提。
- 巡检脚本打的是真配置、真 NapCat、真 Hindsight、真备份，只读；它不走 HTTP，所以不受面板 cookie 限制。
- NapCat 的 WebSocket 在 `ws://127.0.0.1:3001`，HTTP 在 `127.0.0.1:3002`；连接后要等约 1.2 秒再发 action，早发只收到 lifecycle 事件。
