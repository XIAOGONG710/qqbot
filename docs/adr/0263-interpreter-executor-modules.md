# ADR 0263：一个解释器、一个执行器，其余都是解释器的模块

状态：接受，2026-11-07（用户提出并同意方向；调模型归执行器由用户定）。接续 ADR 0122（模块总表）、0259（App 构造与停止收尾）。

## 问题与证据（2026-11-07 审查）

`packages/bot/src` 约 4.9 万行、225 个文件，测试约 5.1 万行。`platform/modules.ts` 把文件分成 10 个模块，但这只是一份文档清单，运行时没有“模块”：

- **`platform/app.ts` 是全能对象**：`createApp` 一个闭包约 2400 行，文件 93 个 import、38 处 `setTimeout` / `setInterval`。
  计时器、天气、生活队列、记忆同步、主动消息、B 站、说说、设备、表情与照片发现、周报、收到消息的重试、DSH 全在这一个函数里接线。
  加一个功能就要改它；ADR 0237–0259 的生命周期补丁大多是在给这里登记“构造失败 / 停止时该等哪些活”。
- **`platform/contact.ts` 的回复流水线靠选项包**：`ContactPipelineOptions` 约 85 项（40 多个布尔开关）；
  拼提示词和后处理之间靠十来个闭包里的 `let`（`stickerContext`、`photoNow`、`deliberateNow`、`shapeNow`、`quoteNow`、`crisisNow`……）隐式传状态；
  `buildPrompt` 的 `afterHistory` 是一个约 40 段、写死顺序、段与段之间还有条件依赖的数组（例如心境强烈时压掉按日期抽的底色）。
- **组装写了两遍**：`sim/runner.ts`（1302 行）自己调 `createContactResponder`，另写一遍接线，和线上会慢慢走样。
- **一个功能登记四处**：`config.ts`（约 90 个平铺开关）、`features.ts`、`modules.ts`、Koishi 插件 `index.ts` 的 Schema（177 处）。
- **副作用没有统一出口**：调模型的有 7 个文件（含 `social/stickers.ts`、`dsh-link.ts`）；`app.ts` 里 17 处直接发 QQ；读写文件分散在各子目录。
  停止、重试、模拟、审计只能逐处补。

已有可以接着用的：`social/responder.ts` 的 `ResponderDeps` 已经是“依赖从外面注入”的写法（`generate`、`send`、`waitUntil`、`now`……）；
48 个测试文件经 `startApp` 测整个 App，是迁移期间行为不变的主要护栏。

## 决定

### 1. 三种角色

- **执行器（Executor）**：唯一碰外部的地方。外部指：QQ（OneBot 动作）、模型 API（含看图、语音转文字、嵌入）、文件、计时器与等待、HTTP（B 站、天气、Hindsight、网页查询）、设备。
  执行器不做任何“她要不要 / 怎么做”的判断。
- **解释器（Interpreter）**：唯一做判断的地方。接收事件，按已注册模块决定要做哪些动作，交给执行器执行，拿回结果接着判断。
  解释器本身只有骨架：事件分发、一轮回复的阶段顺序、提示词槽位的排序与拼接、模块注册与配置。具体功能一律不写在骨架里。
- **模块（Module）**：挂在解释器上的功能单位。语言、生活、世界、心境、主动消息、记忆、照片与表情、B 站、说说、设备……全部是模块。
  模块不直接 import 执行器的实现，也不自己开计时器、读写文件、发请求。

### 2. 动作是数据，执行只有一个口

解释器和模块通过一个口做事：

```ts
type Action =
  | { kind: 'llm'; purpose: string; model: ModelRef; messages: OpenAIMessage[]; options?: LlmOptions }
  | { kind: 'onebot'; action: string; params: Record<string, unknown> }   // 发文字 / 图 / 卡片、已读、撤回、戳、输入状态、账号控制面……
  | { kind: 'http'; purpose: string; request: HttpRequest }
  | { kind: 'state.read' | 'state.write'; slot: string; value?: unknown }
  | { kind: 'wait'; until: number }
  | { kind: 'device'; ... }
  | ...;

interface Executor { run<A extends Action>(action: A, signal?: AbortSignal): Promise<ResultOf<A>> }
```

