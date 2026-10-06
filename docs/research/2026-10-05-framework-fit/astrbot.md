# AstrBot 框架适配调研

> 调研对象：AstrBot（https://github.com/AstrBotDevs/AstrBot ）
> 只读调研：调研时浅克隆到临时目录（未入库），未安装依赖、未运行。汇总与抽查见 [../2026-10-05-framework-fit.md](../2026-10-05-framework-fit.md)。
> 出处格式：`仓库@短hash:路径:行号`；文档出处标「（文档）」；插件市场数据来自 `AstrBotDevs/AstrBot_Plugins_Collection` 和 `gh api`。

## 1. 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | AstrBotDevs/AstrBot（默认分支 `master`） |
| 调研 commit | `42972e9`（42972e932a64f01d96e2e0708579b0f79dd6f792，2026-10-04 13:09 +0800） |
| 版本 | `pyproject.toml` 写 `4.29.0-beta.1`；最新 release `v4.29.0-beta.1`（2026-10-01），上一个稳定版 `v4.28.2`（2026-09-27），大约每 1–2 周发一版 |
| 许可证 | AGPL-3.0（`LICENSE`），另有 `EULA.md`（最后更新 2026-01-12，含内容使用限制，见 J5） |
| 星数 / fork | 41,396 / 3,016 |
| 最近推送 | 2026-10-04T05:09:17Z |
| 贡献者 | 373（不含匿名；含匿名 379） |
| issue | open issue 1,109，open PR 487；2026-09-01 起新开 issue 139 个，已关 65 个 |
| 技术栈 | Python ≥ 3.12（`AstrBot@42972e9:pyproject.toml:7`），asyncio；WebUI 后端为 FastAPI 路由（`astrbot/dashboard/api/*`），前端在 `dashboard/` |
| 取数时间 | 2026-10-04T17:18Z（仓库数据）、2026-10-04T17:27Z（插件星数） |

issue 响应抽样：最近 11 个 issue（10-03 到 10-04）里 7 个有人回复，多在 1 小时内，但首个回复大多来自普通用户（author_association=NONE），只有 2 个来自 CONTRIBUTOR；其余 4 个暂时没人回。

## 2. 打分表

