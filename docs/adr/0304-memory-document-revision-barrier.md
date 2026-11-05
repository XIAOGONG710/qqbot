# ADR 0304：撤回后的文档修订与持久异步屏障

状态：接受。2026-11-05。关联 ADR0013、0068、0082、0302、0303。

## 证据

M31：30条未回复开放片段已写入后撤回一条，消息数不变，旧计数进度使私人/公共文档保留原文；建库等待期间排入遮盖快照也会被旧任务吞掉。合成 App 另证实成功撤回未立即同步记忆，休眠启动仍派发记忆请求。M32a：供应商已经修好模型，旧本地关系/印象缓存仍返回撤回正文。

Hindsight 0.10.2 官方源码表明：异步受理不是完成；同文档串行锁不阻止退避中的旧任务被新任务超越。同 UUID 不绑定新正文，取消不证明 worker 已停止。源码核对只读取公开版本，未访问真实服务或运行目录。

## 决定

1. 进度保留消息计数，增加实际已提交前缀的 SHA-256 摘要。相同条数、前缀改变、条数缩短或旧计数缺摘要，均需要按原稳定 document ID 修订；未改变的正常新增仍遵循 OPEN_EPISODE_STEP。每联系人同步世代使未派发旧快照失效，已派发事实仍记录实际摘要，最新任务重读进度后继续。
2. 撤回被接受后立即以当前档位/启用边界的遮盖历史同步。读取或持久观察失败不向记忆提交旧正文；仅 RAM 中已接受的新撤回观察世代可以安排恢复。等待媒体的撤回保留同步标记到追加完成，休眠/停止不派发，重启从历史和协议状态恢复；不凭错误文案猜测已经接受观察。
3. 真实 SDK 使用客户端 UUID 和精确任务状态接口。Contact 进度内先持久不可变请求、请求哈希、UUID、bank/document、计数和正文摘要，再派发。受理后保留 pending；只有父任务 completed 且非空 children 全部 completed 才发布实际完成摘要并允许下一版本。一次同步只查询状态，不无限轮询或永久持有进程锁。
4. 丢 ACK、超时和重启保留同一 pending。not_found 且当前正文不变时才允许原 UUID/原请求重投；正文已变则失败关闭，不重新外发撤回原文。failed/cancelled 不自动清屏障或创建新任务。停机等待已派发请求收尾；未完成远端任务留给下次核对，不冒认完成。
5. 新 UUID 派发前确认 bank 中 retain、batch_retain、file_convert_retain 的 pending/processing 任务均为空。按 type/total 查询，不用首100条推断没有旧任务，防升级前未知任务迟到覆盖。此只读检查不是跨外部写者事务；所有写者须统一协议，不允许外部手工重试破坏顺序。
6. 保存 pending 后 Contact 文件已含关键派发事实，不能再按“可重建计数”丢弃坏状态。具备可恢复协议的 API 路径遇坏 JSON/schema 保原失败关闭；有未确认 pending 时换 bank 前缀也失败关闭。无此能力的旧 API 保留 ADR0013 的稳定文档覆盖恢复，但其 void retain 完成语义由提供方承担。Common 配置文件本身不存派发意图。
7. 敏感片段不写公共库。若进度证明旧公共文档可能存在，先核对其在途任务，再仅删除该联系人的稳定公共文档；确认后才保存 skip 摘要。缺能力或失败不冒认已经清理，不删除他人文档或整个公共库。
8. 修订识别时和完成时精准失效该联系人的关系/印象缓存，晚读取不能复填被删除缓存；正常追加和他人缓存保留。此仅修本地缓存，不证明供应商模型已刷新。新异步受理与精确删除经记忆审计代理，账本只存摘要和身份哈希，不复制请求正文。

## 运维与残余

pending 请求正文只存原有私有 `memory/<QQ>-<tier>.json`，该文件及实际临时/隔离残留已由隐私审计、导出、遗忘和封存清单覆盖。不可删除 pending 或编辑 UUID/正文来解除屏障；任务失败、取消、变正文后 missing 或坏协议状态需保留证据核实服务端状态后恢复，不能自动猜测。未部署、未访问真实数据或数据库；本轮以假 HTTP、API、临时文件和故障注入验证客户端协议。

**M32b 仍未修复**：官方实现明确 retain 完成之后还有 consolidation，文档替换不等于所有 mental model 已修订。即使重启清空 RAM，也可能读回供应商保留的旧模型正文；另有合成探针。派生模型需要持久修订屏障和独立完成证据，不能用刷新 ACK、文档覆盖或上述缓存失效声称彻底遗忘。日记/总结的直接 retain 尚未接入本次 episode pending 协议；旧弱消息身份、多文件非事务及强杀未持久观察边界不变。

官方依据：[UUID幂等及不同正文](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/tests/test_async_retain_operation_id.py#L121)、[退避与串行条件](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/db/ops.py#L91)、[HTTP协议](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/api/http.py#L9970)、[任务状态](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L21524)、[派生修订边界](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L18088)。
