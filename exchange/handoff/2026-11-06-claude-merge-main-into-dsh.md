# Claude handoff — 把 main 合并进 dsh/qq-control

- 日期：2026-11-06（UTC+9 本机）
- 分支：`merge/main-into-dsh`（基于 `origin/dsh/qq-control@9b6d08ff`，合并 `main@bd5dc7e1`），**只在本地，没有推送**
- 工作目录：`C:\Users\XG\code\qqbot-merge`（worktree）
- 用户决定：整体合并（不是逐条搬）。冲突默认保留 DSH 线的行为；凡采用 main 写法的地方都记在下面。

## 规模

- 合并基点 `8d868303`（11-03）。main 独有 163 个提交，dsh 独有 517 个。
- 冲突 91 个文件、diff3 下约 280 处：源码 38、测试 35、文档 / 配置 17、生成文件 11。

## 验证（本检查点）

- 全仓 `npm run typecheck`：0 个错误。
- bot 完整测试（`--test-timeout=60000`，时区预加载）：4298 项，4282 通过，13 跳过，3 失败。
  - 失败里 2 项是 `runtime.test.ts` 的「只有内部标记的气泡」，原因是合并时新增的 `stripMarkers` 依赖，测试已补上（单独跑 72/72 通过）。
  - 剩下 1 项 `memory-responder-drain-review`「默认安静窗口定时器」是整包并发时的 2 秒等待超时，单独跑 3 次都通过（偶发）。
  - 对照：合并前 DSH 线是 3849 项、5 失败（responder-drain 要 main 的 `4c1c2b94` / `0a4b3614`）；这 5 项现在都通过。
- character-tools 18、koishi 插件 71、mobile-companion 70、根 `scripts` 26（1 跳过）：全部通过。`npm run test:real` 44 项通过。
- `docs/reviews/repro/memory-promise-recall.mjs`（main 的修复后探针）在合并后的代码上通过。

## 需要 DSH 评审的（交接记录里点名的敏感核心）

- `proactive/proactive-planner.ts`：采用 main 的主动消息提交结构（`owned` / 生命周期信号 / `commit(parts)` 提交前再查一次，即 `4c1c2b94` 那条线），再加上 DSH 的参数（`seen`、`doubtNight`、`guess`、`learnedLine`）。
- `social/responder.ts`：DSH 的「只有内部标记的气泡也要处理」（`absorb`）+ main 的主动消息取消（`checkInitiate` / `initiateWork`，`sleepTyping` 里抛 `InitiateCancelled`）、`fallbackReply`。新增 `stripMarkers` 依赖：判断「只有标记」用它，`historyContent` 只在发送确认后调用（否则会提前触发 main 的发送快照，这正是原来 5 项失败的原因之一）。
- `vision/photos.ts`、`platform/app.ts` 的照片发送快照（`sentPhotoHistory` / `sentHistory`，main `0a4b3614`、`7741c31a`）：git 自动合进来了，app 里接上了。
- 危机状态（main `86543a42`、`414145cf`）：`emotion/crisis*.ts` 被 git 自动合进来；app 里统一改用 `markCrisis`（带重试落盘），停止时 `crisisState.flush()`。
- 手机伴侣停止所有权（main `1318e5a8`、`d46c21c0`）：没有直接合 main 的 `runtime.ts`，而是在 DSH 的版本（语音会话、照片审核、背压）上补 `stopped` / `lifetime` / 等待中的操作，并把取消信号传给宿主处理器；`pairing.ts` 加 `stop()`，`mobile-companion-dsh.ts` 同时有 DSH 的 `reset()` 和 main 的 `stop()`，App 构造失败和停止时都会停它。

## 保留 DSH 线、没用 main 写法的（测试已按 DSH 改或 skip 并写明原因）