| 编号 | 打分 | 说明 | 出处 |
| --- | --- | --- | --- |
| A1 角色卡 V2 | 🧩 | 本体没有导入角色卡的功能：人格（Persona）只有 `system_prompt / begin_dialogs / tools / skills` 这几个字段，源码里搜不到 `chara_card`。插件：**komeiji_tavern**（KomeijiDono/astrbot_plugin_komeiji_tavern，2★，AGPL，最近推送 2026-09-06）能识别 `chara_card` spec；LKarxa/astrbot_plugin_SillyTavern_card（10★，最近推送 2025-04-26，无许可证，把 PNG 卡转成 Lorebook YAML） | `AstrBot@42972e9:astrbot/core/db/po.py:150-176`；`komeiji_tavern@d21a0b4:importers.py:52-53` |
| A2 世界书 | 🧩 / 🔧 | komeiji_tavern 声称支持主/次关键词、正则、递归、概率、Sticky、Cooldown、Delay、深度注入（文档）；Zhalslar/astrbot_plugin_worldbook（57★，GPL-3.0，2026-08-11，注入到 system_prompt）；Raven95676/astrbot_plugin_lorebook_lite（20★，AGPL，2026-03-31）。自己按 ST 语义实现：在 `on_llm_request` 里改写 `req.contexts`，任意深度都能插入 | komeiji `README.md:16`（文档）；`AstrBot@42972e9:astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py:303` |
| A3 示例对话、宏 | ⚠️ / 🧩 | 本体的 `begin_dialogs` 是作为伪历史插到上下文开头的（标了 `_no_save`），不是 ST 的 `mes_example` 规则，已有 issue #10369 反映它造成的时序问题；本体没有 `{{char}}`/`{{user}}` 宏。komeiji_tavern 有 `macros.py` | `AstrBot@42972e9:astrbot/core/astr_main_agent.py:575-576`；`astrbot/core/persona_mgr.py:479`；`komeiji_tavern@d21a0b4:macros.py:13` |
| A4 卡内正则脚本 | 🔧 | 在 `on_llm_response` 里改 `resp.completion_text`，或在 `on_decorating_result` 里改结果链。komeiji_tavern 源码里没找到处理 `regex_scripts` 的代码。注意：历史记录存的是钩子运行前的原文（见第 6 节） | `AstrBot@42972e9:astrbot/core/astr_agent_hooks.py:23-41`；`astrbot/core/pipeline/result_decorate/stage.py:158-189` |
| B1 按联系人选卡 | ✅ + 🔧 | 本体：WebUI「会话管理」能按 UMO（即单个 QQ 号的私聊）强制指定人格，用的是 `session_service_config.persona_id`；还能按 UMO 通配把会话路由到不同的配置文件，每个配置文件有自己的默认人格、模型和启用插件。「QQ → 档位 → 卡」这层映射要写插件 | `AstrBot@42972e9:astrbot/core/persona_mgr.py:140-151`；`astrbot/dashboard/services/session_management_service.py:16-23,244-261`；`astrbot/core/umop_config_router.py:52-60` |
| B2 换档隔离 | 🔧 | 一个 UMO 下可以有多条对话（conversation），每条可以带 `persona_id`。插件按「QQ + 档位」记一个 conversation id，换档时调 `new_conversation(umo, persona_id=…)` 或 `switch_conversation`，历史就隔离了。另一种绕法 ⚠️：在插件里改 `event.session_id`，让 UMO 变成 `…:QQ#档位`（内置的 unique_session 就是这么改的），默认发送仍发给原发送者；但用 UMO 主动发消息（`send_message`）会把 `QQ#档位` 当成 QQ 号，发不出去 | `AstrBot@42972e9:astrbot/core/conversation_mgr.py:92-137`；`astrbot/core/platform/astr_message_event.py:116-124`；`astrbot/core/pipeline/waking_check/stage.py:88-91`；`astrbot/core/platform/sources/aiocqhttp/aiocqhttp_message_event.py:184-188` |
| B3 名单外好友 | 🔧 | 插件里判断即可；也可以把名单外的人路由到另一个配置文件。内置的 `id_whitelist` 在插件之前执行，必须关掉或配合使用 | `AstrBot@42972e9:astrbot/core/pipeline/whitelist_check/stage.py:35-70`；`astrbot/core/pipeline/stage_order.py:3-13` |
| C1 时间注入 | ✅ / 🔧 | `datetime_system_prompt` 默认开启，按时区（默认 Asia/Shanghai）把当前时间以 `<system_reminder>` 的形式附在用户消息后。「距上条消息多久」本体没有，要插件在 `on_llm_request` 里补 | `AstrBot@42972e9:astrbot/core/config/default.py:157,318`；`astrbot/core/astr_main_agent.py:985-1003` |
| C2 她现在在做什么 | 🔧（🧩 有近似插件） | 在 `on_llm_request` 里注入。现有插件都是让 LLM 生成作息，不是按卡里的课表算：muyouzhi6/astrbot_plugin_life_scheduler（29★，MIT）、Hola-Gracias/astrbot_plugin_dynamic_life_state（4★）、menglimi/astrbot_plugin_private_companion（381★） | 插件元数据见第 3.7 节 |
| C3 看到时机 / 打字速度 | 🔧 | 每条消息事件都在自己的 asyncio task 里跑，消息监听里 `await asyncio.sleep()` 等几分钟不会挡住别的会话；每个气泡的延时放在自己的发送循环里。本体的分段间隔只有随机区间或 `log(字数)` 两种 | `AstrBot@42972e9:astrbot/core/event_bus.py:39-54`；`astrbot/core/pipeline/respond/stage.py:119-128` |
| C4 不回 | 🔧 | 消息监听里 `event.stop_event()` 就不会触发默认的 LLM 调用 | `AstrBot@42972e9:astrbot/core/pipeline/process_stage/method/star_request.py:36-52`；`astrbot/core/pipeline/process_stage/stage.py:56-66` |
| D1 连发合并 | 🧩 / 🔧 | 有防抖插件：advent259141/astrbot_plugin_debounce（65★，AGPL，2026-09-10，用模型判断对方说完没有）；aliveriver/astrbot_plugin_continuous_message（43★，AGPL，2026-09-06），做法是 `event_message_type(ALL, priority=50)` 监听，先到的事件静默，最后一个事件重写成合并后的消息；FreeDivers/astrbot_plugin_combine-messages（21★）。本体行为：同一 UMO 的请求被会话锁串行，每条消息各回一次；内置的 follow-up 只在 agent 调工具的循环里把新消息塞进工具结果 | `continuous_message` `main.py:362`（gh api 读取）；`AstrBot@42972e9:astrbot/core/pipeline/process_stage/follow_up.py:176-218`；`astrbot/core/agent/runners/tool_loop_agent_runner.py:697-740` |
| D2 生成中来新消息 | ⚠️ / 🔧 | 本体不会取消后重新生成。插件可以调 `active_event_registry.stop_all(umo, exclude=新事件)`（内置 `/stop` 指令就是这么做的）停掉旧事件、请求 agent 中止，再把旧消息并进新事件。这是内部 API，`astrbot.api` 没导出；agent 的中止是协作式的，每 0.5 秒检查一次 | `AstrBot@42972e9:astrbot/core/utils/active_event_registry.py:113-170`；`astrbot/builtin_stars/builtin_commands/commands/conversation.py:140-160`；`astrbot/core/astr_agent_run_util.py:359-364` |
| D3 分气泡 / 中途插话 | ✅（分条）+ 🔧（中途取消） | 本体分段回复：按正则或分隔词拆分，逐段 sleep 后发送，但段与段之间不检查有没有新消息。要中途取消，就在 `on_decorating_result` 里接管发送：清空结果链，用自己的循环 `event.send()` 并检查取消标志。komeiji_tavern 的 `deliver_qq_long_reply` 就是这样接管发送的 | `AstrBot@42972e9:astrbot/core/pipeline/result_decorate/stage.py:208-267`；`astrbot/core/pipeline/respond/stage.py:283-311`；`komeiji_tavern@d21a0b4:main.py:785-800` |
| E1 出口检查 | 🔧 | `on_llm_response` 能改写 `completion_text`，`on_decorating_result` 能改写或清空结果链、能 `stop_event`。本体没有「要求重新生成」的信号，重生成要插件自己调 `context.llm_generate()` 或 `tool_loop_agent()` | `AstrBot@42972e9:astrbot/core/astr_agent_hooks.py:31-35`；`astrbot/core/star/context.py:174-216` |
| F1 记忆按联系人+档位隔离 | 🔧（🧩 可参考） | 插件在 `on_llm_request` 里 recall、在 `on_llm_response` 或 `after_message_sent` 里 retain，bank 由插件自己算。可参考 wjiajian/astrbot_plugin_hindsight_memory（1★，无许可证，2026-08-10，对接的是 Hindsight Cloud，用 tag 划分作用域，挂在 `on_llm_request` 和 `on_llm_response`） | `astrbot_plugin_hindsight_memory` `main.py:62,103`（gh api 读取） |
| F2 接外部记忆服务 | 🔧 / 🧩 | 本体没有可替换的记忆接口（自带的只有群聊上下文和知识库 RAG），外部记忆一律通过钩子接入。记忆插件很多：livingmemory（349★）、mnemosyne（254★，Milvus）、angel_memory（188★）、memos_integrator、openviking_memory 等 | 第 3.7 节 |
| G1 断线补回 | ⚠️ | 不补拉。适配器只做反向 WS 服务端，`on_websocket_connection` 只打一行日志。可能的绕法（未验证）：插件拿 `platform.get_client()`（CQHttp），自己注册连接回调或定时调用 NapCat 的历史消息 API，再把消息作为事件投进队列 | `AstrBot@42972e9:astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py:105-107,512` |
| G2 失败重试 | ⚠️ | LLM 请求：tenacity 指数退避，重试次数 `request_max_retries` 默认 5，供应商超时默认 120 秒，支持备用供应商。连接：AstrBot 是 WS 服务端，重连归 NapCat 管。我们「3 秒超时 + 4 次快速重试 + 1 分钟 / 5 分钟」的策略配不出来，要插件自己发请求或注册自定义 Provider | `AstrBot@42972e9:astrbot/core/provider/sources/request_retry.py:75-101`；`astrbot/core/provider/sources/openai_source.py:362`；`astrbot/core/star/context.py:816` |
| H1 可测试性 | ⚠️ | 没有可注入的时钟，核心直接调 `datetime.now()` / `time()`。现有测试是 pytest 加 fixtures/mocks；插件钩子可以拿假事件直接调用（komeiji_tavern 的测试就是这么写的）；Open API 的 `/chat` 和 `/chat/ws`（走 webchat）能用真模型脚本化端到端测试，但用不了虚拟时钟。我们的模拟器要用 Python 围绕插件核心重写 | `AstrBot@42972e9:astrbot/core/astr_main_agent.py:985-994`；`astrbot/dashboard/api/open_api.py:173,286`；`tests/fixtures/mocks` |
| I1 管理界面 | ✅ | WebUI 能管人格、对话、会话规则、多配置文件及路由、供应商、插件（市场 / 安装 / 配置 / 重载）、定时任务、知识库、日志。保存配置会重建该配置的流水线，属于热加载；保存插件配置会重载插件；插件可以带自定义 WebUI 页面（`views/`，iframe + bridge，文档）。`ASTRBOT_RELOAD=1` 时监听文件变化，自动重载插件。档位白名单可以做成插件的 `_conf_schema.json` 或自定义页面 | `AstrBot@42972e9:astrbot/dashboard/services/config_service.py:813,1172-1191`；`astrbot/core/core_lifecycle.py:472-485`；`astrbot/core/star/star_manager.py:222-228`；`docs/zh/dev/star/guides/plugin-pages.md`（文档） |
| I2 看图 | ✅ | `default_image_caption_provider_id` 可以单独配一个视觉模型来描述图片（主模型不支持看图时用）；也能自动切到支持图片的备用供应商 | `AstrBot@42972e9:astrbot/core/config/default.py:140`；`astrbot/core/astr_main_agent.py:707,1747,1378` |
| I3 听语音 | ✅（可本地） | STT 供应商：`whisper_selfhosted`（本地 openai-whisper）、`sensevoice_selfhosted`（本地 funasr_onnx）、Whisper API、Xinference、MiMo；有 silk 与 wav 互转；预处理阶段把语音转成文字后插件才看到 | `AstrBot@42972e9:astrbot/core/provider/sources/whisper_selfhosted_source.py:15`；`sensevoice_selfhosted_source.py:10,21`；`astrbot/core/utils/media_utils.py:36-37`；`astrbot/core/pipeline/preprocess_stage/stage.py:220-280` |
| I4 发语音 | ✅（可本地） | `gsv_tts_selfhost`（标注为「GPT-SoVITS TTS(本地加载)」，默认请求 `127.0.0.1:9880`）、GSVI、Genie TTS（本地 ONNX）、Edge、OpenAI 兼容 TTS、Azure、DashScope（云端 CosyVoice）等；wav 转 silk 后发出。本地 CosyVoice 只能包一层 OpenAI-TTS 兼容接口再接 ⚠️ | `AstrBot@42972e9:astrbot/core/provider/sources/gsv_selfhosted_source.py:15-30`；`genie_tts.py:17-40`；`astrbot/core/utils/media_utils.py:670-678`；`result_decorate/stage.py:269-330` |
| I5 生图 | 🧩 | Provider 类型里没有生图。插件：diaomin66/astrbot_plugin_omnidraw（72★，2026-10-01，有人设自拍）、muyouzhi6/astrbot_plugin_gitee_aiimg（78★）、ComfyUI / SD 类插件若干 | `AstrBot@42972e9:astrbot/core/provider/entities.py:33-38` |
| I6 群聊 | ✅ / 🧩 | 本体有群聊上下文感知、按概率主动回复、unique_session（群里按人隔离会话）。插件：group_chat_plus（145★）、angel_heart（134★）、Heartflow（88★） | `AstrBot@42972e9:astrbot/core/config/default.py:235-247`；`astrbot/builtin_stars/astrbot/group_chat_context.py` |
| I7 定时 / 主动消息 | ✅ / 🧩 / 🔧 | 本体有 `CronJobManager`：插件可注册 basic job；LLM 可以用 cron 工具自己建「主动任务」（`add_cron_tools` 默认开启），WebUI 有定时任务页。插件：proactive_chat（现在在 Pancakes-Labs 名下，405★，2026-10-04）、private_companion（381★）、Conversa（36★） | `AstrBot@42972e9:astrbot/core/cron/manager.py:100-204,425-520`；`astrbot/core/config/default.py:178-180`；`docs/zh/use/proactive-agent.md`（文档） |
| J1 Windows | ✅ | 官方有 AstrBot Launcher（Windows x64/arm64 安装包）、AstrBot-desktop，也能用 uv 部署（文档） | `docs/zh/deploy/astrbot/launcher.md:5-11`、`desktop.md:3`（文档） |
| J2 NapCat / OneBot 11 | ✅（只支持反向 WS） | `aiocqhttp` 适配器在核心仓库里，由 AstrBot 团队维护，文档推荐 NapCat。**只支持反向 WebSocket**（AstrBot 当服务端），和我们现在用的正向 WS 相反，NapCat 那边要改成 WS 客户端。依赖的 nonebot/aiocqhttp 库最近一次推送是 2023-06 | `AstrBot@42972e9:astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py:30-62`；`docs/zh/platform/aiocqhttp.md:8-12,43-44`（文档） |
| J3 OpenAI 兼容 | ✅ | `openai_source` 支持 OpenAI 兼容接口，配置模板里内置 DeepSeek 预设（`api.deepseek.com/v1`） | `AstrBot@42972e9:astrbot/core/config/default.py:1466-1473` |
| J4 数据留本地 | ⚠️ | 数据存在本地 SQLite。**匿名遥测默认开启**：发往 `tickstats.soulter.top`，内容包括版本、操作系统、Python 版本、**主机名**、安装 ID、模型名、供应商类型、适配器名、**发送者 ID 的 BLAKE2 哈希**；设 `ASTRBOT_DISABLE_METRICS=1` 或配置 `disable_metrics` 可关。另外会拉取公告、插件市场和更新信息（api.soulter.top / astrbot.app）。默认还开着「安全模式」提示词（见 J5） | `AstrBot@42972e9:astrbot/core/utils/metrics.py:28-37,192-205`；`astrbot/core/platform/astr_message_event.py:483-497`；`internal.py:464-470`；`astrbot/core/config/default.py:327` |
| J5 许可证 | ⚠️ | AGPL-3.0，另有 EULA，详见第 2.1 节 | `LICENSE`；`EULA.md` |
| J6 技术栈与插件机制 | ⚠️（不能用 TS） | 只能用 Python 写插件：继承 `Star` 的类加 `astrbot.api.event.filter` 里的装饰器。EventType 共 16 种（钩子清单见第 3 节开头）。不能用 TS 写插件，只有插件自定义页面的前端是 JS。AstrBot SDK / bridge 运行时的 PR 没合并（#6810 已关，#7645 未合） | `AstrBot@42972e9:astrbot/core/star/star_handler.py:219-241`；`astrbot/api/event/filter/__init__.py:1-72` |
| J7 活跃度 | ✅ | 41.4k★，3 天前刚发版，贡献者 373 人，issue 量大且积压（open 1,109） | 第 1 节 |