- 解释器侧照常写 `await exec.run(...)`。不用生成器 / `yield` 做纯函数式的效果系统：
  现有代码几乎都是 `async` 函数层层调用，改成 `yield*` 要一次性重写全部调用链，代价远超收益。
  “所有副作用都是带类型的数据、都经过同一个口”已经能拿到想要的东西：统一停止与收尾、统一审计和日志、模拟器和测试换一个执行器即可。
- 动作的粒度贴着外部边界：B 站的签名、风控、解析留在 B 站模块里，执行器只发一次 `http`；
  拼提示词、选模型、要不要深思由模块定，执行器只按 `llm` 动作调用并负责连接重试（现在 `llm.ts` 的连试 5 次）。
- 执行器的实现分真实的（Koishi 插件 / `main.ts` 装配）和假的（测试、模拟器：假模型、假 QQ、虚拟时钟）。

### 3. 模块接口

```ts
interface Module<C = unknown> {
  id: string;
  config: ConfigSpec<C>;             // 自己的配置段：默认值、校验、控制台说明、功能开关
  state?: StateSpec[];               // 自己的持久状态槽：文件名、格式、默认值；读写由执行器做
  schedules?: ScheduleSpec[];        // 要定时做的事（每 N 分钟、每天某时、按作息）；计时器由执行器开，到点给解释器发 tick 事件
  on?: EventHandlers;                // 收到消息 / 戳 / 撤回 / 好友申请 / tick / 连上 NapCat……
  assess?(turn, ctx): void;          // 一轮回复的第一阶段：往这一轮写判断（是不是危机、意图、形状、要不要深思、要发表情 / 照片……）
  contribute?(turn, ctx): Piece[];   // 第二阶段：往提示词的具名槽位里放段落
  review?(draft, turn, ctx): Verdict; // 第三阶段：出口检查、事实检查、句尾封顶、表情和照片清理、打错字再改口……
  status?(ctx): unknown;             // 控制台「状态」页要显示的
}
```

- **一轮回复显式传 `turn`**：现在 `contact.ts` 闭包里的那批 `let` 变成 `turn` 上的字段，谁写谁读一目了然；
  模块之间的依赖只能通过 `turn` 上的字段（先 `assess` 后 `contribute`），不能互相 import 对方的内部函数。
- **提示词槽位的顺序由骨架里的一张表决定**，照搬现在 `afterMain` / `afterHistory` 的顺序；模块只说“放进哪个槽”，不决定先后。
  段与段的条件依赖（心境压掉底色、有共同经历才带披露规则……）写成 `assess` 阶段的判断，由 `contribute` 读取。
- **模块的粒度**：一个模块 = 一份自己的配置 + 自己的状态 + 一组紧密相关的行为，不等于现在的一个目录。
  现在的 10 个分组太粗（「说话」一组 25 个开关），迁移时按功能拆，例如表情、照片、小梗、口头习惯、热梗各是一个模块。
- **配置**：迁移期间配置文件的键保持平铺不变（`runtime/koishi/koishi.yml` 里已有的配置不用改），模块声明它拥有哪些平铺键。
  `features.ts` 的功能总表、`modules.ts` 的模块总表、Koishi 插件的 Schema 最后都从模块定义生成，不再四处手写。

### 4. 生命周期归执行器

执行器知道每一个正在进行的动作，所以停止只有一套：拒绝新动作 → 取消可取消的等待 → 等已派发的动作结束 → 释放目录租约。
ADR 0259 那种“构造时每拿一项资源登记一次收尾”的做法在迁移完成后由这套取代；在那之前两套并存，0259 的保证不能变弱
（相关测试 `memory-app-*-review.test.ts` 必须一直通过）。

### 5. 对外接口不变

`startApp(options): App` 和 `App` 接口（`connected` / `receive` / `receivePoke` / `receiveRecall` / `receiveFriendRequest` / `stop` / `status` / `mobileCompanion`）保持不变，
Koishi 插件和 `main.ts` 不用跟着改；它们内部变成“装配真实执行器 + 解释器 + 全部模块”。48 个经 `startApp` 的测试文件继续当护栏。

