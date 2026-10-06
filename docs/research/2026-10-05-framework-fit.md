# 调研：迁到现成框架，还是继续自建（2026-10-05）

结论用于 ADR 0008（待写）。这是计划里的第 1 步「书面调研」：只读 README、文档和源码，**没有运行任何候选**。
两份详细报告由子代理读源码写成，每格附出处；标「已核对」的条目由主会话直接复查过。

- [AstrBot](2026-10-05-framework-fit/astrbot.md)（`42972e9`，v4.29.0-beta.1）
- [Koishi + ChatLuna](2026-10-05-framework-fit/koishi-chatluna.md)（koishi `5525cfd` / 4.18.11，chatluna `bcd0c61` / 1.4.0）

## 问题

想白拿管理界面（换角色、改白名单不用编辑文件）、看图、语音、生图、群聊、定时主动消息，
又不丢已经做好并测过的核心：ST 规则拼提示词、按联系人分档和换档隔离、作息与回复时机、消息调度、出口检查、Hindsight 记忆、模拟器。

10-03 的调研已经确认没有原生支持分档的框架（[2026-10-03-sillytavern-fit.md](2026-10-03-sillytavern-fit.md) 第三节），
所以评估口径不是「完全适配」，而是：**核心逻辑能不能干净地写成插件，迁移成本是否小于自建那些现成功能。**
清单共 35 项（角色格式、分档、时间与作息、消息调度、出口检查、记忆、稳定性、可测试性、现成功能、约束），外加六个钩子点：
消息进来、拼提示词、会话 key、发送前检查、发送控制、定时器。

## 范围

- 细查：AstrBot（Python 生态最大）、Koishi + ChatLuna（唯一的 TypeScript 候选）。
- 未查：MaiBot、直接读 ST 格式的小项目、LangBot、NoneBot2、其他 QQ 项目、自建用的现成组件。10-05 用户决定只看这两个。

## 对比

| | AstrBot | Koishi 本体 + 我们自己的插件 | 继续自建（对照） |
| --- | --- | --- | --- |
| 语言 | Python ≥ 3.12，插件不能用 TS | TypeScript / Node，同语言 | TypeScript / Node |
| 我们的代码 | 全部重写（`packages/` 约 7.6k 行含测试） | `packages/bot/src` 约 4.1k 行里约 70% 原样搬；`main.ts`、`config.ts` 改写，`onebot.ts` 换成官方适配器 | 不动 |
| 模拟器 | 框架没有可注入的时钟，只能在插件核心层用 Python 重建 | 不依赖框架，原样保留；假 NapCat 端到端测试也能保留 | 不动 |
| 迁移到功能一致 | 约 15–25 人天；只当前端、核心留在 Node 的折中约 4–7 人天，但两套运行时 | 约 4–5 人天 | 0 |
| 管理界面 | ✅ WebUI，按 QQ 号指定人格，按会话路由配置，改完热加载 | ✅ 控制台按 Schema 自动出表单，保存只重启这一个插件（控制台 AGPL，原样使用） | 要自己做（未调研，粗估管理页 + 热加载数天） |
| 看图 / 听语音 / 发语音 | ✅ 内置：单独的看图模型、本地 Whisper / SenseVoice、本地 GPT-SoVITS | 🧩 插件：multimodal-service（看图）、sst / vits 服务接口和对应插件 | 自己接；重活本来就在外部服务（视觉 API、Whisper、GPT-SoVITS），框架省的是胶水代码 |
| 生图 / 群聊 / 主动消息 | 🧩 / ✅ / ✅ | 🧩 / 群聊会话原生、逻辑自写 / 定时器原生、逻辑自写 | 自己做 |
| NapCat 连接 | 只支持反向 WS，NapCat 要改配置（已核对 `aiocqhttp_platform_adapter.py:45,56`） | 正向 / 反向 / HTTP 都支持，适配器自带重连 | 正向 WS（现状） |
| 断线补回 | ⚠️ 不补拉，要插件自己调 NapCat 接口（未验证） | 🔧 适配器已接好 NapCat 的 `get_friend_msg_history`（已核对 `adapter-onebot@b9d3c3c:src/bot/base.ts:62`） | 已有 |
| 默认行为冲突 | 安全模式提示词默认开启（已核对 `agent_runner.py:18`）；EULA 字面禁止色情、涉及个人隐私的内容和削弱安全机制（已核对 `EULA.md:45-48`）；遥测默认开启，上传主机名和发送者 ID 哈希（已核对 `metrics.py:198`）；历史存的是钩子改写前的回复 | 本体不规定提示词和会话；没找到遥测 | — |
| 许可证 | AGPL-3.0 + EULA；插件和框架同进程，插件要不要 AGPL 官方没说法 | 本体、适配器 MIT（已核对）；控制台 AGPL，原样使用不触发 §13；不碰 ChatLuna 就不碰它的 AGPL | 自有 |
| 活跃度 | 41.4k 星，每 1–2 周发版，373 名贡献者 | 6.2k 星；**2026 年只有 3 次提交，其中 2 次是改版本号**（已核对 `gh api`）；依赖的 cordis 3 从 2024-08 起没更新，cordis 4 还在 rc（已核对 tag） | — |
| 最大风险 | 重写成本 + 和内容限制对着干 | 框架接近停更；Node 24 没在 CI 里测过；插件要打包成 CJS | 管理界面和多模态的胶水都要自己写 |

