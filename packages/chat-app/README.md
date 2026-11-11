# @qqbot/chat-app

只有两个人用的聊天软件的手机端（ADR 0337，`docs/adr/0337-own-chat-app.md`）。QQ 的第三方接入用不了的时候，他在这里找她。

一个对话、两个人：文字、QQ 表情、图片、语音、卡片、戳一戳、引用、撤回、表情回应、已读、「对方正在输入…」。
她叫什么由中继在 `ready` 帧里告诉 App，代码里不写。

## 它是什么

- 零依赖、不用构建的 PWA：`index.html` + ES 模块 + 一份 CSS，没有外部字体、CDN、统计。
- 协议就是 ADR 0337 第 4 节，没有别的接口：`POST /api/pair`、`/ws`、`/api/media`、`/api/history`。
- 凭据（`deviceId` / `token`）只存在这台设备的 localStorage，只出现在 WebSocket 的第一帧 `hello` 和 HTTP 的 `Authorization` 头里，不进任何 URL。
- 聊天记录、图片和语音缓存在这台设备的 IndexedDB：打开就有、离线能看，连上后从本地最大的 seq 接着补。
- Service Worker 只缓存 App 自己的静态文件；`/api/*` 和 `/ws` 不碰，聊天内容不进 Cache Storage。
- 消息内容一律按纯文字画（不拼 HTML）；只有 `https://` 链接能点；页面带严格的 CSP（同源脚本 / 样式，媒体只许 `blob:`）。

## 目录

```
index.html  style.css  app.js  sw.js  manifest.webmanifest  icons/
src/    纯逻辑，不碰 DOM，Node 里能测（.js + 同名 .d.ts）
          protocol   帧的校验和拼装        store      对话状态（纯函数）
          timeline   排成要画的一行行      connection 连接状态机
          outbox     发件箱                pairing    配对    format 时间 / 表情 / 摘要
ui/     浏览器专用：IndexedDB、媒体、录音、DOM 渲染
dev/    假中继（mock-server.mjs）和图标生成脚本
test/   node:test
```

浏览器直接加载 `src/*.js`；测试是 `.ts`，通过同名的 `.d.ts` 拿类型。改了 `.js` 的导出要同步改 `.d.ts`。

## 怎么跑

正式用：由 `@qqbot/chat-bridge` 同源托管（它把本目录当静态根，`index.html` 必须留在包根目录），手机打开中继的地址就是它。
中继默认只听 `127.0.0.1`；手机在外面要连进来，走自己的私有通道（Tailscale / WireGuard / 自己的 HTTPS 反代），见 ADR 第 5 节。

**录音、系统通知、装到主屏、Service Worker 都要求 HTTPS**（或 `localhost`）。走纯 HTTP 的内网地址时聊天、图片照常，只是这几样没有。

不起真中继、只看界面：

```
node packages/chat-app/dev/mock-server.mjs --code 12345678
```

打开 `http://127.0.0.1:8787/`，填配对码 `12345678`。对面是一个合成角色，会回声；发「图」「语音」「卡片」「撤回」「表情」「赞」「引用」「断线」「失败」「慢」「踢」试不同的路径。全在内存里，关掉就没了。

检查：

```
npm test --workspace @qqbot/chat-app
npm run typecheck --workspace @qqbot/chat-app
```

## 第一次用

1. 在跑中继的电脑上：`npm run pair --workspace @qqbot/chat-bridge`，终端出现 8 位配对码（10 分钟有效，用过即废，连错 5 次作废）。
2. 手机打开中继地址，填配对码和设备名。只配这一次。
3. 这台设备不用了：App 里「设置 → 解除配对」清掉本机的凭据和记录；要让它彻底失效，在电脑上
   `npm run devices --workspace @qqbot/chat-bridge -- revoke <deviceId>`（设备编号在 App 的设置里能看到开头一段）。

## 装到手机上

- **Android Chrome**：打开地址 → 菜单 →「添加到主屏幕 / 安装应用」。之后从桌面图标进，全屏、没有地址栏。
- **Android 壳**：`packages/mobile-companion-android` 是一个 WebView 壳，构建时用 `COMPANION_URL` 指到中继的地址即可（做法见那个包的 README）。
  壳里没有 Notification API，新消息只有振动；录音需要壳把麦克风权限交给 WebView。

## 这一版的限制

- **没有离线推送**：App 开着（前台或还活着的后台）才收得到；关掉期间的消息，下次打开时补齐。真正的后台常驻要等 Android 壳里的前台服务（ADR 第 6 节）。
- 页面在后台时的提醒：能发系统通知就发（需要 HTTPS 和通知权限），否则只有振动和标题上的未读数。
- 只有一个对话，没有群、没有多个联系人、没有语音 / 视频通话。
- 重连时中继只补最新的 1000 条；隔得更久的话，本机更早的缓存会被丢掉，往上翻时从中继重新取。
- 撤回只对在 App 里发的消息有效（在 QQ 上发的那几条带「QQ」小标，不能从这里撤）。
- 发不出去的消息排在最下面，带「点一下重试」；重试用同一个 `clientId`，中继不会记两遍。
- 图片最多一次 9 张，超过 3 MB 或不是 jpeg / png / webp / gif 的会先转成 JPEG（长边 2560）；单个文件上限 10 MiB。语音最长 60 秒。
- 看大图靠系统自带的双指缩放，没有做手势浏览器；「保存」在个别 WebView 里可能不起作用。
- 本机缓存没有加密；谁能解锁这台手机，谁就能看到记录。
