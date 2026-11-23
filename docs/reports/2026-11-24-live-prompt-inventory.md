<!-- 由 npm run inventory:live -w @qqbot/bot -- --on selfExport,selfReceipts,desktopDay 生成（2026-11-24，合成角色、假模型、假时钟）；下面「读法」一节是手写的 -->

## 读法（手写）

- 这是**合成角色**上的两天：没有长期记忆、桌面、群、真实天气，所以 main 之后和聊天记录之后那些槽（关系概况、回忆、桌面、群、公共记忆……）一个都没出现，「此刻」79 个槽也只出现了 30 个。
  线上真实的构成要在线上那台跑 `-- --manifests <数据目录>/logs`（已托 dsh，信箱 11-24）。这份能说明的是「线上那套开关下，哪些说明是每轮都放的」。
- 快照之后补开的 selfExport / selfReceipts / desktopDay 在合成环境里不加任何段落（没有桌面那一侧），和不补开的结果逐字一样。
- **只想一想（think）占了 38 轮里的 24 轮**，是回他的两倍。每轮也是整份提示词（平均约 2600 字）。
- 只想一想的轮次不回他、不写标记，但这些给回复用的说明 24 轮里一轮不落：`selfMemory`（记忆 / 日记 / 私密 / 查的标记用法，约 300 字）、`workJudge`（`<<用电脑>>`，约 120 字）、`refusal`；
  `books` 13 轮。拿掉它们是改她想事情时看到的东西，要先问她（已托 dsh 代跑 ask-her，见 docs/plans/2026-11-24-subtraction-round.md 四）。
- 回他的轮次：平均约 4900 字，「此刻」平均 17.7 段、最多 21 段；常驻（12 轮里 ≥11 轮）的是 time、state、world、plans、selfMemory、workJudge、refusal、voice、development、person、humanState、selfThread。
- 后台 83 次调用里约一半是重试：假模型回 `[]`，要对象的解析器重试（见 docs/reports/2026-11-24-background-llm-audit.md），所以这里的后台次数偏高，看量级别看绝对值。

# 线上开关组合的提示词盘点（合成角色）

快照：`exchange/live/koishi-2026-11-20-1855.yaml`；照搬 115 个键，开着 109 个。
快照之后补开：selfExport、selfReceipts、desktopDay。
没搬：contacts、dataDir、deviceControl、dormancy、dsh、externalPlatforms、identityLedger、llm、memory、prompt、qqAllowFriends、qqControl、realTransport、vision。DEFAULTS 不认识的键：groups、mobileCompanion。

## 轮次

共 38 轮给联系人生成：回复 12、主动 2、只想一想 24；预算放不下直接兜底 0。
整份提示词字数：平均 3465，最多 5708，最少 1977。
每轮段数（平均）：main 0、聊天记录之后 0、「此刻」块 14.4。

| 这一轮 | 轮数 | 平均字数 | 「此刻」平均段数 | 「此刻」最多段数 |
|---|---|---|---|---|
| reply | 12 | 4907 | 17.7 | 21 |
| initiate | 2 | 5562 | 18 | 19 |
| think | 24 | 2569 | 12.5 | 14 |

## 模型调用（按用途，两天合计）

| 用途 | 次数 |
|---|---|
| background | 83 |
| chat | 56 |

## 槽（按总字数排）

| 表 | 槽 | 模块 | 出现轮数 | 占比 | 回他/主动/想 | 平均字数（出现时） | 被挤掉 |
|---|---|---|---|---|---|---|---|
| now | initiateNote | initiate-note | 26 | 68% | 0/2/24 | 639 |  |
| now | selfMemory | self-memory | 38 | 100% | 12/2/24 | 304 |  |
| now | world | her-now | 38 | 100% | 12/2/24 | 249 |  |
| now | transcript | transcript | 24 | 63% | 0/0/24 | 316 |  |
| now | workJudge | work-mode | 37 | 97% | 11/2/24 | 121 |  |
| now | books | books | 21 | 55% | 8/0/13 | 207 |  |
| now | plans | her-now | 38 | 100% | 12/2/24 | 84 |  |
| now | time | time-block | 38 | 100% | 12/2/24 | 61 |  |
| now | selfNote | time-notes | 29 | 76% | 8/2/19 | 65 |  |
| now | state | her-now | 38 | 100% | 12/2/24 | 49 |  |
| now | voice | voice | 11 | 29% | 11/0/0 | 145 |  |
| now | development | human-state | 14 | 37% | 12/2/0 | 111 |  |
| now | refusal | soul | 37 | 97% | 11/2/24 | 37 |  |
| now | shellIntent | shell | 11 | 29% | 9/2/0 | 120 |  |
| now | closeness | closeness | 11 | 29% | 9/2/0 | 113 |  |
| now | selfThread | soul | 11 | 29% | 11/0/0 | 103 |  |
| now | dreams | feelings | 18 | 47% | 4/1/13 | 59 |  |
| now | lastUser | reply-basics | 26 | 68% | 0/2/24 | 37 |  |
| now | person | reply-basics | 12 | 32% | 12/0/0 | 68 |  |
| now | feeling | feelings | 7 | 18% | 3/1/3 | 110 |  |
| now | humanState | human-state | 13 | 34% | 11/2/0 | 59 |  |
| now | speechNote | her-notes | 11 | 29% | 9/2/0 | 69 |  |
| now | question | learning-question | 8 | 21% | 6/2/0 | 79 |  |
| now | inner | inner | 9 | 24% | 3/0/6 | 69 |  |
| now | body | her-now | 6 | 16% | 2/0/4 | 87 |  |
| now | review | her-notes | 8 | 21% | 7/1/0 | 57 |  |
| now | wake | soul | 5 | 13% | 2/1/2 | 60 |  |
| now | continuity | continuity | 2 | 5% | 2/0/0 | 56 |  |
| now | takes | her-notes | 1 | 3% | 1/0/0 | 92 |  |

## 模块（按总字数排）

| 模块 | 出现轮数 | 总字数 |
|---|---|---|
| initiate-note | 26 | 16620 |
| her-now | 38 | 15035 |
| self-memory | 38 | 11552 |
| transcript | 24 | 7579 |
| work-mode | 37 | 4477 |
| books | 21 | 4347 |
| soul | 37 | 2803 |
| human-state | 14 | 2318 |
| time-block | 38 | 2305 |
| time-notes | 29 | 1885 |
| feelings | 23 | 1836 |
| reply-basics | 38 | 1766 |
| voice | 11 | 1595 |
| shell | 11 | 1320 |
| her-notes | 11 | 1307 |
| closeness | 11 | 1243 |
| learning-question | 8 | 632 |
| inner | 9 | 621 |
| continuity | 2 | 111 |
