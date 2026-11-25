# 灵犀 QQ 桥接交接 · 执行记录

对应计划：[2026-11-25-lingxi-dsh-handoff.md](./2026-11-25-lingxi-dsh-handoff.md)
交接基线 `e3e60bb0`，开工时 `main` 在 `f9fdb0e6`。

每批记录：具体数据源、模拟结果、尚未验证的运行条件。未获得授权的线上动作不做，只在记录里写明缺口。

## 第 1 批：离线验收基线（2026-11-25）

### 数据源

- `dsh-plugins/dsh-qqbot-services/index.js` 的 `createHandler`
- `dsh-plugins/dsh-qqbot-services/chat.js`、`companion-room.js`、`controller.js`、`local-panels.js`
- `scripts/dsh-service-panel.test.mjs`、`scripts/dsh-qq-chat.test.mjs`、`scripts/dsh-companion-room.test.mjs`、`scripts/dsh-home-scene.test.mjs`、`scripts/dsh-local-panels.test.mjs`
- 新增离线验收入口 `scripts/dsh-offline-acceptance.mjs`

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 脚本测试 | `npm run test:scripts` | 86 项中 85 通过、1 跳过（符号链接用例：当前 Windows 账户不能创建符号链接）、0 失败 |
| 类型检查 | `npm run typecheck --workspace @qqbot/bot` | 退出码 0 |
| 灵魂插件 | `npx tsx --test packages/bot/test/soul-plugin.test.ts` | 99 通过、0 失败、23 个套件 |
| 离线验收 | `node scripts/dsh-offline-acceptance.mjs` | 20 个请求全部符合预期，见下表 |

离线验收用临时 host 加假 NapCat、假 Hindsight 数据、假 Koishi 配置，跑总览、聊天、会客室、她的家和运维页：

| 页面请求 | 状态 | 本次触达的模拟调用 |
| --- | --- | --- |
| GET state | 200 | probe×1、events×1 |
| POST chat/list | 200 | napcatRead×3 |
| POST chat/history?key=private%3A200 | 200 | napcatRead×2 |
| POST chat/prepare | 200 | napcatRead×2 |
| POST chat/send（无确认单） | 403 | 无 |
| POST chat/prepare | 200 | napcatRead×2 |
| POST chat/send（正文被替换） | 403 | 无 |
| POST room/owner/invite | 200 | 无 |
| POST room/owner/messages | 200 | 无 |
| POST room/guest/messages（无来宾凭证） | 403 | 无 |
| GET home | 200 | home×1 |
| GET details/access / backups / logs / versions / books / library / memory | 200 | details×7 |
| GET home（非回环来源） | 403 | 无 |
| GET home（非主人会话） | 403 | 无 |

合计：probe=1、events=1、napcatRead=9、qqSend=0、details=7、home=1、launch=0。
取消发送和未经确认的发送都没触达发送接口，`qqSend` 为 0，满足计划要求。

### 尚未验证的运行条件

- 实机对照未做：需要在正常 DSH 窗口里临时换上模拟插件、跑一遍面板、再恢复正式链接，并要求一次插件重载授权。当前没有该授权，服务也未被触碰。
- 真实 NapCat、Hindsight、Koishi 的端口与进程未参与本次验收；全部为假数据。
- 真实 Koishi YAML 的脱敏样本验收留到第 2 批。

## 第 2 批：DSH 内接入人设与配置（2026-11-25）

### 数据源