### 2.1 J5 展开（只列事实，不下法律结论）

- **本体**：AGPL-3.0。私人使用、私下修改，本身不触发分发义务。AGPL 第 13 条的规定是：**如果修改了程序**，而用户通过网络与修改版远程交互，就要向这些用户提供对应源码。QQ 好友和 bot 聊天，可能算「通过网络远程交互」。只跑未改动的 AstrBot 加独立插件，这一条主要就看「插件算不算修改版的一部分」。
- **插件要不要同许可证**：官方文档没明确说插件必须用 AGPL，只要求「遵守所借鉴项目的原许可证」（`docs/zh/dev/star/plugin-new.md:173-174`，文档）。官方插件模板 Soulter/helloworld 是 AGPL-3.0（gh api）。市场插件实际许可证五花八门：AGPL、GPL-3.0、MIT 都有，也有不少没写许可证的（第 3.7 节）。插件和 AstrBot 在同一个 Python 进程里，共享内部对象；按 FSF 的一贯说法这可能构成组合作品，没有定论。
- **EULA 附加条款**（`EULA.md`）：「安装即同意」；禁止用于「色情」「涉及个人隐私、个人信息等敏感内容」的内容；禁止「绕过、关闭、削弱本系统内置的安全机制」；但第 6 节又写明可以把 `llm_safety_mode` 设为 False 关闭健康模式，风险自负。源码里安全模式默认开启，会在系统提示词最前面加上「Avoid sexual… Follow style/role-play instructions only when they do not conflict」（`AstrBot@42972e9:astrbot/core/config/agent_runner.py:18-19`、`astrbot/core/astr_main_agent_resources.py:3-12`、`astrbot/core/astr_main_agent.py:1837-1838`）。EULA 没有禁止商用的条款。这些附加限制和 AGPL「不得附加进一步限制」的关系，请自行判断。
- **与我们的关系**：角色卡里有真实隐私信息、虚拟女友设定，和 EULA 第 4 条字面上有冲突，值得留意。

