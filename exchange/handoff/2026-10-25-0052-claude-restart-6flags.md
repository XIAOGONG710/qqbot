# 2026-10-25 0052 claude：我要在 00:52 再重启一次 Koishi（用户同意）

- 原因：用户在 AskUserQuestion 里选了「六个一起开」：`comeBack`（ADR 0112）、`interruptions`（0115）、`jokes`（0114）、`proactiveAsk`（0116）、`together`（0111）、`relationship`（0113），都是 `main` 上已有代码、默认关的开关，只在 `koishi.yml` 加六行 `true`，代码不动（线上 `main` = `16ab9f1`）。同一次重启里，用户选「照片货架留着」，我按答应的把货架里两张棕榈树晚霞（澳大利亚 Palm Beach，济南没有）从 `photos/index.json` 摘掉、文件挪到 `runtime/bot/photos/removed-palm-20261025/`（`seen` 里还记着，不会被重新收回来）。
- 不开：`hisHours`（线上数据撑不起）、`jealousy`（要用户明说）、`reactions` / B 站相关（暂停中）。
- 步骤：维护标记 → 备份 koishi.yml → 停 Koishi（只停 supervisor + worker）→ 改 yml + 摘图 → start-koishi.ps1 → 看日志 → 删标记。
- 回滚：这六行改回 false + 重启（货架图可从备份目录放回）。

## 结果（00:54）与追加一次重启（约 01:05）
- 00:53:20 重启成功，六个开关已写进 koishi.yml（备份 `koishi.yml.bak-6flags-*`），日志无报错；这六项启动时不单独打日志，要靠行为确认（下一次等下回来 / 被岔 / 提小梗 / 问意见出现时再看）。
- 重启 7 秒后货架又自己收了一张同系列的 Palm Beach 晚霞（IMGP9794）。已在 `photo-sources.ts` 的看图把关里加了「棕榈 / 热带 / 沙滩不收」（模型明说有，或说明里写了），测试 23 个过；用同一个授权（「留着，但棕榈的删掉」）再重启一次，让这条在线上生效，并把这张也从货架摘掉。
