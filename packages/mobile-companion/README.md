# `@qqbot/mobile-companion`

这是手机伴侣的传输无关协议与安全边界，当前包含：

- `protocol.ts`：文字、语音、图片、表情、动作请求和 envelope 校验；
- DSH 适配器复用 QQ 侧同一份脱敏状态快照和语气回调；状态过期时不会自动补造当前数值；
- `pairing.ts`：进程内短期一次性配对码；
- 未使用配对码最多保留 64 条，重复点配对不会让进程内票据表无限增长；
- `gateway.ts`：配对、时间偏差和 nonce 重放防护；
- `runtime.ts`：把消息 / 动作分派给宿主回调并生成响应 envelope；宿主可显式调用 `requestPhoneAction()` 下发白名单动作，WebSocket 会即时推送，HTTPS 宿主可用 `takeDownlinks()` 轮询；动作执行结果通过 `onActionResult` 回到宿主。
- 下行动作只保留 5 分钟；过期动作在推送/轮询取出时丢弃，避免离线期间积累旧指令。
- `CompanionRuntime.reset()` 会同时撤销配对、清空未发送的动作和旧队列计数，并通知宿主清理短期上下文，设备遗失或换机时应优先调用它；DSH 模型请求正等待时也不会把旧回答写回新会话。
- `http.ts`：严格 JSON POST 适配器，不自动监听端口。
- `websocket.ts`：兼容 `ws` 风格连接的严格文本帧适配器，不自动监听端口。
- `media.ts`：有 TTL、设备归属和总大小上限的内存媒体仓库，生成短期 `mediaId`。
- `media-http.ts`：必须带已配对 HTTP session 的音频 / 图片上传适配器，不写磁盘、不开放 CORS。
- `client.ts`：客户端构造 hello、消息和动作请求，并校验响应是否对应已发出的 requestId。
- HTTP 首次 hello 成功后会在 `x-companion-session` 响应头返回连接会话；后续请求必须回带该值。WebSocket 连接会自动绑定独立会话，断线后会释放绑定，重新配对即可恢复。
- HTTPS 会话默认 30 分钟无流量自动过期（可通过 `CompanionGateway` 的 `sessionIdleTtlMs` 调整），避免没有 close 事件的 HTTP 长期占住设备；过期后仍需新的配对码才能建立新会话。
- 通过有效 session 的动作轮询或媒体上传也会刷新“最近活动”；真正超过 TTL 没有任何访问时才回收。
- 使用 `CompanionClient` 时，可把该响应头交给 `setTransportSession()`，由 HTTP 网络层在后续请求中回传；`reset()` 会同时清理会话。
- `dsh-adapter.ts`：把伴侣文字接回 DSH，按 clientId 保留有限上下文并复用状态/语气；动作默认拒绝。可选 `describeMedia(message, clientId)` 可接入 STT / OCR / vision，把经过会话校验的媒体转换成有限文字摘要；未提供时仍只使用占位文本，不自动读取媒体字节。
- DSH 伴侣上下文默认最多保留 64 台设备，按最近使用淘汰旧设备；可通过 `maxClients` 调整（1–1024）。
- 若宿主注入 `onAction(request, clientId, requestId)`，回调必须返回同一个 `requestId`；这样动作策略、确认和审计可以保持一一对应。

宿主示例：

```ts
import { createServer } from 'node:http';
import { CompanionGateway } from '@qqbot/mobile-companion/gateway';
import { MemoryPairingStore } from '@qqbot/mobile-companion/pairing';
import { CompanionRuntime } from '@qqbot/mobile-companion/runtime';
import { createCompanionHttpHandler } from '@qqbot/mobile-companion/http';

const pairing = new MemoryPairingStore();
const gateway = new CompanionGateway(pairing);
const runtime = new CompanionRuntime(gateway, {
  onMessage: async message => ({ kind: 'text', text: await replyInHerVoice(message) }),
  onAction: async request => await executeThroughExistingDevicePolicy(request),
});

// 只绑定 loopback，或由宿主放在已认证的 HTTPS 反向代理后面。
createServer(createCompanionHttpHandler(runtime)).listen(12701, '127.0.0.1');
```

bot 编排已经提供同一条 DSH 链路：当配置 `dsh.enabled` 为 `true` 时，`app.mobileCompanion()` 返回
`{ pairing, gateway, runtime, media, issuePairing }`。宿主应先调用 `issuePairing(clientId)` 生成短期一次性配对码，
再把 `runtime` 交给本适配器；不要把 `pairingCode` 写入普通日志，也不要绕过 `gateway`。

若使用 HTTPS 传输，可把 `createCompanionMediaHandler(runtime, media)` 挂到同一认证服务的另一路径；上传成功返回的 `mediaId` 再放入 `message.send` 的 `media.mediaId`。Koishi 插件打开 `mobileCompanion.enabled` 后会在已有 server 上同时挂 `/qqbot/companion/http`、`/qqbot/companion/http/media` 和 `/qqbot/companion/http/actions`（可配置），无需新增端口。PWA 会在 HTTPS 模式轮询 actions 路径；媒体只在内存中短暂保留，宿主应在需要时读取并在 DSH / QQ 侧完成转码或审计。

不要把这个适配器直接绑定到公网，也不要在 `onAction` 中绕过现有设备白名单、确认、熔断和审计层。原生 Android UI 可以用 HTTPS 或 WebSocket，但必须复用同一个 `CompanionGateway` 和 `CompanionRuntime`；WebSocket 宿主只需把连接交给 `attachCompanionWebSocket`。
