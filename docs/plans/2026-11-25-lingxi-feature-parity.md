# 灵犀 QQ 桥接：上游功能与本地对照

上游对照提交 `edf9f853341ac049708dc4c68ed432c74f2ad6d4`，交接基线 `e3e60bb0`。
每一行只写到它真正到的程度：

- **代码完成**：功能在仓库里，读得出来。
- **模拟验收**：自动化测试或离线验收脚本跑过，用合成数据。
- **实机验收**：在真实 DSH 窗口、真浏览器或真实第二台设备上点过。
- **已部署**：线上正在跑这一版。

本次接手没有重载、上线或对外发送的授权，所以所有行的上限都是「模拟验收」。

| 功能 | 上游做法 | 本地数据源 | 代码完成 | 模拟验收 | 实机验收 | 已部署 | 没到下一层的原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DSH 面板外观与服务管理 | 灵犀主题、总览、服务状态、单项与顺序启动 | `dsh-plugins/dsh-qqbot-services/index.js`、`client.js`、`scripts/dsh-service-panel.test.mjs` | 是 | 是 | 否 | 否 | 面板改动要重载 DSH 才生效，本次没有重载授权；启动接口只记录调用，不真启动服务 |
| QQ 历史、受限图片语音与本人代发 | 本地 NapCat 历史、受限预览、主人代发 | `chat.js`、`createNapCatReader`、`createNapCatManualSender`、`scripts/dsh-qq-chat.test.mjs` | 是 | 是 | 否 | 否 | 离线验收里 `qqSend=0`，取消发送与未经确认的发送都是 403；真实桌面弹窗没点过 |
| 配置：私聊名单与三项模式 | 导入、导出、预览、原子保存 | `config-editor.js`、`scripts/dsh-config-editor.test.mjs` | 是 | 是 | 否 | 否 | 用合成 YAML 验收（保留其他插件字段、`.bak` 撤销、409 冲突、草稿一次性）；真实 Koishi 配置没参与 |
| 人设查看与编辑 | 上游在 DSH 内改人设 | `packages/character-tools/src/character-editing.ts`、`character-cli.ts`、`character-bridge.js`、`packages/koishi-plugin-qqbot/src/console.ts` | 是 | 是 | 否 | 否 | 共用层 8 项、Koishi 控制台 25 项、配置编辑器 6 项；面板前端只做语法检查，没在真实窗口点过 |
| 灵魂：梗、表情、书架 | 与上游一致 | 既有 `soul`／`books` 面板与 `@qqbot/bot` 灵魂插件 | 是 | 是 | 否 | 否 | `packages/bot` 全量测试与 39 项行为基线逐字一致；面板未实机 |
| 公共记忆查询与关系图 | 上游可逐条看来源与关系 | `public-memory.js`、`scripts/dsh-public-memory.test.mjs` | 是 | 是 | 否 | 否 | 只碰 `owner-bank` 登记的公共库，11 项验收；真实 Hindsight 库没连，全部用合成库 |
| 日志与版本检查 | 运维事件、脱敏召回诊断、Git 远端差异 | `logs-view.js`、`update-check.mjs`、对应两份测试 | 是 | 是 | 否 | 否 | 日志 8 项、版本 9 项；真实 GitHub 远端没参与，更新与重载仍走运维流程 |
| 备份与恢复 | 清单、制品校验、文件级隔离演练 | `restore-stages.mjs`、`scripts/restore-drill.mjs`、`hindsight-restore-drill.mjs` | 是 | 是 | 否 | 否 | 四阶段 11 项；正式切换只写进 `docs/operations/restore.md`，等单独授权 |
| 会客室跨设备与房间媒体 | 单次邀请、仅来宾的 HTTPS 监听、房间内图片与语音 | `companion-room.js`、`createLanGuestHandler`、`room-guest.js` | 是 | 是 | 否 | 否 | 会客室 9 项 + 真 HTTPS 监听 3 项；真实浏览器与真实第二台设备没测，生产证书与防火墙属部署环节 |
| 她的家：公开状态驱动的 3D 房间 | 公开活动映射到房间与原地动作 | `home-status.js`、`home-scene/state.js`、`home-scene/scene.js` | 是 | 是（状态层） | 否 | 否 | 状态层与加速时钟时间线（发布、换房间、收回、再发布、过期、在外面、读取失败）、WebGL 不可用时真 `scene.js` 的回退路径、窄窗口相机取景都在 Node 里验收；窄屏排版与真实 GPU 要看真浏览器，内嵌验收要重载 DSH |
| 正式模型与动作资源 | 上游自有资产 | 暂无 | 否 | 否 | 否 | 否 | 授权来源未确定，计划明确不猜位置、不引入来源不明的资产 |

## 本次一共加了什么

| 批次 | 提交 | 内容 |
| --- | --- | --- |
| 1 | `af87618f` | 离线验收基线脚本与记录 |
| 2 | `5fcec358` | 人设与配置共用一个编辑层，Koishi 与 DSH 都走它 |
| 3 | `0c33b178` | 公共记忆查询与关系图，字段可追到来源 |
| 4 | `545d8eea` | 日志页结构化与脱敏导出 |
| 4 | `8310acbb` | 备份恢复拆成四阶段，切换仍手动 |
| 4 | `977ef9e0` | 版本差异、更新前备份与回滚检查 |
| 5 | `9f074299` | 真 HTTPS 监听下的第二设备路径与房间媒体边界 |

## 要往上走还缺什么

1. 一次 DSH 重载授权：面板、人设编辑、版本卡、记忆页、日志页、她的家内嵌，全部等这一步才能从「模拟验收」升到「实机验收」。
2. 一次真浏览器点选：会客室的图片渲染与语音播放、上传失败提示、她的家的回退说明与窄屏排版（逻辑已在 Node 里验收）。
3. 一次真实第二台设备：真证书、真实局域网地址、防火墙放行。
4. 部署动作（上线、重启、改线上开关）按仓库规则必须单独点头，不在本次范围内。