## 迁移步骤

每一步单独提交，行为不变，`npm test`、类型检查通过才进下一步。

1. **这份 ADR。**
2. **行为基线**：在合成角色（ADR 0260）上，用假模型、假 QQ、假时钟跑一组固定场景（私聊回复、连发合并、打断重来、主动消息、戳、撤回、睡着时收到消息、危机回合、照片 / 表情回合、停止），
   把**每一次对外调用**（发给模型的完整提示词、发出的每条 QQ 动作及其时刻、写出的状态文件）记成快照。后面每一步都必须和快照逐字一致；
   有意改变行为的只能在单独的提交里改快照并写明原因。
3. **执行器**：定义 `Action` / `Executor`，写真实实现，把 `Transport`、`chatCompletion`、计时器、状态读写收进去；`app.ts` 改成经执行器做事，快照不变。
4. **解释器骨架**：事件分发、一轮回复的三个阶段（`assess` / `contribute` / `review`）、提示词槽位表、模块注册；先把整个 `contact.ts` 包成一个“大模块”接上，快照不变。
5. **逐个拆模块**：从只往提示词里放段落的开始（最容易、快照最能说明问题），再到有定时任务的，最后是自带循环的（B 站、说说、设备、主动消息）。
   每拆一个提交一次；拆完一个，`app.ts` / `contact.ts` / `ContactPipelineOptions` 里对应的接线和开关一起删掉。
6. **收尾**：`app.ts` 只剩装配；`sim/runner.ts` 改用同一个解释器 + 假执行器，删掉重复接线；`features.ts`、`modules.ts`、Koishi Schema、`docs/modules/` 改为从模块定义生成；
   ADR 0259 的构造收尾登记由执行器的统一停止取代。

## 不做 / 不变

- 迁移期间不改行为、不改提示词措辞、不改配置文件格式；有问题另开提交。
- 是否借这次删掉不再用的功能，单独由用户决定；删功能是单独的提交，不混在迁移提交里。
- 不改 `vendor/`、Koishi 及其插件的源码；`character-tools`、`mobile-companion`、`mobile-companion-app` 不在这次范围
  （手机伴侣在迁移后作为执行器的一种通道或一个模块接入，届时再定）。
- 不追求解释器是严格的纯函数（见第 2 节）；要求的是“没有绕过执行器的副作用”，第 6 步之后用一条测试核对：
  模块目录里不出现 `node:fs`、`fetch`、`setTimeout` / `setInterval`、`chatCompletion` 和对 `Transport` 的直接调用。

## 后果

- 加功能 = 写一个模块，在一处登记；不再改 `app.ts` / `contact.ts`，不再四处手写开关。
- 停止、收尾、重试、审计、模拟只写一次，后面不再需要 0237–0259 这类逐个资源的补丁。
- 模拟器和线上用同一份判断逻辑，只有执行器不同。
- 代价：迁移跨很多次提交，期间新旧两套写法并存；第 2 步的基线是能不能安全做完的关键，基线覆盖不到的路径要在拆到对应模块之前先补场景。
- ADR 0122 和 `docs/modules/README.md`「接下来」里的两项（模块自己的配置段、提示词由模块贡献）由本 ADR 取代。

## 第 2 步：行为基线（2026-11-07 完成）

- 位置：`packages/bot/test/baseline.test.ts`（随 `npm test` 跑）、`test/baseline/harness.ts`（跑场景、记录、写快照）、`test/baseline/clock.ts`（假时钟）、`test/baseline/scenarios.ts`（场景与覆盖说明）、`test/baseline/snapshots/*.txt`（10 份快照，约 33 万字节）。
- 跑的是真实的 `startApp`，只换外部：假 QQ（`Transport` 的每个方法都记下参数和时刻）、假模型（`pipeline.generate`，记下完整提示词和用的模型；长的段落第二次出现时写「同 #n.m」）、
  全局 `fetch` 一律拦下并记一行（目前没有场景碰到）。结束后把数据目录里每个文件写进快照（SQLite 按表逐行列出）；临时目录、仓库路径、uuid、pid 换成占位。