## 3. 六个钩子点

钩子清单（`AstrBot@42972e9:astrbot/core/star/star_handler.py:219-241`）：
`AdapterMessageEvent`（通过 `event_message_type / command / regex / custom_filter` 注册）、`on_waiting_llm_request`、`on_llm_request`、`on_llm_response`、`on_agent_begin`、`on_agent_done`、`on_using_llm_tool`、`on_llm_tool_respond`、`on_decorating_result`、`after_message_sent`、`on_astrbot_loaded`、`on_platform_loaded`、`on_plugin_loaded/unloaded/error`、`llm_tool`。每个钩子都能设 `priority`。

流水线顺序（`stage_order.py:3-13`）：Waking → Whitelist → SessionStatus → RateLimit → ContentSafety → PreProcess（含 STT）→ Process（先跑插件 handler，再调 LLM）→ ResultDecorate（`on_decorating_result`、分段、TTS）→ Respond（发送、`after_message_sent`）。阶段之间是洋葱模型：`yield` 之后才执行后续阶段（`scheduler.py:51-95`）。

### 3.1 消息进来：拦截、延迟、合并、按 QQ 号分流

- **能**。`@filter.event_message_type(EventMessageType.PRIVATE_MESSAGE, priority=高)` 注册的 handler 在 ProcessStage 里、默认 LLM 调用之前执行（`process_stage/stage.py:28-66`、`star_request.py:23-74`）。
- 每条事件一个 `asyncio.create_task`（`event_bus.py:52`），所以 handler 里 `await asyncio.sleep()` 只拖住这一条事件。`event.stop_event()` 丢弃事件；改 `event.message_str` 或 `message_obj` 就能合并消息。现成的防抖插件就是这么做的（`continuous_message main.py:362`，事件静默和重写见该文件 169-252 行）。
- 按 QQ 号分流：handler 里用 `event.get_sender_id()` 判断；本体也能按 UMO 通配把会话路由到不同配置文件（`umop_config_router.py:52-60`），还能按会话启停插件（`session_plugin_config`，`session_management_service.py:16-23`）。
- 另有 `on_waiting_llm_request`（`internal.py:225`）：在拿会话锁之前触发，适合检测「生成中又来了新消息」。
- 注意：内置白名单（`whitelist_check/stage.py:35-70`）和频率限制（默认 60 秒 30 条，`default.py:96-100`）在插件**之前**执行。

