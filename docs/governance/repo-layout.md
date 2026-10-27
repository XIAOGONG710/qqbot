# 仓库整理方案：主体 / DS 提交 / Claude 提交 / 数据

日期：2026-10-27 · 状态：方案（未执行分支操作）

## 目标

一个仓库里同时有 DSH、Claude 两条工作线，还有大量研究数据和交接文档，现在混在一起。整理成四块，各自有边界、有入口、有权威源：

1. **主体**：能上线的代码与决策（main）；
2. **DS 提交**：DSH 的代码分支 + 交接；
3. **Claude 提交**：Claude 的代码分支 + 交接；
4. **数据**：运行数据与研究语料，**不进 git**，只留说明与索引。

## 一、主体（main）

- `main` 只放**已验收**的代码：`tsc` + 全量测试 + VM 验证通过的合并；
- 每次合并打 tag：`stable-YYYY-MM-DD`；
- `docs/adr/`、`docs/plans/`、`docs/modules/` 属于主体，跟代码一起走；
- 规则：任何分支要进 main，必须先绿、先过 VM、先写 handoff。

## 二、DS 提交（`dsh/*`）

- 分支名：`dsh/<主题>`（如 `dsh/qq-control`、`dsh/module-refactor`）；
- 交接：`exchange` 分支的 `exchange/handoff/YYYY-MM-DD-HHMM-dsh-*.md`；
- 每个提交在 commit message 里带 `ADR 编号` 或 `handoff` 文件名；
- 合并前由 Claude/用户 review；合并后分支保留 7 天再删。

## 三、Claude 提交（`claude/*`）

- 分支名：`claude/<主题>`（如 `claude/qzone-probe-fixes`）；
- 交接：`exchange/handoff/*-claude-*.md`（或 `claude-` 前缀）；
- 同样遵守「先绿、先 VM、先 handoff」；
- 与 DSH 分支冲突时，以「先合入者为准，后合入者 rebase」。

## 四、数据（不进 git）

- 运行数据：`runtime/`（已忽略）；Hindsight 数据在 `C:\qqbot-hindsight\pgdata`；
- 研究语料：`C:\Users\22601\Desktop\大肥鱼研究\`（B 站字幕、GitHub/arXiv/HN、摘要、日志）；
- 仓库里只留：
  - `docs/research/README.md`：索引（报告链接、数据位置、生成方式）；
  - `docs/research/*.md`：**蒸馏后的**结论与插件清单（不含原始语料）；
- 禁止把 cookie、聊天记录、私人日记、原始字幕库提交进 git。

## 五、当前分支与迁移

| 分支 | 内容 | 处理 |
| --- | --- | --- |
| `main` | 本地比 origin/main 多 3 个 docs 提交 | 合并/推送前先确认 |
| `dsh/qq-control` | 线上工作分支（28+ 提交） | 验收后合入 main |
| `refactor/modules-pilot` | 12 模块目录重构（全绿） | 验收后合入 main |
| `dsh/qzone-p1` | 已并入 dsh/qq-control | 保留 tag 后归档 |
| `exchange` | 三份交接 | 保持独立分支 |

## 六、执行顺序（建议）

1. 等 refactor 验收（已完成 2034/2034 + 插件 42/42）；
2. `dsh/qq-control` ← merge `refactor/modules-pilot`；
3. `main` ← merge `dsh/qq-control`；打 tag `stable-2026-10-27`；
4. VM 拉 main，跑一周观察；
5. 归档 `dsh/qzone-p1`、`claude/qzone-probe-fixes`（打 tag 不删）；
6. 每次提交前跑 `modules.test` + 全量测试，防止再乱。

## 七、命名约定

- commit：`<模块>: <做了什么>`（如 `bilibili: 私信可读`）；
- handoff：`YYYY-MM-DD-HHMM-<dsh|claude>-<主题>.md`；
- tag：`stable-*`、`dsh-*`、`claude-*`；
- 数据文件：`<来源>-<日期>.jsonl`（如 `corpus-2026-10-27.jsonl`）。
