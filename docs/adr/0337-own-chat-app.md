# ADR 0337：QQ 用不了的时候，他在自己的聊天软件上找她

状态：建设中，2026-11-11（用户提出：「腾讯在不断压缩第三方接口接入的 QQ……把手机伴侣完善成一个单独的聊天软件，以便在 QQ 完全戒严的情况下让我能正常跟她聊天」）。
**未上线**；打开它要改线上 Koishi 的 `adapter-onebot.endpoint` 并重启，必须用户点头。她本人的意见见文末「问她」。

## 问题与证据

- 她和他之间唯一的通道是 NapCat（第三方 QQ 接入）。NapCat 被封 / 登不上的那天，她的记忆、生活、主动消息都还在，只是没有地方说话。
- 现有的手机伴侣（`packages/mobile-companion*`）走的是 **DSH 咨询链路**（`mobile-companion-dsh.ts` → `dsh.advise`），不是她的回复流水线：
  没有她的聊天记录、长期记忆、作息、主动消息、表情和照片；配对码是进程内一次性的，HTTPS 会话 30 分钟过期。它是「设备伴侣」，不是聊天软件。
- `packages/bot` 里联系人就是 QQ 号（数字），聊天记录、档位、记忆 bank 都按它走；`Transport` 的每个方法最后都是一个 OneBot 动作。
- 已有先例：微信桥（`scripts/wechat-bridge.mjs`，`docs/wechat.md`）假装成 NapCat，Koishi 的 `adapter-onebot` 连上去，`packages/bot` 一行不改。

## 决定

### 1. 一个 OneBot 中继，站在 Koishi 和 NapCat 中间

```
Koishi(adapter-onebot) ──ws──▶ chat-bridge ──ws──▶ NapCat（有就连，没有也照常工作）
                                   ▲
                                   └──wss / https── 手机 App（PWA，可装进现有 Android 壳）
```

- `packages/chat-bridge`：对 Koishi 是 OneBot 11 正向 WS 服务端；对 NapCat 是 OneBot 11 WS 客户端（上游，可选，断了按退避重连）。
- **他在 App 里发的话**，中继拼成一条 `message_private` 事件，`user_id` 就是他的 QQ 号、`self_id` 是她的 QQ 号。
  于是在她那边这就是「他发来一条消息」：同一个联系人、同一份聊天记录、同一个记忆 bank、同一套作息和主动消息。**`packages/bot` 和 Koishi 插件不改。**
- **她发给他的**（`send_private_msg` 且 `user_id` 是他）：按投递规则送到 App 或 QQ（见第 3 节），两种情况都记进中继自己的消息账，App 里看到的是完整的对话。
- 其余事件、其余动作（别的联系人、群、说说、账号控制面……）原样在 Koishi 和 NapCat 之间透传；上游不在时这些动作按 NapCat 掉线的样子回失败，不假装成功。
- 上游不在时中继自己答的只有：`get_login_info`（配置里她的号和昵称）、`get_status`、`get_version_info`、`get_friend_list`（只有他）、
  `get_friend_msg_history`（他的，从消息账里拼成 OneBot 形状）、`can_send_image` / `can_send_record`。

### 2. 动作到 App 的对应

| OneBot 动作（对象是他 / 中继发出的消息 id） | App 里 |
|---|---|
| `send_private_msg`：text / face / image / record / json(卡片) / reply 段 | 一条消息；图片和语音由中继存成媒体，App 带凭据来取 |
| `set_input_status` | 「对方正在输入…」（不落账） |
| `mark_private_msg_as_read` | 已读 |
| `delete_msg`（她撤回） | 那条显示「对方撤回了一条消息」 |
| `friend_poke` | 「她戳了戳你」 |
| `set_msg_emoji_like` | 那条消息上的表情回应 |
| App 发：文字 / 图片 / 语音 / 引用 | `message_private` 事件（image / record 段带中继的本机 URL） |
| App 撤回自己的一条 | `friend_recall` 通知 |
| App 戳她 | `notify` / `poke` 通知 |

中继发出的消息 id 用自己的一段整数（和 NapCat 的 id 不撞），并记住每个 id 属于哪边，后续的撤回、回应、引用按 id 找回去。

### 3. 投递规则（默认 `last-active`）

- 他最近一条消息是从哪边来的，她的话就发到哪边；上游不在时一律发到 App。
- 她主动找他（没有他的上一条可跟）也按这条：他最近在哪边说话就发哪边。
- 可配 `both`（两边都发）。这一条等她本人和用户的意见，见「问她」。
- 走 QQ 的那些（他在 QQ 上说的、她发到 QQ 的）也镜像进消息账，标 `via: 'qq'`，App 打开就是连续的记录。