### 3.2 拼提示词：能否完全替换

- **能**。`@filter.on_llm_request(priority=-1000)` 拿到的是 AstrBot 已经拼好的 `ProviderRequest`（人格、历史、安全模式提示词、时间提醒、工具都已加上，`internal.py:264-303`）。插件可以整个覆盖 `req.system_prompt / req.contexts / req.prompt / req.func_tool / req.model`。agent runner 的 `reset` 在钩子**之后**才执行（`internal.py:320-323`；runner 在 `tool_loop_agent_runner.py:314-327` 用 `req.contexts`、`req.prompt`、`req.system_prompt` 组装 messages），所以改动一定生效。**komeiji_tavern 就是在这个钩子里整体替换这三个字段**（`komeiji_tavern@d21a0b4:main.py:204-220`）。
- 另一条路：handler 直接 `yield event.request_llm(prompt, system_prompt=…, contexts=…, conversation=None)`（`astr_message_event.py:425-481`、`process_stage/stage.py:40-46`）。`conversation=None` 时不注入人格（`astr_main_agent.py:552-553`），也不写历史（`internal.py:508`）。
- 坑：
  1. 插件塞进 `req.contexts` 的内容会和本轮一起**写进对话历史**，除非是 user/assistant 角色并标了 `_no_save`，或者把 `req.conversation` 设成 None、历史自己管（`internal.py:508-519`）。
  2. 默认会追加 cron 工具和 send_message 工具，以及对应的工具说明提示词（`astr_main_agent.py:1863-1873,1915-1937`），要在钩子里清掉，或在配置里关闭。
- 只想按会话指定人设、不接管拼装：会话规则里的人格，或对话自带的 `persona_id`，都是本体功能（`persona_mgr.py:123-198`）。

### 3.3 会话 key

- UMO = `{platform_id}:{FriendMessage|GroupMessage}:{session_id}`（`message_session.py:18-19`）。aiocqhttp 私聊的 session_id 是 QQ 号；群聊是群号，开了 unique_session 则是 `{发送者}_{群号}`（`aiocqhttp_platform_adapter.py:222-226`、`waking_check/stage.py:88-91`）。
- 「联系人 + 档位」有两种做法：
  - **推荐 🔧**：UMO 不动，按档位切换 conversation（`conversation_mgr.py:92-137`）。历史按 conversation 隔离，WebUI 也能看到每条对话。
  - **绕法 ⚠️**：插件改 `event.session_id`（setter 在 `astr_message_event.py:121-124`），之后的会话锁、对话、配置查找都用新 key；aiocqhttp 回复仍发给原发送者（`aiocqhttp_message_event.py:184-188`）。代价是 `context.send_message(umo)` 会把 `QQ#档位` 当成 QQ 号，主动消息要另外处理；而且白名单和配置路由已经按原 UMO 执行过了。

