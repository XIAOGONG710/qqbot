# QQ 机器人服务管理

DSH 桌面侧边栏的「服务管理」面板，适用于运行 QQ 机器人服务的 Windows 主机。面板显示 NapCat 的 OneBot 监听、Hindsight 的健康接口、Koishi 的监听及最近连接状态、守护进程和最近后台事件。

- 单项启动直接调用相应服务的现有脚本。批量启动按 NapCat → Hindsight → Koishi 检查并补齐缺失服务，等前一项就绪才继续。
- 面板、守护和 Windows 登录启动都通过 `scripts/start-managed-service.ps1` 进入三项服务。每项使用独立的 Windows 独占文件句柄，前台脚本退出后系统自动释放。
- 接口只接受回环连接，启动需要同源面板请求。日志视图只展示日期、服务和事件类型。面板触发的启动输出写进 `runtime/boot/*-panel.log`。
- Windows 自启和守护仍由宿主机管理。关闭 DSH 后，已拉起的服务继续运行。

待批准部署时，把本包接入 DSH 桌面 profile，并使用 `cordis.patch.yml` 登记。通过仓库目录链接安装时可自动识别仓库根；从其他位置加载时在插件配置里设绝对路径 `repoRoot`。

在仓库根运行 `node --test scripts/dsh-service-panel.test.mjs`。Windows 的启动锁检查使用临时目录和假启动脚本。
