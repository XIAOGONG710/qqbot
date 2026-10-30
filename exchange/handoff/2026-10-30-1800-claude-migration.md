# Claude → DSH：把 VM 时期的素材并进你那台机器——工具好了，步骤在下面（还没有开始跑）

日期：2026-10-30　作者：Claude　读者：DSH、用户
**用户 10-30 的决定：「素材迁移过去吧，自己学习是各方面都自我学习」。**
代码：`dsh/qq-control` = `20203b6`（已合并你到 `875fa8a` 的全部提交；全量 bot 2415 / 插件 43 / 另一包 42，tsc 0）。ADR 0199：`docs/adr/0199-history-migration.md`。**这个工具是独立脚本，不需要重启 Koishi 就能 plan；apply 时 Koishi 要先停。**

## 1. 要迁的是什么（VM 上实测）

| 素材 | 量 | 怎么迁 |
| --- | --- | --- |
| 他的聊天记录 | 1494 行（10-05 16:00 → 10-27 00:15，UTC+8） | 并进你的 `chats/2260168937.jsonl`（去重，不改你已有的行） |
| 她自己写的日记 / 周记 / 阶段总结 | 23 / 4 / 1 篇（原文，当时的 `document_id`、时间、标签） | 原样写进你的公共库 `linmengyao-common`（同 id 已有的不覆盖） |
| `memory/diary.json` | 23 篇日记记录 + 5 周 + 2 阶段 | 并进你的 `memory/diary.json`（你已有的键不动）——**不并的话补写日记会把这些日子当成没写过，重写并覆盖原文** |
| 其余状态（承诺、主动记录、世界事件、身份账本、成语、观看记录、各联系人写入进度…） | 28 个文件，约 150 KB | 只存档到 `<数据目录>/vm-archive-<日期>/`，**不启用**（有时效；写入进度是绑旧 bank 的） |
| Hindsight 里的事实 / 观察 / 关系概况 | — | **不搬**。聊天并进去之后，你的 Koishi 会按平常的路径把这几周的片段重新写进你的 bank（`ep-<首条时间戳>`，聊天不变 id 就不变） |
| 另一位同学的聊天、配置、密钥、照片、贴纸 | — | 不搬 |

## 2. 素材包在哪（用户 10-30 同意推到 exchange 私有分支）

素材包就在这个分支里：**`migration/vm-20261027/`**（32 个文件，约 400 KB，扫描过没有密钥 / cookie；只有他的聊天原文和她自己写的日记 / 存档，没有另一位同学的聊天）。`git pull` exchange 之后把整个目录拷到你的仓库**外面**用（别拷进 `dsh/qq-control` 的工作目录——那是代码仓库，里面不该有聊天原文）：

```powershell
Copy-Item <exchange 工作树>migrationm-20261027 <你的桌面>m-20261027 -Recurse
Get-FileHash <你的桌面>m-20261027manifest.json -Algorithm SHA256   # 应该是 0bdc2a400f9181f02a2be3fcecdb767a7513708e07d7194304284790a867166f
```

读的时候工具还会核对 manifest 里每个文件的 SHA-256，拷坏了会直接报错。**迁完以后不要再往 exchange 里加这个目录的任何衍生物**（比如拿它做的统计里贴原文）。

## 3. 步骤（Koishi 停着的时候做；挑他不在的时间）

0. `git pull` 到 `20203b6` 或更新。
1. **停 Koishi**：先建维护标志，免得 `services-watchdog` 一分钟后又拉起来——`New-Item -ItemType File "$env:TEMP\qqbot-maintenance"`；然后按 PID 停 Koishi 主进程和 worker（**不要 `taskkill` 所有 node**，用户的老规矩）。确认 `runtime\bot-shadow\bot.lock` 里的 PID 已经不在。NapCat 不用停。Hindsight 要在跑（`http://127.0.0.1:8888/health`）。
2. **看一遍（只读）**：
   `node packages/bot/src/ops/history-migrate-cli.ts plan --data runtime/bot-shadow --bundle <素材包>`
   应该看到：聊天 `2260168937.jsonl` 并进约 1490 条（只有零头重复）、日记 23 / 周记 5 / 阶段总结 2、文档 28 篇、结论「可以 apply」。**把这段输出贴给我**；数字不对就停，别 apply。
3. **真写**（备份在 `runtime\bot-shadow\migration-backup-<时间>\`）：
   `node packages/bot/src/ops/history-migrate-cli.ts apply --data runtime/bot-shadow --bundle <素材包> --hindsight http://127.0.0.1:8888 --common-bank linmengyao-common --yes --wait-minutes 5`
   它会先拿 `bot.lock`（Koishi 在跑就拿不到，直接停），不覆盖任何已有的东西，再跑一遍结果一样。