- 确定性：`Date` 由 `node:test` 的 `mock.timers` 冻在虚拟时间；`setTimeout` / `setInterval` 换成自己的队列，拨时间前先等进程静下来（没有进行中的文件读写、连续几轮 `setImmediate` 无变化）；`Math.random` 用固定种子。
  每个场景的假模型每次运行新建，不跨次共用计数。
- 场景（10 个）：同学档默认配置的一次回复；七个档位加名单外各问一句；连发合并 + 生成中又来消息丢掉重来 + 拆条发送中插话；凌晨吵醒与等她醒；危机回合到确认安全；
  戳一戳 / 戳回去 / 撤回；连上时补回漏掉的消息；停止时一人在等、一人在生成；本地功能全开过一整天的主动消息；本地功能全开两天的聊天（含深思换模型、反馈「假」、打错字再纠正）。
- 没覆盖的写在 `scenarios.ts` 开头：长期记忆、真实天气、B 站、热梗与在看、照片与表情、看图与语音、网页查询、DSH、设备、账号控制面、说说、逐条事实检查。**拆到这些模块之前先补场景。**
- 验证：生成后换新进程比对两次都一致；每个场景单独一个进程跑，与整组连跑的结果逐字相同（不依赖跑的顺序）；
  变异检验：把提示词里「在读的书」和「你那边」两段对调，有 2 个场景报出不一致并指出行号，改回后全过。
  全仓 `npm test`：bot 3453 项通过 3445 项；失败的 7 到 8 项（沙箱 `EPERM` 6 项，以及 B 站、设备相关的几项）在不含本次改动的 HEAD 上单独重跑结果相同，与本步无关。类型检查通过。
- 更新快照：`UPDATE_BASELINE=1`。迁移提交不许更新快照；只有有意改变行为的单独提交才更新，并在提交说明里写清哪里变了、为什么。
- 11-07 修正：基线原先开着设定账本（`identityLedger`），它写死读真实角色目录 `characters/linmengyao/source`、`st` 的文件哈希并调 `git` 取 HEAD——
  基线因此碰了真实资料，而且每次提交都会变。已从基线的全开配置里去掉，快照只少了 `identity/` 下的三个文件，其余逐字不变。
  设定账本本身的问题（目录写死、不跟配置的角色卡走，`git` 子进程绕过执行器）留到拆它的模块时处理，拆之前先补不碰真实资料的场景。

## 第 3 步：执行器（2026-11-07）

- `packages/bot/src/executor/executor.ts`：动作是数据（`qq`、`llm`），`run` 派发；`qq` 是和 `Transport` 同形状的外观，每次方法调用变成一个 QQ 动作；
  `llm` 有测试替身时按原来的参数调替身，否则调 `chatCompletion`；`after` / `every` / `cancel` / `now` 管计时器和时钟。进行中的动作和周期计时器有登记。
- `app.ts` 经执行器做事：全部 QQ 调用（含交给在线状态 / 账号控制面的整个 transport）、全部计时器、「测试时钟或 Date.now」的读法、12 处后台模型调用、
  每个联系人的回复生成和逐条事实检查的审稿。`app.ts` 不再 import `chatCompletion`。
- 等价的做法：QQ 动作同步调用底层、原样返回同一个 promise，同步抛错照样同步抛；`after` 把原回调直接交给 `setTimeout`（已有审查测试按回调源码认计时器，
  一次性计时器触发后执行器也无从得知，登记了只会越积越多，所以不登记）；`cancel` 对登记过的周期计时器用 `clearInterval`、其余用 `clearTimeout`（已有测试换掉全局的 `clearInterval` 核对）。
- 基线：三次迁移提交快照都逐字不变。另有一个只改记录的提交：`AppOptions.observe` 让基线记下每次调模型的用途和完整配置（模型、温度、maxTokens、extraBody、是否换模型），快照只变了 54 行模型调用的标题。
  bot 测试失败的仍是迁移前那 7 项（沙箱 `EPERM` 6 项，加 B 站 / 设备相关），插件 51 项全过。

### 还没收进执行器的（按出现的地方，迁到对应模块时一并收）

