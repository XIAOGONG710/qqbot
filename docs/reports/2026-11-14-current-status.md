# 当前功能状态（2026-11-14）

接替 [2026-10-09 的状态汇总](2026-10-09-current-status.md)。回答三件事：线上开着什么、代码里有但关着的是什么、正在做和等人定的是什么。
线上开关以 DSH 那台 11-13 23:11 导出的快照为准（[`exchange/live/koishi-2026-11-13-2311.yaml`](../../exchange/live/koishi-2026-11-13-2311.yaml)，`scripts/read-switches.mjs` 打码导出）；
每个功能的说明见 [模块总览](../modules/README.md)，功能总表在 `packages/bot/src/platform/features.ts`。

## 运行快照

- 线上只有一台（DSH 那台）：Koishi + NapCat，数据目录 `runtime/bot-shadow`（旧的 `runtime/bot` 11-13 改名为 `runtime/bot-legacy-20261113`，没删）。
- 模型：DeepSeek `deepseek-flash`，温度 1.3，不开思考；认真问她时深思换模型（`deliberate` + `depthRouting`）。看图同样走 DeepSeek。
- 长期记忆：Hindsight 开着（`127.0.0.1:8899`），bank 前缀 `linmengyao`。
- 名单外好友不回（`unlistedFriends: false`），群聊关着。
- 功能总表 119 项：**开着 97 项、关着 22 项**。开着的按组：说话 27、她的日子 26、在 QQ 上的样子 12、主动找他 9、记忆和安全 9、B 站 7、照片和表情 5、工具 2。
  不是开 / 关、而是选了档位的：主动消息 `on`、图片表情 `send`、事实检查 `fix`、搜索 `auto`、节日 `greet`、设备控制 `on`、说说 `on`、签名 `on`、B 站五项都是 `on`。

## 代码里有、线上关着的 22 项

| 组 | 开关 | 是什么 | ADR |
| --- | --- | --- | --- |
| 说话 | `shortReplies` | 说话更短 | — |
| 说话 | `tailCap` | 句尾「吧」「呢」封顶 | 0146 |
| 说话 | `silenceNotice` | 没回时告诉他原因 | 0173 |
| 说话 | `jealousy` | 吃醋（最轻一档） | 0123 |
| 她的日子 | `realAirQuality` / `realDaylight` / `realCalendar` | 真实空气质量 / 日照 / 法定节假日与调休 | 0227 / 0228 / 0231 |
| 她的日子 | `ownerPeek` | 他能不能看她自己总结的东西（默认不能：她的私人空间） | 0200 |
| 主动找他 | `photoShares` | 喂完猫发张照片 | 0110 |
| 主动找他 | `hisHours` | 按他在线的钟头排 | 0117 |
| 照片和表情 | `foodPhotos` | 吃的照片（用户 10-25 看过货架后关掉） | 0128 |
| 照片和表情 | `aiPhotos` | AI 生活照草稿，人工审核后才可用（见下「生图」） | 0240 |
| 在 QQ 上的样子 | `reactions` | 表情回应 | 0083 |
| 在 QQ 上的样子 | `qzoneBrowse` / `qzonePeek` / `qzoneStrangers` | 翻自己空间 / 刷好友动态 / 刷陌生人空间 | 0142 / 0145 / 0144 |
| 在 QQ 上的样子 | `groupChat` | 群聊（只在名单里的群、被叫到才说） | 0210 |
| 记忆和安全 | `crossRecent` | QQ 和桌面互读最近几轮 | 0177 |
| 记忆和安全 | `unlistedFriends` | 名单外的好友也回 | 0209 |
| 记忆和安全 | `qqControl` / `qqFriendGate` | 账号控制面 / 好友申请 | 0142 |
| 工具 | `dsh` | 外部顾问（按需咨询） | 0223 |

打开任何一项都会改变她的言行或对外动作：按 CLAUDE.md，先问她本人、用户点头、再改线上开关。

## 正在做

- **架构迁移（[ADR 0336](../adr/0336-interpreter-executor-modules.md)）**：第 5 步「逐个拆模块」进行中。`contact.ts` 里还剩心境、形状、深思、长短、时间块、公共记忆与披露等互相缠着的几组，
  以及设备菜单、他的请求等她点头（这两样基线没覆盖，要先补场景）。第 6 步（模拟器用同一个解释器、控制台表单从模块定义生成）还没开始。不改行为，行为基线逐字不变。
- **自己的聊天软件（[ADR 0337](../adr/0337-own-chat-app.md)）**：中继和手机端写好了，**未上线**。上线第一步（纯透传）要改线上 Koishi 的 endpoint 并重启，要用户点头。
  她要的「先在 QQ 上说，不在再去那边戳一下」还没做（改她主动找他的行为，要用户同意）；App 里他发的图片、语音她还看不到、听不到。
- **语音、唱歌**：DSH 那台在做（语音归用户，这台不碰）。11-13 起她可以随时发语音（`f09ba414`），语音网关多种子挑选（`82405949`）。
- **生图**：ADR 0239–0247 已经把「草稿 → 人工审核 → 才能发」的整条链路、预算和每日上限、手机审核做好了，`aiPhotos` 关着。缺的是选定生图模型 / 服务（用户：不急，要耐心找）。

## 备份

- 每天一份（`scripts/backup.mjs`，服务守护调用）：Hindsight 数据库 + 她的聊天记录和状态文件，保留 7 天。
- 11-13 发现两处问题，都已处理：
  - 服务守护 11-10 开机后没自启，11-11 到 11-13 没有备份；DSH 11-13 把它起起来，并补跑了一次（`hindsight.sql` 41.5 MB、`her-state.zip` 31.2 MB，完成）。
  - 11-10 起 `her-state.zip` 只有 190 字节：脚本先认了旧的 `runtime/bot`。现在按 Koishi 配置里的 `dataDir` 备份，配置的目录不在就判失败（`fix(backup)` 提交）。
- **恢复演练从来没跑过**（`scripts/hindsight-restore-drill.mjs`，只往隔离的空库导入，不碰线上）。跑不跑等用户定。

## 等用户定的

1. 恢复演练要不要跑一次（只读备份、导入一个隔离的空库）。
2. ADR 0337 上线第一步（改 endpoint、重启 Koishi）。
3. ADR 0337「先 QQ、没应再去 App 说一句」要不要做（她本人 11-11 的原话见 ADR）。
4. 生图模型选定后，`aiPhotos` 再按 ADR 0240 的多闸打开。
