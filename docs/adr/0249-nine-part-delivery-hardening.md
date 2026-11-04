# ADR 0249：九项交付收口

日期：2026-11-04

## 目标

把跨端连续性、生图、手机端、语音、健康检查、恢复、现实数据、长期拟人评测和外部平台草稿从“已有模块”收口为可测试的交付边界。

## 决策

1. DSH 显式咨询和手机伴侣共用的短上下文写入 `dataDir/memory/dsh-recent.json`。只在完整问答成功后原子提交，损坏文件隔离，最多保留有限轮次；QQ 原聊天历史仍由原记录负责。
2. 真实生图继续使用 ADR 0247 的预检和 `--confirm-live` 验收；没有密钥或真实供应商时只报告阻塞，不生成假成功。生成结果仍必须经过质量门和人工审核。
3. `@qqbot/mobile-companion-android` 提供最小原生 Android 宿主。它只加载构建时指定的同源 HTTPS PWA，不内置凭据、不提供 JavaScript 桥或 shell，麦克风需要系统授权。
4. 手机协议加入实时语音 start/chunk/stop/cancel。服务端强制分片顺序、单片/总量/时长边界和显式中断；宿主可在 stop 后把转写与回复作为同一轮对话返回。
5. Koishi 状态页继续作为跨端健康检查页，统一显示 QQ、长期记忆、现实世界数据、DSH、手机伴侣和 AI 照片运行摘要，不展示路径、密钥或上游错误正文。
6. 文件恢复演练后可用 `restore:hindsight` 向名称以 `qqbot_restore_drill_` 开头的空 PostgreSQL 数据库导入。必须显式确认、校验完整备份和空库；不触碰在线库、不自动删演练库。
7. 现实世界事实使用统一来源、新鲜度、优先级和冲突裁决契约。同等级近时来源矛盾时返回 `conflict`，不得由模型猜一个值。
8. `eval:companion` 对一段或多段聊天 JSONL 输出重复、内部状态泄漏、助手套话和超长气泡等匿名比率，不回显原话，用于按周/月对比。
9. Koishi 新增“外部草稿”中文页面，统一筛选贴吧、抖音和小红书草稿。页面只允许批准/拒绝；批准不会发布，真实发布仍必须由官方适配器、账号授权、平台开关和发布状态机共同放行。

## 验收边界

- 仓库内可自动验证：协议、状态机、安全边界、持久化、页面服务端接口、静态 Android 安全配置、恢复计划与匿名评测。
- 环境相关的最终验收：真实图片供应商调用、Android 真机录音/网络、正式域名证书、隔离 PostgreSQL 实际导入、外部平台官方账号授权。缺少对应凭据或设备时必须报告“未实测”，不能用模拟结果冒充。

## 常用命令

```powershell
npm --workspace @qqbot/bot run eval:companion -- --chat runtime/bot/chats/<文件>.jsonl
npm --workspace @qqbot/bot run ai-photo -- smoke --confirm-live
npm run restore:drill
npm run restore:hindsight -- --backup runtime/backups/<日期> --database-url postgresql://用户:密码@主机/qqbot_restore_drill_20261104 --confirm-isolated --plan
npm --workspace @qqbot/mobile-companion-android test
```