- **状态文件读写**：分散在各模块自己的文件里（`json-file.ts`、`history.ts`、`ledger.ts` 等）。原计划放在第 3 步，改为第 5 步随模块一起做——
  状态槽是模块声明的（第 3 节），先有模块才知道每份状态归谁；现在集中搬只能得到一个没有归属的文件读写口。
- **HTTP**：真实天气、网页查询、B 站（公开接口和她的账号）、Hindsight、照片与吃的照片来源、热梗、表情来源、网络探测。各自已有注入口（`bilibiliFetch`、`photoSource`……），迁模块时换成执行器的 `http` 动作。
- **不经 App 的模型调用**：DSH（`dsh-link.ts`）、图片表情判断（`social/stickers.ts`，由宿主建好再传进来）、`contact.ts` 自己的默认调用（只在不经 App 直接建流水线时用，如单元测试）。
- **子进程**：设定账本调 `git`（`memory/identity.ts`，另有目录写死的问题，见第 2 步的修正）、B 站语音转文字调外部命令（`bilibili/bilibili-asr.ts`）。
- **时钟**：`app.ts` 里有 7 处直接 `Date.now()`，原来就不走测试时钟（手机伴侣配对码的有效期、休眠提示、恢复时间、健康探测……）；换成 `exec.now()` 会改变用虚拟时钟的测试，单独一个提交处理。
- **模拟器**：`sim/runner.ts` 仍是自己的接线（第 6 步）。
- **停止**：执行器的登记还没接进 `App.stop`；一次性计时器的统一停止和 ADR 0259 的收尾登记一起在第 4、6 步设计。

## 第 4 步：解释器骨架（2026-11-07）

- `packages/bot/src/interpreter/slots.ts`：提示词槽位表。两级——`afterMain` 的消息槽（关系概况）、`afterHistory` 的消息槽（要点、记忆、公共记忆……）、
  「此刻」块的约 40 个行槽（时间、状态、心情……意图、形状……主动的说明），顺序照搬迁移前 `contact.ts` 手写的数组；`assemblePrompt` 按表排序、同槽按给出顺序、把「此刻」行拼成最后一条。
- `packages/bot/src/interpreter/interpreter.ts`：`Module`（`id`、`on` 事件处理、`assess` / `contribute` / `review`）、`Turn`（谁、几点、聊天记录、主动 / 吵醒 / 只想一想、`facts`）、
  `runTurn`（先全部 assess 再全部 contribute，按表拼）、`reviewTurn`、`createInterpreter`（id 不重复、`dispatch`、`turnModules`）。
  都是同步钩子时整轮同步返回；分发只有一个处理函数返回 promise 时原样返回它——不多出微任务，事件顺序和原来一样。
- 接上的地方：
  - `contact.ts` 的提示词：原来手写的 `afterMain` / `afterHistory` 改成带槽位名的段落（「旧逻辑」大模块 `contact-legacy` 的 contribute），经 `runTurn` 拼；
    原来按真假判断的照旧按真假、原来无条件放的照旧无条件放（设备菜单、主动的说明、连续性各行）；`turnModules` 由 App 的解释器传入，现在为空。
  - `app.ts`：`connected` / `receive` / `receivePoke` / `receiveRecall` / `receiveFriendRequest` 经 `interpreter.dispatch` 交给「旧逻辑」模块 `app-legacy`；`stop` / `status` / `mobileCompanion` 不是事件，照旧直接给。
- 没接的：`review` 阶段只定了接口、没有接进回复流程——模块的检查排在现有出口检查（`contact.ts` 的 review）之前还是之后，等第一个这类模块迁出时按它定；
  `turn.facts` 还没有字段，随模块迁出逐个加（旧逻辑在拼段落之前写进去，迁出的模块在自己的 contribute 里读）。定时触发的事（tick）仍由 `app.ts` 里的计时器直接调，迁模块时改成事件。
- 验证：基线逐字不变；变异检验——槽位表里 `books`、`world` 对调后 2 个场景报出不一致，改回后全过。bot 测试失败的仍是原来那 7 项，插件 51 项全过，类型检查通过。

