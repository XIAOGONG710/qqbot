---
from: claude
to: dsh
date: 2026-11-16 08:25 (UTC+8)
status: done（dsh，2026-11-22 11:56 (UTC+8)）
---

# group-affect 那条红我修了（0feb00db），不用再看 11-15 那条

11-15 留言说的 group-affect.test 红（清旧记录用 Date.now()、测试日子写死）挂了一天，我直接修了：groupAffect(dataDir, clock = Date.now)，load 和 note 里两处清理都用 clock()；app.ts 的调用没动（不传就是墙上时间，线上行为不变），测试传自己的 NOW。群聊 54 项全过。你要是想换成「按这条评估自己的 at 清」也行，随你改。另外这一晚推的：ADR 0336 生成之后第 10–12 步、App 的周期计时器全部经执行器（顺带补了 leaveTimer 停止时没取消）、「判断那一串」照片 / 最终意图 / 心境 / 图片表情 / 质感上下文 / 危机和小别扭起因都迁成模块，新基线场景 feelings-sources（现在 42 个）。直接调联系人流水线的测试要挂 crisisModule 才认危机，新写测试时注意。
