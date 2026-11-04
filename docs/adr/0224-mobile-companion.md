# ADR 0224：Android-first 手机伴侣

## 状态

已建立传输无关的协议与安全策略；原生 Android 客户端尚未打包发布。

## 决策

手机伴侣先采用 Android-first、服务端会话协议，不把 QQ、DSH 和设备控制耦合在 UI 内：

- `packages/mobile-companion/src/protocol.ts` 定义文字、语音、图片、表情包和动作请求的统一 envelope；
- 媒体只允许短期 `mediaId` 或 `https` 引用，不能传 `file://`、本地路径或任意外链；
- 每个媒体引用必须在 `mediaId` 和 `https` URL 之间二选一，避免宿主在两种来源之间产生歧义；
- 媒体时长限制在 2 小时内，宽高限制在 1–8192，且可选元数据必须是整数；
- `audio` 只能携带 `audio/*` MIME，`image` / `sticker` 只能携带 `image/*` MIME；
- 图片表情只能使用服务端 catalog id，避免客户端伪造任意图片；
- 手机动作采用白名单：通知、定时、响铃、登记链接、媒体控制、音量；不提供 shell、键盘注入、读短信、安装/卸载或支付；
- `notify` / `timer` 可自动执行，其余动作默认需要用户确认；所有动作沿用现有设备控制的限额、熔断和审计账；
- 动作参数只接受有限数量的扁平字符串 / 有限数字，并限制键名与字符串长度；复杂对象必须在宿主侧转换为固定 schema；
- 动作 `reason` 只接受最多 500 字的字符串，避免确认和审计界面被任意对象或超长文本污染；
- 动作参数拒绝 `__proto__`、`constructor`、`prototype` 等保留键，避免宿主后续转换参数对象时产生原型污染风险；
- `open_link` 只能携带手机端已登记的 `targetId`，不能直接下发 URL；PWA 当前只登记自身首页，并在确认框展示解析后的真实目标；
- envelope 必须包含版本、requestId、nonce、时间戳，客户端和服务端都校验时间偏差；
- 首次连接走 `hello`：短期配对码（二维码 / 一次性链接）+ clientId + 能力列表，配对码不进入审计正文；
- `packages/mobile-companion/src/gateway.ts` 提供传输无关的会话闸门：先消费配对码，再接受消息 / 动作包；重复 nonce、未配对包和错误 body 拒绝，nonce 集合有上限；
- `packages/mobile-companion/src/pairing.ts` 提供默认的一次性配对码实现：只在进程内保存、TTL 到期清理、成功消费即删除；跨进程部署时替换为同等语义的安全 TTL 存储；
- `packages/mobile-companion/src/runtime.ts` 提供宿主分派层：把已验证的消息 / 动作交给回调，并生成统一响应 envelope；它不监听端口、不直接执行系统动作，便于 QQ、HTTPS、WebSocket 和 Android 复用；
- `CompanionRuntime.requestPhoneAction()` 提供受控的宿主→手机下行动作队列：只接受协议白名单，WebSocket 即时推送，HTTPS 宿主可轮询；手机执行后用 `action.result` 回执，宿主可通过 `onActionResult` 审计。下行动作只保留 5 分钟，且不授予 shell、键盘注入或任意系统权限。
- `packages/mobile-companion/src/http.ts` / `koa.ts` 提供可挂到 Node HTTPS / loopback server 的严格 JSON POST 适配器和同 session 保护的动作轮询；固定路径、Content-Type、body 上限和错误响应，不自动开放公网或 CORS；
- `packages/mobile-companion/src/websocket.ts` 提供兼容 `ws` 风格连接的严格文本帧适配器；限制单帧大小、拒绝二进制 / 非 JSON 帧，并把错误通过 close code 和短错误摘要返回；它不自动监听端口；
- `packages/mobile-companion/src/client.ts` 提供客户端状态机：构造 hello / 消息 / 动作包，记录 pending requestId，并拒绝无法关联的响应；Android / Flutter 网络层只需传输这些 envelope；
- `packages/mobile-companion/src/dsh-adapter.ts` 提供 DSH 适配器：按 `clientId` 保留有限连续上下文，复用宿主提供的脱敏状态和角色语气；手机动作默认拒绝，只有宿主显式注入策略回调时才执行。媒体可通过可选 `describeMedia` 接入 STT / OCR / vision，适配器只传递摘要和引用元数据，不自动把原始字节送进 DSH；Bot 侧的 `MediaReader.voiceDataToText` 可把手机音频接入现有 STT，未提供时安全降级为占位文本。
- `packages/bot/src/mobile-companion-dsh.ts` 和 `App.mobileCompanion()` 在 DSH 开启时创建同一进程内的配对存储、网关、运行时和语气适配器；宿主可以直接取出运行时挂 HTTPS / WebSocket，DSH 关闭时不会创建手机会话。
- Koishi 插件增加 `mobileCompanion.enabled`、`websocketPath` 和 `httpPath`：默认关闭，显式打开且 DSH 同时开启时才把运行时挂到已有 `ctx.server.ws()` / `ctx.server.post()`，不另开端口；HTTPS envelope 和 `/media` 上传沿用同一 session。Koishi server 不可用或 DSH 关闭时只记录原因，不启动公网监听。
- `CompanionGateway.reset()` 和 `MemoryPairingStore.revoke()` 提供停用 / 换机时的显式撤销路径；撤销会清空当前 nonce 集合，旧会话必须重新配对；
- Bot 执行 `/dsh unpair` 时还会按旧 clientId 清掉内存媒体，避免已撤销设备在媒体 TTL 内继续读取旧上传内容；
- 动作宿主回调会收到原始 requestId，返回的 `ActionResult.requestId` 必须沿用它，避免手机端无法关联批准 / 拒绝结果；
- Bot 默认把动作回执接到脱敏运维日志，只记录设备、requestId、成功/失败和决策，不记录动作参数或媒体内容；
- `CompanionRuntime` 按 `clientId` 串行处理已通过网关的包，避免并发 HTTP / WebSocket 消息把 DSH 连续上下文写乱；不同设备之间仍可并行。
- `CompanionRuntime.reset()` 除了撤销网关会话、清空下行动作、媒体和旧队列计数，还调用宿主的 reset 回调，清掉按设备保存的 DSH 短期上下文；解除配对不会留下旧设备的连续语境。
- DSH 适配器对模型等待中的请求记录 reset generation；撤销发生后旧回答不再写入新上下文，只返回重新配对提示，避免并发边界复活旧设备语境。
- 网关同时绑定连接会话：WebSocket 每条连接使用独立随机 session，HTTP 首次 hello 通过 `x-companion-session` 返回短期会话标识，后续请求必须回带；只知道 clientId 或另开连接不能劫持已配对设备。
- HTTP 没有可靠的断线事件，因此网关默认对会话做 30 分钟空闲回收（`sessionIdleTtlMs` 可调）；回收只释放连接绑定，不保留旧 nonce，重新建立会话仍需一次性配对码。
- 媒体上传和动作轮询也会经过同一空闲 TTL 查询；过期的 HTTP session 不能只靠旧 header 继续上传或取出下行动作。
- WebSocket 关闭或出错时释放该连接绑定，旧会话不能继续发送；恢复连接需要通过 QQ 重新生成一次性配对码。
- 运行时状态额外暴露 `connected`，控制台据此区分“已配对但等待重连”和“当前传输已连接”，避免把旧身份误显示为在线。
- 每个 `clientId` 最多排队 32 个包；超限请求立即拒绝，避免异常手机连接把宿主内存和 DSH 调用队列无限占满。
- 客户端最多同时保留 32 个 pending 请求，nonce / requestId 追踪只保留最近 256 个，长时间运行不会无限增长。
- `CompanionClient.reset()` 用于本地注销 / 切换设备，清空 pending、nonce 和 requestId 窗口，避免旧会话污染新配对。
- `CompanionRuntime.status()` 只返回已配对 clientId、connected、队列总数和上限，不包含消息正文、配对码或 nonce，可安全供控制台显示。
- `packages/mobile-companion-app` 提供零依赖 PWA / WebView 客户端：复用 `CompanionClient` 的状态层，支持文字、麦克风录音、媒体引用、服务端表情和白名单动作确认；浏览器脚本对宿主下行动作保留 256 项 nonce 窗口，重复下行不会再次执行；原生 Android UI 后续只需替换展示和网络适配，不复制协议规则。
- `media.ts` / `media-http.ts` 提供可选的短期内存媒体上传链路：必须先完成 HTTP session 配对，单设备、单进程和总字节数都有上限；上传返回的 `mediaId` 再进入普通消息包，不把文件写入运行时目录。
- QQ 侧提供 `/dsh unpair` 显式撤销入口：立即清掉配对身份、连接和 nonce，便于设备遗失或需要立刻换机时止损；重新使用 `/dsh pair` 获取一次性配对码。

动作清单的唯一来源是 `packages/mobile-companion/src/protocol.ts` 中的
`PHONE_ACTION_CAPABILITIES`。协议白名单、宿主动作策略和 Koishi 控制台都读取它，新增动作时只需扩展一份描述，避免确认规则和页面说明漂移。

## 当前范围

这次先落地契约、运行时校验和策略测试，避免先做一个无法安全撤回的“全权限 APP”。现有 `device-phone.ts` 仍只通过 ntfy 发通知；下一步接入会话网关时，必须复用本 ADR 的校验和 ADR 0148 的设备闸门。

## 明确不做

不实现无审计最高权限、任意远程命令执行、读取手机私密数据或绕过系统确认。需要更高权限的动作必须增加新的 ADR、单独开关、可见确认和撤回路径。
