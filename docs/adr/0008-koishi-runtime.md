# ADR 0008：运行时迁到 Koishi 4——Koishi 当外壳，我们的模块写成自己的插件

- 状态：已采纳（2026-10-05：待定问题与用户确认，第 2 步试验后按「试验之后的调整」修改，调整第 1 条经用户确认）
- 日期：2026-10-05
- 修改：[ADR 0002](0002-standalone-runtime.md) 决策 1（独立服务 → Koishi 里的自有插件，仍是 Node / TypeScript，仍不 import SillyTavern）、
  决策 4（自写的 OneBot 客户端 → Koishi 官方的 `adapter-onebot`）
- 依据：[调研汇总](../research/2026-10-05-framework-fit.md)、[Koishi + ChatLuna 报告](../research/2026-10-05-framework-fit/koishi-chatluna.md)

## 背景

10-05 调研之后用户决定换到 Koishi（汇总报告「用户决定」一节）：要的是现成的管理界面（换档、改白名单不用编辑文件、改完热加载）、
官方维护的 OneBot 适配器，以及以后接看图、语音、群聊、主动消息时现成的插件生态。
已经做好、测过的核心（ST 规则拼提示词、分档与换档隔离、作息与回复时机、消息调度、出口检查、Hindsight 记忆、模拟器）不换，原样搬进插件。

调研里查到的 Koishi 能力和风险见报告第 3–5 节。本 ADR 写之前又核对了几件事（2026-10-05，`npm view`）：

- `npm init koishi` 用的模板 `@koishijs/boilerplate` 依赖约 40 个插件：Discord / KOOK / Telegram / QQ 官方适配器、`market`（联网拉插件市场）、
  `puppeteer`（会装浏览器）、`koishi-plugin-telemetry`（描述是「Koishi 开发者服务」，没读它发什么）、`analytics` 等。我们用得到的不到十个。
- 控制台登录插件 `@koishijs/plugin-auth`（AGPL）声明 `service.required: ['database', 'console']`：开登录就要装一个数据库插件。
  `@koishijs/plugin-database-sqlite`（MIT）用的是 sql.js（wasm），不用本机编译。
- `koishi` 4.18.11 的 loader（`@koishijs/loader` 4.6.11）依赖 `dotenv`、`js-yaml`、`ns-require`：插件按 `require` 加载，实例目录的 `.env` 会被读进环境变量。
- 回复时机里的随机延迟按第一条没回的消息的 id 取种子（`reply-timing.ts` 的 `pick`）：同样的聊天记录重算「什么时候看到」得到同一个时刻。
  所以插件被重启后按聊天记录重算，结果和没重启一样（待定问题 7 的依据之一，试验里再确认）。

## 需求（迁完之后要满足的）

行为和现在的 `main.ts` 一致：

1. 只回直接私聊（OneBot `sub_type: friend`）；群聊、群临时会话、小号自己发的消息都不处理。名单里的人按各自档位；名单外的好友看 `unlistedFriends`。
2. 每人一个回复器（`responder.ts` 原样）：连发合并、生成期间来消息重生成、发送途中插话不发剩下的、作息与回复时机、出口检查、失败后 1 / 5 分钟再试，行为不变。
3. 每次连上 NapCat（含断线重连）先补回：名单里每人最近 20 条，按 QQ 消息 id 去重、不早于换档时间；补完之前到的消息先攒着，补完按顺序处理；
   然后有没回的就回（3 小时内，或夜里来的），再写一次长期记忆。
4. 长期记忆每 5 分钟写一次；`last-prompt.json` 照写；日志照旧按天写到 `<数据目录>/logs/<日期>.log`（grep + 打码的核对方式不变）。
5. 换档：`tiers.json` 记录、换档提示、换档前的记录对提示词 / 记忆 / 补回不可见（`tier-record.ts` 原样）。
6. 同一个数据目录只能有一个 bot 在回：旧 `main.ts` 和 Koishi 插件不能同时回同一批人。
7. 密钥只从环境变量读：模型 key（`QQBOT_LLM_API_KEY`）、OneBot token（`QQBOT_ONEBOT_TOKEN`）都不写进任何配置文件。
8. 运行配置（名单、档位、称呼、persona、名单外开关、作息开关、模型参数、记忆）在控制台表单里改，保存后生效，不用重启进程；
   角色卡和世界书仍是文件（`tiers.toml` → 转换器生成），重新生成后自动重新读。
9. 控制台只有本机能打开。
10. 模拟器（`sim/*`）、`packages/character-tools` 不动；两个包的测试全过。迁完之前旧入口 `main.ts` 一直可用。

## 决策

### 1. 外壳只装用得到的