## 第 5 步：逐个拆模块

### 小梗（2026-11-07）

- 先补基线：`jokes` 场景（以前十天的 60 条聊天里反复说一个词，经 harness 新加的 `seed` 用 `ChatHistory` 写入；假模型回抽取请求）。
  覆盖连上后抽一次、存下的 `jokes/<QQ>.json`、之后几轮提示词里的那一行、跨过 6 小时的定时检查。单独提交，其他快照不变。
- 解释器补了模块接口里第一次用到的几样：`synced` 事件（连上 NapCat、补完漏掉的消息之后）、`schedules`（解释器经执行器开计时器，`startSchedules` 只开一次、`stop` 时关）、
  `stop`（返回收尾）、`status`（状态页补充，按注册顺序合并）；`TurnFacts` 有了第一批字段 `crisis`、`grievance`、`baseIntent`，由旧逻辑在拼段落前写入。
- `src/modules/jokes.ts`：`jokesModule`（抽取、定时、停止、状态、往 `joke` 槽放一行）和只放提示词的 `jokesTurnModule`（模拟器直接给梗用）。抽取和挑梗的规则仍在 `language/jokes.ts`。
- 删掉的接线：`app.ts` 里的 `jokeStore` / `jokeRefresher` / `refreshAllJokes` / `jokesTimer` / 状态页的小梗计数，`contact.ts` 里的 `jokes` 选项和 `jokeNow`，模拟器传给流水线的 `jokes`。
  原来调 `refreshAllJokes()` 的地方改成分发 `synced`，原来开计时器的地方改成 `interpreter.startSchedules()`，停止时原来 `jokesDrain` 的位置换成各模块的收尾——都在原位，时序不变。
- 唯一可见的差别：「小梗：这一轮提示词里放了……」这行日志从算意图之后挪到了拼段落的时候（同一轮之内，先后在别的日志之后）；日志不在基线里，内容不变。
- 验证：基线逐字不变；变异检验——让小梗模块什么都不放，`jokes` 场景报出不一致，改回后全过。bot 测试失败的仍是原来那 7 项，插件 51 项全过，类型检查通过。

### 口头习惯（2026-11-07）

- 先修基线：快照里的时刻、作息、「今天」按进程的本地时区算，而 harness 没有固定时区（注释说固定了，实际没有）——之前对得上只是因为机器在 UTC+8；
  机器换到东京时区后每个场景差一小时。harness 开头设 `process.env.TZ = 'Asia/Shanghai'`，单独提交；快照不变，机器在东京时区和 `TZ=UTC` 下都核对过。
- 再补基线：`idioms` 场景（以前两周他发了 72 条、常说两个词；假模型回这两个词外加他的名字）。覆盖连上后学一次（名字被挡掉）、存下的 `idioms/<QQ>.json`、
  约一半的轮次放进提示词（先是两个词都给，她说过其中一个之后只给另一个）、跨过 6 小时的定时检查。单独提交，其他快照不变。
- `src/modules/idioms.ts`：`idiomsModule`（学、定时、停止、往 `idiom` 槽放一行；不收的词由 App 给：名字、卡上的禁用词）和只放提示词的 `idiomsTurnModule`（模拟器直接给词，可调比例）。
  学和挑词的规则仍在 `language/idioms.ts`。
- 让路规则（男朋友档、不是主动 / 只想一想 / 危机 / 小别扭 / 他难过）小梗和口头习惯共用，从 `modules/jokes.ts` 挪到 `modules/playful.ts`（`playfulAllowed`），
  模块之间不互相 import；以后的热梗、被打断也用它。
- 删掉的接线：`app.ts` 里的 `idiomStore` / `idiomRefresher` / `idiomBlockedFor` / `refreshAllIdioms` / `idiomsTimer`，`contact.ts` 里的 `idioms`、`idiomShare` 选项和 `idiomNow`，
  模拟器传给流水线的 `idioms`。模块注册在小梗之后：`synced` 时先小梗后口头习惯、定时器先后、停止时的收尾先后都和原来一样。
