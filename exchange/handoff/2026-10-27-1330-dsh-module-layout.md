# 按模块重划目录：计划与试点结果（2026-10-27）

## 0. 结论

- **可行**：已在独立 worktree `qqbot-refactor`、分支 `refactor/modules-pilot` 上完成 **emotion 模块试点**（10 个文件、24 处引用改写），`tsc` 干净，**2034 用例 2031 过 3 败**（3 条都是改动前就有的 `app.test.ts` 链接文本期望，不是重构引入）。
- **推荐增量做**：一个模块一个提交，全部绿了再合 `main`；不要一次性搬 154 个文件。
- **总工期**：约 **1.5–2 个工作日**（机械搬运为主，风险在引用遗漏与并行分支冲突）。

## 1. 现状

- `packages/bot/src` 下 **154 个扁平 `.ts`**；
- 逻辑上已有 8 个模块（`src/modules.ts`），但**物理目录没分**；
- `modules.test.ts` 会递归遍历 `src`，按 `modules.ts` 的 `files` 认领；`modules-doc.ts` 生成 `docs/modules/`；
- 插件 `packages/koishi-plugin-qqbot` 用 **深路径引用**（如 `../../bot/src/account.ts`）；
- 另有 `src/memory/`（已存在）、`src/ops/`、`src/sim/`、`src/st/`、`src/vendor/`。

## 2. 目标结构（与 modules.ts 的 8 个模块一一对应）

```
packages/bot/src/
  language/   33 个：prompt intent shape expression exit-check fact-check … st/
  life/       29 个：schedule world body money pursuits diary … tastes acquaintances
  emotion/    10 个：affect feelings moments grievance crisis crisis-state disclosure feedback …
  proactive/   6 个：proactive proactive-planner proactive-state inner shares follow-ups
  memory/     15 个：history archive backfill state-schema tier-record json-file …（+ 现有 memory 内部实现）
  rhythm/     21 个：responder reply-timing rate-limit stickers photos pokes presence qzone* account quote-reply media vision …
  bilibili/   20 个：bilibili* feed-browsing platform-breaker …
  platform/   25 个：app main contact config features modules modules-doc onebot log lock heartbeat device-* …
  ops/ sim/    保持不动
  st/ vendor/  平台资产，暂留原位（避免卡/素材路径变动）
```

说明：
- `memory/` 已有子目录（Hindsight 客户端等），模块文件直接放进去即可，`modules.ts` 里用 `memory/` 前缀；
- `st/`（角色卡构建）、`vendor/` 建议**暂不搬**，先在 `platform` 的 files 里保留 `st/`、`vendor/`；
- `ops/`、`sim/` 不动，它们只改引用。

## 3. 迁移步骤（每个模块一遍）

1. `git mv` 该模块文件到目标目录；
2. 代码改写（脚本）：
   - 收集 `packages/bot/src`、`packages/bot/test`、`packages/koishi-plugin-qqbot/src`、`scripts/*.mjs` 里所有相对 import；
   - 旧路径 → 新路径映射；解析绝对路径（相对仓库根），算新相对路径；
   - **被移动文件内部的引用也要重算**（试点踩过：`./history.ts` 要变 `../history.ts`）；
   - 插件深路径 `../../bot/src/foo.ts` → `../../bot/src/<module>/foo.ts`；
3. 更新 `modules.ts` 的 `files` 条目（`foo.ts` → `<module>/foo.ts`）；
4. `node packages/bot/src/ops/modules-doc.ts` 重新生成 `docs/modules/`；
5. 验收：`tsc`（bot + 插件）→ `node --test` 全量 → `modules.test` → 抽一个 CLI 冒烟；
6. 一个模块一个提交；全部完成后再合 `main`。

## 4. 试点结果（emotion）

- 分支 `refactor/modules-pilot`（已推送），worktree `C:/Users/22601/Desktop/qqbot-refactor`；
- `git mv` 10 个文件到 `src/emotion/`；
- 改写 24 个文件的引用；emotion 内部相对路径补 `../`；
- `modules.ts` 条目改为 `emotion/...`，`docs/modules` 重新生成；
- `tsc` 干净；
- 测试 **2034 / 2031 过 / 3 败**：失败全部是 `app.test.ts` 的 3 条「分享文本期望纯链接」（改动前就有），`device-service` 那条本次通过（说明它是偶发）。

## 5. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 引用漏改（运行时才炸） | 全量 `tsc` + 2034 测试 + CLI 冒烟；`grep -r "from './foo.ts'"` 双重检查 |
| 与 VM/Claude 分支冲突 | 选一个空窗期做；每模块小提交；先 rebase 再合 |
| 文档/模块测试红 | 每步重新生成 `docs/modules`；`modules.test` 必须绿 |
| 历史丢失 | 全程 `git mv`（保留 history） |
| 运行中的实例 | 重构分支不动线上 worktree；验收通过再切，切完重启 Koishi |
| 时间超预期 | 机械搬运可脚本化；试点已证明 10 文件约 20 分钟 |

## 6. 建议顺序

1. `emotion`（已完成试点）
2. `proactive`（6 个，最小，验证跨模块引用）
3. `bilibili`（20 个，引用最独立）
4. `rhythm`（21 个，含 qzone/stickers）
5. `language`（33 个，最核心，放后面）
6. `life`（29 个）
7. `memory`（15 个 + 现有子目录）
8. `platform`（25 个，最后搬 app/main/modules 本身）

## 7. 不做什么

- 不顺手改逻辑/重命名 API（纯搬运，行为零变化）；
- 不动 `st/`、`vendor/` 的物理位置；
- 不在重构分支上做“灵魂”改造（避免两件事混在一起）。