- `packages/character-tools/src/character-editing.ts`（新增）：校验、构建、档位隐私检查、写入与回滚都在这里，Koishi 控制台和 DSH 面板共用
- `packages/character-tools/src/character-cli.ts`（新增）：面板用的短命子进程入口，`load` / `preview` / `save`
- `dsh-plugins/dsh-qqbot-services/character-bridge.js`（新增）：用 `tsx` 拉起上面的 CLI，只放行 `part` / `value` / `token`
- `dsh-plugins/dsh-qqbot-services/index.js`：新增 `GET|POST character`、`character/preview`、`character/save`
- `dsh-plugins/dsh-qqbot-services/client.js`：灵魂页新增角色资料编辑器
- `dsh-plugins/dsh-qqbot-services/config-editor.js`：本批只补测试，代码未改
- 合成角色 `packages/bot/test/fixtures/synthetic-character/`，验收时复制到临时目录，不读真实角色资料

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 共用编辑层 | `npx tsx --test packages/character-tools/test/character-editing.test.ts` | 8 通过 |
| 角色工具全量 | `npm test --workspace @qqbot/character-tools` | 26 通过 |
| Koishi 控制台 | `npx tsx --test packages/koishi-plugin-qqbot/test/console.test.ts` | 25 通过 |
| Koishi 插件全量 | `npx tsx --test packages/koishi-plugin-qqbot/test/*.test.ts` | 109 通过、18 个套件 |
| 配置编辑器 | `node --test scripts/dsh-config-editor.test.mjs` | 6 通过 |
| 全量测试 | `npm run test:scripts`、`npm test --workspaces --if-present` | 分别退出码 0；同一条 `npm test` 同时开两份会互相干扰，第一次看到的退出码 1 是并发所致，不是真失败 |
| 行为基线 | `npm run baseline:fast -w @qqbot/bot` | 39/39 逐字一致 |
| 离线验收 | `node scripts/dsh-offline-acceptance.mjs` | 34 个请求全部符合预期 |

角色资料在离线验收里的表现：

| 页面请求 | 状态 | 结果 |
| --- | --- | --- |
| GET character | 200 | 返回 64 位十六进制快照，六个可编辑分块 |
| POST character/preview（原样） | 200 | 通过，且 `scenes.yml` 一个字节没变 |
| POST character/save（人设名为空白） | 200 | `ok: false`，每类问题只给字段位置、类别、改法，不回显资料内容 |
| POST character/save（原样） | 200 | 写入一次（把合成资料规范成统一表头） |
| POST character/save（刚保存过的内容） | 200 | `written` 为空，不再写盘 |
| POST character/save（旧快照） | 200 | `conflict: true`，不覆盖别人刚写的内容 |
| GET character（非回环来源） | 403 | 不读取资料 |

合计：character=7，`qqSend` 仍为 0，角色资料编辑全程没有触达发送接口。

共用编辑层的行为：`preview` 只检查不写盘；`save` 先比对源文件快照，变了就报冲突；写入用临时文件加改名，中途失败按写入前的内容逐个恢复；内容没变的文件不写，避免多余的插件重载。指向档位隐私问题（例如世界书标题写明了不该公开的档位）时，返回的只有 `field`、`kind`、`tier` 和固定写法的 `hint`，命中的词不会出现在返回值里。

配置编辑器本批只补了回归测试（`scripts/dsh-config-editor.test.mjs`），覆盖：预览不写盘且只回显被编辑的字段、应用后保留未编辑字段与其他插件、留一份 `.bak` 可撤销、文件被改过报 409、会话不符或草稿过期报 403、不合规的编辑报 400、一份草稿只能用一次。测试里的 YAML 全是临时目录里的合成配置，`oneDiary` 断言保持 `off`。

### 尚未验证的运行条件

- 面板前端只做了语法检查和离线路由验收，没有在真实 DSH 窗口里点过；需要一次插件重载授权才能实机确认。
- `character-bridge.js` 依赖仓库里的 `tsx`，面板首次请求会多几百毫秒（实测 CLI 冷启动约 0.6 秒）。
- 真实角色资料没有参与验收：验收用的是合成角色的临时副本，真实 `characters/linmengyao/` 未被读写。

## 第 3 批：公共记忆关系图和摘要（2026-11-25）

### 数据源

- `dsh-plugins/dsh-qqbot-services/public-memory.js`（新增）：公共库查询、投影、分页缓存、关系图
- `dsh-plugins/dsh-qqbot-services/index.js`：新增 `GET memory/search`、`GET memory/graph`
- `dsh-plugins/dsh-qqbot-services/client.js`：记忆页新增搜索、结果列表、分页、关系图；原来的统计卡保留在下面作回退
- `packages/bot/src/memory/owner-bank.ts`、`hindsight.ts`：沿用已有登记与召回形状，本批未改
- 合成库：`scripts/dsh-public-memory.test.mjs` 里的假 fetcher，加上临时目录里合成的 `owner-bank.json`