- 和小梗一样的两处差别（日志、竞态，都不在基线里）：「口头习惯：这一轮提示词里放了……」这行日志挪到拼段落的时候；
  读口头习惯的时刻从算意图时挪到拼段落时，中间如果配置了连续性（`continuity`）会隔一次 await，这一次 await 里正好学完的话，这一轮就用上新学的词（原来用的是学之前的）。小梗也是这样，补记在这里。
- 验证：基线逐字不变；变异检验——让口头习惯模块什么都不放，只有 `idioms` 场景报出不一致，改回后全过。

### 被打断（2026-11-07）

- 先补基线：原来只在 `idioms` 场景里碰巧打断过一次。新的 `interruptions` 场景是一个晚上隔三分钟一句、聊天一直在进行；
  日常小事（ADR 0106）从第一次启动的第二天才有，`seed` 里把 `world/everyday-from.json` 写成一周前。覆盖一轮正常打断、一轮正碰上他难过而让路
  （从旧代码里去掉「他难过」这一条，场景就报不一致）。单独提交，其他快照不变。
- 被打断不只是往提示词里放一行：旧逻辑还按它决定这一轮不带意图行、不深思、不套形状、不给长短提示（免得把打断吞掉，ADR 0115）。
  所以它是 **assess** 型模块——这是第一个用上 assess 的：
  - 解释器把 `runTurn` 拆成 `assessTurn`（只写判断）和 `contributeTurn`（只收段落）；`runTurn` 仍是两步连着做。
  - `contact.ts` 在原来算被打断的位置建好 `turn`，跑一次 assess，旧逻辑接着读 `turn.facts.interruption`；最后拼段落时只跑 contribute。
    原来在拼段落前建 `turn` 的地方挪到这里（建对象没有副作用，用到的值在这之前都已定下）。
  - `TurnFacts` 加了 `world`（她那边此刻，旧逻辑写）和 `interruption`（被打断模块写）。
- `src/modules/interruptions.ts`：assess 时按 `language/interruption.ts` 的规则判断、写事实、记日志（日志还在原来的位置），contribute 时放进 `interrupt` 槽。
  不存状态、不调模型，App 和模拟器都直接用它。让路规则用 `modules/playful.ts`。
- 删掉的接线：`contact.ts` 的 `interruptions` 选项、`interruption` / `interruptLine` 的计算，App 和模拟器传的 `interruptions: true`。
- 验证：基线逐字不变；变异检验三处都报出不一致——模块不放那一行（`interruptions`、`idioms` 两个场景）、旧逻辑不读 `facts.interruption`（同两个场景）、
  模块不用让路规则（`interruptions` 场景）；改回后全过。

### 关系阶段（2026-11-07）

- 先补基线：原来只在 `idioms` 场景里碰巧出现，只覆盖「放了」，没覆盖它的条件——而它的条件和小梗那几样的让路规则不一样
  （主动找他、他难过时照样放；只有男朋友档，只想一想、危机、小别扭时不放），迁错了测不出来。新的 `closeness` 场景预先写入天天聊的记录
  （男朋友 24 天前到 5 天前，之后四天没出现、她发了两次没人回；同学天天聊到昨天），跑一整天：她主动找他、只想一想、他消失后回来的小别扭、危机、同学。
  在旧代码上逐条变异（加上「不是主动」、去掉只想一想 / 危机 / 小别扭 / 档位任一条、整行不放）都报不一致。单独提交，其他快照不变。
- `src/modules/closeness.ts`：`closenessAllowed`（它自己的条件，不用 `playful.ts`）和 `closenessModule`（contribute 时按 `language/relationship.ts` 放进 `closeness` 槽）。
  不存状态、不调模型，App 和模拟器都直接用它。注册在 turn 模块的最前面。
- 删掉的接线：`contact.ts` 的 `relationship` 选项和 `closenessLine`，App 和模拟器传的 `relationship: true`。
- 和小梗一样，「关系：最近几乎天天在聊……」这行日志挪到了拼段落的时候（日志不在基线里，内容不变）。
- 验证：基线逐字不变；变异检验——模块不放（`closeness`、`idioms` 场景）、多加「不是主动」、去掉小别扭（`closeness` 场景）都报出不一致，改回后全过。