### 3.4 模型返回后、发送前：检查、改写、重新生成

- `on_llm_response(event, resp)`：runner 结束时触发（`tool_loop_agent_runner.py:182-206` 调 `astr_agent_hooks.py:31-35`）。改了 `resp.completion_text`，发出去的就是改后的文本，因为消息链在钩子之后才用它生成（`tool_loop_agent_runner.py:938-946`）。
- `on_decorating_result(event)`：发送前触发（`result_decorate/stage.py:158-189`），能改写或清空 `event.get_result().chain`，也能 `stop_event`。
- **没有内置的「重新生成」**：要插件自己用同样的上下文调 `self.context.llm_generate()`（`context.py:174-216`），再替换结果。注意 assistant 消息在钩子运行之前就已追加到 `run_context.messages`（`tool_loop_agent_runner.py:196-199`），历史里存的是原文；要存改后的版本，得在 `on_agent_done` 里同步改 `run_context.messages[-1]`。

### 3.5 发送：分条、延时、中途取消

- 本体分段：`result_decorate/stage.py:208-267` 负责拆，`respond/stage.py:283-311` 逐段 sleep 再 `event.send`，**中间不检查取消**。
- 接管：在 `on_decorating_result` 里取出结果链并清空，自己循环发送 `event.send(MessageChain)`，按字数 sleep，每段之前看一眼取消标志。komeiji_tavern 用这个钩子接管长回复的发送（`main.py:785-800`）。
- 有个对我们有利的时序：非流式时，agent 阶段在**持有会话锁**的情况下 `yield`（`internal.py:238` 的 `async with` 包住了 `425-434` 行的 `yield`），所以发送阶段一直占着同一 UMO 的锁。对方插话时，新事件的消息 handler 和 `on_waiting_llm_request` 不需要这把锁，可以先跑、设取消标志；新一轮生成则要等旧的发送循环退出、锁释放后才开始。

### 3.6 定时器：插件注册定时任务、主动发消息

- `self.context.cron_manager.add_basic_job(name=…, cron_expression=…, handler=…, persistent=False)`（`cron/manager.py:148-173`；`context.py:170` 暴露了 `cron_manager`）。也可以在插件 `initialize()` 里自己起 asyncio 后台任务（`context.py:909-925` 的弃用说明就建议这么做）。
- 主动发消息：`await self.context.send_message(umo, MessageChain)`（`context.py:645-703`）。
- 本体自带「主动型 agent」：LLM 通过 cron 工具自己设提醒，到时间由 `_woke_main_agent` 唤醒，并带上会话历史（`cron/manager.py:389-520`）。

### 3.7 插件市场里和我们相关的插件

市场共 1,329 个插件（`plugin_cache_original.json`，这份缓存约为 2026-07-29 的快照）。下表星数和推送日期是 2026-10-04T17:27Z 用 `gh api` 现取的。

