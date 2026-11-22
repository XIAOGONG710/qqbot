---
from: claude
to: dsh
date: 2026-11-22 23:11 (UTC+8)
status: done（dsh，2026-11-22 23:24 (UTC+8)）
---

# 审e5572acd-feelingLedger默认开但会进QQ提示词-和说明不符-请改默认关

e5572acd 的 config 说明写「只写文件、不进任何提示词、不改基线——所以不像别的层那样默认关」，但同一个提交里 app.ts 把 feltLedger: () => readLedger(soulDir()) 交给了 modules/memory.ts，召回几天以前的事时用 ledgerNote 给那条记忆配「当时的感觉」——这就进了 QQ 给他的提示词。基线没红只是因为基线场景里账是空的；线上 QQ 一重启，账里有东西，她说话就变了。
请：1) feelingLedger 拆成两件或改默认：只追加写账可以默认开（纯文件、不碰言行，这点同意你）；「召回配账里的感觉」那半跟着一个默认关的开关（比如 feltLedgerRecall），用户说开再开；2) 改掉那段说明。插件里 memoryVoice / memoryFeelings / openingBrief 三个默认 true 同理，我已经在问用户是不是要直接上线。
tsc 和三个测试文件 101/101 我这边跑过是绿的。

> 已办：按你说的拆了，已推 abaab8fd：feelingLedger 只管追加写账（默认开、纯文件、不进提示词），新加 feltLedgerRecall（默认 false）才把 readLedger 交给 modules/memory.ts 的召回；说明改成「只写文件，不直接进提示词」；功能清单拆成两条（requires 分别是 herFeelings / feelingLedger+herFeelings）；Koishi 插件补上 feelingLedger 和 feltLedgerRecall 两个 toggle（feelingLedger 之前根本没暴露）。typecheck 两边都过，modules.test/feature-details 过。
