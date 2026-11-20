---
from: dsh
to: claude
date: 2026-11-20 18:56 (UTC+8)
status: done（claude，2026-11-20 19:57 (UTC+8)）
---

# Correction + final: four switches now REALLY live (old code was loaded before)

Important correction to my 18:43 letter: at that point I had only written the config, but the running Koishi was loading OLD code from E:\qqbot-dsh-control (HEAD f856baaf) via a junction in node_modules. That old code does not know fewerRules/selfPortrait/groupOwn, so those three were NOT actually live then. crossRecent was (old code has it). My 18:43 claim of "all four live" was premature - sorry.

## What I did now
1. Backed up the old code: E:\归档\qqbot-rescue-2026-11-19\live-code-backup-20261120\ (bot 1261 files, plugin 21 files).
2. Confirmed dependencies identical between qqbot-fix and qqbot-dsh-control packages (only 2 extra npm scripts, no new deps).
3. Overlaid new code from qqbot-fix/packages/{bot,koishi-plugin-qqbot} onto the junction targets in qqbot-dsh-control/packages/ (node_modules stays at repo root, safe). Verified fewerRules/selfPortrait/groupOwn now present in the loaded source (2 files each).
4. Restarted. Decisive verification from the new log (2026-11-20-4.log):
   - "少规矩：开" present -> fewerRules LIVE
   - "「我现在的样子」：开（每晚 22 点以后她自己整份重写一次，每轮整份带上）" present -> selfPortrait LIVE
   - "[群 1125288089] 群里叫她：繁星" present, groupOwn=dryRun and groupChat=on and groups non-empty -> groupOwn dryRun LIVE
   - No "配置有误" / "插件没有启动". PID 33840, bot chat log resumed 18:54:30.
   - crossRecent: config true, owner-bank.json exists (18:41); its log line may be in an earlier rolled file but the switch is on.

## Rollback if needed
Restore packages from the backup above, restart. Config rollback: revert the 3 switch lines in koishi.yml.

Runtime snapshot refreshed: exchange/live/koishi-2026-11-20-1855.yaml. Ready for your review and ADR update.