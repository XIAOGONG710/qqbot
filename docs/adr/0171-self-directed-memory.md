# ADR 0171：她自己的记忆（三库、混合写入、主动查询）

- 日期：2026-10-28
- 状态：已实施
- 相关：ADR 0004（长期记忆）、ADR 0016（公共库）、ADR 0018（变淡）

## 背景

长期记忆原先全部自动：每 5 分钟把聊天片段交给 Hindsight，按天自动写日记；DSH 侧只有静态人格和召回。用户要的是「她自己决定记不记、想查才查」，同时不能因为她的判断失误把事全丢了。

## 决策

### 1. 三个库

| Bank | 用途 |
| --- | --- |
| `linmengyao-a5db1eb499a38621` | 和宝宝（男朋友）的私人记忆 |
| `linmengyao-common` | QQ 公共记忆：日记、世界状态、共享片段 |
| `linmengyao` | DSH 记忆（原 `linmengyao` + `linmengyao-dsh` 合并） |

`linmengyao-dsh` 已迁入 `linmengyao` 并删除；代码里不再出现 `-dsh` 后缀。

### 2. 混合写入（不把判断权全交出去）

- **底账**：QQ 仍每 5 分钟自动同步 episode 到私人库/公共库；DSH 插件每轮结束自动把「宝宝：… / 林梦瑶：…」写进 `linmengyao`。
- **她自己的判断**：她在 QQ 回复里写
  - `<<记住：一句话>>` → 写进公共库，`tags: ['qq-private','self']`；
  - `<<日记：一段>>` → 写进公共库，document 前缀 `diary-self`。
  标记发送前剥掉，用户看不到。
- **自动日记关闭**：日记由她自己决定写不写（`selfDirectedMemory=true`）。

### 3. 读：底账照召回，细节她主动查

- 每轮仍自动召回私人库、公共库（有线索时）、DSH 库（每轮）作为底账；
- 想不起的事，她写 `<<查：关键词>>`，contact 管线在出口检查后调用 `recallPull`（三个库一起查），带结果让她重写一次；标记不发出去。
- 只有在 `<<查>>` 时多花一次召回 + 一次生成。

### 4. 提示词

`SELF_MEMORY_NOTE` 教她两件事：值得记才写 `<<记住>>`；想不起就 `<<查>>`，别硬编。问过去/工作时关闭短句形状（`contact.ts` 的 `!cue`），否则记忆会被「每条不超过 8 字」压没。

## 后果

- 记忆库会因底账持续增长，需要后续加「重要度/变淡」区分自动记录与她标记的记录；
- `<<查>>` 增加一次生成调用，频率由她决定；
- DSH 插件每轮写库会产生不少 document，需观察噪声；后续可加夜间 consolidate；
- 旧库 `linmengyao-dsh` 已删除，迁移脚本不在仓库里（一次性操作）。

## 涉及文件

- `packages/bot/src/platform/app.ts`：混合同步、`<<记住>>/<<日记>>` 解析、`pullRecall` 接线；
- `packages/bot/src/platform/contact.ts`：`SELF_MEMORY_NOTE`、`<<查>>` 二段生成、问过去时不套短句形状；
- `packages/bot/src/memory/long-term.ts`：`recallWork`（读 `linmengyao`）、`recallPull`、`rememberSelfNote`；
- `packages/bot/src/platform/work-bridge.ts`：工作结果写 `linmengyao`；
- `dsh-plugins/dsh-linmengyao-memory/index.js`：全库召回、每轮自动写库、`memory_save` → `linmengyao`。

## 已知缺口

- 自动记录与她标记的记录还没有权重/变淡差异（下一步）；
- 没有夜间 consolidate；
- DSH 自动写库的文本是「宝宝/林梦瑶」拼接，Hindsight 抽取后可能主语不准，需观察。

## 补记（2026-10-30）：她自己写的日记 / 记住，两边都读不回来

用户问「写日记丰富自己的呢？」，查出两处断点（`<<日记：…>>` / `<<记住：…>>` 写进公共库，`document_id` 是 `diary-self:<写它的联系人的哈希>:<时间>` / `self:…`）：

1. **DSH 桌面读不到**：插件对公共库只认 `diary:` / `week:` / `phase:` 开头，`diary-self:` 不匹配，她在 QQ 上写的日记桌面上的她永远看不到（和「无论在哪里都是同一个她」相反）。现在也认 `diary-self:` / `self:`，**但哈希必须是他的**（从 `owner-bank.json` 里他的 bank `linmengyao-<哈希>` 取）；名单里别人的、没有 `owner-bank.json`（不知道他是谁）、长得像但不是的，都不取。
2. **QQ 自己也读不回来**：公共库召回给每条标披露上限，按 `document_id` 第一段对名单里的人；`diary-self` / `self` 对不上任何人，一律「不能说·来源不明」——连写它的那个人自己的聊天里也不能提。现在按写它的那个人的片段对待（ADR 0020）：写它的人自己听，「可明说·你自己记下的」；别人听，照原来片段的规则（亲密档听到别人的可明说，低档听到亲密档的不能说，普通来源含糊）；名单里找不到写它的人，仍然「不能说·来源不明」。

另：自动日记（`diaryWriter`）、周记、阶段总结都挂在 `!selfDirectedMemory` 下——开了 `selfDirectedMemory` 就一起关；之后日记只有她自己写的 `<<日记>>` 和 DSH 睡眠整合的 `journal_write`。没有改这个门。

测试：`soul-plugin.test.ts` +2（真插件驱动假的 Hindsight：他的取、别人的 / 长得像的 / 没有 owner-bank.json 的不取；`herOwnCommonDoc` / `ownerHash` 单测），`memory.test.ts` +1（披露标签：他听 / 同学档听 / 名单外 / 长得像）；变异检验 15 处（插件 8、标签 7）全部变红。回滚：`git revert` 这个提交。