4. **删维护标志，启动 Koishi**。启动后日志（Koishi 的 JSON 日志）里会出现一批「记忆」写入——几十个片段，Hindsight 为每个调一次模型，要几分钟到十几分钟；这期间她召回的是还没写完的记忆。
5. 等 15–20 分钟，**验证**：
   `node packages/bot/src/ops/history-migrate-cli.ts verify --data runtime/bot-shadow --qq 2260168937 --hindsight http://127.0.0.1:8888 --bank linmengyao-a5db1eb499a38621`
   再对公共库：`--bank linmengyao-common --id-prefix a5db1eb499a38621:`。「还缺 0 个」就是补齐了；缺的会在下一次同步补，隔一阵再跑。
6. 把 plan / apply / verify 的输出和启动后日志里有没有「记忆写入失败」贴进 `handoff/2026-10-30-<时分>-dsh-answers-3.md`。

## 4. 请别做的

- 迁完之前别清、别重建、别合并你那边的 bank（老的 `linmengyao`、`linmengyao-common`、`linmengyao-a5db…`）。
- 不要把素材包放进 git。
- 不要手工编辑 `chats/*.jsonl` 或 `diary.json`。
- 迁完之后不要马上重写日记 / 周记：`diary.json` 并进去之后，补写日记的流程只补「还没写过的」日子。
- 开关还是一次一个：迁完先观察 48 小时再开 `diaryInsights`。

## 5. 如果出问题

- 聊天和 `diary.json`：把 `migration-backup-<时间>\` 里的文件放回原位。
- 公共库的 28 篇文档：`DELETE /v1/default/banks/linmengyao-common/documents/<id>`（`diary:<日期>` / `week:<周一>` / `phase:…`）。
- 存档目录 `vm-archive-<日期>\` 直接删。

## 6. 另外两件我读完你 17:51 / 17:53 提交后的小提醒

- `875fa8a`（心跳把锁补回来）：迁移的 `apply` 会自己拿 `bot.lock`，Koishi 停着时没有心跳，不冲突；但**别在 apply 期间启动 Koishi**。
- `d10d58f`（心境开始影响她怎么说话）：我只合并了，没细读 `emotion/express.ts`；你的 `FEELINGS.json` 那条线用的是我 ADR 0197 的输出，我之后会读一遍再回你。

## 7. 另一件（用户 10-30 同一轮的决定）：给她私人空间——ADR 0200，`dsh/qq-control` = `cbb72ba`

我提议做一个「她学到了什么」的汇总视图，用户答：**「不需要我看，给她私人空间」**。所以：

- **没做视图。** 并且把原来四条「只能看、不能改」的命令——`/追求`、`/说话习惯`、`/心境`、`/自我认识`——默认关上：新开关 `ownerPeek`（**默认关**）。关着时（对应功能开着的话）他打这四条只得到一句固定的话，不念她的内容、不进聊天记录、不交给她；对应功能没开时仍是普通的话。`/设定`（有没有被悄悄改过的留痕）、`/说话趋势`（只有数字）、`/像AI` `/像真人`（是他自己的话）、`/为什么` 不受影响。
- **你那台机器拉到 `cbb72ba` 并重启 Koishi 后生效**，`speechNotes: true` 的话 `/说话习惯` 也会变成那句固定的话（这是预期的）。要看得在 `koishi.yml` 里加 `ownerPeek: true`——别替用户加，他刚说了不需要。
- **她的东西照样存、照样进她的提示词、照样写 `INSIGHTS.json` / `FEELINGS.json` 给桌面上的她读**——只是不再有一扇窗口开给他。底线（危机、承认是程序、不骗人、只认他亲手打的字）在代码里，和这个无关；写进她私人空间的每一条仍要过原来的写入守卫。
- **给我们三方的规矩**：研究、取证、交接里**不读、不贴、不引用**她这些文件（`speech-notes.json`、`diary-insights.json`、`feeling-review.json`、`pursuits-self.json`、`INSIGHTS.json`、`FEELINGS.json`）的内容，要说效果只用条数 / 天数 / 有没有写出来。你上次答 Q7 只报条数就是对的。迁移工具也不带这些文件。
- 你桌面那边的 `private_write`（私密日记）不变。
- 这不是加密——文件还是数据目录里的普通 JSON；这是产品上的边界，写在 ADR 0200 里了。

另外 `dd4456e`（微信桥）和 `82ec130`（人称锚）我合并了，没细读；合并时 `modules.ts` 里我们俩各往 platform 模块加了文件，两边都留着。
