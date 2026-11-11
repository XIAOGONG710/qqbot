# 自己的聊天软件：QQ 用不了的时候在这里找她（ADR 0337，建设中，未上线）

目标（用户 2026-11-11）：腾讯在收紧第三方 QQ 接入。哪天 NapCat 登不上了，他还能在自己的 App 里正常跟她聊天，
她记得的事、作息、主动消息都跟过来。

**上线要改线上 Koishi 的 `adapter-onebot.endpoint` 并重启，必须用户点头。** 下面是做法，不是已经做了。

## 现在的状态

| 部分 | 状态 |
|---|---|
| 中继 `packages/chat-bridge` | ✅ 写好，78 项测试（含端到端：假 NapCat + 假 Koishi + 假手机） |
| 手机端 `packages/chat-app` | 另见该包 |
| 线上 Koishi 指向中继 | ⛔ 没做（要用户点头） |
| 她看 App 里发来的图片 | ⛔ 现在看不了，见「已知的限制」 |

## 它是什么

```
Koishi(adapter-onebot) ──ws──▶ chat-bridge ──ws──▶ NapCat（有就连，没有也照常工作）
                                   ▲
                                   └── http / ws ── 手机 App
```

中继在 Koishi 眼里就是 NapCat。`packages/bot` 和 Koishi 插件一行不改：

- 他在 App 里发的话，中继拼成一条 `message_private` 事件，`user_id` 是他的 QQ 号。她那边就是「他发来一条消息」。
- 她发给他的话，按投递规则送到 QQ 或 App；两边的都记进中继自己的消息账，App 里看到的是连续的记录。
- 别的联系人、群、说说、账号控制面：原样在 Koishi 和 NapCat 之间透传。上游不在时这些动作回失败，不假装成功。

## 配置

环境变量优先，其次 `runtime/chat-bridge/config.json`，最后默认值。

| 环境变量 | config.json | 默认 | 说明 |
|---|---|---|---|
| `CHAT_BRIDGE_OWNER_ID` | `ownerId` | 必填 | 他的 QQ 号 |
| `CHAT_BRIDGE_OWNER_NAME` | `ownerName` | `他` | 事件里他的昵称 |
| `CHAT_BRIDGE_SELF_ID` | `selfId` | 必填 | 她的 QQ 号（和 Koishi 里 `selfId` 一致） |
| `CHAT_BRIDGE_SELF_NAME` | `selfName` | `她` | 她的昵称，App 顶上显示的名字 |
| `CHAT_BRIDGE_UPSTREAM` | `upstreamUrl` | 不填 | NapCat 的 OneBot 正向 WS 地址，如 `ws://127.0.0.1:3001`。不填就没有上游 |
| `CHAT_BRIDGE_ONEBOT_PORT` | `onebotPort` | `3200` | 给 Koishi 连的端口，**永远只开在 127.0.0.1** |
| `CHAT_BRIDGE_APP_PORT` | `appPort` | `3210` | 给手机连的端口 |
| `CHAT_BRIDGE_HOST` | `host` | `127.0.0.1` | 手机那个端口监听的地址 |
| `CHAT_BRIDGE_DELIVERY` | `delivery` | `last-active` | 投递规则：`last-active` 或 `both` |
| `CHAT_BRIDGE_DATA` | — | `runtime/chat-bridge` | 数据目录 |
| `CHAT_BRIDGE_STATIC` | `staticDir` | `packages/chat-app` 里有 `index.html` 的那个目录 | App 的静态文件 |
| `QQBOT_ONEBOT_TOKEN` | **不许写进文件** | 不设 | Koishi 连中继要带它，中继连 NapCat 也带它 |

`config.json` 例子（号码换成真的）：

```json
{
  "ownerId": 10001,
  "ownerName": "阿明",
  "selfId": 20002,
  "selfName": "小瑶",
  "upstreamUrl": "ws://127.0.0.1:3001"
}
```

`config.json` 里出现 `token`、上游地址里带 `?access_token=` 都会拒绝启动：凭据只放环境变量。

## 跑起来

```bash
npm start --workspace @qqbot/chat-bridge
# 或者起的同时打印一个配对码
npm start --workspace @qqbot/chat-bridge -- --pair
```

日志只有「连上 / 断开 / 收到一条 / 发出一条」，没有 token、配对码和聊天内容。`Ctrl+C` 停。

## 把 Koishi 指过来（要用户点头）

`runtime/koishi/koishi.yml` 里 `adapter-onebot` 的 `endpoint` 从 NapCat 的地址改成中继的：

```yaml
adapter-onebot:
  endpoint: ws://127.0.0.1:3200     # 原来是 NapCat 的地址；NapCat 的地址挪到中继的 upstreamUrl
  # 其余（protocol、selfId、token）不动
```

然后重启 Koishi。建议分三步（ADR「上线步骤」）：

1. 只起中继、改 endpoint，不配对手机。这时没有人在 App 里说过话，她发给他的话全部照旧走 QQ，行为和直连 NapCat 相同——先这样跑几天。
2. 手机配对，在 App 里说话。
3. QQ 真断的那天不用做任何事：App 上显示上游 `down`，她的话都到 App。

## 配对手机

配对一次，长期有效（不是每次扫码）。

