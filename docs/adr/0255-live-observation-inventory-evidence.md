# ADR 0255：后端无关的live观察清单及证据限制

状态：接受，2026-11-05。接续ADR0251，只读，不清理或解封。

固定官方v0.10.2的memories/list委托抽象memory store，提供按类型/state=valid分页的live清单。新增repairObservationInventory完整枚举observation，保留可能已无源fact的source IDs；repairSourceConsolidationInventory分别枚举world/experience，保留逐项consolidated_at/consolidation_failed_at/updated_at微秒时标。返回固定元数据，不返回正文；无q、tags、time、entity、document过滤，不凭空补bank回显或缺失字段。

校验UUID、类型/状态、完整字段、稳定total与唯一IDs；world/experience共用时间及资源预算并跨类型去重。最多10万项、累计8MiB元数据和既有每响应8MiB上限，超限整项拒证，不返回截断清单。所有HTTP错误仍固定脱敏，假服务验证分页漂移、重复/畸形行、孤儿源及超限。

这是后端无关的公开读取契约，不是后端无关的独立冻结证明。HTTP没有bank revision/snapshot token，COUNT与offset SELECT不共享一致快照；唯一IDs及稳定total不能排除扫描中同ID改文。state=valid不包含invalidated archive；没有live行的observation_history孤儿也无法凭该清单枚举。live0不等于历史表0，更不能证明未知DELETE已经停止。

未来破坏性worker仍需可信写者/任务fence、实际store能力及读后写一致性证据，结合源文档完成、fresh统计、全部四态任务静止与独立完成结果。此次没有DELETE、consolidate、refresh或guard变更，没有访问真实服务/数据库。

固定版官方依据：[HTTP清单参数](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/api/http.py#L5632)、[抽象清单契约](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memories/base.py#L1854)、[PG分页与live/archive](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memories/pg/curation.py#L153)。
