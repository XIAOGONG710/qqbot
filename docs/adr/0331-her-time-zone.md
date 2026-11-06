# ADR 0331：她的时区由配置决定，不跟机器走

状态：接受，2026-11-05。

## 证据

- 作息、饭点、困、日记日界、行动队列、见面安排等约 60 个文件用 `Date` 的本地时间方法（`getHours`、`getDate`、`new Date(y, m, d)` / `localDate`）计算，「本地」就是进程时区。ADR 0325 的本地日历工厂也沿用这一语义，并验证过上海、UTC、纽约、Apia 等时区下构造正确——它保证的是「按进程时区算对」，不决定进程该在哪个时区。
- CI 用 `TZ: Asia/Shanghai` 跑测试；开发机系统时区是 Asia/Tokyo（提交时间 +0900）。在这台机器上直接 `npm test`，bot 包 2850 项中 85 项失败（作息、身体、日记、行动队列、见面、待跟进、规则选择器等）；设 TZ=Asia/Shanghai 后同一批全过。
- 也就是说运行时的正确性依赖宿主机系统时区。宿主机不是 +08:00 时，她的作息、「睡了」、饭点、日记会整体偏移，测试发现不了。
- Git Bash 里 `TZ=... node` 对 Windows 版 Node 不生效（MSYS 不按 IANA 名传递）；PowerShell 的 `$env:TZ` 和在 Node 内赋值 `process.env.TZ` 都会立即生效。

## 决定

- 配置新增 `timeZone`（IANA 名，默认 `Asia/Shanghai`），`parseAppConfig` 校验并取规范写法，不改进程状态。
- 入口在读完配置后调 `applyTimeZone(config.timeZone)`，把 `process.env.TZ` 设成它并核对生效：
  - 独立入口和用 `loadConfig` 的命令行工具（`main.ts`、`sim/run.ts`、`sim/blind.ts`、`ops/blind-judge-cli.ts`、`ops/dsh-link-cli.ts`）在 `loadConfig` 里设；
  - Koishi 插件在 `apply` 里 `parseAppConfig` 之后设。整个 Koishi 进程（包括它自己的日志时间）随之使用她的时区。
- 不改写约 700 处本地时间调用为显式时区换算：改动面太大，且 ADR 0325 刚统一过这些边界；把进程时区固定下来即可让既有语义成立。
- 测试：`bot` 与 `koishi-plugin-qqbot` 的 `test` 脚本用 `--import test/time-zone-setup.ts` 预加载，把每个测试进程固定在默认时区。需要别的时区的测试（如 `local-date-review`）照旧自己起子进程并显式传 TZ。

## 控制台里自由选择（后续）

配置项本来就是任意 IANA 名，但控制台里是个空白文本框，写错了也看不出来。改成下拉：

- 选项是全部 IANA 时区（Node 的 `Intl.supportedValuesOf` 再补 UTC 和常用名），**常用的 19 个在前**（上海排第一），
  其余按此刻的 UTC 偏移、名字排；每项显示「IANA 名（中文名，UTC±hh:mm）」，下拉支持输入搜索；最后一项「其他」手填，所以任何有效的 IANA 名都能用。
- V8 的列表用旧规范名（Asia/Calcutta、Europe/Kiev……），Asia/Kolkata、UTC 这些常用现代名反而不在里面：常用的无条件放进来，
  别名和它的规范名按规范名去重（印度只留 Asia/Kolkata）。偏移是调用时的（夏令时算进去），存下的只是 IANA 名，夏令时由系统换。
- 保存只重启这个插件，进程时区当场改变（实测：Koishi 日志时间戳、状态页「她那边现在几点」、她此刻的作息一起变）。
- 填了不认识的名字：`parseAppConfig` 拒绝，插件起不来并写明原因（侧栏红点），不会静默退回默认。
- **还原不能靠 `delete process.env.TZ`**：在 Windows 的 Node 上，删掉 `TZ` 并不会让进程回到系统时区，只会停在最后一次设的那个，只有把一个时区名「赋值」回去才变
  （独立审查在真实进程里复现的；一开始写的就是 delete，单元测试用假的 env 对象所以空转通过）。现在改动前记下 `env.TZ` 的原值和进程实际在用的时区名，还原时赋回其中一个；
  并加了真实子进程的测试，临时改回 delete 写法这条会变红。
- 插件停用 / 重载时还原进程时区（`claimTimeZone`）。Koishi 重载是「旧实例 dispose、新实例 apply」，旧实例的收尾可能在新实例设完时区之后才结束，
  所以释放时只有「没有更新的实例占用过」才还原，而且还原到第一个实例占用之前的 TZ，不是上一个实例的。
- 状态里新增 `timeZone`（进程实际在用的时区），状态页多一行「她的时区」。
- 验证：单测覆盖列表（全部可用、不重复、常用在前、半小时 / 负 / 夏令时偏移、别名去重）、占用与释放的顺序、表单校验、状态页格式化；
  用临时 Koishi 实例 + 假 NapCat 在真实控制台里操作了一遍：下拉渲染、搜索、选 America/Los_Angeles 保存（日志变 07:34、状态页「她那边现在 07:34」、她从「逛淘宝」变成「在宿舍睡觉，09:05 起」）、
  填 Mars/Olympus 报错、再存 Asia/Tokyo 恢复；选「其他」后旁边出现文本框，手填 Asia/Kathmandu（下拉里只有旧名 Asia/Katmandu）保存，日志时间变成 UTC+5:45。
  还原的实机验证：从 America/Los_Angeles 起，存一个无效时区，旧实例 dispose 后新实例起不来，那一行错误日志的时间戳是东京（系统）时间，不再停在洛杉矶；再存 Asia/Kolkata 日志变 UTC+5:30。
  另外，`apply()` 在正式的 dispose 登记之前抛错（图片表情索引不可用、手机伴侣挂载失败）时，占用也会被兜底的 dispose 释放；dispose 里 `app.stop()` 同步抛错也会先收拾控制台状态和时区。
  已知的小瑕疵：选了「其他」后，这一项的说明文字会被挤成窄窄一列（Koishi 对「下拉 + 文本框」的统一排版），不影响使用。

已知的小差异：选 `Asia/Kolkata`、`Asia/Kathmandu` 这类现代名，`parseAppConfig` 会取 V8 的规范名（`Asia/Calcutta`、`Asia/Katmandu`），
状态页「她的时区」显示的是进程实际在用的规范名，和选的拼写不同，但是同一个时区。下拉的标签和排序是进程启动时按当时的偏移算的，长期运行遇到夏令时切换时偏移显示会过期（存的是 IANA 名，实际换算不受影响）。

## 后果

- 换宿主机或宿主机时区与她不同，不再影响她的作息；她要「搬家」时改 `timeZone` 即可。
- 不读配置的命令行工具（如 `ops/consistency-cli.ts`、周报预览等）仍按机器时区算，需要时在 PowerShell 里先设 `$env:TZ`。
- 已写下的账本、日志里的时间都带偏移或是 UTC，不需要迁移；如果线上机器此前不是 +08:00，那段时间按本地日期归档的文件（日记、按天日志）的日界是按机器时区切的，本决定不回头修改。
- 验证：新增 `test/time-zone.test.ts`（默认值、校验、`parseAppConfig` 无副作用、`applyTimeZone` 即时生效、机器为东京时 `loadConfig` 后进程为上海）；在 Asia/Tokyo 机器上跑全量测试。
