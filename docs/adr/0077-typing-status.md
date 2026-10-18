# ADR 0077：「对方正在输入…」

- 状态：**已实现，未上线、未在真 QQ 上验证**（分支 `claude/typing-status`；配置 `typingStatus` 默认关）
- 日期：2026-10-19
- 关联：[ADR 0075](0075-reply-rhythm.md)（回复节奏：看到之后她要打字多久）、[ADR 0007](0007-schedule-and-reply-timing.md)（什么时候看到）
- 用户授权：2026-10-19 凌晨「三小时内不用问我，继续往更像人做」——放开的是做和测，**上线（打开配置、重启）和第一次在真 QQ 上试仍要用户在场**。

## 背景

真人回消息时对方的 QQ 上会显示「对方正在输入…」。她的节奏（ADR 0075 之前的 `typingMs`：每条按字数等几秒）一直是**偷偷等**：他那边什么都没有，几秒后消息突然出现。机器人最容易被看出来的地方之一。

NapCat 有扩展动作 `set_input_status { user_id, event_type }`（`vendor/NapCatQQ/packages/napcat-onebot/action/extends/SetInputStatus.ts`，线上 4.18.28 的打包文件里有 `set_input_status` 和 `sendShowInputStatusReq`）；`event_type: 1` 是「正在输入」（源码里的示例值，没有文档说明其它取值）。

## 决策

1. **只在她「打字」的那段等待里显示**：`responder.ts` 的四个等待（回复和主动各自的第一条、之后每条之间）原来是 `sleep(typingMs)`，改成 `sleepTyping`：等待 ≥ `TYPING_MIN_MS`（1.5 秒）才显示，一开始就调一次 `deps.typing(userId)`，之后每 `TYPING_REFRESH_MS`（4 秒）补发一次，直到等完；发出那条消息，状态自己消失。不到 1.5 秒的不显示（真人也不会刚显示就收到）。
2. **调用不等结果，出错不影响发送**：`typing` 同步调用、异常吞掉；`app.ts` 里 `setInputStatus(...).catch` 只记**一次**日志（`typingFailed`），之后不再记。
3. **「看到之前」的等待不显示**：她在上课、睡觉、冷场没看到的那段不是在打字，不显示（本来也不在 `typingMs` 里）。
4. **配置 `typingStatus` 默认关**；两个入口都提供：Koishi 插件走 `bot.internal._request('set_input_status', …)`（Koishi 的 Internal 没有定义这个扩展动作）、独立入口走 `OneBotClient.setInputStatus`。

## 没验证的（上线前要在用户在场时试）

- **`event_type: 1` 在对方 QQ 上到底显示成什么**（正在输入 / 正在说话）：我没有在真 QQ 上调过（会在用户的 QQ 上闪一下，凌晨不做）。上线时先开配置、让用户发一句、看他那边有没有「对方正在输入…」。
- QQ 客户端对输入状态的保持时间（我按几秒假设，4 秒补发）。显示时间不对（闪一下就没了 / 回完了还挂着）就调 `TYPING_REFRESH_MS`。
- 打字显示和 ADR 0075 的节奏叠在一起时：节奏候选让第一条多一段「想」（`thinkMs`），她还没开始打字，不该显示。叠在一起的写法在 `claude/all-candidates` 的 `responder.ts`（先 `sleep` 想的那段、再 `sleepTyping` 打字的那段，没配 `typing` 时和原来一个样），`runtime.test.ts` 有一项（想 5 秒、打 3 秒：只在第 5 秒显示一次）。**单独上这个候选（不带节奏）时没有「想」的那段，不用管。**

## 验证

- `test/runtime.test.ts` 新增 3 项（假时钟）：等 9 秒显示 3 次（0、4、8 秒）、两条之间的等待各自显示、发出去之后不再有；不到 1.5 秒不显示、没配 `typing` 照旧；`typing` 抛异常不影响发送。56 项全过。
- `koishi-plugin-qqbot` 的 `config.test.ts` 新增 1 项（默认关、开了进配置、默认值不写回 yml）。
