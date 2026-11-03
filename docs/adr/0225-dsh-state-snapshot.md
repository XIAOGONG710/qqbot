# ADR 0225：QQ → DSH 真人式状态快照

状态：已实现，默认跟随 DSH 开关；只读，不写回 QQ 状态。

## 决定

QQ 端唯一计算需要值、真人式数值和关系数值，并在 DSH 开启时每 10 分钟原子写入：

```text
<QQBOT_SOUL_DIR>/STATE.json
```

快照带 `kind`、`version`、`generatedAt` 和脱敏后的数值字段。DSH 插件只接受版本为 1、时间不超过 30 分钟且未来自未来超过 1 分钟的快照；过期、损坏或字段不合法时不注入，并记录一条诊断日志。

## 边界

- 不写入 QQ 号、聊天原文、日志、令牌、地址或完整世界书；
- `recentEvents` 只传事件类型摘要；
- DSH 只读快照，不直接修改 QQ 的状态、关系账或世界账；
- DSH 开关关闭时删除旧快照，避免桌面端继续使用上一轮状态；
- `STATE.json` 与 `NOW.md`、`FEELINGS.json` 一样属于本地临时导出，不进入聊天记录和长期记忆。

## DSH 侧适配

`dsh-plugins/dsh-linmengyao-memory/index.js` 以独立的 `linmengyao-state` 上下文块读取它，并保留旧版本插件兼容：没有 `STATE.json` 时继续使用已有的 `NOW.md`、`FEELINGS.json` 和记忆桥，不把缺失状态编成当前事实。
