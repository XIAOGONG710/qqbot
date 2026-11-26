# 手机伴侣 / 自己的聊天软件：安全与正确性审查（2026-11-26）

范围：`packages/mobile-companion`（经 `packages/koishi-plugin-qqbot/src/index.ts` 的 `mountMobileCompanion` 和 `App.mobileCompanion()` 挂进 Koishi）、
`packages/chat-bridge`，以及 `packages/mobile-companion-app`、`packages/chat-app` 里和它们打交道的部分（协议、配对、凭据）。
对照的设计：ADR 0224（手机伴侣）、0245（照片审核）、0248（跨端上下文）、0337（自己的聊天软件）。
只读代码和合成测试，没有碰 `runtime/`、`characters/`，没有连线上服务。

严重度：**高** = 未配对的人能拿到她 / 他的数据或让进程退出；**中** = 已配对设备或常见运维操作能把服务弄坏，或功能静默失效；**低** = 纵深防御、需要额外前提；**提示** = 现在不触发的隐患。

## 结论

没有发现「未配对就能读到聊天 / 记忆 / 私人空间」或「能让她替手机执行动作」的路径：

- 手机伴侣：配对码 6 字节随机（48 位）+ 设备 ID 6 字节随机，一次性、TTL、`/dsh unpair` 撤销；会话绑定到连接（WS 每条连接一个随机 session，HTTP 由服务端签发 `x-companion-session`）；
  nonce 窗口覆盖整段时钟偏差且满了失败关闭；每设备 32 个排队上限；媒体按 clientId 隔离、只收白名单 MIME 且核对文件头、`GET` 只给图片；
  手机发起的 `action.request` 在 bot 里没有接 `onAction`，一律 `deny`；照片审核决定要 `confirmation: 'confirmed'`（ADR 0245 的设计如此）。
- chat-bridge：token 32 字节、表里只存 SHA-256、恒定时间比较；配对码 8 位、10 分钟、用过即废、连错 5 次作废、全局限流；
  `/api/*` 带 CSP sandbox、`nosniff`、`no-store`，不开 CORS；凭据只在 WS 第一帧和 `Authorization` 头，不进 URL；静态文件挡住 `..`、点文件、符号链接出目录；
  Koishi 那一侧只听 `127.0.0.1`，本机媒体地址只认回环且拒绝带代理头的请求；日志不含内容（有测试）。
- 两个 PWA：渲染全用 `textContent` / `h()`，没有 `innerHTML`；链接只放 https，`rel="noopener noreferrer"`；chat-app 收到 `unauthorized` 才删本机凭据。

找到的问题如下。7 条当时就修了（不改变她说什么、做什么），6 条留给用户定；其中 A、D、E 当天后补修掉（同样不改变她的言行、不碰线上开关），现在留给用户的是 B、C、F。

## 已修

