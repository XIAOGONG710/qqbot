# ADR 0319：模拟宿主的记忆能力与停止所有权

状态：接受，2026-11-05。接续 ADR 0039、0303、0313、0318。

## 已确认问题

合成真实runScenario证明：结束返回且测试bank删除后，旧relationship读取失败仍追加sim.log并修改已返回steps；restart后旧读取日志写入新step。另一条真实HindsightClient配合假HTTP证明，包装层遗漏submitRetain/retentionStatus等可选能力，远端任务全部pending但writer已记三篇written。诊断只用合成卡/聊天、临时目录、假API，没有真实服务或角色数据。

## 约束

模拟宿主必须停止并收尾旧实例拥有的工作，再更换实例或清理测试bank；纯读/生成停止后不能改日志、报告或派发新工作，已经派发的修改请求保留真实ACK及持久进度。重启不能依靠settle（回复暂时安静）代替停止所有者。异常退出遵循同一收尾顺序；不合作且未完成的写请求不能被假定取消成功。

Hindsight包装保持原API真实存在的可选能力、原实例this及全部参数，新增高级能力不会默默降级到旧retain协议；缺省方法仍缺省。模拟down阻新增业务请求，deleteBank保留既有清理例外。advanced受理与completed事实继续由原SDK协议区分，不以模拟器包装假造完成回执。

本批不证明测试bank的远端已接受异步任务全部静止；本地请求drain不同于服务端worker生命周期。未知DELETE/不合作请求、旧派生观察清理等仍遵循既有边界，不访问真实服务/数据库或解除公共保护。