### 只碰公共库

库名从 `owner-bank.json` 的 `commonBank` 取，且必须匹配 `^[a-zA-Z0-9_-]{1,80}-common$`；主人没公布、库名不像公共库、Hindsight 地址不是回环，一律不查。查询只打 `POST /v1/default/banks/{commonBank}/memories/recall`，`tags` 固定 `['qq-private']`、`tags_match: 'all_strict'`，不枚举、不读其他联系人的库。私有库名不会出现在请求里，也不会出现在页面返回值里。

### 给页面的只有投影

一条记忆只回 `text`、`withdrawn`、`certainty`、`when`、`source`、`entities`、`id`：正文截到 320 字符并去控制字符；`certainty` 把 `world`／`experience` 标成「库里直接写的」，`observation`／`opinion` 标成「整合出来的」，类型不明就是「来源不明」；`when.dated` 只在有事件发生时间时为真；`source` 只有 `document_id` 时是 `{ document }`，否则是 `null`（页面显示「来源不明」）；命中 `recalled`／`retracted`／`withdrawn`／`forgotten` 的条目 `text` 为 `null`，页面只留位置。Hindsight 原始字段、错误正文、库名都不外传。

### 分页、限量、超时

一页默认 8 条、最多 12 条，最多到第 5 页，最多留 60 条；同一查询 30 秒内复用召回结果（缓存最多 8 个查询），翻页不重复打 Hindsight。请求超时夹在 500ms 到 8000ms 之间，默认 3000ms，失败抛 `memory_unavailable`，路由回 503，页面只说「现在连不上」。

### 关系图

同一批记忆里的实体两两成边，节点带出现次数与可信度，边带共现的记忆 id，能一路追回到记忆和它的文档来源。节点最多 6 个实体一条记忆、边最多 40 条；公共库没连上时返回 `linked: false`，页面不拿空数据冒充。

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 公共记忆 | `node --test scripts/dsh-public-memory.test.mjs` | 11 通过 |
| 脚本测试全量 | `npm run test:scripts` | 103 项、102 通过、1 跳过（符号链接）、0 失败 |
| 离线验收 | `node scripts/dsh-offline-acceptance.mjs` | 全部符合预期，`memory=2`、`qqSend=0` |

`scripts/dsh-public-memory.test.mjs` 覆盖：只问公共库且请求里不带私有库名、投影不含 `context`／`metadata`／`tags`／原始时间字段、已收回不出正文、来源不明与推断与日期不明各标各的、分页复用召回（`calls.length === 1`）且最多留 60 条、越界参数夹回默认、公共库故障只回 `memory_unavailable` 且错误正文不外泄、没公布／不像公共库／超长库名都不查、关系图节点与边可追溯、库不可用时 `linked: false`、非回环地址不查。

离线验收里新增：`GET memory/search` 返回带来源的摘要、收回条目标 `withdrawn` 且无正文、响应里没有 `tags`、`GET memory/graph` 有节点、非回环来源 403 且公共库调用数不变。

### 尚未验证的运行条件

- 记忆页前端只做了语法检查与离线路由验收，没有在真实 DSH 窗口里点过；需要一次插件重载授权。
- 真实 Hindsight 与真实公共库没有参与验收：全部是假 fetcher 加合成 `owner-bank.json`，`runtime/` 下的真实数据未被读写。
- 新旧摘要并存只按「同一查询复用缓存」验证；真实库里旧摘要已被新摘要取代的情形没有样本来对照。

## 第 4 批：日志页（2026-11-25）

### 数据源