- 坏记忆进度：失败关闭（用户 11-06 选定），`long-term.ts` 整体取 DSH（main 的相关提交都已以同名提交移植过）。
- 现实数据缓存（天气 / 空气质量 / 日照）：坏文件改名隔离后照常重取。main 的天气「坏缓存拒绝使用」那条测试 skip。main 的坏时钟防护补进来了（越界时钟不写缓存、不记越界的失败时刻、状态里不出现 NaN 年龄）。
- 早上的困：保留 DSH 的公式（起床正好是 `wake.early` 才算早八困，起床有浮动以后就不出现，ADR 0219，她本人的意见）。main `41747512` 把它改成按第一节课判断，会让这条在浮动以后复活；对应的 main 测试 skip。
- 设备看屏幕 / 摄像头：DSH 的「她同意才执行」（`pendingAsk`）；DSH 对话上下文 `DshConversationContext`（持久化）；指令收敛照旧。
- 校时容差（补回、时间线 60 秒）；`human-values` 不把收款换算成情绪；`needs.ts` 的零时长饭。

## 合并时发现并修掉的缺陷

- `emotion/feelings.ts`：main 的情绪证据校验只认 `world` / `him` / `author` 三种来源，DSH 新加的 `self`（她自己回想的感受、梦）会被静默丢掉。已加上 `self`。
- `life/needs.ts`：DSH 的 `activeEventIds` 只处理同时段重复，main 的「部分重叠的饭不算完整吃完」没有覆盖到；两者合并。
- `proactive/inner.ts`：main 限定念头只有两行，DSH 的协议有可选的「想查：」「想做：」。现在最多四行，第三、四行只能是这两种，别的（比如又写一个去向）照 main 的规则拒绝。
- `world/weather.ts`：DSH 的出错分支在坏时钟下自己会抛错。

## main 的改动在 DSH 代码上的延伸（ADR 0334 / 0335）

- 地点：DSH 的空气质量、日照、交通、状态检查原来写死了两座城市的 id 和名字，改成和天气一样读卡上的 `weather.places`；卡上没写就不开，日志写原因。控制台的现实数据一行只说覆盖几个地方，不写地名。
- 真名：DSH 新加的运行时文案和正则（DSH 照片草稿、聊天回顾、他的反应、群聊话题、念头主题、日报关键词、控制台标签）里的真实猫名、NPC 名改成从卡上读或通用说法；注释同理。
- 测试：DSH 新加的 18 个测试原来直接读真实角色卡，按 ADR 0333 改成合成卡，依赖真实卡内容的断言换成合成资料里对应的值（书单、日子、说话规矩、AI 身份那句的说法——合成卡的这两句改成了和真实卡同样的意思）。守卫测试 `no-real-character-data` 通过。

## ADR 编号

- main 的 21 份记忆 ADR 在 DSH 线上已经以 0300–0320 存在：删掉 main 的 02xx 副本，以 DSH 的为准（两边文字有出入的，main 的版本在 git 的 main 分支上）。
- main 独有的 15 份改到 0321–0335：0227→0321 … 0236→0329、0243→0330、0248→0331、0250→0332、0260→0333、0261→0334、0262→0335。
- 只改了「来自 main 的行」里的编号引用；DSH 原有的行里的 ADR 号指的是 DSH 自己的那份，没动。`modules.ts` 的清单按映射合并。
- 0224 / 0225 / 0226 的重号是 DSH 线上本来就有的，没动。

## 规则文件

- `CLAUDE.md` 两边的规则取并集（DSH 的「改功能先问她」「指令收敛」+ main 的「每项任务一次本地提交」「尽量不开子代理」「测试只用合成角色」），环境一节用 main 的（本机核对过的 Node / gh 记录）；新增 `AGENTS.md`，和 `CLAUDE.md` 只差标题。
- 按 DSH 的规则，下面这些是功能层面的变化，**按规则应先问她**（这次没有调用 `scripts/ask-her.mjs`，需要你决定要不要问）：QQ 个性签名里那句改成「楼下的猫又胖了」；念头主题里的猫改成「楼下的猫」；main 带来的回复兜底（`fallbackReply`：提示词放不下时回一句「这条消息太长了，分几段发给我吧」）；主动消息提交前再检查一次条件（条件变了就不发）。

## 没做的 / 要注意

- 没有推送；`dsh/qq-control`、`main` 两个分支都没动。
- `memory-responder-drain-review` 的「默认安静窗口定时器」在整包并发时偶发超时。
- `packages/bot/sim/*.json` 仍是真实卡推出来的场景（私有数据，ADR 0335 不在范围）。
