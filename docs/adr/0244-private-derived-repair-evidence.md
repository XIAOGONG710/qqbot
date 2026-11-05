# ADR 0244：私有关系模型的持久修复与证据解封

状态：接受，2026-11-05。关联 ADR0241、0242、0243。

后续：旧世代已知UUID的有限收尾与新任务身份校验已由ADR0245接续；下文未完成项描述本ADR接受时的边界。

## 范围与依据

本批推进M32b，完成已知单一联系人的私有QQ片段与唯一relationship模型的自动修复子集。公共bank含日记、周记、阶段总结及跨联系人资料，旧进度没有完整输入依赖，不能证明它们已净化，继续保留原屏障。没有访问真实运行时、部署服务、数据库或角色资料。

官方固定版v0.10.2的fresh统计仅证明待整合与失败事实计数；文档替换会移除正确引用旧事实的观察，但统计不能证明历史悬空观察完整性。因此修复收据只解封该私有关系模型及已核对原始片段；所有曾污染bank的observation仍在请求、响应与最终格式化处排除，不将模型刷新冒充整库彻底遗忘。其他未污染bank保持原策略。

## 协议

1. derived.json升级v2，保存稳定来源事件、活动污染集合、修复租约、阶段证据及已修收据，不保存聊天或模型原文。相同精确来源重复观察为幂等；同键不同范围失败关闭。真实新撤回改变污染世代。合法v1迁移保留未知范围，未知owner/allDocuments不自动解封；已修事件保留收据以防启动扫描再次污染。
2. JSON仍唯一事实源，SQLite仅OS协调锁。锁内fresh合并、发布后确认、缺失见证及坏状态保原策略沿用。读世代在解封时更新；旧缓存和旧await结果不能在新世代复活。共享审计、导出、遗忘与归档仍保留活守卫、收据及协调文件。
3. LongTerm从可靠历史与已完成retained摘要构造完整私有文档清单，核对每个count前缀、正文摘要与服务器实际内容hash。缺历史、截断、pending、未知文档或多模型均不启动破坏性修复。服务器hash严格复现固定版sanitize行为，保留合法Unicode，不使用近似trim/NFC。
4. 开始修复后冻结该联系人远端片段提交，普通新消息仍在本地；每步fresh核验来源与污染世代。新撤回必须先更新已完成来源，不能以旧worker解新污染。普通追加不改变已派发前缀：pending核对与not_found恢复均使用原count前缀，不把合法新尾部误判为修订。
5. 每次推进有限阶段，无sleep或无限轮询：对应源文档任务完成，fresh stats且pending/failed均零，完整分页核对所有未结/失败/取消任务及文档/模型目录；确认唯一自有relationship后持久记录派发，暂停自动刷新，重新等静止，再clear并读回空内容。随后full刷新仅使用world/experience原始QQ事实，排除mental models、chunks和diary/week/phase标签。
6. 刷新必须返回合法UUID并独立GET核对operation类型、模型、completed以及content_written/content_unchanged；content_preserved_no_new_facts不是成功。读取实际模型、严格is_stale=false、精确水位、配置及完整目录再次匹配，再恢复原auto/间隔，并重新核对最终证据后CAS提交。微秒不截断；模型scope水位可以早于全bank写水位，不以错误大小关系阻合法修复。生产原策略仍为auto=true、1800秒，更新mission也保留安全full来源配置。
7. 所有mutation先写派发阶段，ACK后记录实际事实。refresh无客户端UUID，丢失ACK不盲重发；旧世代未结或未知派发扫描全部journal，不允许新租约绕过。stop取消纯读取，但等待已派mutation的ACK和检查点落盘后才完成drain。审计只记元数据，刷新受理只标accepted；审计失败不改主ACK。

## 保留边界

- 公共派生模型、旧日记/总结依赖及directretain提交协议仍待审；本批没有自动删除已回复事实或共享日记。
- 旧世代已有UUID的pending刷新遇到新污染时，当前也保持屏障，尚无自动旧世代settlement仲裁。可查询的证据不等于本实现已自动消费；需核实服务端后恢复，不能删除journal或改generation解除。
- failed/cancelled不能证明worker已停止；未知ACK、坏状态、旧不明文档/模型及目录不一致继续保护。历史观察不因relationship收据自动开放，后续须独立来源完整性或清理协议。
- 协调文件运行中不可删换，旧写者统一升级；50ms只为争锁预算。外部不合作写者、多文件与远端非事务、任意网络exactly-once、断电fsync及真实部署行为不在本批证明范围内。

官方依据（固定v0.10.2）：[fresh统计接口](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/api/http.py)、[模型刷新与保留旧内容分支](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py)、[历史孤儿观察回归与正常delta替换保证](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/tests/test_delta_retain_orphan_observations.py)。后者明确旧bug产生的有效观察可因源事实已不存在而不再被consolidation选中，故不能从当前计数推断历史观察已清。接口行为、过滤条件与阶段重启由合成假HTTP/API、真实临时JSON/SQLite、故障注入和完整回归验证；未把fake服务成功冒充真实部署清理证明。