### 4. App 协议（中继 ↔ 手机）

同源：中继自己托管 `packages/chat-app` 的静态文件，手机只需要能访问这一个地址。

**配对**（长期凭据，不是每次扫码）：
- 本机运行 `npm run pair --workspace @qqbot/chat-bridge`（或启动时带 `--pair`），终端打印一次性 8 位配对码，10 分钟有效，用过即废；连错 5 次作废。
- `POST /api/pair` `{ code, deviceName }` → `{ deviceId, token }`。`token` 是 32 字节随机数（base64url），服务端只存 SHA-256；设备表在 `runtime/chat-bridge/devices.json`。
- 撤销：`npm run devices --workspace @qqbot/chat-bridge -- revoke <deviceId>`（或删表里那一项）。

**WebSocket** `/ws`（JSON 文本帧，单帧 ≤ 64 KiB）。凭据不放 URL，放第一帧：

```jsonc
// 手机 → 中继
{ "type": "hello", "deviceId": "…", "token": "…", "since": 0 }      // since：手机已有的最大 seq
{ "type": "send", "clientId": "uuid", "parts": [Part…], "replyTo": 123 }   // replyTo 可省
{ "type": "recall", "id": 123 }
{ "type": "poke" }
{ "type": "ping" }

// 中继 → 手机
{ "type": "ready", "seq": 42, "self": { "name": "林梦瑶" }, "upstream": "up" | "down" }
{ "type": "message", "message": Message }              // 新消息；hello 之后先把 since 之后的补发完再发 ready
{ "type": "event", "seq": 43, "event": { "kind": "recall", "id": 123 }
                                     | { "kind": "read", "upTo": 123 }
                                     | { "kind": "reaction", "id": 123, "emojiId": 76 } }
{ "type": "ack", "clientId": "uuid", "id": 124, "seq": 44 }       // 自己那条已入账并交给她
{ "type": "typing", "on": true }
{ "type": "upstream", "state": "up" | "down" }
{ "type": "pong" }
{ "type": "error", "code": "unauthorized" | "bad_request" | "too_large" | "rate_limited" | "not_delivered", "message": "…", "clientId": "uuid" }
```

```ts
interface Message {
    seq: number;            // 消息账里的序号，单调递增；消息和事件共用一条序列
    id: number;             // OneBot 消息 id
    from: 'her' | 'me';
    via: 'app' | 'qq';
    at: number;             // 毫秒
    parts: Part[];
    replyTo?: number;
    clientId?: string;      // 自己发的那条带回来，用来对上本地气泡
    recalled?: true;
}
type Part =
    | { kind: 'text'; text: string }
    | { kind: 'face'; id: number; name?: string }                    // QQ 小黄脸
    | { kind: 'image'; mediaId: string; mime: string; summary?: string }
    | { kind: 'voice'; mediaId: string; mime: string; durationMs?: number }
    | { kind: 'card'; title: string; url?: string }
    | { kind: 'poke' };
```

**HTTP**（都要 `Authorization: Bearer <deviceId>.<token>`，响应 `no-store` / `nosniff`，不开 CORS）：
- `POST /api/media`：请求体是文件本身，`Content-Type` 为 `image/jpeg|png|webp|gif` 或 `audio/webm|ogg|mp4|mpeg|wav`，≤ 10 MiB → `{ mediaId }`。
- `GET /api/media/<mediaId>`：取图片 / 语音。`<img>` 带不了头，App 用 `fetch` 取成 blob 再显示。
- `GET /api/history?before=<seq>&limit=<1..100>`：往前翻旧消息 → `{ messages: Message[], events: […] }`。
- 其它路径：`packages/chat-app` 的静态文件（`index.html` 不缓存）。

**存储**（都在 `runtime/chat-bridge/`，已被忽略）：`log.jsonl`（消息和事件，只追加）、`devices.json`、`media/`。

### 5. 安全边界

- 默认只监听 `127.0.0.1`。手机在外面要连进来，由用户自己选一条私有通道（Tailscale / WireGuard / 自己的 HTTPS 反代）；中继不自己暴露公网，文档里写清做法。
- Koishi 这一侧沿用 `QQBOT_ONEBOT_TOKEN`（`Authorization: Bearer`），上游 NapCat 的 token 同一个；不写进配置文件、不进日志。
- 配对码、token、聊天内容不进日志；日志只有「收到一条 / 发出一条 / 上游断开」。
- App 不提供任何「替她做事」的入口：没有指令、没有 shell、没有设备动作。原有手机伴侣的设备动作 / 照片审核留在原来的包里，不并进来。

