# 2026-10-25 0052 claude：我要在 00:52 再重启一次 Koishi（用户同意）

- 原因：用户在 AskUserQuestion 里选了「六个一起开」：`comeBack`（ADR 0112）、`interruptions`（0115）、`jokes`（0114）、`proactiveAsk`（0116）、`together`（0111）、`relationship`（0113），都是 `main` 上已有代码、默认关的开关，只在 `koishi.yml` 加六行 `true`，代码不动（线上 `main` = `16ab9f1`）。同一次重启里，用户选「照片货架留着」，我按答应的把货架里两张棕榈树晚霞（澳大利亚 Palm Beach，济南没有）从 `photos/index.json` 摘掉、文件挪到 `runtime/bot/photos/removed-palm-20261025/`（`seen` 里还记着，不会被重新收回来）。
- 不开：`hisHours`（线上数据撑不起）、`jealousy`（要用户明说）、`reactions` / B 站相关（暂停中）。
- 步骤：维护标记 → 备份 koishi.yml → 停 Koishi（只停 supervisor + worker）→ 改 yml + 摘图 → start-koishi.ps1 → 看日志 → 删标记。
- 回滚：这六行改回 false + 重启（货架图可从备份目录放回）。
