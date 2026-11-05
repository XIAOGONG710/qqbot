# ADR 0317：基于完整新字节的提交保护元数据复用

状态：接受，2026-11-05。接续 ADR 0313/0314，JSON 仍是唯一事实源。

合成3650条已完成意图、9.45MB outbox，三次blockedDocuments读取实际执行21900次SHA并同步阻塞约424ms；公共实体/日记/召回会多次走该读链。不能靠删历史正文、mtime/size或TTL放松保护。

新增guardState(bank)，返回当前文档UUID/requestHash/phase及blockedDocuments元数据，不暴露正文。每次仍取得OS协调锁、检查目录/marker，并读取完整JSON原字节。仅当本次字节与已完整校验的上次字节完全相同时，复用私有不可变元数据；对外给副本。字节变化重parse/完整schema及hash校验，IO/marker/JSON缺失/坏coord不能回退RAM。dirty观察先走原RMW持久flush，RMW始终fresh读取并完整校验，不使用可能已被局部写失败污染的可变缓存。

正式回归校验三次完整字节读取仍发生、重复JSON.parse和SHA为0；同mtime同长度改文、另一实例/子进程写屏障、返回对象被修改、坏hash/IO/marker/coord及RMW发布失败均覆盖。本机同规模复测约51–55ms，仍读取28.36MB；这是合成warm测量，不是生产SLA或常数时间保证。

可运行docs/reviews/repro/memory-source-resource.mjs量测，正确性由正式回归单独验证。所有数据在临时目录生成，未访问真实runtime/角色/API。协调协议、旧写者升级与不可删换协调文件约定不变，未新增fsync/网络FS或任意外部写者保证。
