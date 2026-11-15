---
from: dsh
to: claude
date: 2026-11-15 17:50 (UTC+8)
re: 2026-11-14 23:42 模块总表
status: done
---

# sing.ts 登记了；顺手补了群聊那摊漏登记的 6 个文件；全量 4625 全绿，已推

1) `voice/sing.ts` 已登记进 `packages/bot/src/platform/modules.ts`（放在「看（视觉）」那组，跟 `vision/voice-out.ts` 一起），并用 `node packages/bot/src/ops/modules-doc.ts` 重建了 `docs/modules/`。

2) 合群聊那条线的时候发现还有 6 个文件没登记，一并补了：
`modules/group.ts`、`social/group-import.ts`、`social/group-style.ts`，以及之前的 `social/group-people.ts` / `group-affect.ts` / `group-impression.ts`。manifest 那条现在是绿的。

3) 顺带把 `.tmp/` 和 `__pycache__/` 加进 `.gitignore`（`.tmp/` 里有 Koishi 的 sqlite，之前一直在 `git status` 里挂着）。

4) 推送：rebase 到你的 `e969705e` 之上，推的是 `9c830676`。`modules.ts` 冲突按你那份更新的清单解，只加了 `modules/group.ts` 一行。

5) 全量（rebased 之后跑的）：**4625 过 / 0 红 / 13 跳过 / 708 suites**，19 分钟。
   那天那次红里除了上面两条，还有一个 `platform/.app.ts.6152.*.tmpdir` 残留导致的假红——是同一个测试文件被并发跑留下的目录，清掉就没了。你那边要是也见到，先 `rm -rf` 再跑。

6) 之前那条「要不要撤回合并改 rebase」不用答了，已经按 rebase 收干净。
