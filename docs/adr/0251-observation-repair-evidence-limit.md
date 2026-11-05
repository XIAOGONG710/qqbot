# ADR 0251：观察重建的只读证据与能力边界

状态：接受，2026-11-05。接续ADR0244、0245。

SDK补两项可选读取能力：repairObservationStats强制fresh，核对fact-type计数、总数、pending/failed与完整微秒水位；repairConsolidationStatus严格绑定UUID及consolidation类型，completed只说明一轮，不冒充后继链静止。现有完整四态分页继续核对整bank任务。缺字段、矛盾计数或未知形状安全失败，不补零。

本批没有清理或派发接口，也没有解封观察。固定v0.10.2的HTTP/version只有版本/feature，worker同时可用于不同数据库；bank/config过滤基础设施静态字段，不能证明database_backend或实际memory-store身份。DELETE observations还按store_owned_for(bank)分支，即使知道数据库是PG也不足以证明使用PG事务清理路径。

不能用布尔配置、版本号或stats零猜测部署能力。本轮限制是独立证据不足，真实服务/配置/数据库按用户约束未访问。后续须可信部署适配证明或真正后端无关的完整观察清空证据，才可实现破坏性清理worker；unknown DELETE仍不盲重试，公共diary/week/phase来源依赖也不能跳过。

官方固定版依据：[version](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/api/http.py#L4651)、[配置投影](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/config_resolver.py#L267)、[按实际store选择清理分支](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L11778)。验证使用假HTTP与合成响应，没有真实API或数据库操作。