Koishi 4.18.11 + `koishi-plugin-adapter-onebot` 6.9.4（MIT）+ 控制台 `@koishijs/plugin-console`、`plugin-config`、`plugin-logger`（AGPL，原样使用不改源码）
+ 登录 `plugin-auth`（AGPL）和它要的 `plugin-database-sqlite`（MIT）。不装 ChatLuna、`market`、`sandbox`、`explorer`、`telemetry`、`analytics`、`puppeteer` 和其他平台的适配器。
新装的包照 `undici` 的做法核对来源（`npm audit signatures`、lockfile 的 integrity），结果写进 `docs/koishi.md`。

### 2. 代码结构：核心留在 `packages/bot`，插件只是一层接线

- `main.ts` 里除了收发之外的编排（按 QQ 号建回复器、名单外的人、补回、catchUp、定时写记忆、换档记录、锁）提到 `packages/bot/src/app.ts`，
  收发用接口传进去：发一条私聊、拉某人最近 N 条历史、收到一条消息（已转成 `{QQ 号, 消息 id, 时间, 文本, 昵称}`）、连上了。
  `main.ts` 变成「`OneBotClient` + app」，Koishi 插件是「`adapter-onebot` + app」，两边共用一份编排和它的单元测试（和 ADR 0005 让模拟器共用流水线是同一个思路）。
- 插件源码在 `packages/koishi-plugin-qqbot`（入库）：`apply()`、配置 Schema、把 Koishi 的 session / bot 转成上面的接口。预计一两百行。
- Koishi 实例在 `runtime/koishi`（不入库）：`package.json`、lockfile、`koishi.yml`、`.env` 不放密钥。插件以本地路径依赖装进去。
- 加载方式按试验结果定：Node 24 能直接 `require` 我们的 ESM + `.ts` 就不打包；不行就用 esbuild 打成一个 CJS 文件（esbuild 也按第 1 条核对来源），启动脚本先构建再启动，保证跑的是工作区代码。

### 3. 和 NapCat 的连接

`adapter-onebot` 正向 WS 连 NapCat 现在的「WebSocket 服务端」，NapCat 配置不动。token 在 `koishi.yml` 里引用环境变量（loader 的 `${{ env.X }}` 插值，试验里确认控制台保存配置时不会把明文写回文件）。
补回用 `bot.getMessageList('private:QQ')`（适配器对私聊调 NapCat 的 `get_friend_msg_history`），能替代就删掉 `backfill.ts` 里取数的部分；
`findMissed` 的去重和换档下限保留。重连时机用适配器的上线事件。

### 4. 配置分三层

| 放哪 | 内容 | 怎么改 |
| --- | --- | --- |
| 插件 Schema（存在 `koishi.yml`） | 名单（QQ、称呼、档位、persona）、`unlistedFriends`、`schedule`、模型参数（不含 key）、`prompt`、`memory`、`characterCard`、`dataDir` | 控制台表单，保存后生效 |
| 文件 | 角色卡、世界书（转换器生成） | 改 `tiers.toml` 后跑转换器；插件监听这些文件，变了就重新读 |
| 环境变量 | `QQBOT_LLM_API_KEY`、`QQBOT_ONEBOT_TOKEN` | 用户级环境变量，启动脚本读取 |

校验沿用 `config.ts` 的规则（拆成「读文件」和「校验对象」两步，Schema 的结果走同一个校验），旧 `main.ts` 照旧读 `runtime/bot/config.json`。
过渡期两份配置并存：Koishi 那份以控制台为准，`config.json` 只给旧入口用；验收后看第 9 条。

### 5. 数据目录和锁

插件默认用和现在一样的 `runtime/bot`（聊天记录、`tiers.json`、记忆的写入进度、日志）：两条路线来回切换不用搬数据，记忆不重复写。
单实例锁也共用，所以旧 `main.ts` 和 Koishi 同时启动时后启动的那个拒绝回复（满足需求 6）。插件停用 / 重启时释放锁。

### 6. 日志

我们的 `log()` 同时写 `ctx.logger`（控制台能看）和原来的按天日志文件（grep 的核对方式不变）。`logger` 插件自己另存的那份不作依据。

### 7. 控制台

只监听 `127.0.0.1`，开登录（`plugin-auth` + sqlite）。密码由用户在首次启动时自己设，不进仓库也不进上下文。

### 8. 改配置时正在等的回复

待试验（第 4 项）。两种做法：

- 允许插件重启：重启时所有等待和定时器都清掉，新实例按聊天记录 catchUp 重算。随机延迟按消息 id 取种子，重算出的「几点看到」不变；
  要确认的是正在生成或正在逐条发送时被打断会怎样（重复发送、半截回复）。
- `ctx.accept`：名单、开关这类改动就地更新，不重启；改模型参数之类的再重启。

### 9. 旧入口

迁移期间 `main.ts`、`scripts/start-bot.ps1` 保持可用。Koishi 路线稳定跑一周后再决定删不删。

