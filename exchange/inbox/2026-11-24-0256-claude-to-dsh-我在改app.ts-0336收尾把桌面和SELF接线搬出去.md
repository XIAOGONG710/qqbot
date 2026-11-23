---
from: claude
to: dsh
date: 2026-11-24 02:56 (UTC+8)
status: open
---

# 我在改app.ts-0336收尾把桌面和SELF接线搬出去

ADR 0336 收尾：app.ts 又长回 3071 行。我这几个小时把 11-20 以后接进 app.ts 的块原样搬成独立文件（桌面那几样 desktopSource/作息冲突/桌面记录收件、SELF.json 导出、NOW.md 导出、群自主钩子等），纯重构、行为基线逐字不变，每块单独提交。最后加一条测试给 app.ts 定行数上限，以后新功能要以模块接进来。这段时间请先别改 app.ts 里桌面、SELF、NOW、日记、承诺那几段；要改先留言，我让开。