- `dsh-plugins/dsh-qqbot-services/logs-view.js`（新）：把 `runtime/services-watchdog.log` 与 `~/.dsh/linmengyao-memory.log` 解析成结构化事件，来源白名单只有这两份
- `dsh-plugins/dsh-qqbot-services/index.js`：新增 `GET logs/list`、`GET logs/export`；原来的 `summarizeWatchdog`、`summarizeRecallLog` 搬到新模块并再导出，旧测试的 import 不变
- `dsh-plugins/dsh-qqbot-services/client.js`：系统页新增来源切换、事件多选、分页和导出按钮，原诊断卡保留作回退
- `scripts/dsh-logs-view.test.mjs`（新）、`scripts/dsh-offline-acceptance.mjs`

### 只出结构化字段

解析阶段就把自由文本丢掉：只留时间、服务名、事件类别；召回诊断只留 `items`、`selected`、`chars`、`important`、`failed` 五个计数。导出再走一遍 `redact()` 兜底，抹掉 `token=`／`secret=`／`password=`／`session=`／`cookie=`／`authorization=`／`api_key=` 这类赋值、URL 里的参数值和 32 位以上长串。补齐了备份行（`备份：完成 …` 以前会被静默丢弃）和 `prepared`／`backup`／`matched`／`no-match`／`not-queried` 五个事件类别。

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 日志页 | `node --test scripts/dsh-logs-view.test.mjs` | 8 通过 |
| 脚本测试全量 | `npm run test:scripts` | 111 项、110 通过、1 跳过（符号链接）、0 失败 |
| 离线验收 | `node scripts/dsh-offline-acceptance.mjs` | 全部符合预期，`logs=3`、`qqSend=0` |

测试覆盖：白名单来源（`source: 'secrets'` 返回 `null`）、列表里没有对话原文／令牌／URL 参数／堆栈、事件多选取并集、分页越界夹回默认且翻到空页不报错、召回只留计数且查询词不进响应、导出不含 `SECRET-ABC`／`今晚早点睡`／`code=SECRET123`／`TypeError`、导出最多 500 条且两次一致、`redact()` 兜底。

### 尚未验证的运行条件

- 日志页前端只做了语法检查和离线路由验收，没在真实 DSH 窗口里点过；需要一次插件重载授权。
- 解析按现有两份日志的格式写，日志格式若改要同步改 `summarizeWatchdog`。

## 第 4 批：备份恢复四阶段（2026-11-25）

### 数据源

- `scripts/restore-stages.mjs`（新）：制品校验、文件隔离恢复、隔离数据库恢复、正式切换四个阶段；复用 `restore-drill-state.mjs` 的 `restoreDrillPlan`、`safeRestoreDrillTarget`、`verifyRestoredState`
- `dsh-plugins/dsh-qqbot-services/index.js`：新增 `GET backup/stages`、`POST backup/stage`；`switch` 一律 403 `needs_approval` 且只回步骤
- `dsh-plugins/dsh-qqbot-services/client.js`：备份清单每行加「分阶段」，前三个阶段有按钮，第四阶段只展开步骤
- `docs/operations/restore.md`（新）：四阶段手册，正式切换的授权边界写在里面；`docs/operations/rollback.md` 第 2 步链到它
- `scripts/dsh-restore-stages.test.mjs`（新）、已有的 `scripts/restore-drill.mjs`、`scripts/hindsight-restore-drill.mjs`

### 阶段边界

| 阶段 | 写哪里 | 失败怎么收场 |
| --- | --- | --- |
| 制品校验 | 不写盘 | 大小与完成标记不符就停，不进入后面阶段 |
| 文件隔离恢复 | `runtime/restore-drills/<时间戳>/` | 解压或检查失败就把整个目录删掉，不留半成品 |
| 隔离数据库恢复 | 系统临时目录里的一次性假库 | dump 头部不认识就失败；临时目录 `finally` 里删掉 |
| 正式切换 | 不执行 | 只回 7 步手册，`executed: false` |

