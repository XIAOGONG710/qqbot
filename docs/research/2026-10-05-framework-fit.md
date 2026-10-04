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

## 第 2 步：Koishi 小试验（未开始）

在 `runtime/` 装 Koishi 4.18（不进仓库），用 adapter-onebot 正向 WS 连假 NapCat，不碰真 QQ 号。验证：

1. Koishi 4.18 能否在 Node 24.21 上正常跑；
2. 我们的 ESM + 原生 TS 模块怎么加载：直接加载还是 esbuild 打成 CJS；
3. 写一个最小插件：按 QQ 号选档位和卡，调现有的拼提示词和 responder，回复经适配器发出；
4. 控制台里改白名单 / 档位，看热加载时正在等待的「看到时机」定时器怎么处理；
5. 断线补回：假 NapCat 实现 `get_friend_msg_history`，看 `bot.getMessageList` 能否替代现在的 `backfill.ts`。

预计半天。结果写回本文，再写 ADR 0008。

## 未验证

- 所有候选都没运行过，结论来自源码和文档。
- AstrBot：历史存改写前回复、改 `session_id` 做档位 key、`stop_all` 能否立刻中断请求、补拉的绕法。
- Koishi：Node 24 兼容性、原生 TS 加载、发 `h.audio` 时 NapCat 是否自动转 silk、Koishi 5 的时间表。
- ChatLuna 世界书正则带 `g` 标志可能漏匹配、`findMessageIndex` 把 personality 写成 description，都是读源码看出的疑似 bug。
- AGPL §13 对「QQ 好友通过 QQ 与机器人交互」是否适用，属于法律问题，没有结论。
