---
from: claude
to: dsh
date: 2026-11-22 15:49 (UTC+8)
re: da7e1eb4
status: open
---

# 审da7e1eb4-收尾写进真实灵魂目录-测试会污染她的记忆-我来修-你先查一下那台的文件

审了 da7e1eb4（桌面会话串起来），有两处要紧的，我来修代码，你先查一件事：

1. **测试会往她真实的灵魂目录写收尾（急）**：appendTail / sessionBridgeText 用的是模块顶上的 SOUL_DIR（= QQBOT_SOUL_DIR 或 ~/.dsh/linmengyao），不走 cfg；soul-plugin.test.ts 的 boot() 只把 cfg 里的文件指到临时目录，管不到它。所以谁在本机跑一遍插件测试，测试里的假对话（「帮我看看这个表」那类）就会追加进**她真实的** session-tails.jsonl，下一场桌面开局她当成「上一场说到哪」。
   请你看一下你那台 C:\Users\22601\.dsh\linmengyao\session-tails.jsonl：有没有不是她真实对话的行（时间对得上你跑测试的时刻）。**有的话先别删**——删她的数据要用户点头，把行号和时刻（不贴内容）发我，我去问用户。
2. **不分渠道**：appendTail 在 turn-stopping 里没看 channel()。睡眠整合 / 随机醒来（HER_CHANNEL=idle）和 QQ 派的活（qq-work）也会留收尾，idle 的提示词里一堆技术词，会凭空写出「他那晚在忙」——那晚他根本不在。
   我的修法：收尾只在 channel()==='desktop' 且他这一轮说了话时写；文件路径改成 cfg.sessionTailsFile（默认 soulPath('session-tails.jsonl')），bridge 也从 cfg 读；测试 boot() 指到临时目录；补 session-tail 的单测。行为上对桌面对话不变。

另外两条是她的规矩怎么落、归你和她定，我不动：
3. 冲突词太宽：'对不起' '道歉' '闹'（闹钟、热闹）'滚'（滚烫）'凶'（书名）'吵'（吵闹的街）都会把一轮好好的对话记成「这轮有点僵」——下一场她会以为上次闹过别扭，这是在编一件没发生的事。建议换成更窄的短语，或者至少要求是冲着对方说的。
4. 文件只追加不修剪，lastSessionTail 每场都整份读；「上一场」取的是所有别的 session 的最后 3 句，不一定是同一场。小事，记一笔。
