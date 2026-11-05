# ADR 0248：她的时区由配置决定，不跟机器走

状态：接受，2026-11-05。

## 证据

- 作息、饭点、困、日记日界、行动队列、见面安排等约 60 个文件用 `Date` 的本地时间方法（`getHours`、`getDate`、`new Date(y, m, d)` / `localDate`）计算，「本地」就是进程时区。ADR 0231 的本地日历工厂也沿用这一语义，并验证过上海、UTC、纽约、Apia 等时区下构造正确——它保证的是「按进程时区算对」，不决定进程该在哪个时区。
- CI 用 `TZ: Asia/Shanghai` 跑测试；开发机系统时区是 Asia/Tokyo（提交时间 +0900）。在这台机器上直接 `npm test`，bot 包 2850 项中 85 项失败（作息、身体、日记、行动队列、见面、待跟进、规则选择器等）；设 TZ=Asia/Shanghai 后同一批全过。
- 也就是说运行时的正确性依赖宿主机系统时区。宿主机不是 +08:00 时，她的作息、「睡了」、饭点、日记会整体偏移，测试发现不了。
- Git Bash 里 `TZ=... node` 对 Windows 版 Node 不生效（MSYS 不按 IANA 名传递）；PowerShell 的 `$env:TZ` 和在 Node 内赋值 `process.env.TZ` 都会立即生效。

## 决定

- 配置新增 `timeZone`（IANA 名，默认 `Asia/Shanghai`），`parseAppConfig` 校验并取规范写法，不改进程状态。
- 入口在读完配置后调 `applyTimeZone(config.timeZone)`，把 `process.env.TZ` 设成它并核对生效：
  - 独立入口和用 `loadConfig` 的命令行工具（`main.ts`、`sim/run.ts`、`sim/blind.ts`、`ops/blind-judge-cli.ts`、`ops/dsh-link-cli.ts`）在 `loadConfig` 里设；
  - Koishi 插件在 `apply` 里 `parseAppConfig` 之后设。整个 Koishi 进程（包括它自己的日志时间）随之使用她的时区。
- 不改写约 700 处本地时间调用为显式时区换算：改动面太大，且 ADR 0231 刚统一过这些边界；把进程时区固定下来即可让既有语义成立。
- 测试：`bot` 与 `koishi-plugin-qqbot` 的 `test` 脚本用 `--import test/time-zone-setup.ts` 预加载，把每个测试进程固定在默认时区。需要别的时区的测试（如 `local-date-review`）照旧自己起子进程并显式传 TZ。

## 后果

- 换宿主机或宿主机时区与她不同，不再影响她的作息；她要「搬家」时改 `timeZone` 即可。
- 不读配置的命令行工具（如 `ops/consistency-cli.ts`、周报预览等）仍按机器时区算，需要时在 PowerShell 里先设 `$env:TZ`。
- 已写下的账本、日志里的时间都带偏移或是 UTC，不需要迁移；如果线上机器此前不是 +08:00，那段时间按本地日期归档的文件（日记、按天日志）的日界是按机器时区切的，本决定不回头修改。
- 验证：新增 `test/time-zone.test.ts`（默认值、校验、`parseAppConfig` 无副作用、`applyTimeZone` 即时生效、机器为东京时 `loadConfig` 后进程为上海）；在 Asia/Tokyo 机器上跑全量测试。
