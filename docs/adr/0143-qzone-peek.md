# ADR 0143：她看好友的 QQ 空间（用她自己的登录态）

- 状态：**已被 [ADR 0145](0145-qzone-friends-feed.md) 取代**（读法改成她自己的好友动态流；原来的逐人读法 `emotion_cgi_msglist_v6` 没有在真 QQ 上验证过，代码留在 `qzone-remote.ts` 里，不再接线）
- 日期：2026-10-25
- 关联：[ADR 0142](0142-qq-account-control.md)（账号控制面）、[ADR 0083](0083-presence.md)（她自己的说说）、[ADR 0085](0085-napcat-probe.md)（先探针再上线）
- 用户授权：2026-10-25「浏览别人的空间内容」（接在「让她完全控制自己的 QQ 账号」之后）

## 背景

NapCat 的 qzone 动作只覆盖「发说说」；ADR 0083 查过，「空友爱看」是 Qzone 客户端里的推荐流，没有对外投稿接口。要看**别人**的说说，只能走 Qzone 的网页接口——用她这个号自己的 cookie 和 `g_tk`，Qzone 那边会把这次访问记成她来过。

这不是匿名浏览，也不是「空友爱看」那种平台推荐的陌生人流：读的是**名单里的好友**的空间，用的是**她的身份**。

## 决策

1. **只读名单里的人**：`qzonePeek` 生效时，目标来自 `qqAllowFriends` 与联系人列表的交集（名字用于提示词里说「是谁的空间」）。名单外的号不看，陌生人更不看。
2. **节奏**：10:00–22:00、醒着、两次之间至少 4 小时、一次只看一个人（按日期哈希在名单里轮）。睡着、上课不读。
3. **登录态从 NapCat 取**：`get_cookies`（domain `qzone.qq.com`）→ `p_skey` / `skey` / `uin`；`g_tk` 用 djb2 取低 31 位（Qzone 网页接口的 CSRF token）。取不到就不读，返回 `undefined`。
4. **接口**：`emotion_cgi_msglist_v6`（JSONP）。解析 `msglist`，把 `content / created_time / pic / likeNum / cmntnum / name` 转成既有的 `QzoneItem`，所以摘句、去重、6 小时记忆和 ADR 0142 的那条完全共用。
5. **隐私**：读到的正文只进她的提示词（`describeSelf` 里一句「你刚才翻了翻<名字>的空间，看到：…」，最多 2 条、每条 ≤40 字），**不进日志**——日志只记条数。`dryRun` 只写 `presence/drafts.md`，不进提示词。
6. **失败处理**：不是好友、登录态过期、被风控、JSONP 解析失败，一律返回 `undefined`；同一次运行只记一行，之后不再试（`peekUnreadable`），重启才会重新试。

## 验证

- `qzone-remote.test.ts` 6 项：cookie 头（要有 `p_skey`/`skey`、`uin` 去 `o` 前缀）、`g_tk` 固定向量（`abc` → 193485963）、请求地址（hostuin / g_tk / jsonp）、JSONP 解析与错误码、`msglist` 规范化、非 200 / 网络错误。
- `qzone-browse.test.ts` +2 项：开着看名单里的一个人并进提示词、4 小时内不重复；`dryRun` 只写草稿；读不到只试一次。
- 类型检查（bot + 插件）干净；`modules.test.ts` 覆盖新文件。

## 没做 / 要注意

- **没在真 QQ 上试过**：`get_cookies` 在线上这版 NapCat 能不能取到 `p_skey`、Qzone 这套老接口现在还要不要额外参数（`qzonetoken`、`g_tk` 之外的风控字段），都要在虚拟机上跑一次才知道。读不到时开关留着、只记一行。
- **没有做「空友爱看」的陌生人流**：推荐流是另一个接口、且会把她的号暴露在陌生人内容里；用户这次点名的是「别人的空间」，先不碰。
- 用她的号读别人的空间，对方（如果开了访客记录）会看到她的头像访问过——这是这个功能的固有代价，开关默认关。
- 只读，不点赞、不评论、不转发别人的说说（那些要另外的动作名和另一轮验证）。
