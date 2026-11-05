# ADR 0242：派生记忆污染的持久读取屏障

状态：接受，2026-11-05。关联 ADR0082、0239、0241。

## 事实与范围

M32b合成反例：文档已占位覆盖并重启，供应商关系/印象模型仍旧；A的聊天可污染B的公共印象和实体缓存，返回观察不会因`prefer_observations:false`自动消失。本地旧日记也能绕过远端读取守卫，进入新周记/阶段总结模型。

本批修复客户端读取和再次生成/提交的旁路。受污染模型的自动重建与有证据解封尚未完成，不能把本批称为外部数据已删除或全部模型已刷新。

## 决定

1. 新`memory/derived.json`保存按bank绑定的污染世代、精确document集合及明确qq/tier来源；无原文。私人和公共标记用同次JSON原子发布，不能在两次发布之间留崩溃窗口。当前无clear/过期接口；同库证据只能累积，未知文档范围不能被后来的精确范围覆盖。
2. SQLite仅提供短同步OS互斥，JSON仍为事实源。锁内重读合并，失败保留RAM增量并拒绝未确认读取；发布后异常只有精确读回匹配才确认。首次clean也必须发布空状态。已有协调文件或本实例曾读过状态而JSON缺失，保留证据失败关闭，重启不猜clean。协调文件运行中不可删除/替换，50ms仅争锁预算。
3. 接受撤回时立即同步建立屏障并使未派发旧快照失效。`ChatHistory.load`仅对真实持久撤回生成`recalled:true`视图标识，剥离原JSONL同名字段，不能用字面占位文本猜来源。App在回复器创建前恢复旧已遮盖历史的屏障；坏历史来源先保守屏蔽该owner。同步入口在任何await前也识别修订，SDK嵌入者须提供当前可靠来源快照。
4. 脏私人bank屏蔽关系模型与观察；脏公共bank屏蔽所有公共person模型、实体和无可靠来源的派生输出，不能只清撤回者自己的模型。缓存命中前、await后与最终格式化后复核世代，旧在途结果不重填/输出。day/week二次召回、别人今天、日记原文同守界。
5. 脏bank仍允许明确`world/experience`且绑定标准未污染原始episode文档的事实；未知来源、污染文档、diary/week/phase及观察不凭字段外形冒充原始事实。精确文档未知时只扩大对应来源owner，保留其他私人bank与可证明未污染的公共原始事实。坏中央状态不能证明哪些bank干净，读取失败关闭。
6. 日记生成前、读取/生成await后及新retain派发前检查公共派生可用性。本地旧texts不能绕过守卫再次进入模型；暂停不删除旧资料、不标空总结或完成。已派发retain确认后仍保存真实written进度，不把已发生事实改判未发。
7. 集中元数据及协调见证纳入按明确owner.qq识别的共享隐私清单，覆盖实际`derived.json.tmp-PID-seq`残留。半行或坏临时片段仅报告共享归属未知，不猜联系人、不回显原文；不收入任意前缀文件。遗忘保留共享store与协调文件；导出不复制其他人的共享内容。归档保留活守卫并报告例外；新bank可用，切回旧bank仍受原屏障保护，不因移动源联系人文件误解封第三人的模型。

## 待完成与运维边界

当前屏障会使受污染bank的派生能力暂停，直到实现可验证修订协议；原始事实与其他bank保持上述可用范围。不能手动删除guard、只看时间戳或传一个布尔值来解除保护。坏状态需保留原件恢复/核实，不自动隔离成空白。

官方v0.10.2源码显示：需要fresh stats（`refresh=true`，同时检查pending与failed consolidation）、任务静止、覆盖旧联系人/档位的完整模型清单、安全full重建且排除旧mental models，以及核验刷新outcome。`content_preserved_no_new_facts`即使completed并更新时间戳也保留旧正文；仍不能解封。日记/总结的来源依赖缺失同样要纳入修订证据，不猜测删除已回复事实。上述自动修订本批未实现。

新发现M33：承诺模型等待期间撤回未回复的确认，旧提取结果仍能保存early约见，同消息数再次同步及重启仍生效。已保存独立合成诊断，未修复，不能声称本批守卫覆盖所有跨模块派生状态。

未访问真实运行目录、QQ、模型服务或数据库，未部署。验证为临时合成数据、假HTTP/API、跨进程store测试和故障注入，不宣称网络FS、断电fsync或exactly-once。

官方依据：[fresh统计](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/api/http.py#L9474)、[跨模型默认来源](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L17802)、[保留旧正文的完成结果](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L18740)。
