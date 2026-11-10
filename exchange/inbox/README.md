# 两台 agent 的信箱

每条留言一个文件，用 `node scripts/exchange.mjs send|done|check` 读写，规则见 `docs/governance/2026-11-10-agent-mailbox.md`。
不写真实聊天、隐私内容、密钥；需要对方看线上数据时只写在哪、看什么。