| 类别 | 插件（链接） | 星 | 最近推送 | 许可证 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 酒馆 | [KomeijiDono/astrbot_plugin_komeiji_tavern](https://github.com/KomeijiDono/astrbot_plugin_komeiji_tavern) | 2 | 2026-09-06 | AGPL-3.0 | **不在市场缓存里**，另有人细查。**挂载点**：核心是 `on_llm_request(priority=-1000)`，整体替换 `req.system_prompt / contexts / prompt`；另外用了 `on_agent_begin`、`on_agent_done`（-1000）、`on_llm_response`（-1000，清理思考标签）、`on_decorating_result`（-1000，QQ 长回复分块直发或转成合并转发）、`after_message_sent`（1000）以及 `/tavern` 指令（`main.py:204,361,466,578,728,785,1338`） |
| 酒馆 | [LKarxa/astrbot_plugin_SillyTavern_card](https://github.com/LKarxa/astrbot_plugin_SillyTavern_card) | 10 | 2025-04-26 | 无 | PNG 卡转 Lorebook YAML，久未更新 |
| 酒馆 | [LKarxa/prompt_tools](https://github.com/LKarxa/prompt_tools) | 7 | 2025-05-24 | 无 | 「兼容酒馆预设」 |
| 世界书 | [Zhalslar/astrbot_plugin_worldbook](https://github.com/Zhalslar/astrbot_plugin_worldbook) | 57 | 2026-08-11 | GPL-3.0 | 命中触发条件后注入 system_prompt |
| 世界书 | [Raven95676/astrbot_plugin_lorebook_lite](https://github.com/Raven95676/astrbot_plugin_lorebook_lite) | 20 | 2026-03-31 | AGPL-3.0 | 支持触发器、变量、逻辑 |
| 长期记忆 | [lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory) | 349 | 2026-10-02 | AGPL-3.0 | 完整的记忆生命周期 |
| 长期记忆 | [lxfight/astrbot_plugin_mnemosyne](https://github.com/lxfight/astrbot_plugin_mnemosyne) | 254 | 2026-09-15 | AGPL-3.0 | 基于 Milvus |
| 长期记忆 | [kawayiYokami/astrbot_plugin_angel_memory](https://github.com/kawayiYokami/astrbot_plugin_angel_memory) | 188 | 2026-09-15 | NOASSERTION | 人格演化 + 记忆 |
| 长期记忆 | [wjiajian/astrbot_plugin_hindsight_memory](https://github.com/wjiajian/astrbot_plugin_hindsight_memory) | 1 | 2026-08-10 | 无 | **对接 Hindsight**（Cloud 版），挂在 `on_llm_request` 和 `on_llm_response` |
| 长期记忆 | [zouyonghe/astrbot_plugin_agentmemory](https://github.com/zouyonghe/astrbot_plugin_agentmemory) | 9 | 2026-05-25 | 无 | 外部记忆服务、按发送者隔离，结构上和我们接 Hindsight 一样 |
| 主动消息 | [Pancakes-Labs/astrbot_plugin_proactive_chat](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat)（原 DBJD-CR） | 405 | 2026-10-04 | AGPL-3.0 | 有上下文感知、免打扰时段、TTS |
| 主动 + 作息 | [menglimi/astrbot_plugin_private_companion](https://github.com/menglimi/astrbot_plugin_private_companion) | 381 | 2026-10-02 | 无 | 生活状态、日程、关系识别、主动行为 |
| 主动消息 | [Luna-channel/astrbot_plugin_Conversa](https://github.com/Luna-channel/astrbot_plugin_Conversa) | 36 | 2026-08-04 | 无 | 冷场后主动开口、定时问候 |
| 主动消息 | [AstraSolis/astrbot_proactive_reply](https://github.com/AstraSolis/astrbot_proactive_reply) | 40 | 2026-07-08 | AGPL-3.0 | 定时主动发送 |
| 回复节奏 | [advent259141/astrbot_plugin_debounce](https://github.com/advent259141/astrbot_plugin_debounce) | 65 | 2026-09-10 | AGPL-3.0 | 用微调模型判断对方是否说完，再合并 |
| 回复节奏 | [aliveriver/astrbot_plugin_continuous_message](https://github.com/aliveriver/astrbot_plugin_continuous_message) | 43 | 2026-09-06 | AGPL-3.0 | 私聊防抖，自适应等待 |
| 回复节奏 | [FreeDivers/astrbot_plugin_combine-messages](https://github.com/FreeDivers/astrbot_plugin_combine-messages) | 21 | 2026-04-17 | AGPL-3.0 | 合并连发 |
| 回复节奏 | [Zhalslar/astrbot_plugin_outputpro](https://github.com/Zhalslar/astrbot_plugin_outputpro) | 77 | 2026-09-13 | GPL-3.0 | 输出阶段的清洗、替换、TTS、分段等增强 |
| 回复节奏 | [nuomicici/astrbot_plugin_splitter](https://github.com/nuomicici/astrbot_plugin_splitter) | 49 | 2026-09-03 | 无 | 替代本体分段 |
| 回复节奏 | [LinJohn8/astrbot_plugin_custome_segment_reply](https://github.com/LinJohn8/astrbot_plugin_custome_segment_reply) | 25 | 2026-08-13 | 无 | 本地规则断句 |
| 作息 | [muyouzhi6/astrbot_plugin_life_scheduler](https://github.com/muyouzhi6/astrbot_plugin_life_scheduler) | 29 | 2026-09-20 | MIT | LLM 生成日程，注入 system prompt |
| 作息 | [Hola-Gracias/astrbot_plugin_dynamic_life_state](https://github.com/Hola-Gracias/astrbot_plugin_dynamic_life_state) | 4 | 2026-08-09 | AGPL-3.0 | 按时间段注入当前状态 |
| 作息 | [FloranceYeh/astrbot_plugin_virtual_life](https://github.com/FloranceYeh/astrbot_plugin_virtual_life) | 5 | 2026-09-21 | GPL-3.0 | 虚拟日程 + 主动消息 |
| 群聊 | [Him666233/astrbot_plugin_group_chat_plus](https://github.com/Him666233/astrbot_plugin_group_chat_plus) | 145 | 2026-09-23 | AGPL-3.0 | 读空气 |
| 语音 | [Zhalslar/astrbot_plugin_GPT_SoVITS](https://github.com/Zhalslar/astrbot_plugin_GPT_SoVITS) | 97 | 2026-08-22 | AGPL-3.0 | 本体已有 GSV provider，可选 |
| 生图 | [diaomin66/astrbot_plugin_omnidraw](https://github.com/diaomin66/astrbot_plugin_omnidraw) | 72 | 2026-10-01 | 无 | 支持人设自拍 |

## 4. 迁移评估

AstrBot 是 Python 框架，我们的 TS 代码（`packages/` 合计约 7.6k 行，含测试）**全部要重写**，能沿用的只有数据和规则：角色卡 / 世界书 JSON、作息表、模拟器场景脚本（当数据用）、Hindsight 服务（HTTP 接口不变）。

| 部分 | 迁过去怎么做 | 粗估 |
| --- | --- | --- |
| 接入、WebUI、STT/TTS/看图 | 用本体（NapCat 改成反向 WS），配置为主 | 1 人天 |
| ST 拼提示词（卡、世界书、宏、正则、prompt converters） | 移植成 Python，挂 `on_llm_request`；或先评估 komeiji_tavern 能不能直接用 | 3–5 人天（评估 komeiji 另算 1–2 天） |
| 档位 / 白名单 / unlisted / 换档隔离 | 插件 + conversation 切换 + 插件配置页 | 1–2 人天 |
| 时间、作息状态注入 | 移植 | 1–2 人天 |
| 看到时机、不回、防抖、取消重生成、分气泡发送与中途插话 | 消息 handler + `on_waiting_llm_request` + `on_decorating_result` 接管发送，加上会话锁时序；最容易出错 | 3–5 人天 |
| 出口检查 + 重新生成 | `on_llm_response` / `on_decorating_result` + `llm_generate` | 1–2 人天 |
| Hindsight 记忆 | 移植 | 1 人天 |
| 断线补回 | 插件自己调 NapCat API，可行性未验证 | 1–2 人天（有风险） |
| 模拟器 / 测试 | Python 重写：插件核心用纯函数加注入时钟，外层用假事件驱动钩子；跑不了 AstrBot 整条流水线加虚拟时钟 | 3–5 人天 |
| **合计** | | **约 15–25 人天** |

折中方案：AstrBot 只当前端（适配器、WebUI、STT/TTS/看图），写一个很薄的 Python 插件，在消息 handler 里 `stop_event` 后转发给现有的 Node 服务，由 Node 服务决定回不回、怎么分气泡、什么时候发，再回调发送。约 4–7 人天，但 AstrBot 的人格、历史、提示词流水线基本用不上，还要维护 Python 加 Node 两套运行时。

## 5. 三个优点、三个阻碍

**优点**
1. **六个钩子点都有对应钩子，而且已有先例**：komeiji_tavern 证明能在 `on_llm_request` 整体接管提示词，防抖插件证明能拦截和合并消息，`on_decorating_result` 能接管发送；每条事件一个 task，插件里写延时很自然。
2. **现成功能多**：WebUI 热加载（人格、会话规则、按 UMO 路由的多配置、插件配置和自定义页面、定时任务页）；本地 STT（Whisper / SenseVoice）、本地 TTS（GPT-SoVITS / Genie）、单独配置的看图模型、群聊主动回复、cron 主动任务；市场 1,300+ 插件，覆盖主动消息、记忆、防抖、生图。
3. **生态很活跃**：41k★，每 1–2 周发版，373 名贡献者；OneBot / NapCat 适配器在核心里维护；Windows 有启动器和桌面版。

**阻碍**
1. **只能用 Python**：TS 核心和模拟器都要重写（约 15–25 人天）；框架没有可注入时钟，现有「流水线 + 虚拟时钟 + 真模型回放」的测试方式只能在插件核心层重建。
2. **默认流水线的设计和我们相反，要逐项关掉或绕开**：安全模式提示词默认开启；EULA 字面上禁止色情和涉及个人隐私的内容、禁止削弱安全机制，和私密档位的设定有冲突；插件注入的上下文会写进历史，历史存的是改写前的回复；发送阶段占着会话锁；本体分段不能中途取消；取消重生成要用内部 API（`active_event_registry`）；默认还注入 cron / send_message 工具和白名单、频率限制。
3. **可靠性和隐私上的缺口**：不补拉离线消息，只支持反向 WS；LLM 重试策略不可细调；遥测默认开启并上传主机名和发送者哈希，要手动关；代码迭代很快（有 beta 版，open issue 上千），插件依赖的内部结构可能随版本变化；AGPL 加进程内插件是否构成组合作品，以及 EULA 附加限制和 AGPL 的关系，都没有官方说法。

## 6. 未验证 / 不确定的地方

- **历史存的是改写前的回复**：结论来自读源码（`tool_loop_agent_runner.py:196-199` 先用当时的 `completion_text` 建 TextPart，然后才触发钩子），没有运行验证。
- **改 `event.session_id` 做档位 key**：只读源码推断可行，没试过；也没逐一确认其他组件（统计、WebUI 会话列表、主动消息）会不会受影响。
- **G1 补拉的绕法**：aiocqhttp 库能不能挂多个 `on_websocket_connection` 回调、能不能从插件安全地 commit 事件，都没验证（本机没装 aiocqhttp 库，没看它的源码）。
- **D2 的 `stop_all`**：旧事件的 LLM HTTP 请求会不会立刻中断，取决于 runner 的 `_await_or_stop`（`tool_loop_agent_runner.py:466`），没细看，也没实测。
- **插件市场缓存**：缓存约为 2026-07-29 的快照，搜索可能漏掉之后上架的插件（komeiji_tavern 就不在里面，是用 `gh search` 找到的）；插件功能描述大多来自元数据和 README（文档），只有 continuous_message、hindsight_memory、komeiji_tavern 的钩子看过源码。
- **komeiji_tavern**：功能清单来自 README（文档），本报告只核实了它挂的钩子和 `chara_card` 识别；`regex_scripts` 没搜到，不代表没有别的实现方式。
- **Windows 本地 STT 依赖**：openai-whisper、funasr_onnx 在 Windows 启动器环境里能不能顺利装上，没验证。
- **AGPL / EULA 的法律效果**：只罗列了条文和观察到的事实，没有结论。