ChatLuna 本身不合用：世界书缺二级关键词和逻辑、`@depth`、包含组，`tokenLimit` 语义和文档不一致；
导卡插件把 `exclude_recursion` 映射成了 `recursiveScan`（语义相反）；没有作息和档位隔离；拟人插件不会取消重生成、发送途中不停。
借它的组件要背上 LangChain、数据库和 AGPL，值得借的只有看图，而自己调视觉 API 也只要一天左右。详见 Koishi 报告第 2、4 节。

## 初步判断（待用户决定，写进 ADR 0008）

1. **不整体迁 AstrBot。** 功能最全，但要重写全部 TS 核心和模拟器，还要逐项关掉安全模式、遥测、内置白名单和频率限制，并和 EULA 的字面限制共存。
2. **Koishi 本体当外壳是拿到管理界面和适配器最省的路**：我们的核心本来就是依赖注入写法（responder 的 send / sleep / now / waitUntil 都由外面传入），
   Koishi 那层只有插件入口和配置 Schema。万一 Koishi 停更，退回现在的独立 `main.ts` 的成本也小。风险集中在框架维护，需要第 2 步实测来确认能不能接受。
3. **多模态不是选框架的决定因素**：看图、语音的重活在外部服务，任何路线都要部署；框架省下的是胶水和配置界面。

**用户决定（2026-10-05）：换到 Koishi。** 主会话当时的意见是先不换：管理页自建粗估 2–4 天，和迁移成本相近，又不用依赖接近停更的框架。
用户听完仍决定迁移，下个会话先写 ADR 0008，再做下面的试验和迁移。

## 第 2 步：Koishi 小试验（2026-10-05 02:00–02:30）

按 [ADR 0008](../adr/0008-koishi-runtime.md) 的试验表做。环境：`runtime/koishi-trial`（不入库）手写最小实例，
`koishi` 4.18.11、`adapter-onebot` 6.9.4、`plugin-console` 5.30.11、`config` 2.8.6、`logger` 2.6.9、`auth` 4.1.7、`database-sqlite` 4.7.0
（加上 `koishi` 自带的 `http` / `proxy-agent` / `server`），共 193 个包、27 MB；Node 24.21.0。
假 NapCat（node + `ws`，事件和 API 按 NapCat 的字段，另有 HTTP 控制口：推消息、断线、断线期间的离线消息）、假模型接口（固定回两行），
虚构联系人 10001（同学）、10002（男朋友）、10003（熟人），数据目录在会话临时目录。插件是试验用的一次性代码，
直接 import `packages/bot/src` 里的模块（`contact.ts`、`backfill.ts`、`tier-record.ts`、`lock.ts`、`log.ts` 等），不改它们。
真 bot（PID 6312）一直在跑，没有受影响。

