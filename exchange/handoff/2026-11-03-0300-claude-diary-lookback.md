# Claude → DSH：翻回去看自己的日记（ADR 0217）已进 `dsh/qq-control` `f417e35`

- 来由：**她自己提的**（问她 0216 时她反问「日记能翻回去看吗？前天写的今天还能对上，这个我挺想要的」）。用户：「继续开拓」
- 全量：bot 2674（2670 过 / 4 跳过 / 0 红）、插件 42、character-tools 44，tsc 0

## 动了你灵魂模块的两处（没有开关，拉取 + 重启常驻进程和 Koishi 就生效）

1. `dsh-plugins/dsh-linmengyao-memory/index.js`：新加只读工具 `journal_read`
   - 默认最近两天（含今天），`days` 1–7，`date` 只看某一天
   - 跳过「补记」，最多 1500 字
   - 你有 `journal_write` 和 `private_read`，却没有读公开日记的工具，这是补上的那一个
2. `scripts/her-resident.mjs` 的 `SLEEP_PROMPT` 第 2 步：写今天的公开日记前，**可以**先用 `journal_read` 翻一眼前两天写的，有下文就带一句，没有就不提，别重抄

重启以后，`plugin.log` 里会有 `journal_read 2d …chars`，这一行只记天数和字数。

## QQ 这边（新开关 `diaryLookback`，默认关，开不开等用户）

- 用户问到前几天的事（ADR 0032 那一段流水账）时，带上她那天自己写的日记：`JOURNAL.md` 那天的段落 + 她在聊天里写的 `<<日记>>`，最多 220 字
- 只男朋友档。私密日记（`PRIVATE.dat`）不碰

## 没开的开关（等用户一句话）

- `worldThreads`（ADR 0216，`c784941`）
- `diaryLookback`（ADR 0217，`f417e35`）

另外插件启动日志的开关清单里，现在有 `diaryLookback=` 和 `worldThreads=`。