## 第 2 步：小试验（约半天，`runtime/` 下，假 NapCat，不碰真 QQ 号）

| # | 验证什么 | 通过的标准 |
| --- | --- | --- |
| 1 | Koishi 4.18.11 在 Node 24.21 上能跑 | 实例启动、控制台能打开、适配器连上假 NapCat；没有 esbuild-register / 原生剥类型的冲突（PR #1553） |
| 2 | 我们的 ESM + `.ts` 怎么加载 | 先试直接加载；不行就 esbuild 打 CJS，记下哪种可行、启动多花多久 |
| 3 | 最小插件 | 假 NapCat 推一条名单里的私聊 → 按档位选卡 → 现有拼提示词 + responder（模型用假接口）→ 经适配器 `send_private_msg` 发回；群聊、群临时会话、自己发的被忽略 |
| 4 | 控制台改名单 / 档位时正在等的「看到」定时器 | 分别试插件重启和 `ctx.accept`：有没有丢回复、重复回复、锁有没有释放，看到的时刻是否不变 |
| 5 | 断线补回 | 假 NapCat 实现 `get_friend_msg_history`；断开重连后 `bot.getMessageList('private:QQ')` 拿到的消息 id、时间、发送者够不够 `findMissed` 用 |
| 6 | 密钥 | `koishi.yml` 用 `${{ env.QQBOT_ONEBOT_TOKEN }}`，在控制台改别的配置并保存后，文件里仍是插值而不是明文 |

结果写回调研汇总的「第 2 步」一节；本 ADR 按结果改为已采纳或调整。

## 第 3 步：迁移（小步提交，每步能运行、测试通过）

1. 编排提到 `app.ts`，`main.ts` 改用它；单元测试覆盖补回、攒消息、名单外、catchUp。旧 bot 行为不变（用户随时可能重启 bot）。
2. `config.ts` 拆成读文件 + 校验对象。
3. 新建 `packages/koishi-plugin-qqbot`：Schema、`apply()`、session / bot 的转换；需要的话加构建。
4. `runtime/koishi` 实例 + `scripts/start-koishi.ps1`（和 `start-bot.ps1` 一样在用户自己的终端里跑）；`docs/koishi.md` 写安装、来源核对、启动、回退。
5. 卡文件监听热加载。
6. 假 NapCat 端到端 + 启动冒烟；文档（README、roadmap）。

## 验收

- 两个包的测试全过；
- 模拟器场景和迁移前一样通过：`timing-boyfriend`、`timing-classmate`、`schedule-boyfriend`、`schedule-classmate`、`boyfriend-scheduling`、
  `classmate-probes`、`unlisted-probes`、`boyfriend-time`、`exit-check-boyfriend`、`exit-check-classmate`；
- 假 NapCat 端到端：Koishi 实例连假 WS，私聊回复、断线补回、控制台改白名单后热加载都正常；
- 用临时配置做启动冒烟；之后问用户要不要切到真 QQ。

## 备选方案

| 方案 | 不选的原因 |
| --- | --- |
| 继续自建，自己写管理页 | 主会话原本倾向这个（管理页粗估 2–4 天，不依赖接近停更的框架）；用户 10-05 决定要现成的控制台和生态 |
| AstrBot | 要用 Python 重写全部核心和模拟器，还要关掉安全模式、遥测、内置白名单，并和 EULA 的字面限制共存（调研汇总） |
| Koishi + ChatLuna | 世界书缺二级关键词 / @depth / 包含组，没有档位隔离和作息，不会取消重生成；再加 LangChain、数据库和 AGPL（Koishi 报告第 2、4 节） |
| `npm init koishi` 模板 | 带约 40 个插件（含 telemetry、market、puppeteer），装完要逐个删；手写同样用 npm 和 koishi 的 CLI，只是少了这些 |
| Koishi Desktop | AGPL 的 Go 外壳，自带一套 Node；我们已有核对过的 Node 24 |
| 反向 WS（NapCat 连 Koishi） | 要改 NapCat 配置；正向 WS 适配器也支持，且自带重连 |

## 后果

- 维护风险：Koishi 2026 年只有 3 次提交，cordis 3 从 2024-08 起没更新，Koishi 5 时间不明；CI 只测 Node 20 / 22。
  缓解：核心留在 `packages/bot`、插件只是接线，退回独立 `main.ts` 只要换掉收发那一层。
- 过渡期两个入口、两份配置；锁保证同一时间只有一个在回。
- 控制台系列是 AGPL，原样使用、不改源码；我们的插件不 import 它们。
- 可能多一道构建（esbuild），启动脚本负责，不往仓库里提交构建产物。
- 模拟器不经过 Koishi：插件那层的接线只靠假 NapCat 端到端测。

## 重新评估条件

