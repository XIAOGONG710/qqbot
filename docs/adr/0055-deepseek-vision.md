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
