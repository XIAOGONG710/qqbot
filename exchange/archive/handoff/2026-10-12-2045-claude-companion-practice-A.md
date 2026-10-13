# Claude：陪伴实践调研 · A 块（开源项目一行版总表）已交，停在这里等方向

- 时间：2026-10-12 20:45（GMT+8）
- **署名说明**：任务书原定 DSH 做；用户 10-12 晚在 Claude 会话里贴了启动提示词并明确说"你来做"，所以这一份由 Claude 代做，没有冒名 DSH。
- 依据：`exchange/archive/tasks/2026-10-12-dsh-companion-practice-research.md`（`b73c979`）+ 用户四条补充（E 块来源限免登录；A 只出一行总表不读源码；优先级 B>C>D>E；D 块"表演型冷淡"归与目标冲突）
- 产物：`exchange/research/2026-10-companion-practice/inventory.md`
- 范围：**只做了 A**。B–E、`options.md` 没动，等用户或 Claude 圈项目 / 确认方向。

## 推了什么

- `inventory.md`：12 行总表（MaiBot / AstrBot + 2 个 AstrBot 陪伴插件 / NoneBot2 + naturel_gpt / Koishi + ChatLuna / AIRI / Open-LLM-VTuber / SillyTavern 生态 / Letta / mem0 / Zep·Graphiti），每行：做什么 / 怎么触发主动发言 / 记忆方案 / 最近提交活跃度 / 许可证 / 哪一块值得拆开看；每格带证据标记。
- 没读任何源码：来源是 README / 官方文档、GitHub 未登录 API 的元数据、commits.atom、仓库**文件名**（没打开）、以及 10-05 已读过代码的旧报告。
- 没改代码、没碰 `docs/adr/`、没登录任何账号、没用浏览器档案 / cookie、没下载可执行文件。

## 最想让你们看的三件事

1. **只有 private_companion（AstrBot 插件，390★）把"主动发言"建在状态 + 日程上**：行为候选 → 额度 / 时机 / 权限 / 发送前复核，并**记录"拦截原因"**；其余项目的"主动"基本都是"对方沉默 N 秒"或定时问候，理由在对方身上不在她的日子上。**它没有许可证**（API null，仓库无 LICENSE），只能读思路不能搬代码。建议 B 块以它为主要对照，请你们确认要不要深读。
2. **记忆的主流是"只增不删"**：mem0 v3 明说 ADD-only，ST Vector Storage 文档明说无衰减，AIRI 把全部记忆拼进提示词。主动遗忘 / 复核更正只在 MaiBot（目录里有 `memory_lifecycle_policy`、`person_fact_reverification`，**只看了文件名**）、naturel_gpt（2023 年的"记忆强化 / 主动遗忘"，已 476 天没提交）、Letta（dreaming）里露头。C 块可对比的材料比 B 少。
3. **Letta 的主仓库已经搬了**：`letta-ai/letta` 的 README 说 V1 服务器已退役，现在是 `letta-ai/letta-code`（偏编码智能体 harness）。10-03 / 10-05 的旧报告里如果引用过老 Letta，要注意。

## 没找到 / 没核实（详见 inventory.md 末尾）

- MaiBot 决定开口的具体算法（只有 README 口号 + 文件名）。
- AIRI 的主动发言（只有手机通知一句）；Letta 的"主动给用户发消息"。
- NoneBot 生态别的人格插件（aichat 等只在搜索摘要里见过名字，未核实）。
- OLV 后端主动发言的 conf.yaml 键名（文档页 404）。
- SillyTavern 内置 auto mode 是不是纯计时器（只有一条二手帖）。
- OpenClaw / z-waif / warashi：想到了没做，已在"没纳入"里写明。

## 需要你们定的

- 圈 3–4 个项目深读。我的参考排序在 inventory.md 末尾："private_companion > MaiBot > Letta Code > Graphiti"（候补 Qvink、mem0 的 ADD-only 当对照）。这只是参考，不是选。
- A 的边界对不对：我按"陪伴 / 拟人 + 记忆库"混着列了 12 行；若只想要"陪伴型"，可以砍掉 mem0 / Graphiti / Letta，把它们挪到 C 块再看。

## 小事

- GitHub 未登录 API 额度是 60 次 / 小时，调研时一度只剩十几次；B–E 如果要大量查仓库，改走 raw 文件和 atom，别用 API。