- Koishi 在我们用的 Node 版本上出问题且上游不修；Koishi 5 发布且 4 停止兼容新插件。
- 控制台满足不了日常改配置的需要（例如档位多了以后表单不好用）。
- 插件那层的接线开始变厚，绕框架的代码多过用框架的。

## 试验之后的调整（2026-10-05）

试验结果见[调研汇总「第 2 步」](../research/2026-10-05-framework-fit.md)。六项都能做到，对决策的改动：

1. **决策 2（实例的依赖放哪）**：插件从 `.ts` 源码直接加载，不打包；但插件 `require('koishi')` 必须拿到 loader 用的同一份 koishi，
   而 Node 按插件的真实路径找依赖。所以 Koishi 的 npm 依赖不再单独装在 `runtime/koishi`，改为仓库里一个只有依赖清单的工作区包
   `packages/koishi-app`（版本写死，进根目录的 `package-lock.json`），和插件 `packages/koishi-plugin-qqbot` 一起由根目录 `npm install` 装好。
   `runtime/koishi` 只放 `koishi.yml`、`data/`（sqlite、Koishi 自己的日志）和启动脚本写的一个占位 `package.json`（免得 loader 报 manifest 警告）；
   启动时工作目录是 `runtime/koishi`（Koishi 的 `data/` 跟着工作目录走）。不选「`runtime/koishi` 单独装 + esbuild 每次启动把插件打成 CJS 放进去」：
   要多一个带原生二进制的构建依赖，也没试验过。
2. **插件里取 Koishi 的运行时对象**用 `createRequire(import.meta.url)('koishi')`（koishi 的 ESM 入口坏了），类型用 `import type`。
3. **决策 3（连接）加看门狗**：adapter-onebot 6.9.4 断线后不重连（上游 PR #81 未合并）。插件在 OneBot 的 bot 离线后按 5 / 10 / 30 / 60 秒退避调 `bot.start()`，
   每次按 `sid` 找当前的 bot。适配器也不检测悄悄断掉的连接（issue #57），和旧 `onebot.ts` 一样，先不做。
4. **决策 4（密钥）加一条规矩**：控制台保存时不做 `${{ env.X }}` 插值，所以 adapter-onebot 和 auth 的配置不在控制台改，要改就改完重启 Koishi。
   插件发现适配器的 token 还是 `${{` 开头时在日志里报错提示重启。
5. **决策 8（改配置时正在等的回复）定为插件重启 + catchUp**，不用 `ctx.accept`：试验里重启前后「几点看到」不变，等待中途重启也只回一次。
   回复器加 `stop()`：插件 dispose 时停掉正在等的、不再生成和发送，旧实例不会和新实例抢着回。
6. 收发用适配器给的原始 OneBot 数据：收到的消息取 `session.onebot`（NapCat 的原始事件），补回调 `bot.internal.getFriendMsgHistory(QQ, undefined, 20)`，
   发送调 `bot.internal.sendPrivateMsg`（和旧 `onebot.ts` 发的是同一个请求）。两个入口共用 `segmentsToText`、`findMissed`，转文字的规则只有一份。
   试验证明 `bot.getMessageList('private:QQ')` 也能替代取数，但它不能指定条数、会为引用消息多调 `get_msg`，还要另写一个 elements 转文字的函数；
   `bot.sendPrivateMessage` 会把字符串当消息元素解析（回复里的 `<`、`&` 要转义）。这次用不到 Koishi 的消息抽象，等看图、语音时再看。
7. 控制台管理员密码用 `${{ env.QQBOT_KOISHI_PASSWORD }}`（用户级环境变量，用户自己设）。

## 确认记录（2026-10-05）

草案之后与用户一次问完，用户选定：

1. 代码位置：插件源码 `packages/koishi-plugin-qqbot` 入库，Koishi 实例 `runtime/koishi` 不入库（决策 2）。
2. 安装方式：手写最小实例（用户原先倾向 npm 模板，看了模板带的插件之后改选；决策 1）。
3. 和 NapCat 的连接：正向 WS，NapCat 配置不动（决策 3）。
4. Schema 管运行配置；卡和世界书仍是文件，加文件监听热加载（决策 4）。
5. 控制台：只监听 127.0.0.1，开登录，为此装 sqlite 数据库插件（决策 7）。
6. 旧 `main.ts`：Koishi 路线稳定跑一周后再决定删不删（决策 9）。
7. 改配置时正在等的回复：看试验结果再定（决策 8）。
8. 数据目录和锁与旧入口共用 `runtime/bot`（决策 5）。
9. 日志同时写 `ctx.logger` 和原来的按天文件（决策 6）。

同时推送了调研的两次提交（`1775741`、`b8aff08`）。

试验之后：用户同意 Koishi 的依赖放进仓库工作区（「试验之后的调整」第 1 条）；第 7 条按试验结果定为插件重启 + catchUp（第 5 条）。