| # | 验证什么 | 结果 |
| --- | --- | --- |
| 1 | Node 24.21 上能不能跑 | **能。** 启动到插件 apply 约 1 秒，日志里没有 Experimental / Deprecation 警告；控制台 HTTP 200。生产模式（`koishi start`）不经过 esbuild-register，PR #1553 的冲突只在开发模式 |
| 2 | ESM + `.ts` 怎么加载 | **不打包，直接加载。** loader 的 `require` 走 Node 24 的 require(esm) + 原生剥类型，插件和它 import 的 `packages/bot/src` 都是源码。一处坑：插件里 `import { Schema } from 'koishi'` 会走 koishi 的 ESM 入口，它在 `@koishijs/loader/lib/index.mjs:23` 崩（`Class extends value #<Object>`：那个文件 `import Loader from "./shared.js"`，默认导入了 CJS 的整个 `module.exports`，是上游打包问题，和 Node 版本无关）。改成 `createRequire(import.meta.url)('koishi')` 取 CJS 版（和 loader 用的是同一份），类型仍用 `import type` |
| 3 | 最小插件 | **通过。** `ctx.middleware(cb, true)` 收到的私聊带 `session.onebot`（原始 OneBot 事件），按 `isDirect` + `sub_type === 'friend'` 只放过直接私聊；群消息 `isDirect=false`、群临时会话 `sub_type=group` 都放给 `next()`；小号自己在手机上发的（`message_sent`）Koishi 不送进中间件；名单外的被忽略。回复走 `bot.sendPrivateMessage`，两条气泡按打字间隔发出，`send_private_msg` 返回的 id 记进聊天记录。中文从事件到聊天记录都正常（试验时用 Git Bash 的 curl 发中文会乱码，是 curl 的参数编码，改用 node 发就好） |
| 4 | 控制台改配置时正在等的回复 | **插件重启 + catchUp 就够，不用 `ctx.accept`。** 用控制台的 WS 接口（和网页表单保存走同一个 `manager/reload`）改名单：插件 dispose → 释放锁 → 重新 apply → 拿到锁（同一进程）→ 不重连、直接补回 → 对没回的消息 catchUp。两位联系人等着「起床后看到」，重启前后算出的时刻一样（09:43:23、09:58:34，随机延迟按消息 id 取种子）。白天冷场等 30 秒的那条，在等的中途重启：只生成一次、只回一次，时刻不变。前提是旧实例 dispose 后不能再动：试验里 dispose 后等待永不结束、发送直接报错；正式代码要给回复器加 `stop()`。保存时配置实际没变就不重启 |
| 5 | 断线补回 | **`getMessageList('private:QQ')` 能替代取数那一半。** 它对私聊调 `get_friend_msg_history`（不传 count，NapCat 默认 20 条，和现在一样），返回的消息有 `id`、`timestamp`、`user.id`、`elements`，喂给原来的 `findMissed` 就行（去重、换档下限都不变）。启动时补回 2 条并回复一次。**但断线后适配器不会自己重连**，见下 |
| 6 | 密钥和登录 | `koishi.yml` 里 `token: ${{ env.X }}`，控制台显示的是模板，保存别的插件后文件里仍是模板。开 `auth` 后：不登录看不到配置、保存返回 unauthorized，密码错也一样，对了才能改；管理员密码同样用 `${{ env.X }}`。**坑：保存带模板的那个插件本身时，正在运行的插件拿到的是模板原文**，见下 |

**试验发现的上游问题（都不改上游源码，在我们的插件里绕开）**

