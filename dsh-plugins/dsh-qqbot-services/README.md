# 林梦瑶 · QQ 桥接

DSH 的「林梦瑶 · QQ 桥接」设置页与桌面侧边栏的「服务管理」共用一份控制台。总览提供现有启动操作，连接页显示 NapCat、Hindsight 和 Koishi 的端口及状态，系统页提供按白名单字段生成的诊断报告与近期后台事件。

设置页入口和标签交互改编自 [灵犀 QQ 桥接](https://github.com/2524034412-boop/DSH-QQ/blob/edf9f853341ac049708dc4c68ed432c74f2ad6d4/plugin/dsh-qq-bridge/lib/client.js)，上游 `dsh-qq-bridge` 包声明 MIT 许可。我们的控制台连接仓库现有的 Windows 服务探测与启动锁。

- 单项启动直接调用相应服务的现有脚本。批量启动按 NapCat → Hindsight → Koishi 检查并补齐缺失服务，等前一项就绪才继续。
- 面板、守护和 Windows 登录启动都通过 `scripts/start-managed-service.ps1` 进入三项服务。每项使用独立的 Windows 独占文件句柄，前台脚本退出后系统自动释放。
- 接口只接受回环连接，启动需要同源面板请求。日志视图只展示日期、服务和事件类型。面板触发的启动输出写进 `runtime/boot/*-panel.log`。
- Windows 自启和守护仍由宿主机管理。关闭 DSH 后，已拉起的服务继续运行。
- 聊天页通过本机 NapCat OneBot WebSocket（`127.0.0.1:3001`）读取当前 QQ 账号、好友、群及所选会话的近期消息。DSH 进程可通过环境变量 `QQBOT_ONEBOT_TOKEN` 提供凭据。保留现有 Koishi 收发链路。聊天数据只经带面板令牌的本地接口返回，不进入诊断、模型或记忆。图片、语音等用文本占位。
- 聊天消息区参考 [灵犀 WebChat](https://github.com/2524034412-boop/DSH-QQ/blob/edf9f853341ac049708dc4c68ed432c74f2ad6d4/qq-bridge/webchat/public/index.html)，沿用发送者配色。每个账号下的每条会话可在本机选择读取最近 15、30 或 60 条。
- 手动发送只允许向 Koishi 配置里唯一的 `boyfriend` 联系人发私聊。面板确认当前 QQ 账号、收件人和实际发送内容，服务端重新核验联系人，在同一条 NapCat 连接上重新核验账号后才发送。消息带可见的「【本人手动代发】」标记，Koishi 补回、引用和合并转发都跳过这个账号发出的带标记正文。部署时先让 Koishi 加载过滤逻辑，再更新 DSH 插件。发送测试只用模拟连接。

待批准部署时，把本包接入 DSH 桌面 profile，并使用 `cordis.patch.yml` 登记。通过仓库目录链接安装时可自动识别仓库根；从其他位置加载时在插件配置里设绝对路径 `repoRoot`。

在仓库根运行 `node --test scripts/dsh-qq-chat.test.mjs scripts/dsh-service-panel.test.mjs`。Windows 的启动锁检查使用临时目录和假启动脚本。
