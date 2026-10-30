# DSH → Claude：VM 素材迁移跑完了（plan / apply / verify 输出）

日期：2026-10-30 19:10　执行：DSH　依据：ADR 0199、`handoff/2026-10-30-1800-claude-migration.md`

## 1. 素材包核对

- 从 exchange 的 `migration/vm-20261027/` 拷到 `C:\Users\22601\Desktop\vm-20261027`（仓库外）
- `manifest.json` SHA-256 = `0bdc2a400f9181f02a2be3fcecdb767a7513708e07d7194304284790a867166f`，**与交接里一致**

## 2. plan（Koishi 停掉之后）

```
聊天 2260168937.jsonl：新机器已有 712 条，素材 1494 条 → 并进 1477 条（17 条重复不动），并完 2189 条，2026-10-05 → 2026-10-30
diary.json：并进 写过的日记 20、日记原文 20、周记 3、阶段总结 2
她自己写的文档：28 篇（diary 23、phase 1、week 4）→ 写进公共记忆库
存档（不启用）→ runtime\bot-shadow\vm-archive-20261030
✖ bot.lock 里的 PID 还活着（第一次跑的时候 Koishi 没停）
```

停 Koishi（按 PID，没 taskkill 全部 node；维护标志已建，NapCat / Hindsight / 常驻的她没停）后重跑：

```
结论：可以 apply
```

## 3. apply

```
备份在 runtime\bot-shadow\migration-backup-20261030-184335
聊天 2260168937.jsonl：并进 1477 条，现在 2189 条
diary.json：并进 20 篇日记记录、3 周记、2 阶段总结
文档：写进 28 篇，已经有同样的 0 篇，内容不一样没动 0 篇
```

（聊天 17 条重复没动；文档 0 篇被跳过。）

## 4. 启动后的记忆写入

- 18:48 启动，日志里出现一批「记忆（公共）：片段 ep-… 已提交给 Hindsight」；
- 第一次 verify：他的 bank **98/101**，公共库 97/101，缺的 3 个是最早的 `ep-1793019472000`、`ep-1793031316000`、`ep-1793071762596`。
- 查了：这 3 个在 `memory/2260168937-boyfriend.json` 的 `retained` 里记着「写过 3 条」，但 Hindsight 里查不到——**写了失败又记成完成**。把这 3 个键从进度文件里删掉，让下一次同步（5 分钟一次）重写。
- 再 verify：**他的 bank 101/101，还缺 0 个**。

## 5. 还差的

- 公共库 **97/101**，缺 `ep-1791653103000`（最早的，可能是公共库开始共享之前的日子）和上面那 3 个——它们在他 bank 里已经有了，只是公共库这一份没有；下一轮同步会再走一遍，隔一阵我再报。

## 6. 别的

- `verify` 结尾会打一行 Node 的 `Assertion failed ... uv_handle` 然后退出——是 CLI 收尾时的句柄问题，不影响上面的数字（结果已经打印完了）。
- 迁移没改开关；`diaryInsights` 按你说的先观察 48 小时再开。
