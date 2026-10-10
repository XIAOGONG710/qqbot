# ADR 0055：用现有 DeepSeek 接口看懂图片

- 状态：已实现，默认关；尚未上线
- 日期：2026-10-10

## 背景与取证

ADR 0052 只接了 QQ 语音转文字和 NapCat OCR。当时按「DeepSeek 不能看图、需要另一家的 key」留下 `ImageDescriber` 接口，没有实现提供方。

DSH 10-10 的实测推翻了这个前提：同一把 `QQBOT_LLM_API_KEY` 下，`deepseek-flash` 能正确描述自制的色块图，也能读懂一张自制聊天截图；`deepseek-v4-pro` 收到的是 `Unsupported Image`，关思考时还会编造图中内容，所以不能用来兜底。

DeepSeek 官方图像理解文档也明确：`deepseek-flash` 的 Chat Completions 接受 `user.content` 数组，其中图片是标准的 `image_url` 内容块；可直接传公网 `http(s)` URL。图片不能放在 system / assistant 消息里。

## 决策

1. `vision.provider` 现在接受 `deepseek`；没有 `vision` 配置时仍完全不调看图接口。
2. 看图复用聊天模型的 `QQBOT_LLM_API_KEY`，不新增密钥。默认接口 `https://api.deepseek.com`，默认模型 `deepseek-flash`，但配置可覆盖接口和模型名。
3. 每张普通照片 / 截图单独发一个 Chat Completions 请求：一段简短中文说明 + QQ 图片公网 URL；关思考、正文上限 200 token。表情包照旧不发。
4. NapCat OCR 和 DeepSeek 看图并行：有两边结果时写成 `[图片：图像描述；上面写着：OCR]`。看图超时、HTTP 错误、空正文都只退回 OCR 或 `[图片]`，不挡住回复。
5. 两个运行入口共用 `configuredImageDescriber`：独立入口和 Koishi 插件行为一致。Koishi 控制台增加「看懂图片内容」开关，默认关。
6. 看图默认关，因为打开后聊天里的普通图片会发到 DeepSeek 服务器；由用户确认隐私范围后再开。OCR 仍在 NapCat 本地进行，不受这个开关影响。

## 验证

- `vision.test.ts` 固定请求 URL、Authorization、模型、关思考参数和官方 `image_url` 结构；HTTP 错误、空正文必须抛错给媒体层降级。
- `runtime.test.ts`：默认没有 vision；`deepseek` 配置补 8 秒默认上限；其他提供方拒绝。
- 插件配置测试：旧配置默认关；打开后补默认接口、模型、上限；写回再读形状不变。
- `media.test.ts` 已覆盖图像描述与 OCR 合并、看图失败时只保留 OCR。

## 上线前

1. 在虚拟机的 Koishi 控制台打开开关（线上不在这台开发机；不能拿本机端口和 `runtime/` 判断线上状态）。
2. 用不含隐私的自制图做一次真接口冒烟，确认 QQ 图片 URL 能由 DeepSeek 下载、日志显示「看图」。
3. 再由用户发一张愿意交给 DeepSeek 的普通图片确认端到端；失败只关开关，不影响 OCR 和文字聊天。

## 调整（2026-10-10 晚，Claude）：只给名单里的人；先下载再发

- **用户 10-10 22:50**：开，只对名单里的人。`app.ts` 建两份读取器，名单里的人用带看图的，名单外的（`unlistedFriends`）只走语音转文字和 OCR（OCR 在本机，图不出去）。测试：名单里的人发图调看图、名单外的不调，OCR 两边照旧。
- **先把图下载到本机、转成 base64 data URL 再发**（`imageDownloader`，单张 5 MB 以内，4 秒）：冒烟时 DeepSeek 自己下载外网图会失败（维基的图 400「Failed to download image」），
  base64 的自制图 0.8 秒认对（「左侧为红色，右侧为蓝色」）。下不来、太大就退回直接给地址，再不行退回 OCR。只在线上入口 `configuredImageDescriber` 里下载，`deepSeekImageDescriber` 的测试照旧。
- 上线要在 `koishi.yml` 的插件配置里打开 `vision.enabled`；第一次真用看日志里「看图」那一行，再请用户发一张愿意交给 DeepSeek 的普通照片。
- ADR 0055 里「线上不在这台开发机」不对：这台机器的 Koishi 就是线上实例（`exchange/handoff/2026-10-10-2235-claude.md`）。

## 调整（2026-10-10 夜，Claude）：空回复再问一次；DSH 对抗审查补的证据

DSH 的对抗审查（`exchange/reviews/2026-10-10-dsh-adversary-review.md`，整理在 `exchange/handoff/2026-10-10-2355-dsh.md` 更正四）补了几条更硬的证据：

- **接口自己声明**：`GET /models` 里 `deepseek-flash` 的 `input_modalities` 是 `["text","image"]`，`deepseek-v4-pro` 只有 `["text"]`；
  带一张 64×64 图，flash 多算 184 个 token，v4-pro 只多 5 个（就是 `[Unsupported Image]` 占位符）。所以看图只能用 flash。
- **图没到时会编**：v4-pro 收不到像素、题面又说有图时会照给答案；flash 在「没图 + 关思考」下 4 次里也编过 1 次。
  我们这边图下不来时退回给原地址，flash 下不到会返回 400「Failed to download image」（报错，不是编），再退回 OCR / 「[图片]」——不会出现「没图却有描述」。
- **认字会丢字也会加字**，而且看不清时还说自己「清晰度很高」：描述只当「图里大概是什么」，图上的字照旧以 NapCat 的 OCR 为准（`[图片：……；上面写着：……]` 两段分开）。
- **偶尔 200 但正文是空的**（低频、没复现出概率，不是推理吃光预算）：原来直接算「没看出来」。现在 `vision.ts` 同一张图（已下好的 base64）再问一次（`EMPTY_RETRIES = 1`），
  还空才算失败；HTTP 错误不重问（400 再问也是 400）。整体仍受 `media.ts` 的 8 秒上限管。
- 看出来时日志记一行「看图：看图模型说了 N 个字（x 秒）」，只记字数，不记图上是什么；原来成功时没有日志，没法确认端到端。

验证：`vision.test.ts` 加空回复重问（第二次拿到就用、两次都空才失败、400 只问一次）；真接口冒烟（本机画的红底白方块，base64）3/3 认对，每次 0.8–1.1 秒。