1. **正向 WS 断线后不重连**（adapter-onebot 6.9.4 + `@satorijs/core` 4.6.0）。连接关闭时 satori 先把状态设成「重连中」、排了 5 秒后重试，
   随后适配器自己的 close 处理（`lib/index.js:681-683`）调 `bot.offline()`，5 秒后重试检查 `getActive()` 为假就放弃了（`@satorijs/core/lib/index.cjs:622-638`）。
   试验里断开后 3 分钟没有任何重连。上游 PR #81（2026-08-23 提出，未合并）描述的就是这个，还提到重试次数用完后不会转入每分钟一次的慢重试。
   绕法：插件监听 `login-updated`，OneBot 的 bot 变成离线后按 5 / 10 / 30 / 60 秒退避调 `bot.start()`（用 `ctx.setTimeout`，插件卸载时自动清掉）。
   验证：断开并拒绝连接 12 秒，期间对方发了 2 条；5 秒后重启连接、被拒 2 次、第 3 次连上，补回 2 条、回复一次。
   断线那一刻正在发的回复报 `this._request is not a function`（上游 issue #74），走原来的「1 分钟后再试」，重连后的 catchUp 让这次再试作废，没有重复发送。
2. **按引用比 bot 不可靠**：`ctx.bots.includes(bot)` 为假，同一个适配器实例前后拿到的 bot 也不 `===`（cordis 的代理）；控制台重载适配器后旧 bot 已作废，
   对它 `start()` 报 `cannot create effect on inactive context`。要每次按 `bot.sid` 从 `ctx.bots` 里找当前的。
3. **控制台保存时不做 `${{ }}` 插值**：`Loader.reload` 对已运行的插件直接 `fork.update(原始配置)`（`@koishijs/loader/lib/shared.js:298`），
   只有新建插件时插值（`:279`）。所以在控制台里保存 adapter-onebot（或 auth）的表单后，适配器拿到的 token 是 `${{ env.QQBOT_ONEBOT_TOKEN }}` 这串字，
   NapCat 拒绝（试验里假 NapCat 记下 bad token），直到整个 Koishi 重启。文件里一直是模板，重启后就好。我们自己插件的配置里没有密钥（模型 key 在代码里读环境变量），不受影响。
   做法：这两个插件的配置不在控制台改；要改就改完重启 Koishi。
4. **数据目录跟着进程的工作目录走**：`database-sqlite` 的 `data/koishi.db`、`logger` 的日志都相对 `process.cwd()`，不是配置文件所在目录。
   工作目录里没有 `package.json` 时 loader 打一条「failed to migrate manifest」警告，不影响运行。

**来源核对**：`npm audit signatures`，193 个包都有有效的 npm 仓库签名，21 个带来源证明。`npm audit` 报 2 个中危：`file-type` 16.5.4（`plugin-http` 用来认下载内容的类型，ASF 解析死循环）、
`uuid` 8.3.2（控制台用，v3/v5/v6 传入 buf 时缺边界检查），都不在我们用到的路径上。

**对 ADR 0008 的影响**：加载不用打包；但插件要和 loader 用同一份 `koishi`，所以 Koishi 的依赖和插件放在同一个 `node_modules` 根下最省事（试验就是这样），
见 ADR 0008「试验之后的调整」。

## 未验证

- AstrBot 没运行过，结论来自源码和文档；Koishi 第 2 步试验跑过（见上一节），其余结论同样来自源码和文档。
- AstrBot：历史存改写前回复、改 `session_id` 做档位 key、`stop_all` 能否立刻中断请求、补拉的绕法。
- Koishi：发 `h.audio` 时 NapCat 是否自动转 silk、Koishi 5 的时间表；连接悄悄断掉（没有 close 事件）时适配器能否发现（上游 issue #57，旧 `onebot.ts` 也没有心跳检测）。
- ChatLuna 世界书正则带 `g` 标志可能漏匹配、`findMessageIndex` 把 personality 写成 description，都是读源码看出的疑似 bug。
- AGPL §13 对「QQ 好友通过 QQ 与机器人交互」是否适用，属于法律问题，没有结论。
