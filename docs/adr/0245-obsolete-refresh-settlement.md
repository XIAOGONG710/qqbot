# ADR 0245：旧世代已知刷新任务的有限收尾

状态：接受，2026-11-05。接续ADR0244。

## 证据与范围

真实LongTerm合成回归确认：旧refresh-pending已有UUID，新撤回使污染世代更新；服务端后来completed，客户端仍因跨世代未结屏障永久阻塞。不能删除旧journal、伪造完成或执行旧lease的配置恢复来解除。

本批只自动消费已知UUID、completed且content_written/content_unchanged的旧任务事实。failed/cancelled/not_found、无UUID、preserved等outcome、改配置及证据不完整保持原保护。preserved不在本批支持范围，并不声称它必然意味着worker未停止。公共bank与历史observation仍按ADR0244保护。

## 决定

1. 新repairJournals只返回fresh克隆的租约、阶段、证据与可选settlement元数据；无模型/聊天原文。settleRefresh严格绑定旧lease、UUID、refresh类型、relationship、两类成功完成结果、原safe配置与模型身份、fresh整合零及完整四态任务静止证明，并对当前observedGeneration做CAS。
2. settlement只追加“旧任务已结束”事实，不改旧phase/evidence、当前污染世代、事件、收据或自动配置；原始派发记录完整保留。重复相同证据幂等，不同证据不能改绑。已settled旧journal不能继续checkpoint以恢复旧配置。发布前失败保屏障，发布后异常仅精确读回确认。
3. worker每次最多仲裁一个旧任务，无循环等待；每次await后核验fresh来源和世代，stop取消纯GET，晚结果不追加settlement。新来源先按原协议遮盖并完成，随后才允许新lease。旧模型当前safe paused配置仅在已settled旧journal的原auto/间隔、模型身份和配置hash全部匹配时承接；不任意猜测关闭的自动刷新应开启。
4. 新lease必须独立核对完整来源/目录，重新clear、full刷新、独立完成证据及最终配置/水位，再恢复本lease的原auto并CAS；旧completed不是新来源的修复结果。
5. 交叉复现实证第二refresh若复用旧UUID，clear后的空模型也能被旧completed误当新重建。现在同bank的刷新UUID只能归属一个lease：worker在ACK入口拒复用，store checkpoint和持久schema独立验证唯一归属（UUID大小写规范化）。同lease重复ACK仍幂等；复用ACK保持refresh-dispatched未知，不能改UUID或盲重POST。

## 未完成与限制

这不是通用未知HTTP仲裁。其他旧阶段、无UUID丢ACK、证据不符/任务失败等仍需可信恢复；不合作外部写者及任意网络exactly-once不在保证内。JSON唯一事实源、SQLite仅OS锁、旧写者统一升级、运行中不可删换协调文件、50ms仅争锁预算等限制保持。

观察整库重建仍未实现。固定版v0.10.2的PostgreSQL DELETE observations可在事务内清历史孤儿并重置原始事实整合进度，但无请求UUID、也不自动排重建；未确认DELETE可能迟到，不能靠读回零/再次DELETE成功后立即重建。consolidate还可能排后继任务，需独立持久请求事实与完整静止证据；非PG分支有源事实扫描上限，不能照搬同等事务保证。公共日记/总结来源依赖、directretain协议与其他记忆审查继续open。

仅合成数据、假API及临时JSON/SQLite故障注入，无真实服务、数据库、运行时或部署验证。[固定版清观察实现](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L11778)、[HTTP同步响应](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/api/http.py#L9230)、[整合任务后继链](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py#L2214)。
