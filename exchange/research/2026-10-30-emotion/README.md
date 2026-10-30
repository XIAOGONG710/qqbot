# 情感模块（ADR 0197）：取证和回放脚本（2026-10-30）

结论在 `docs/adr/0197-feelings-shared-and-reviewed.md`。这里只放脚本和数字；**不放聊天内容**（回放的输出里有他们聊天的摘要，只打在屏幕上）。

## 取证（线上 VM 到 10-27，只读）

- 心境上线（10-22 19:45）到 10-27 共 117 次回他，带心境的 26 次：松了口气 17、开心 5、担心 4；难过 / 烦 / 累 0 次。
- 世界账 202 条事件：study 47、leisure 47、eat 31、work_on_project 26、attend_class 25、sleep 17、read_book 3、feed_cat 2、receive_money 2、interact_npc 2；带 feel 的 0 条；interrupted 11 条是排程撞车，不是情绪。
- 需求投影（15 天账，每 3 小时一个点）：energy 最低 51、p50 88；stress 最大 37；hunger ≥70 占 5%——触发不了"累 / 烦"。
- 身体事实（60 天）：感冒 5/61 天、早八 3/61、课多的晚上 4/61、过了零点半几乎每晚；这些本来就以事实写在提示词里。
- `moments.json` 在线上不存在（作者的文件，我不写）。

## 回放（`feeling-review-replay.mjs`）

`QQBOT_CONFIG=<线上 config.json> node feeling-review-replay.mjs <仓库根>`：线上 10-22 20:00 → 10-27 的真聊天（188 条）按"一段聊天结束后半小时"逐段让她回想一次，共用一份状态。

26 段聊天 → 12 次回想（0 次失败）→ 记下 15 条、放下 4 条、想记没成 2 条；最后留着 8 条：开心·小事 5、松了口气·小事 2、开心·明显 1（都因他）。他的 83 次发言后她回他的那一刻，只有 2 次有"明显"的回想出来的感受（都是开心）。

`feeling-review-dry.mjs`：指定几个晚上各想一次（第一版按夜里触发时用的）。`mutate-feelings.mjs <仓库根> [名字片段]`：61 处变异检验，58 红 + 3 等价。
