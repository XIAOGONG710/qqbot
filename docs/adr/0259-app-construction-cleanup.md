# ADR 0259：App构造失败的资源收尾与目录租约

状态：接受，2026-11-05。接续ADR0240、0246、0258。

真实App合成故障注入证明：context读取EIO使构造失败，外层catch直接释放租约，但之前的memoryTimer/LongTerm仍活；异步设备启动晚来时访问尚未初始化的stopped，服务不关闭且授予say仍可发送。天气首refresh在构造前段已派发，单纯清timer/global读口不能阻止其后续缓存写入。

构造期间每取得一项活资源便登记失败收尾，正常返回后清空登记，不代替正常App.stop。失败时首先同步置stopped，停止全部已建owner、清计时器/读入口，再等待已经派发的任务收尾后释放目录租约。保持startApp同步抛原构造错误；若仍有异步收尾，租约在后台保留，不能立即再启动同目录。无待收尾任务时仍可同步释放。

覆盖天气首refresh及全局读口/weather/life计时器、media读取、photo取消、heartbeat、tastes计时器、设备启动、memory/promises/diary/context/responder及memoryTimer。presence/browsing/risk/replies/planner为连接后启动，不在同步构造阶段伪登记不存在实例。设备晚到服务的stop必须等待；授予say/log/onAudit在失败后关闭。设备关闭拒绝不得被吞成启动成功，原promise交收尾诊断。天气已经派发的刷新保持原逻辑，包括后续城市和有效缓存写入，租约直到整个任务结束；不谎称已取消它。

构造阶段已经发生的有效同步写入和确认事实不回滚或猜删。allSettled收尾失败保留诊断和原错误，原数据协议负责后续校验；不是数据事务或任意外部副作用回滚。不合作的设备启动/停止请求可能使租约持续保留，不能猜其已停止。正常App.stop的设备/天气完整生命周期不因本协议自动获得新保证，全局天气多实例隔离也未解决。

五项正式回归使用临时合成卡、假timer/设备/fetch、真实App/锁与写入路径；旧版本对照失败、新版本通过。未访问真实角色、运行时、外部模型、QQ、天气或数据库。

## 2026-11-05 正常停止的设备与天气收尾

独立正常App合成验证确认构造失败收尾不覆盖普通stop：pending设备启动、service.stop以及已派通知ACK尚未结束时，旧App.stop可同步返回并释放租约；初次/后续interval天气刷新也会在释放后继续缓存写入。

现在构造失败与正常stop共享幂等设备收尾，聚合startup、服务stop和已派通知settlement。停止后设备say/log/onAudit拒新；通知在调用公开transport之前即登记，处理传输同步重入App.stop，成功/拒绝/同步抛错均结束收尾，不改变即时派发、不增重试或聊天历史。late服务只停止一次，startup/stop错误与收尾诊断保持区别。

天气App层跟踪完整refresh promise，初次及interval统一入口；停止后不派新刷新，快照已派轮次并等待全部完成，之后释放目录。构造收尾同样allSettled后汇总错误，不能因一项失败提前释放。维持provider的原singleflight和两城市行为，不声称取消已经派发的刷新或清空旧缓存。真实fake fetch内同步stop对照验证已有微任务边界使登记在先，未发现额外重入缺陷，没有为类比进行新重构。

这些是本地正常退出的等待保证，不是QQ与文件事务，不提供发送失败持久outbox、强杀后的通知重放或不合作外部服务可终止保证。停止返回前等待底层真实结束；不合作startup/service/transport可阻drain。全局天气跨同时运行App的隔离仍是原边界。
