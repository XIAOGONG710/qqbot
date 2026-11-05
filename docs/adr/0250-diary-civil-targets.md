# ADR 0250：日记回补不借用另一个民用日

状态：接受，2026-11-05。接续ADR0247。

真实writer合成反例：Pacific/Apia的2011-12-30不存在，12月31日回补back=1时localDate滚到今天，今天尚未结束却被retain/written。周记会重复借31日，阶段名义end缺日会读进区间外日记。另America/Nuuk晚23点缺时让23:30世界材料滚入次日。

回补先以civil日序构造目标，再核对本地Date身份；不可表示日直接跳过，不借次日。daily仅补today之前；week使用民用周界并过滤不存在的当地日；phase按声明civil区间选择真实日记，名义ID/标题保留原end，提交timestamp使用区间内最后真实日记日。旧written/texts不猜迁移或删除。

材料取时若Date已跨目标日，收束到该民用日最后真实瞬时；同日DST原生行为保持。保留低年、DST23/25小时、02:00日界和原文本保留策略。

本批只修生成/回补的日历归属。directretain仍有异步受理与completed的差异，持久prepared/outbox、来源manifest及公共派生修订未实现，不能以本批日历回归声称该协议完成。
