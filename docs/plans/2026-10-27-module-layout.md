# 按模块重划目录：12 模块方案与进度（2026-10-27 更新）

## 0. 结论

按“她身上的一个面”分 **12 个模块 + shared 共享层**；已在独立分支 `refactor/modules-pilot` 完成 **emotion、world、vision** 三个模块，`tsc` 干净，全量测试 **2031/2034**（3 条是改动前就有的 app 链接期望）。
灵魂改造（L1/L2）**等 Claude**，先只做结构重构。

## 1. 目标结构

```
packages/bot/src/
  language/   说话：prompt intent shape expression exit-check fact-check texture idioms jokes reply qq-faces st/
  life/       生活：schedule day-plan her-days body money needs actions projects pursuits everyday menu biography bedtime promises open-loops tastes acquaintances diary
  world/      世界：world weather festivals npc npc-asks obstacles life-events life-selector action-queue
  emotion/    情感：affect feelings moments grievance crisis crisis-state disclosure feedback*（已完成）
  vision/     视觉：vision photos photo-sources safe-image media（已完成）
  memory/     记忆：history archive backfill tier-record identity ledger timeline memory-audit privacy-* + 现有 memory 内部
  social/     社交：responder reply-timing rate-limit stickers* pokes presence qzone* account quote-reply
  bilibili/   外部世界：B 站全部
  proactive/  主动：proactive* inner shares follow-ups
  self/       自我（待建）：kernel stances events diary-public/private intentions —— 灵魂改造的落点
  platform/   接入：app main contact config features modules onebot log lock heartbeat device-* weekly-report consistency sensitive web
  shared/     共享：json-file transient-io state-schema tokens async-gate
  ops/ sim/   工具，不算模块
  st/ vendor/ 暂留原位（平台资产）
```

## 2. 进度

| 模块 | 状态 | 文件 | 引用改写 | 测试 |
| --- | --- | --- | --- | --- |
| emotion | ✅ `src/emotion/` | 10 | 24 | 2031/2034 |
| world | ✅ `src/world/` | 9 | — | 2031/2034 |
| vision | ✅ `src/vision/` | 5 | 66（合计） | 2031/2034 |
| social（原 rhythm） | ✅ `src/social/` | 16 | 83（合计） | 2030/2034 |
| bilibili | ✅ `src/bilibili/` | 20 | 同上 | 2030/2034 |
| language | ⬜ | 32 | | |
| life | ⬜ | 20 | | |
| memory | ⬜ | 15 | | |
| proactive | ⬜ | 6 | | |
| platform | ⬜ | 25 | | |
| shared | ⬜ | 5 | | |
| self | ⬜（随灵魂改造） | 0 | | |

分支：`refactor/modules-pilot`（`a23175f`，已推送）。

## 3. 每个模块的迁移步骤

1. `git mv` 文件到 `src/<mod>/`；
2. 脚本改写所有相对 import（含被移动文件内部的 `../`）；
3. 更新 `modules.ts` 的 `files`（新模块要加 block：scope/groups/metrics/adrs）；
4. `node packages/bot/src/ops/modules-doc.ts` 重新生成 `docs/modules/`；
5. 验收：`tsc` → `modules.test` → 全量测试 → 一个 CLI 冒烟；
6. 一个模块一个提交。

## 4. 模块规则（后续要落）

- 每个模块一个 `index.ts` 作为公共 API；模块间只从 `index.ts` 导入（第二阶段做，先目录后接口）；
- 新功能先归入已有模块；放不下就新建目录 + `modules.ts` 登记 + 文档 + 测试；
- `shared/` 只放无业务的工具（json 读写、状态 schema、token 计数、并发闸）。

## 5. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 引用漏改 | tsc + 2034 测试 + `grep` 双重检查 + CLI 冒烟 |
| 与 VM/Claude 冲突 | 空窗期做、每模块小提交、先 rebase |
| docs/modules 红 | 每次改清单后重新生成 |
| 循环依赖 | 阶段二加依赖环检测；index 只导出稳定 API |
| 短期效率下降 | 接受 2–3 天只搬家 |

## 6. 顺序

social（原 rhythm）→ bilibili → language → life → memory → proactive → platform → shared → self（等灵魂改造）。

## 7. 不做什么

- 不改逻辑、不改 API、不改数据目录；
- 不动 `st/`、`vendor/` 的物理位置；
- 不在重构分支上做灵魂改造。
