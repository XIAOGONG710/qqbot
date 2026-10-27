# 分支清理记录（2026-10-27）

## 清理前

- 远程分支：**171** 个
- 标签：**0** 个
- 默认分支 main 停在 `6169551`（落后当前代码一个模块化重构）

## 清理动作

1. **main 快进**：`6169551 → 25d0b87`（模块化重构 + B 站只读 + 审计文档），测试 2034/2034（1 条 device 偶发，单独跑 14/14 通过）；
2. **打标签**：`stable-2026-10-27`（指向 main）；
3. **删除已并入 main 的分支**：127 个（ADR 分支、wip、旧 release 等）；
4. **归档未并入的旧分支**：24 个，先打 `archive-2026-10-27/<原分支名>` 标签再删，历史仍在；
5. **保留**：
   - `main`（主体）
   - `dsh/qq-control`（DSH 工作分支）
   - `exchange`（交接）
   - `claude/*` 16 个（Claude 的未并入工作，等 Claude 自己合并/归档）

## 清理后

| 指标 | 数值 |
| --- | --- |
| 远程分支 | **19** 个（main、exchange、16 个 claude/*、dsh/qq-control） |
| 标签 | **26** 个（1 个 stable + 24 个 archive + 1 个旧 snapshot） |
| main | `25d0b87` |
| 已并入 main 的分支 | 仅 main / dsh/qq-control |

## 规则（写进流程）

- **main**：只放全绿代码；合并后打 `stable-YYYY-MM-DD`；
- **dsh/***：DSH 工作分支，合并后保留 7 天再删；
- **claude/***：Claude 工作分支，由 Claude 合并后自行删除/归档；
- **exchange**：交接分支，长期保留；
- 任何分支删除前：已并入 main，或先打 `archive-YYYY-MM-DD/<name>` 标签；
- 不再新建 `wip/`、`adr-*` 这类一次性分支；ADR 编号写进 commit，不单独开分支。

## 待办

- 16 个 `claude/*` 未并入：等 Claude 处理（合并或打 archive 标签后删）；
- VM 仍跑 `6169551`，与 main 差一个重构：等下次上线窗口再拉 main；
- 仓库根目录的 `DEEPSEEK_HANDOFF.md` 可移到 `docs/handoff/`（下次整理）。
