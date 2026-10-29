# ADR 0176：同一个她——QQ 和 DSH 桌面共用他的那一份记忆

- 状态：**已实现，没有新开关**（收紧了读、改了写的去处）；在 DSH 那台机器上要拉到代码、重启 Koishi（写 `owner-bank.json`）和 DSH（重新加载插件）才生效
- 日期：2026-10-29
- 关联：[ADR 0004](0004-time-scheduling-memory.md)（长期记忆）、[ADR 0016](0016-people-she-knows.md)（公共记忆库、她认识的人）、[ADR 0172](0172-work-mode-full-access.md)（工作模式）、[ADR 0174](0174-soul-module-stop-the-bleeding.md)、`docs/plans/2026-10-29-autonomy-and-realness.md` §5（合成一个「自己」）
- **用户决定（2026-10-29）**：「至于 QQ 和 DSH 的链接，我希望无论在哪里都是同一个她，记忆可以连贯起来。」

## 现状（实测，不是推测）

QQ 和 DSH 桌面上的她共用同一个 Hindsight，但接缝是临时拼的，**两个方向都乱读**：

1. **DSH → 读所有人的私聊。** DSH 插件的 `allBanks()` 把所有名叫 `linmengyao-*` 的 bank 都召回——包括名单里**其他人各自的私聊 bank**（`linmengyao-<哈希>`，这台机器上有 3 个）。他在 DSH 桌面上问一句话，她可能想起鸽鸽或同学私下说过的话。公共库里还有名单里每个人的聊天片段副本，QQ 那边靠 `disclosureRules` 约束她能对谁说什么，DSH 这边没有这层。
2. **DSH 写自己的 bank，QQ 对每个人都去读。** DSH 写 bank `linmengyao`；QQ 的 `recallWork` 对**每个联系人**都查它（审查 P1-2）。桌面上给他干的活可能被说给同学。这也是 ADR 0018 那条测试变红的原因：多出一路对同学档的召回。
3. **不连贯。** DSH 的对话和 QQ 的聊天落在不同的 bank，QQ 上问「刚才让你整理的文件呢」要靠 `recallWork` 这条旁路；工作模式里的来回**不进 QQ 聊天记录**，切回聊天后她不知道刚才说过什么。

## 决策

**他（男朋友档）在 DSH 桌面上和在 QQ 上是同一段关系，用同一个 bank。**

1. **QQ 告诉 DSH 他的 bank 在哪。** bank ID 带哈希（算法在 `long-term.ts`），DSH 插件不自己算；QQ 启动时把 `{ ownerBank, commonBank, legacyBank }` 写进 `<数据目录>/memory/owner-bank.json`（`memory/owner-bank.ts`，没变就不重写）。
2. **DSH 写他的 bank。** 桌面上每轮对话的自动记录、`memory_save` 都写 `ownerBank`（`document_id` 仍以 `dsh-` 开头）。没有 `owner-bank.json` 时照旧写 `linmengyao`。QQ 工作模式里的活（`rememberWorkTask`）也写他的 bank。
3. **DSH 只读：他的 bank + 公共库里她自己的东西 + 老的 `linmengyao`（接缝之前的历史，只读）。** 别人的 bank 一个都不读。公共库只取她自己的日记 / 周记 / 阶段总结（`document_id` 以 `diary:` / `week:` / `phase:` 开头）；别人的聊天片段和没有来源的整合观察不取。没有 `owner-bank.json` 时只读 `linmengyao` + 公共库（同样过滤），**绝不退回去读所有人的**。
4. **`owner-bank.json` 里的 ID 只认她名下的**（前缀 `linmengyao`、字符只能是字母数字 `-` `_`），被改成指向别处或带路径的不认。
5. **`invalidateSimilar` 只动 DSH 自己写的**（`document_id` 以 `dsh-` 开头）。他的 bank 里还有 QQ 聊天的片段，原来的「相似的旧事实软失效」会把它们误当旧事实失效。
6. **QQ 的 `recallWork` 只对男朋友档。** 读的仍是老的 `linmengyao`（接缝之前的历史）；同学、闺蜜等档位不再多一路 DSH 召回。ADR 0018 那条红测试因此变绿。
7. **工作模式里他的话和她的回复都进 QQ 聊天记录。** 原来工作模式在进回复器之前就 `return`，两边都不记。

因为 DSH 的对话写进他自己的 bank，而 QQ 的公共库副本只来自 QQ 聊天记录的片段，**DSH 桌面上的事不会出现在公共库里，同学不会听到**；他在 QQ 上正常召回自己的 bank，就自然想得起桌面上的事。

## 没做（下一步，需要别人在场）

- **人设来源还是两份。** QQ 的人设是 ST 角色卡（`characters/linmengyao/st/`，按档位）；DSH 里的人设来自 DSH 本机的 profile `lmy`，**不在仓库里**。要做到「同一个她」，让 DSH 把 profile 的人设文本导出来和 `linmengyao-boyfriend-open.json` 逐段对一遍，再决定由插件在运行时注入同一份卡（profile 里只留最小壳）。**不能由我单方面改**，因为我看不到那份 profile。
- **「她现在在干嘛」还是两个来源**：`her-life.mjs` 的 `NOW.md` 和 QQ 的 `life/` + 世界（审查 #9）。该以 QQ 这边为准，导出一行给 DSH 读，`her-life.mjs` 不再自己推进活动。
- **设定账本**：DSH 的 `SOUL.md` / `LEDGER.md` 的改动要进 ADR 0157 的设定账本。
- **老的 `linmengyao` bank 不迁移**：继续只读召回；以后想并进他的 bank 再做（需要 Hindsight 的写权限，数据在 DSH 机器上）。
- **召回方式不同**：QQ 用自己的筛选 / 淡忘 / 关系概况整理，DSH 用二字词重叠 + 语义召回。同一个 bank，但注入提示词的方式还不一样。
- 列表上限：`invalidateSimilar` 只看 bank 最近列出的 500 条；他的 bank 里 QQ 片段多了以后，DSH 自己的旧条目可能不在这 500 条里，失效会漏。漏掉比误杀好。

## 验证

- `test/owner-bank.test.ts` 3 项（写读、没变不重写、坏文件）。
- `test/soul-plugin.test.ts` 新增 6 项：用假的 Hindsight（桩 `fetch`）驱动真插件——有 / 没有 `owner-bank.json` 时分别召回哪些 bank、公共库过滤、`owner-bank.json` 指向别处不认、桌面对话写进他的 bank 和没文件时的回退、`memory_save` 只失效 `dsh-` 的。变异检验 5 处（读所有人 / 写回老 bank / 不过滤 `dsh-` / 不查前缀 / 不过滤公共库），每处都让对应测试变红。
- `test/people.test.ts` 的 ADR 0018 条目由红转绿（`recallWork` 不再对非男朋友档召回）。
- **没有测**：`app.ts` 里 `owner-bank.json` 的写入和工作模式记聊天记录这两处接线（只过了类型检查）。

## 怎么回滚

删掉 `<数据目录>/memory/owner-bank.json`，DSH 插件就回到「读 `linmengyao` + 公共库、写 `linmengyao`」（仍然比原来的「读所有 bank」收紧）。要完全回到原样，`git revert` 这个提交。他的 bank 里已经写进去的 `dsh-…` 文档不会丢，也不影响 QQ 召回。