```bash
npm run pair --workspace @qqbot/chat-bridge
```

终端打印一个 8 位配对码：10 分钟内有效，只能用一次，输错 5 次作废（再跑一次命令拿新的）。在手机 App 里输入它。
中继在跑的时候直接跑这条命令就行，不用重启。

看有哪些设备、撤销一台：

```bash
npm run devices --workspace @qqbot/chat-bridge
npm run devices --workspace @qqbot/chat-bridge -- revoke <deviceId>
```

撤销后那台手机的凭据马上失效，已经连着的连接几秒内被断开。手机丢了就撤销它。
设备表在 `runtime/chat-bridge/devices.json`，里面只有凭据的 SHA-256，没有原文；直接删掉表里那一项效果一样。

## 手机在外面怎么连进来

中继默认只听 `127.0.0.1`，**不要把它直接放到公网上**。手机要在外面用，自己选一条私有通道：

### Tailscale（推荐，最省事）

1. 电脑和手机都装 Tailscale，登录同一个账号。
2. 在电脑上把中继的手机端口挂到 tailnet 里，并带上 HTTPS：

   ```bash
   tailscale serve --bg 3210
   ```

   手机上打开 `https://<电脑名>.<tailnet 名>.ts.net/`。中继本身仍然只听 `127.0.0.1`，只有你 tailnet 里的设备进得来。
   （HTTPS 是必要的：手机浏览器只在 HTTPS 下才给录音权限，才能装成 PWA。）
3. 不要用 `tailscale funnel`——那是放到公网。

### WireGuard

手机和电脑建好隧道后，把 `CHAT_BRIDGE_HOST` 设成电脑在隧道里的地址（例如 `10.0.0.1`），手机打开 `http://10.0.0.1:3210/`。
这样没有 HTTPS，录语音和安装 PWA 用不了；要用就在前面加一层自己的 HTTPS 反代。

### 自己的 HTTPS 反代

反代到 `http://127.0.0.1:3210`，要转发 WebSocket（`/ws`）。请求体上限放到 10 MiB 以上（传图片、语音）。
反代放在哪、谁能访问由你自己负责；中继只认配对过的设备，但登录入口（`/api/pair`）和 App 的壳是不要凭据就能访问的。

不管哪种：`CHAT_BRIDGE_HOST` 设成 `0.0.0.0` 之前想清楚这台电脑的网络里都有谁。

## 投递规则

- `last-active`（默认）：他最近一条消息从哪边来，她的话就发到哪边。从没在 App 里说过话时全部走 QQ。上游不在（NapCat 连不上，或者 NapCat 的心跳说 QQ 掉线了）一律发到 App。
- `both`：上游在就总是发 QQ（App 里同时看得到这一条的镜像）；QQ 没发出去就改发 App。

走 QQ 的那些（他在 QQ 上说的、她发到 QQ 的）也镜像进消息账，App 打开就是连续的记录。
App 没开着的时候她发到 App 的话先记在账里，打开时补齐；这一版没有离线推送。

## 数据

都在 `runtime/chat-bridge/`（已被 Git 忽略）：

| 文件 | 内容 |
|---|---|
| `log.jsonl` | 消息和事件，只追加。**这是聊天记录原文，注意备份和保密** |
| `devices.json` | 已配对的设备（只有凭据的摘要）和当前配对码的摘要 |
| `media/` | 图片和语音 |
| `config.json` | 配置（可选） |

## 已知的限制

- **她现在看不了 App 里发来的图片。** 事件里图片的地址是中继的本机地址（`http://127.0.0.1:3200/media/…`，ADR 这么定的），
  而 `packages/bot` 下载图片时拒绝本机和内网地址（`vision/safe-image.ts`，防 SSRF）。图片照样送到、照样进记录，她只知道「他发了一张图」。
  要她看得见，得在 `packages/bot` 里给这个地址开一个口子——那是改她的行为，按规则要先问她、用户同意。
- **App 里发的语音她听不出字。** 语音转文字用的是 QQ 自带的（`fetch_ptt_text`），App 里的语音不在 QQ 上。她只知道「他发了一条语音」。
- 她的提示词里仍然说的是 QQ；她不知道这是另一个软件（ADR 第 6 节，等她和用户定）。
- 她发视频、文件、合并转发到 App：App 显示不了，这一条回失败（不假装发到了）。
- 他在 QQ 上发的那条，App 里撤回不了（中继没法替他操作他的 QQ）。
- App 协议里没有「取消表情回应」。
- 中继答 `get_friend_msg_history` 只在上游不在的时候；上游在时原样问 NapCat，NapCat 的记录里没有 App 上的那些。

## 回滚

1. `adapter-onebot.endpoint` 改回 NapCat 的地址，重启 Koishi。
2. 停掉中继（`Ctrl+C`）。

`runtime/chat-bridge/` 留着不碍事，下次再起还是那本账。她自己那份聊天记录在 bot 的数据目录里，App 上聊的那些她当时就记下了，回滚不丢。

## 检查

```bash
npm run typecheck --workspace @qqbot/chat-bridge
npm test --workspace @qqbot/chat-bridge
```

测试只用虚构的号码和名字，不连真 QQ、不读 `characters/` 和 `runtime/`，只在 `127.0.0.1` 的临时端口上监听。
