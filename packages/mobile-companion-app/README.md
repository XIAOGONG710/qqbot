# `@qqbot/mobile-companion-app`

这是一个零依赖、Android-first 的 PWA 客户端原型。它直接连接 Koishi 挂载的 WebSocket，不保存配对码，不提供 shell、键盘注入、短信、安装或支付能力。

目录自带 Web App manifest 和只缓存静态资源的 Service Worker，可在手机浏览器中“添加到主屏幕”；Service Worker 不缓存聊天、配对码或媒体请求。

当前支持：

- 一次性配对码连接；
- DSH 语气下的文字对话；
- WebSocket 实时聊天，或 HTTPS 会话聊天；HTTPS 模式可从手机相机 / 文件选择器上传音频和图片，也可直接调用麦克风录音，得到短期 `mediaId` 后自动发送；
- 音频 / 图片的 HTTPS 或短期 `mediaId` 引用；
- 服务端 catalog 表情 ID；
- `notify`、`timer`、`ring`、`open_link`、`media_control`、`volume` 白名单动作；敏感动作必须勾选确认。
- 宿主下发动作时，PWA 只执行通知、振动响铃、计时器和 HTTPS 链接；媒体控制 / 音量等动作明确回执拒绝。
- 浏览器侧在完整 5 分钟协议窗口内保留最多 256 个下行 nonce；重复下行不再次执行，窗口内流量达到上限时要求重新连接，不会淘汰仍有效的旧 nonce。

开发时直接运行 `npm run serve --workspace @qqbot/mobile-companion-app`（默认只绑定 `127.0.0.1:4173`），WebSocket 地址填写为 Koishi server 的 `/qqbot/companion`，HTTPS 地址填写为 `/qqbot/companion/http`，媒体上传地址填写为其下的 `/media`。生产环境应使用 HTTPS/WSS 或已认证的反向代理，并在 Android WebView 中复用同一页面。

这层 UI 不绕过 `@qqbot/mobile-companion` 的网关和动作策略；后续若改成原生 Android，只替换 UI 与网络适配，不复制协议规则。
