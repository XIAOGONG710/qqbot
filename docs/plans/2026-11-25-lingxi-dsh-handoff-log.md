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