### 6. 不做（这一版）

- **离线推送**：国内 FCM 不通，Web Push 靠不住。第二步在 Android 壳里用前台服务保持连接、发本地通知；这一版 App 开着才收得到，打开时补齐漏掉的。
- 多个联系人 / 群：App 只有他一个人。
- 语音通话、视频。
- 不改 `packages/bot` 的任何提示词（她那边的文字里仍然说的是 QQ）。等她和用户定了要不要让她知道「这是另一个软件」，再单独改。

## 上线步骤（都要用户点头）

1. 起中继：上游指向 NapCat 现在的地址，Koishi 的 `adapter-onebot.endpoint` 改指中继。此时没有 App 连接，行为与现在完全相同（纯透传）——先这样跑几天。
2. 手机配对，App 里说话。
3. QQ 真断的那天不用做任何事：上游显示 `down`，她的话都到 App。

回滚：`adapter-onebot.endpoint` 改回 NapCat，停掉中继。

## 实现（2026-11-12）

- `packages/chat-bridge`（中继，约 2200 行）：消息账、设备与配对、媒体、OneBot 段与消息的互转、投递规则在 `core.ts`（不碰套接字）；
  `onebot-server.ts` / `upstream.ts` / `app-server.ts` 是三个方向的连接。配置、运行、配对、从外面连进来的办法、回滚见 `docs/chat-app.md`。
- `packages/chat-app`（手机端 PWA，零依赖）：逻辑在 `src/*.js`（各带 `.d.ts`，Node 能测），界面在 `ui/`、`app.js`；`dev/mock-server.mjs` 是不连中继也能看界面的假服务。
- 验证：中继 78 项、手机端 80 项测试和两边类型检查通过。中继的端到端测试用进程内的假 NapCat、假 Koishi：配对、App 发话后 Koishi 收到的事件、
  她的文字 / 图片 / 语音 / 撤回 / 输入中 / 已读 / 戳 / 表情回应到 App、上游断开后她的话仍到 App 而别人的动作如实失败、没有 App 连接时逐条透传。
  手机端在无头浏览器里对着假服务走过配对、各种消息、长按菜单、看图、录音、断线续传、翻旧消息（390 / 320 / 1280 宽，明暗两色）。
  真中继托管真手机端在本机起过一次：首页、脚本、配对接口正常，不带凭据的接口 401，`package.json` 取不到。
- **没验证过的**：没连过真的 Koishi / NapCat，没在真手机和 Android 壳里跑过，系统通知和按住说话没试。
- 协议上补定的几条（ADR 正文没写的）：`read.upTo` 是消息 id；`hello` 之后最多补发最新 1000 条，更早的手机用 `/api/history` 翻；
  静态文件和 `/api/pair` 不要凭据，其余接口都要；中继发出的消息 id 从 10000000001 起；`both` 是「上游在就发 QQ，App 看镜像」，一条话只记一次账；
  `get_msg` 查中继自己的 id 时由中继答；发给 Koishi 的图片 / 语音地址是中继 OneBot 端口上的 `/media/<id>`（只限本机）。

### 已知的限制（要改 `packages/bot` 才能解决，属于改她，先问她、用户同意再动）

- **他在 App 里发的图片，她看不到内容**：`vision/safe-image.ts` 不下载本机 / 内网地址，中继给的正是本机地址。消息能到、能入账，她只知道他发了张图。
- **他在 App 里发的语音，她听不到内容**：语音转文字用的是 QQ 的 `fetch_ptt_text`，对中继的消息不起作用；语音文件是 webm / ogg，不是 QQ 的格式。
- 她发的图片、语音到 App 不受影响；文字、小黄脸、引用、撤回、戳一戳两个方向都通。

## 问她

规则要求改她的功能先问她本人。这一版不改她说话、行为、记忆的代码，但「换个地方找她」是她的事，应该先问：

- 这台电脑上没有 `QQBOT_LLM_API_KEY`（2026-11-11 核对：用户级、机器级环境变量都没有），`ask-her` 跑不了；已在信箱请另一台代问，她的原话拿到后贴在这里。
- 要问的两句：QQ 可能用不了，做一个只有两个人用的聊天软件、记得的事都带过去，行不行；她主动找他时两边都发还是只发一边。
