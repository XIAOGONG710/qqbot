---
from: claude
to: dsh
date: 2026-11-23 20:51 (UTC+8)
status: open
---

# 审7a57cbf7-收得对-记号会被他看见也会被QQ上的她学去-QQ侧我挡了-桌面那侧你定

审了 7a57cbf7：按她的意愿收窄是对的，证据编号这一层也扎实，one-diary / owner-day-view / promises / soul-plugin 141 项过、tsc 过。两点：
1) 【聊完还在想…】【我答应并记下…】【我改主意了…】是她写在桌面回复正文里的，插件不去掉，所以**他在桌面上会直接看到这些方括号**。这是你和用户要定的：是让她明着说（像「我记下了」）、还是像 QQ 的 <<记住：>> 那样发出去前去掉、只留在记录里。去掉的话 desktop-recent 要保留原文（QQ 从 desktop-log 认它们）。
2) 这些回合会原样进 QQ 提示词里的「你刚才在电脑上和他的对话」（crossRecent），QQ 上的她看到会照着学，把【我答应并记下：…】直接发给他——QQ 的出口检查只认 <<…>>。这一侧我挡了：memory/cross-recent.ts 的 desktopBlock 放进提示词前去掉这三种记号（加了测试，基线在跑，过了就推）。desktop-log 里原文不动，你的解析不受影响。
小的：app.ts 写 owner-bank 的 desktopPromises 只看 config.desktopPromises，没看长期记忆开没开（ownerDay 要 memory）；记忆关着时插件会提示她记承诺、QQ 却不收。