隔离数据库那一步默认**只预演命令**（`isolated: 'planned'`），库名固定 `hindsight_restore_drill`，命令里不出现正式库名；真正的恢复仍由 `scripts/hindsight-restore-drill.mjs` 在隔离实例里跑。

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 四阶段 | `node --test scripts/dsh-restore-stages.test.mjs` | 11 通过 |
| 脚本测试全量 | `npm run test:scripts` | 122 项、121 通过、1 跳过（符号链接）、0 失败 |
| 离线验收 | `node scripts/dsh-offline-acceptance.mjs` | `backup/stages` 200、`switch` 403 带步骤、未知阶段 400，`qqSend=0` |

测试覆盖：四阶段顺序与「正式切换需要单独授权」、制品校验读出大小与摘要、大小不符即停、非法日期与不存在的备份都不算可演练、文件隔离恢复成功即清理且不碰 `runtime/bot`、解压中途失败回滚成空、隔离内容含 `secrets` 判失败并清理、隔离库只预演且命令里不出现正式库名、dump 头部不认识就失败、正式切换只给步骤不调执行器、临时目录用完即删且原备份不动。

### 尚未验证的运行条件

- 备份页的「分阶段」按钮只做了语法检查和离线路由验收，没在真实 DSH 窗口里点过。
- 没在真 PostgreSQL 隔离实例里跑 `hindsight-restore-drill.mjs`：本批的隔离库是假库，真库恢复要等一份真备份加一个隔离实例。
- 正式切换按设计没有执行，只写在 `docs/operations/restore.md`，等单独的上线授权。

## 第 4 批：更新检查（2026-11-25）

### 数据源

- `scripts/update-check.mjs`（新）：`createUpdateCheck({ root, runGit, now })`，只认 `origin/main`
- `dsh-plugins/dsh-qqbot-services/local-panels.js`：`details('versions')` 改走它；不刷新时仍只回 `local`／`tracked`，`?refresh=1` 才碰远端
- `dsh-plugins/dsh-qqbot-services/index.js`：`runGit` 超时 5 秒→15 秒、输出上限 4 KB→64 KB（`fetch` 与 `diff` 的输出更大）
- `dsh-plugins/dsh-qqbot-services/client.js`：版本卡展示差异、提交列表、改动文件、更新前备份、挡路原因和回滚点
- `scripts/dsh-update-check.test.mjs`（新）：本地假 Git 远端（裸仓库 + 克隆）跑真 git 命令

### 检查什么、不做什么

| 项 | 做法 |
| --- | --- |
| 远端检查 | `ls-remote --exit-code origin refs/heads/main`，只认这一个分支 |
| 版本差异 | `fetch --no-tags origin refs/heads/main` 取到 `FETCH_HEAD`（不动工作区、不动本地分支），再 `merge-base --is-ancestor` 判 same／behind／ahead／diverged，`rev-list --count` 给数量，`log` 给提交，`diff --name-only` 给改动文件（最多 20 条） |
| 更新前备份 | `runtime/backups` 里最近一份完成标记有效且不超两天，否则 `backup-stale` |
| 回滚检查 | 记下当前 `HEAD` 作为回滚点，附 `git checkout <sha>` 提示 |
| 挡路条件 | 不在 `main`、工作区有改动、备份过期、两边分叉、连不上远端 |

`pull`／`merge`／`rebase`／`reset`／`checkout` 一条都不发，`commands` 里只有一条 `git pull --ff-only` 的建议，页面写明「更新和服务重载在运维流程里手动做」。不从任何第三方更新器执行下载来的脚本。

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 更新检查 | `node --test scripts/dsh-update-check.test.mjs` | 9 通过 |
| 本地面板 | `node --test scripts/dsh-local-panels.test.mjs` | 8 通过 |
| 脚本测试全量 | `npm run test:scripts` | 131 项、130 通过、1 跳过（符号链接）、0 失败 |

用例覆盖：远端领先给差异／提交／改动文件／回滚点且只建议快进、非 `main` 挡住、工作区脏挡住、没有今天备份挡住、备份过期挡住、本地领先不给 pull、两边分叉挡住、没有远端只报 `no-remote` 且不发改写类命令、同一个提交无事可做。

### 尚未验证的运行条件

