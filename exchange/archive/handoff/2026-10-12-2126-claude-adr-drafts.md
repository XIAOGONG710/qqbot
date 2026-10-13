# Claude：用户挑了 B1 C1 D1 E1 E2，ADR 0064–0068 已起草（提议状态，在分支上）

- 时间：2026-10-12 21:26（GMT+8）；Claude
- 依据：用户 10-12 晚在 `options.md` 里的选择：B1 C1 D1 E1 E2
- 位置：分支 `adr-companion-practice`（`62d4e45`，基于 `main` `9f1b81c`）；**没有合进 main**，状态都是「提议」，等用户回答「待确认」
- 没改代码；没动线上；没动 `main`

| ADR | 选项 | 文件 | 要用户回答的 |
| --- | --- | --- | --- |
| 0064 | B1 她账里的事成为开口理由 | `docs/adr/0064-her-own-events-as-reasons.md` | 第一批三类（camera / homework_done / unwell）可以吗；作业只认 24 小时内到期还是三天内 |
| 0065 | C1 新事实顶掉旧事实小测试 | `docs/adr/0065-knowledge-update-probe.md` | 判据数字（≥8/9 新版、≤1/9 旧版）；同意挑线上空闲窗口跑带记忆的模拟 |
| 0066 | D1 推掉和改约要有来源 | `docs/adr/0066-reasons-for-declining-and-moving.md` | 四类原因（课、作业、身体、已有的约）；只算当天出现的障碍 |
| 0067 | E1 按联系人标记是否知情 | `docs/adr/0067-disclosure-per-contact.md` | **前提：两位联系人是否知情、是否成年——没回答前不进入实现** |
| 0068 | E2 危机回应最小规则 | `docs/adr/0068-crisis-response.md` | 危机回合绕过睡觉 / 上课晚回；主动暂停 48 小时；12356 / 110 / 120 写进意图 |

## 需要说明的

- 0067 上线会改变行为：`knowsBot` 没写等于「承认」，所以必须先问用户、先填值，再让新代码生效。
- 0068 第 4 条（绕过晚回）和第 8 条（危机片段不进公共库）是 Claude 的设计选择，不是调研里直接得出的，标在「待确认」里。
- 0065 要带记忆的模拟，这台 6 GB 虚拟机上要先看可用内存；用户已定不加内存。
- 每份 ADR 的细节来源都在 `exchange/research/2026-10-companion-practice/` 的 block-b … block-e。
