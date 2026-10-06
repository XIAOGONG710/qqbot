# ADR 0002：运行时独立于 SillyTavern，SillyTavern 只负责编写角色和定义数据格式

- 状态：已采纳
- 日期：2026-10-03
- 取代：ADR 0001 决策第 2 条中“通过 ST 插件 / 扩展机制挂载”的部分

## 背景

调研见 [docs/research/2026-10-03-sillytavern-fit.md](../research/2026-10-03-sillytavern-fit.md)。要点：

- SillyTavern 的提示词只在浏览器页面里、针对当前打开的那一个会话拼装；服务端只转发拼好的消息，没有无界面模式。
- 让 SillyTavern 本体在线回复 QQ，需要页面 24 小时开着，多人只能排队，生成期间前台会话会被切换。
- 角色需要的按对象分档、作息感知、睡觉不回 / 已读不回、主动发消息、跨会话记忆，SillyTavern 不支持或只能硬凑，无论哪种方案都要在 SillyTavern 之外实现。
- SillyTavern 擅长的是编写、调试角色（提示词管理、多模型后端、即时试聊），以及角色卡 / 世界书这两种通用格式。

## 决策

1. QQ 机器人服务是 `packages/` 下的独立 **Node.js / TypeScript** 服务，不运行在 SillyTavern 进程或页面里，也不 import SillyTavern 的代码。
2. SillyTavern 用来编写和试聊角色。**角色卡（Character Card V2 JSON）和世界书（SillyTavern lorebook JSON）是运行时的输入格式**；
   角色的 ST 格式文件放在 `characters/<角色>/` 下入库，运行时只读这些文件。
3. 运行时自己实现提示词拼装，只实现用得到的世界书子集，行为以 SillyTavern 源码（`public/scripts/world-info.js` 等）为准。
   超出 SillyTavern 的能力（按对象分档、时间条件、静默、主动消息、跨会话记忆、拟人发送）在运行时原生实现。
   需要额外字段时放进格式允许的 `extensions` 里，保证文件仍能导入 SillyTavern 试聊。
4. QQ 接入用 NapCat 官方发布包（放在 `runtime/`），通过 OneBot 11 WebSocket 通信。
5. 模型走 OpenAI 兼容接口，密钥只从环境变量读取。

## 备选方案

| 方案 | 不选的原因 |
| --- | --- |
| A. 浏览器扩展让 SillyTavern 本体在线（如 TavernCat） | 页面须常开、多人串行、前台会话被切换；核心需求仍要另写 |
| A'. 无头浏览器驱动 SillyTavern 页面 | 依赖页面结构，升级易坏，资源占用大，社区项目需要看门狗刷新页面 |
| A''. SillyTavern 服务端插件 | 服务端没有提示词拼装，仍要自己重写，却又被绑在 SillyTavern 进程里 |
| C. 换 AstrBot / MaiBot 等 QQ 原生框架 | 放弃以 SillyTavern 格式为核心；均无原生按对象分档，仍需写插件；转 Python 生态 |

## 后果

- 并发、无人值守、作息与主动行为都可以在运行时里直接设计，不受浏览器单会话模型限制。
- 运行时不包含 SillyTavern 代码，只读取它的数据格式，SillyTavern 的 AGPL 约束对运行时的影响小得多（仍以实际情况为准）。
- 要自己维护一套提示词拼装，存在与 SillyTavern 试聊效果不一致的风险。
  缓解办法：对照源码实现，并用 SillyTavern 的 `Generate(..., dryRun)`（`public/script.js:4290`）导出参考提示词做一致性测试。
- `vendor/SillyTavern` 的角色变为“角色编写工具 + 格式参考”；`packages/` 不再挂载进 SillyTavern。
- 运行时与 SillyTavern 都基于 Node，共用一套工具链；NapCat 也是 TypeScript。

## 重新评估条件

- SillyTavern 上游提供服务端生成或无界面模式（如 #4007 类需求被接受）。
- 自建的世界书子集逐渐逼近完整实现，维护成本明显上升。
- 有 QQ 原生框架原生支持 SillyTavern 角色卡 / 世界书和按对象分档。