| # | 位置 | 失效场景 | 严重度 | 修法 / 提交 |
|---|---|---|---|---|
| 1 | `packages/mobile-companion/src/voice-session.ts` `VoiceSessionGate.start`；`runtime.ts:321`（start）、`:329`（chunk）；`voice-conversation.ts:20` | 已配对设备反复 `voice.session.start` 不收尾：闸门只在**同一段**的下一个分片时才检查超时，`withBufferedVoiceConversation` 的缓冲只在 stop / cancel / reset 时清。每段最多 8 MiB、段数不限，内存一直涨到 `/dsh unpair`。分片因超时 / 超量被闸门作废时，宿主缓冲也不清。 | 中 | 同一设备最多同时 2 段；每次 start / chunk 先清掉超过 2 分钟没收尾的会话，并调宿主 `onVoiceSessionCancel` 丢缓冲；分片被闸门作废时同样丢缓冲。`d530ba4f` |
| 2 | `voice-conversation.ts:51`、`runtime.ts:346` | 转写期间 `App.stop()`：停止回调不带 `AbortSignal`，转写完后照样调 DSH、写进跨端共享上下文（ADR 0224「停止后不得重建短期上下文」）。 | 低 | 停止回调带上运行时的 signal，转写前后都检查，交给 `onMessage` 时也带上。`d530ba4f` |
| 3 | `packages/mobile-companion/src/websocket.ts:33` | 未配对的 WS 连接可以一直开着，每条都在运行时登记一个下行监听；Koishi 的 `ctx.server.ws()` 没有连接数上限。 | 低（默认只听本机） | 连上 30 秒内没配对成功就 `1008 hello_timeout` 断开（`helloTimeoutMs` 可调）。`d530ba4f` |
| 4 | `packages/mobile-companion/src/pairing.ts:43` | 配对码错了不计数，有效期内可无限次猜；比较用 `!==`。实际要同时猜中 48 位 clientId 和 48 位配对码，做不到——属纵深防御。 | 低 | 同一张码连错 5 次作废（与 chat-bridge 一致）；摘要后恒定时间比较。`d530ba4f` |
| 5 | `packages/bot/src/mobile-companion-dsh.ts:49`（旧） | `onActionResult` 被塞进 `createDshCompanionHandlers` 的选项，而那个适配器不认它，静默丢掉。结果：手机对宿主下发动作的回执一律回「宿主未接入手机动作回执」，运维日志里的脱敏回执审计（ADR 0224）从来没写过，未回执槽位要等 5 分钟才释放（上限 16）。线上目前没有调用 `requestPhoneAction`，所以是潜伏的。 | 中（功能静默失效） | 挂到运行时那一层的 handlers 上。测试走 `createMobileCompanion` 全链路。与本报告同批提交。 |
| 6 | `packages/chat-bridge/src/app-server.ts` 撤销核对定时器、WS hello（现 `:300` 起、`:345` 起） | 设备表每次都从磁盘读；`devices.json` 不是合法 JSON（ADR 0337 写了可以手删表项，手改到一半、存了个错字）时，`setInterval` 里抛出的异常没人接，**整个中继进程退出**，她和他的两条路一起断。WS hello 同样同步抛错。 | 中 | 核对这一轮跳过并记一次日志；新连接以 `1011` 断开但**不回 `unauthorized`**（App 收到它会删本机凭据，表修好后还得重新配对）；表修好自动恢复。HTTP 那一路本来就被 catch 成 500。`f3fe7330` |
| 7 | `packages/chat-bridge/src/core.ts:308`、`:313` | 上游的好友撤回 / 戳一戳写账失败（磁盘满）时被队列静默吞掉，账上少一条，日志里什么也没有。（起初怀疑会成为未处理 rejection 让进程退出；验证后不会——队列的 `tail` 已经接住。） | 低 | 记一条不含内容的日志。`f3fe7330` |
| A | `packages/bot/src/platform/app.ts`（旧 `onPhotoReviewList`）、`mobile-companion/src/media.ts` | 列照片草稿时给每条都往媒体仓里放一张缩略图（默认 20 条、最多 50 条），每设备媒体上限是 16、满了淘汰最早放的：**最新的几条草稿**在返回之前缩略图就没了；还会挤掉手机刚上传、还没发出去的图片 / 语音（同一个每设备配额）。 | 中 | 列表逻辑搬到 `bot/src/mobile-companion-dsh.ts` 的 `photoReviewLister`（`createMobileCompanion({ photoDrafts })`，app.ts 只剩一行）：只给最新 8 条做缩略图，其余照样列出、不带缩略图；放新的之前先收回这台设备上一次列表留下的缩略图（媒体仓加了 `discard`），反复刷新也不占满配额。测试：`bot/test/dsh-link.test.ts`「照片审核列表只给最新 8 条做缩略图…」。11-26 后补。 |
| D | `packages/chat-bridge/src/app-server.ts` WS 升级与 hello | `MAX_CONNECTIONS = 16` 把没 hello 的连接也算进去，能连到端口的人每 10 秒重连就能占满，App 拿到 503；hello 之前发坏帧只回错误、不断开。 | 低 | 没 hello 的连接（含正在握手的）单独限 4 条，已认证的 16 条不再被它们占；hello 超时 10 秒 → 5 秒（App 一连上就发 hello）；hello 前的坏帧（非 JSON、二进制、超 64 KiB）回 `bad_request` / `too_large` 后断开，不回 `unauthorized`（免得 App 删凭据）；hello 时已认证满 16 条则 `1013` 断开。测试：`chat-bridge/test/e2e.test.ts`「没 hello 的连接单独限 4 条…」。11-26 后补。 |
| E | `packages/mobile-companion/src/http.ts`、`koa.ts` | `hello` 时请求带了 `x-companion-session` 就用客户端给的值当会话凭据，客户端可以挑一个好猜的值。 | 低 | `hello` 一律由服务端 `createSession()` 签发（`http.ts` 的 `sessionFor`，Koa 路由共用）；之后的请求照旧带回 hello 响应头里的那个。现有 PWA（`mobile-companion-app`）在 hello 前本来就清空会话、从响应头取新的，不受影响；`chat-app` 走 chat-bridge 的 Bearer 凭据，不用这个头。测试：`mobile-companion/test/protocol.test.ts` HTTP 适配器那条、`test/koa.test.ts` 第一条。11-26 后补。 |

