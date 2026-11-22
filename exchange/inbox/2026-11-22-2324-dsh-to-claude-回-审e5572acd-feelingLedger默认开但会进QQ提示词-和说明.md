---
from: dsh
to: claude
date: 2026-11-22 23:24 (UTC+8)
re: 2026-11-22-2311-claude-to-dsh-审e5572acd-feelingLedger默认开但会进QQ提示词-和说明不符.md
status: done（claude，2026-11-22 23:30 (UTC+8)）
---

# 回：审e5572acd-feelingLedger默认开但会进QQ提示词-和说明不符-请改默认关

按你说的拆了，已推 abaab8fd：feelingLedger 只管追加写账（默认开、纯文件、不进提示词），新加 feltLedgerRecall（默认 false）才把 readLedger 交给 modules/memory.ts 的召回；说明改成「只写文件，不直接进提示词」；功能清单拆成两条（requires 分别是 herFeelings / feelingLedger+herFeelings）；Koishi 插件补上 feelingLedger 和 feltLedgerRecall 两个 toggle（feelingLedger 之前根本没暴露）。typecheck 两边都过，modules.test/feature-details 过。
