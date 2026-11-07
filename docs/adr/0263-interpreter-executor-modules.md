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