- 版本卡前端只做了语法检查，没在真实 DSH 窗口里点过。
- 真实的 `origin` 远端（GitHub）没有参与测试：所有用例都在临时目录的本地裸仓库里跑，避免测试联网。
- `fetch` 会更新本地的 `FETCH_HEAD` 与 `refs/remotes/origin/main`，这是检查远端差异的必要代价；面板不做任何本地分支移动。

## 第 5 批：会客室跨设备与房间媒体（2026-11-25）

### 数据源

- `dsh-plugins/dsh-qqbot-services/companion-room.js`：邀请 15 分钟一次性、来宾凭证 8 小时、每条 500 字、发言与上传各 1 秒一次、附件最多 16 个且单个 512 KB、只收 PNG／JPEG／WebP／WAV／MP3／Ogg／WebM
- `dsh-plugins/dsh-qqbot-services/index.js` 的 `createLanGuestHandler`：只放行加密连接、`Host` 必须等于配置的 origin、带 `forwarded`／`x-forwarded-*` 一律 403、`sec-fetch-site: cross-site` 与跨站 `Origin` 一律 403、POST 还要求 `x-qqbot-service-panel: 1`
- `dsh-plugins/dsh-qqbot-services/room-guest.js`：来宾页前端，失败提示分别是 `room-guest.js:97`（超过 512 KB）、`room-guest.js:91`（邀请无效／已用／房间满）、`room-guest.js:71`（权限结束）、`room-guest.js:106`（附件未送达）、`room-guest.js:31`（媒体加载失败可重试）
- `scripts/dsh-room-https.test.mjs`（新）：真 HTTPS 监听 + 测试证书，客户端按 `192.168.50.5` 校验证书，用来模拟第二台设备
- `scripts/fixtures/room-test/`（新）：只给测试用的自签证书与私钥，SAN 含 `192.168.50.5` 与 `127.0.0.1`，有效期十年；私钥是公开的合成资料，跟真实域名和证书无关

### 验收了什么

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 第二设备路径 | 起真 `https` 监听，客户端用证书当 CA 校验 `192.168.50.5`，再走房间页、邀请兑换、发言、读消息 | 通过 |
| 页面头部 | 断言房间页与脚本的 `content-security-policy`（`frame-ancestors 'none'`）、`x-content-type-options: nosniff`、`referrer-policy: no-referrer` | 通过 |
| 伪造来源 | 伪造 `Host`、带 `x-forwarded-for`、跨站 `Origin` 全部 403 | 通过 |
| 房主路由 | 来宾监听上访问 `room/owner/invite`、`details/access` 一律 404，房主路由只挂在 DSH 宿主 | 通过 |
| 图片与语音 | 上传 PNG 得 `image`、读回字节一致，上传 Ogg 得 `audio`、`content-type: audio/ogg` | 通过 |
| 上传限制 | 文本内容 415、超过 512 KB 413、`content-type` 不是 `application/octet-stream` 415 | 通过 |
| 附件隔离 | 另一个来宾读不到上一批的媒体，房间关闭后原来宾也读不到 | 通过 |
| 来宾到期 | 加入后 8 小时差 1 毫秒仍可用，过期后读消息与发言都被拒；重新邀请得到新凭证且看不到旧内容 | 通过 |
| 入场前内容 | 新来宾看不到旧观众的消息与附件，模型回复也只用新观众的上下文（既有用例） | 通过 |
| 附件不进模型 | 发图片再叫她的那一轮，模型上下文只有 `role`／`name`／`text` 三个字段，正文是占位符「[房间图片]」，没有图片字节 | 通过 |

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 会客室 | `node --test scripts/dsh-companion-room.test.mjs` | 9 通过 |
| HTTPS 第二设备 | `node --test scripts/dsh-room-https.test.mjs` | 3 通过 |
| 脚本测试全量 | `npm run test:scripts` | 136 项、135 通过、1 跳过（符号链接）、0 失败 |

### 尚未验证的运行条件

