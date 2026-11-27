# I 记忆、遗忘和多端接续

## 当前状态

2026 年 11 月 27 日，按用户要求先征询，备用网关返回 429（免费额度北京时间 11 月 28 日 00:00 重置），本次没有拿到她的回答；用户随后给出授权，只改代码和测试。仅用合成资料和临时目录，未碰线上服务、未发 QQ 消息、未提交、未推送。

I 的实现与验收用例已补齐：桌面最近对话写入带 `ownerBank`，读取时传 `ownerBank` 排除别家行、无归属旧行照读、没传则读全部；session-tail 带 `scope`，隔天按「昨晚/接着」回看窗口和话题线索匹配；撤回来源后不复活旧摘要、旧收尾、旧回复。

四条验收对应的用例（均已落在测试里，未重复造）：

1. 同一账号隔天接续：`packages/bot/test/cross-recent.test.ts`「隔天只按续聊线索读取同一账号的桌面查错」；`packages/bot/test/app.test.ts`「隔天接续：昨晚桌面的查错进度…」端到端核对提示词带上桌面那轮的进度线索。
2. 换账号读不到：上两条用例内的换 `ownerBank` / 换账号断言；`app.test.ts`「跨端最近对话只属于唯一 deviceOwner」。
3. 撤回后重开会话不复活：`soul-plugin.test.ts`「撤回后新桌面会话不复活旧摘要、旧回复或旧收尾，换账号也不继承」。
4. 记忆接口超时：`soul-plugin.test.ts`「记忆库列表卡住时按截止点继续并保留近期对话」「DSH 公共库响应正文忽略取消时，预算耗尽仍保留已返回的同一主人私有召回」。

跑通情况：写这部分的外包 agent 只拿到编辑权限、跑不了命令，所以上面那句「未能执行」是它当时的状态。收工后由主代理在有命令权限的终端补跑，并顺手修了一件它没发现的：`emotion/recovery.ts` 是新文件，没在 `src/platform/modules.ts` 的模块总表里登记，`modules.test.ts` 会直接点名。实测结果：

```
cd packages/bot
npm run typecheck                            # 0 错误
node --import ./test/time-zone-setup.ts --test test/cross-recent.test.ts test/soul-plugin.test.ts   # 115 条全过
node --import ./test/time-zone-setup.ts --test test/app.test.ts                                     # 143 条全过
node --import ./test/time-zone-setup.ts --test "test/**/*.test.ts"                                  # 5388 条，5378 过 / 0 失败 / 10 跳过
```

没有改行为基线快照，也没有用 `UPDATE_BASELINE=1`。

还剩：D（情绪恢复）另做一个提交，见 `packages/bot/src/emotion/recovery.ts`；它默认不接线（`appraisals` 不传 `repairs` 时行为逐字不变），要不要开由用户点头。

## 授权后的验收

- 用同一个合成账号将昨晚在 DSH 查到的进度接续到隔天的 QQ。
- 切换账号后用同一问法，确认读取不到原会话内容。
- 撤回来源消息后，重开会话并重查，确认派生摘要不会重新引入该来源。
- 注入记忆接口超时，确认能在等待预算内接着聊，并且只引用取得的证据。
