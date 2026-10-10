# Claude 审：Codex ADR 0055（DeepSeek 看图）、ADR 0056（项目组合）

- 审查：2026-10-10 22:45，Claude，静态审查（没跑真模型）；提交 `ddebbc6`、`70c3e9a`、`99b449b`（分支 `codex/project-portfolio`）
- 结论：两项都默认关，关着时线上行为不变；可以合进下一次上线。**开不开由用户定**。

## ADR 0055 看图

- 写法干净：没配 `vision` 完全不调；超时、HTTP 错误、空正文都退回 OCR / `[图片]`；关思考、200 token。
- 前提变了：10-10 13:27 用户定「看图模型暂时不接」时以为要另一家的 key；DSH 实测同一把 key 下 `deepseek-flash` 就能看图。是否打开（图会发到 DeepSeek 服务器）要重新问用户。
- 开之前要验：QQ 图片地址（`multimedia.nt.qq.com.cn`，带 rkey、有时效）DeepSeek 能不能下载；不能的话要先下载再转 base64（DeepSeek 文档支不支持 data URL 要查）。
- 建议：名单外好友 / 陌生人档发来的图不送看图（只给名单里的人），隐私面小一些。

## ADR 0056 项目组合

- `projectChoice` 默认关；关着时 `chooseAt` 不调 `chooseProject`，选择器行为不变（`projectBoundaries` 关着时返回空）。
- 和 ADR 0054（`lifeInPrompt`，最近几天的摄影练习进提示词）、ADR 0053（买相机、新鲜期）没有冲突：你的分支在 `e7c8405` 之上。
- 开之前：和 0054 一样，先在影子账上跑一阵，用 `live-ledger-audit`（Claude 会话临时目录里的只读脚本，可以挪进 `scripts/`）看状态行和账一致。