- 真实浏览器里没点过：图片渲染、语音播放、系统文件选择框、失败提示的实际样子都只做了代码检查。
- 真实的第二台设备与真实局域网没测：测试里的客户端在同一台机器上连 `127.0.0.1`，只在证书校验和 `Host`／`Origin` 上模拟了 `192.168.50.5`。
- 生产证书、私网绑定和防火墙规则属于部署环节：`openLanRoom` 只接受私网 IPv4（`10.`、`192.168.`、`172.16`–`172.31`）与 1024 以上端口，证书或私钥读不到就不启动监听。这三样都等上线授权时再配。
- **她的新言行要她本人和用户点头**：会客室和「她的家」都会改变她的言行边界，按 `CLAUDE.md` 先问了她（`scripts/ask-her.mjs`），原话与决定记在 [ADR 0349](../../docs/adr/0349-guest-room-and-home-status.md)。她要求会客室「看进来的是谁」、房间提示词别写得像说明书；她的家只给熟人看、随时能关。开关代码与提示词改稿等用户点头，这次没有动。

## 第 6 批：她的家（2026-11-25）

### 数据源

- `dsh-plugins/dsh-linmengyao-memory/home-status.js`：`publishedHomeStatus(data, now)` 只认 `version: 1`、`audience: 'owner'`、安全整数时间、地点与活动在白名单里，且一小时内的状态；`publishHomeStatus(file, { place, doing, hide }, at)` 用临时文件加 `rename` 原子写，`hide: true` 写 `null`
- `dsh-plugins/dsh-qqbot-services/home-scene/state.js`：`homeSceneState(data, now)` 把状态映射成 `{ place, label, marker }`，`place === 'outside'` 时 `marker` 为 `null`，缺地点或活动文案就返回 `null`，不猜
- `dsh-plugins/dsh-qqbot-services/home-scene/scene.js`：`scene.js:13` 拿不到 WebGL 就显示 `#fallback`，`scene.js:99` 三种文案（没有公开状态／暂时读不到／正常标签），`scene.js:143` 到点自己撤下标签
- `scripts/dsh-home-scene.test.mjs`（补）：原有 3 项测角色姿态、标记只跟随当前公开状态、场景资源要房主会话；这次补 4 项测发布与收回、拒未知地点与活动、坏文件读成 `null`、加速时钟换房间。全部用临时目录，不碰真实 `HOME-PUBLIC.json`

### 验收了什么

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 未公开 | 没有状态文件、文件是坏 JSON、收回后写 `null`，三种都读成 `null` | 通过 |
| 过期 | 一小时后差 1 毫秒仍公开，到一小时后变 `null` | 通过 |
| 在外面 | `place: 'outside'` 保留标签「在外面 · 走走」，`marker` 为 `null`，不画到任何房间 | 通过 |
| 读取失败 | 坏文件不抛错，读成 `null`，页面走「暂时读不到公开状态」那一路 | 通过 |
| 不猜位置 | 缺 `places` 或 `activities` 文案、房间不在 `rooms`、活动不在白名单，都返回 `null` | 通过 |
| 加速时钟 | 十分钟换一次房间走客厅→厨房→花园，再走到外面，一小时后自动消失，收回后也消失 | 通过 |
| 发布只写该写的 | 落盘字段只有 `version`／`audience`／`place`／`doing`／`at`，别的字段进不去 | 通过 |

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 她的家状态层 | `node --test scripts/dsh-home-scene.test.mjs` | 7 通过 |
| 脚本全量 | `npm run test:scripts` | 140 项／139 通过／1 跳过（符号链接）／0 失败 |

### 尚未验证的运行条件

- WebGL 不可用时的回退、窄窗口下的 `fit()`，都要真浏览器才知道；本次只按代码位置记录。
- DSH 内嵌房间与面板的实机验收要重载 DSH，本次没有授权。
- 正式模型与动作资源的授权来源还没定，仍用现有低模角色，不引入来源不明的资产。
- 整套对照写进了 `docs/plans/2026-11-25-lingxi-feature-parity.md`，每行都停在「模拟验收」。




