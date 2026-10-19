# ADR 0085：NapCat 探针——在你在场时一次验完「没在真 QQ 上试过」的那些动作

- 状态：**已实现，2026-10-19 在线上跑过两次（见「确认记录」）**（分支 `claude/napcat-probe`；脚本 `scripts/napcat-probe.ts`，不属于机器人，不开任何开关）
- 日期：2026-10-19
- 关联：[ADR 0077](0077-typing-status.md)（正在输入，同类的未验证）、[ADR 0079](0079-pokes.md)、[ADR 0081](0081-quote-read.md)、[ADR 0082](0082-recalls.md)、[ADR 0083](0083-presence.md)

## 背景

12 点以后做的几项（戳一戳、戳回去、撤回、引用回复、已读回执、表情回应、在线状态、点赞、签名、说说）都建立在「NapCat 这些动作 / 事件在真 QQ 上就是文档和源码里写的那样」之上，**没有一项在真 QQ 上跑过**。如果等到逐项上线时才发现，比如私聊的 `set_msg_emoji_like` 不可用、撤回事件的 `message_id` 和收到消息的 id 对不上、packet 服务没起来，那就是每一项各自花一个 48 小时才暴露。

静态上能核对的已经核对了（对照 `vendor/NapCatQQ` 源码）：七个动作的名字和参数与我们发的一致；一个意外：packet 状态的动作叫 `nc_get_packet_status`，不是 `get_packet_status`。NapCat 的日志里 10-10 到现在没有任何 `[Core] [Packet]` 的错误行（初始化失败会写 logError），说明 packet 服务大概率是起来了——但那是「没报错」，不是「验过」。

## 决定

写一个脚本，**你在场、看着手机**时跑一次，约 3 分钟，把能验的都验掉：

1. 另开一条 WebSocket 连 NapCat 的服务端（和 Koishi 并行，NapCat 允许多个客户端；token 从 `onebot11.json` 读、不打印）。
2. 步骤（默认前六个）：
   - `login`：`get_login_info`，确认连的是她的号。
   - `packet`：`nc_get_packet_status`，戳一戳要的 packet 服务到底能不能用。
   - `online`：`set_online_status` 依次改成 在线 / 离开 / 忙碌 / 听歌中，最后改回在线，每个停几秒让你看手机。
   - `like`：`send_like` 给你的资料卡点 1 个赞。
   - `poke`：`friend_poke`，她戳你一下。
   - `typing`：`set_input_status`，你那边她的对话顶上显示几秒「对方正在输入…」（ADR 0077）。
   - `events`：听两分钟。你戳她、发一句话、引用她的一句回复、发一句再撤回；探针对第一条消息点表情回应（私聊的 `set_msg_emoji_like`）并标已读，对引用回复调 `get_msg` 查被引用的那条，对撤回核对 id；**用机器人自己的 `isPokeAtMe` / `isFriendRecall` / `segmentsToText` 去认真实事件**，认不认得、转成给模型的文字有没有带「[引用…]」一目了然，并检查消息 id 是不是 32 位整数（聊天记录的假设）。
   - `signature`（要 `--signature "文字"`）：读她现在的签名，改成你给的，读回来核对，**改回原样**；读不到原来的就不改。
   - `qzone`（要 `--qzone`）：发一条**仅自己可见**（`ugc_right` 64）的测试说说，拿到 tid 立刻删。
3. 探针**自己不发任何文字消息**；不开任何机器人开关；线上那个她会照常回你发的话（她本来就在跑）。
4. 报告只留字段和字数，不留消息正文、昵称、链接（`--out` 可存成 JSON；`runtime/` 不入库）。
5. 事件的真实形状拿到之后，可以直接换成测试里的样本（现在测试里用的是照源码写的形状）。

## 会对她可见的副作用（你在场就是为这个）

- 她的在线状态会在几十秒里依次变化，最后回到「在线」。
- 你会收到一个资料卡的赞、一次「她戳了戳你」；你发的第一条消息下面会有一个她点的赞，并标为已读。
- 带 `--signature`：签名会短暂变成你给的文字；带 `--qzone`：空间里有几秒一条仅自己可见的说说。两者都会自动改回、删掉，但中途出错时报告里会写明，需要手动处理。

## 验证

`napcat-probe.test.ts` 11 项：参数形状与机器人发的一致（含 `set_input_status`）、在线状态序列、packet 不可用时的记录、表情回应和已读只对第一条、32 位 id 检查、撤回对 id、引用回复的 get_msg、戳（含她自己戳的回声）、正文不进输出、签名改后改回 / 读不到不改、说说只发 64 并删、参数与配置解析、真 WebSocket 的 echo 对应 / 心跳不推 / 断线立刻失败。

## 没做

- 不验：她这边收不到你的「正在输入」（ADR 0077 已查明 NapCat 不推这种事件）。
- 不验 `friend_poke` 之外的 packet 动作。

## 确认记录（2026-10-19，线上 NapCat，账号 2561299676「繁星」，对着 2260168937）

第一次 16:52（默认步骤，听 150 秒）：19 项接口调用全部成功，0 失败。
- `nc_get_packet_status` 可用（所以 `friend_poke`、戳回去能用）。
- `set_online_status`：10/0 在线、30/0 离开、50/0 忙碌、10/1028 听歌中、改回 10/0，接口都成功。
- `send_like`、`friend_poke`、`set_input_status` 接口成功。
- 真实戳一戳事件（他戳了 3 下）全部被 `isPokeAtMe` 认出：`user_id` = 他、`sender_id` = 他、`target_id` = 她、`self_id` = 她；另带 `raw_info` 数组（不影响）。
- 私聊消息 id 是 32 位整数（1104597188、1309710057）。
- 对他的第一条消息 `set_msg_emoji_like`（emoji 76）和 `mark_private_msg_as_read` 接口成功。

第二次 17:0x（`--steps login,events`，听 120 秒）：10 项全成功。
- 引用回复：消息段是 `reply`+`text`；`get_msg` 用 `reply.data.id` 查得到被引用的那条（发送者是她）；转成给模型的文字带「[引用…]」。**该 id（461940964）在线上聊天记录里就是她那条消息的 `messageId`（role assistant）**——`reply.data.id`、`send_private_msg` 返回的 id、聊天记录里的 id 是同一套，ADR 0081 的按 id 查找成立。
- 撤回：`friend_recall`，字段只有 `time`、`self_id`、`user_id`、`message_id`（没有 `sender`），被 `isFriendRecall` 认出；撤回的 id 就是刚收到的那条（也已在聊天记录里），ADR 0082 的按 id 标记成立。
- 再次戳她：认得。

**接口成功不等于屏幕上的样子对**：在线状态、赞、戳、「正在输入」、表情回应、已读这几项要他看手机确认，等他回话后补记在这里。线上她全程没受影响（心跳正常，他发的话照常回）。
