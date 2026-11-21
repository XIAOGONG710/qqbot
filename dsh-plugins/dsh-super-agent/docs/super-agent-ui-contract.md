# Super Agent 控制台 · 前后端数据契约（v1）

Host 半以 `prefix` 路由注册 `/api/super-agent`，Client 半只允许通过这两个端点访问数据，**不得**直接读 Session 事件、不得写 DOM。

## 1. `GET /api/super-agent/state`

轮询间隔 1500ms（页面隐藏时退避到 6000ms）。返回 `application/json`，形状固定如下（字段只会新增，不会改名）：

```jsonc
{
  "schema": 1,
  "now": 1762700000000,
  "startedAt": 1762690000000,
  "uptimeMs": 10000000,
  "mode": { "accept": "observe", "paused": false, "runner": "simulate" },   // accept: observe|accept, runner: session|simulate
  "config": { "maxWorkers": 4, "watchdogIntervalMs": 15000, "staleAfterMs": 240000,
              "routerModel": "deepseek-flash", "workerModel": "deepseek-flash" },
  "health": { "state": "ready", "note": "" },                                // ready | warn | error

  "router": { "decisions": 42, "batches": 20, "avgBatch": 2.1, "avgDecisionMs": 320,
              "lastDecisionAt": 1762699990000, "model": "deepseek-flash",
              "semanticCalls": 12, "semanticFailures": 0 },

  "admission": {
    "received": 300, "fastPathBlocked": 210, "semanticCandidates": 90,
    "semanticRejected": 55, "accepted": 35, "dispatched": 28, "ratePerMin": 12.4,
    "funnel": [
      { "stage": "raw",        "label": "原始事件", "count": 300 },
      { "stage": "fast",       "label": "规则快筛", "count": 90  },
      { "stage": "semantic",   "label": "语义判定", "count": 35  },
      { "stage": "dispatched", "label": "已派单",   "count": 28  }
    ],
    "rules": [ { "id": "bug", "name": "群里的 bug 报告", "hits": 12,
                 "instruction": "静默复现并修复，只在确认问题且方案简单时交付" } ]
  },

  "workers": [
    { "id": "w-01", "ticketId": "t-abc", "threadId": "th-1",
      "title": "修复登录超时", "status": "running",            // queued|running|done|failed|cancelled
      "source": "github", "cwd": "C:/…", "startedAt": 1762699000000, "endedAt": null,
      "elapsedMs": 182000, "progress": 0.45, "lastProgressAt": 1762699990000,
      "turns": 3, "steps": 12, "toolCalls": 24,
      "tokens": { "in": 12000, "out": 900, "cacheRead": 8000 },
      "model": "deepseek-flash", "summary": "复现中", "stalled": false,
      "simulated": true, "attentionCost": 0, "sessionId": "sa-worker-01" }
  ],

  "threads": [
    { "id": "th-1", "title": "Issue #42 登录超时", "source": "github", "updatedAt": 1762699990000,
      "messages": 5, "subscribers": ["w-01"], "directDeliveries": 3, "routerBypassed": 2 }
  ],

  "watchdog": { "state": "ok",                    // ok | warn | alert
                "checks": 33, "lastCheckAt": 1762699990000,
                "stalled": 0, "loops": 0, "drift": 0,
                "findings": [ { "at": 1762699990000, "workerId": "w-01",
                                "kind": "stall", "text": "w-01 12 分钟没有新进展" } ] },

  "attention": { "emitted": 4, "suppressed": 31, "budget": 0.12, "ratio": 7.75,
                 "reasons": { "result-ready": 2, "decision-needed": 1, "failed": 1, "progress": 0 },
                 "recent": [ { "at": 1762699990000, "reason": "result-ready",
                               "text": "PR #43 已提交，等你验收", "workerId": "w-01" } ] },

  "metrics": { "completed": 20, "p50Ms": 744000, "p95Ms": 942000, "avgMs": 800000,
               "routerDecisions": 42, "cacheReadTokens": 23230000,
               "sessions": 20, "savedMinutes": 86 },

  "events": [ { "t": 1762699990000, "kind": "trigger",       // trigger|admit|reject|batch|dispatch|progress|
                                                        // result|watchdog|attention|mode|error
               "level": "info", "text": "github · @alice 评论：登录超时",
               "workerId": null, "threadId": "th-1" } ],  // 新→旧，最多 200 条

  "timeline": [ { "t": 1762699990000, "kind": "trigger", "workerId": null } ],   // 最多 400 条

  "compare": { "super":  { "p50Ms": 744000, "p95Ms": 942000 },
               "single": { "p50Ms": 900000, "p95Ms": 1770000, "estimated": true } }
  // single.estimated=true 表示没有实测单会话基线，用的是论文口径（p95 = 29.5 分钟）回落值
}
```

## 2. `POST /api/super-agent/command`

请求体 `{ "command": "…", "args": { … } }`，响应 `{ "ok": true, "result": … }` 或 `{ "ok": false, "error": "…" }`。

| command | args | 语义 |
| --- | --- | --- |
| `demo` | `{ triggers?: number, work?: number, speedMs?: number }` | 重放论文实验负载：合成约 300 条消息 / 20 个工单请求，模拟 Worker 执行，产出 p50/p95 与对照数据 |
| `mode` | `{ accept?: "observe"\|"accept", paused?: boolean }` | 切换主动模式 / 暂停路由 |
| `trigger` | `{ source, author?, text, threadId? }` | 注入一条真实触发器，走完整两级准入 |
| `dispatch` | `{ title, brief, cwd? }` | 绕过准入，直接派一个真实 Worker 会话 |
| `stop` | `{ workerId }` | 中断 Worker 会话 |
| `watchdog` | `{}` | 立即巡检一次 |
| `reset` | `{}` | 清空全部记录（保留配置） |

## 3. 视觉与交互要求（Client 半）

- 注册 `sidebar.panellist` 图标 + `main` 页面（key = `dsh-super-agent`），页面即「Super Agent 控制台」。
- 必须有的可视化：
  1. **架构拓扑图**（SVG）：左侧 Router 节点、中间线程轴、右侧 Worker 泳道、底部注意力闸门；触发点沿路径流动，Worker 运行时节点脉冲，卡住时变红。
  2. **准入漏斗**：4 级漏斗（原始→规则快筛→语义判定→派单），带每级转化率。
  3. **注意力预算表**：打扰次数 vs 静默次数、克制比（suppressed/emitted），最近 3 次打扰的原因。
  4. **Worker 泳道卡**：状态、进度环、用时、turns/steps/toolCalls、token、线程链接、stalled 标记。
  5. **Watchdog 健康环** + findings 列表。
  6. **指标卡**：p50/p95、Router 决策数、平均 batch、cacheRead token、触发器/分钟；与单会话基线对照的条形对比。
  7. **事件流**：按 kind 着色、可滚动、自动吸底。
  8. **控制条**：模式开关、重放实验、暂停/继续、巡检、重置。
- 只用宿主主题 token（`--dsw-alias-*`）与自有布局；不引第三方依赖、不 require Harness Client 包、不写 `document.body`。
- 文案全部走 `ctx.locale`（zh + en 两套）；数字/时间用 `Intl` 格式化。
- 组件必须容错：state 缺失字段、请求失败、host 未就绪时显示空态/离线态，不得崩溃导致整页空白。