每条都有先失败后通过的测试：`mobile-companion/test/voice-session.test.ts`（后三项）、`test/websocket.test.ts`、`test/protocol.test.ts`「同一张配对码连错 5 次作废」、
`bot/test/dsh-link.test.ts`「bot 工厂把宿主下发动作的手机回执交给 onActionResult 审计」、`chat-bridge/test/e2e.test.ts`「设备表被改坏」、`chat-bridge/test/core.test.ts`「写账失败（磁盘满）」。

## 没修，留给用户

| # | 位置 | 失效场景 | 严重度 | 建议 | 为什么没直接改 |
|---|---|---|---|---|---|
| B | `packages/chat-bridge/src/media.ts`（`createMediaStore` 没有任何清理）、`app-server.ts:160`（写限流 30 起步、每秒补 0.5） | `runtime/chat-bridge/media/` 只增不减。一台已配对设备（或泄露的 token）每秒可传 0.5 个 10 MiB 文件，约 430 GB/天；正常使用下她发的图也永远留着。 | 中（凭据泄露时可撑满磁盘） | 定保留期 / 总量上限，按「消息账里还引用的」做清理；上传按天限额。 | 涉及删数据，要用户定保留策略。 |
| C | `chat-bridge/src/onebot-server.ts:66`、`media.ts:138`（`readMediaReference`）、`:118`（`redirect: 'follow'`） | 没设 `QQBOT_ONEBOT_TOKEN` 时，本机任何进程都能冒充 Koishi 连上来，用 `send_private_msg` 给他发一张 `file=C:\…` 的「图片」，中继就读这个本机文件（只有文件头像图片 / 音频的才收）并送到 App；`http(s)` 地址会跟随重定向去取（可打到内网）。 | 低（要本机代码执行或同机进程） | 启动时缺 token 直接拒绝（或至少醒目警告）；本机路径只允许 Koishi / 她的数据目录；取外链不跟随到私网地址。 | 改启动条件 = 改线上开关，要用户点头。 |
| F | `mobile-companion/src/gateway.ts:90`、`bot/src/platform/owner-commands.ts`（`/dsh pair`） | 已有一台配对设备时再 `/dsh pair`，新码对应一个新 clientId，网关回「会话已经绑定另一台设备」，必须先 `/dsh unpair`；`/dsh pair` 的回复里没提。 | 低（体验） | `/dsh pair` 时若已配对，回复里说明要先解除。 | 改的是她回给他的话，按规则要先问她。 |

## 提示（现在不触发）

- `mobile-companion/src/websocket.ts:43` 关闭原因按**字符**截到 123，而 `ws` 按**字节**限制、超了同步抛 `RangeError`；抛的时候 `closed` 已经置位，连接会留着不再处理。现有错误文字最长 60 字节，不触发；以后加长错误文字时注意。
- `mobile-companion/src/runtime.ts:359` 把宿主处理器的错误文字（截 500 字）原样回给手机。看的人是他本人；若以后接入的处理器错误里可能带上游 URL / 路径，要先脱敏。
- Koa 媒体上传（`koa.ts` `readBody`）每个请求先在内存里攒到 8 MiB 再交给有总量上限的仓库，并发上传数不限；只对已配对会话开放。

## 测试是否断言了它声称的内容

- `voice-session.test.ts`「实时语音分片必须有序，可中断且有总量边界」：标题说了「可中断」「总量边界」，正文只测了顺序和 stop。已补一条真正测总量上限和取消的。
- `protocol.test.ts` 里动作回执的几条都是直接 `new CompanionRuntime(…, { onActionResult })`，绕过了 bot 的接线，所以第 5 条（回执审计被丢）一直没被发现。已在 `dsh-link.test.ts` 补走 `createMobileCompanion` 的一条。
- 其余抽查的（HTTP / WS 适配器、配对存储、e2e 的配对 / 撤销 / 上传 / 静态文件 / 限流、日志不含内容）断言和标题一致。

## 验证

- `npm test -w @qqbot/mobile-companion`、`npm test -w @qqbot/chat-bridge`、`npm test -w @qqbot/bot` 全过；`npm run typecheck` 通过。
- `packages/bot/src` 有改动，`npm run baseline:fast -w @qqbot/bot`：39/39 逐字一致。
- A / D / E 后补时：`npm test` 跑了 `@qqbot/bot`、`@qqbot/mobile-companion`、`@qqbot/chat-bridge`、`@qqbot/mobile-companion-app`、`@qqbot/chat-app`、`koishi-plugin-qqbot`，全过；`npm run typecheck` 通过；
  `baseline:fast` 39/39 逐字一致；`app.ts` 少了 22 行，`app-size.test.ts` 的上限跟着调到 2675。
