# 记忆与数据：深入审查（进行中）

阶段一。修复复现实验使用合成聊天、临时目录和假API；未访问真实runtime，未连接真实记忆库、模型或QQ。此前模块完成不代表记忆模块完成。

**验证资料范围更正（第十一批）**：此前“全部操作使用合成资料/未读取角色资料”的表述过宽；既有全量回归中有用例加载仓库角色卡。第十一批副代理也误跑了9项旧diary用例（两张仓库卡），已明确停止该类执行并重跑剔除它们的合成集；没有把卡或正文外发给服务。历史测试通过数量仍是当时实际结果，但不能据此称全合成。本轮主代理仅执行已确认以临时合成卡/假API工作的463项集合和全仓类型检查，没有新跑全仓测试；463项不冒充完整仓库覆盖。后续验证须先识别fixture来源，角色卡依赖用例在合成化之前不运行，不改弱断言凑绿。

## 文件与数据流清单

登记范围是整个 `packages/bot/src/memory/`，共18个源文件。

| 工作流 | 自有文件 | 直接链路与当前覆盖 |
| --- | --- | --- |
| 本地聊天与补回 | history、backfill | app 接收/补回/媒体等待后的去重、contact 提示词与换档；已修存储边界，短 ID 身份协议待贯通 |
| JSON/时间/schema | json-file、state-schema、transient-io | 世界、生活、照片、危机及主动状态直接消费者；共享修复需全仓验证 |
| 长期写入与召回 | long-term、hindsight、episodes、fading | config、app/contact、日记/周记、公共库、后台同步、模拟器；本批只完成运输边界和排队快照等子集，完整生命周期尚待深入 |
| 审计/设定/换档 | ledger、identity、memory-audit、tier-record、timeline | app 启动/提示词/命令、审计与纠错 CLI、跨渠道事实；本批修复后继续复核副状态及恢复 |
| 隐私/归档/休眠 | privacy-audit、privacy-forget、archive、dormancy | CLI 演练/导出/回收、app 商量/确认/取消/唤醒、旧 bank 归属；已修本批确证缺陷，停机协调与多步骤恢复待审 |

依据模块文档及 ADR0012/0016/0017/0018/0043/0157/0158/0159/0161；保持危机隔离、披露、换档和记忆变淡既定策略。

## 本批发现与修复

编号是证据分组，不代表完整模块清单。

- M01：不可序列化 JSON 根值会覆盖旧状态为 `undefined`。现在序列化成功后才写；坏 JSON 错误不包含解析器回显的私密原文。
- M02：本地四位年时间戳可能跨时区溢出 UTC 四位年持久格式。共享 schema 同时检查 UTC 边界，保留合法低年份。
- M03：JSONL 崩溃半行会与下次追加粘连；缓存条目可被调用方修改。补分隔符并隔离对象别名，不删除旧字节。
- M04：坏补回 ID、源时间、消息/媒体容器可拖垮整批；同批完全重复事实和未来历史会触发不应发生的处理。逐条校验并保留其余合法数据。
- M05：撤回标记坏 JSON/schema 被当作没有撤回，原文重新可见。现在保留原件并失败关闭；没有擅自迁移裸 ID 格式。
- M06：同大小/mtime 原子替换后活进程仍读旧缓存，重启却读新事实；存在探测还会吞 IO 错误。缓存增加文件身份及纳秒时间，仅 ENOENT 视为缺失。
- M07：坏休眠控制状态可自动醒来；提议异步回复可覆盖已经取消、确认或替换的状态。严格校验原件不动，UUID 提议令牌及 app CAS 回填；损坏封存核对与损坏控制状态分别处理。
- M08：封存 manifest 畸形/越界或链接可导致异常或越界读取。校验路径、schema 与链接；核对失败仍按既定约定醒来并报告。
- M09：同秒导出/遗忘恢复资料、归档档位快照可能覆盖；审计/归档可跟随联系人命名链接。原子预留独立批次、独占快照并拒绝链接，保留档位附加元数据。
- M10：历史 bank 前缀更换后，仅删除当前公共库会漏掉可归属的旧公共文档。增加按标准联系人哈希证明的精确历史库目标；无法证明的旧库明确列为未解决。
- M11：休眠封存副本仍为 proposed，按说明恢复后无法唤醒。确认时在 manifest 生成前写入副本 dormant 状态，完整封存成功后才发布 live 状态；以真正复制恢复验证。
- M12：账本追加会覆盖旧 head，掩盖已截尾证据；坏 schema 抛异常，Date/toJSON/稀疏数组哈希与实际 JSON 不一致。规范化序列化、校验坏行占位、锁内重读并拒绝坏链追加，head 原子发布。
- M13：档位写失败后先发布内存，同档重试跳过持久化，重启丢失降档屏障。确认持久发布后才更新内存，坏 schema/错误正文不泄漏。
- M14：设定账本坏链仍继续追加、删除文件缺少提交依据却可被视为解释充分；审计准备/日志失败会改变远端成功的主结果。保留断点、复核删除依据，派生审计失败安全降级。
- M15：时间线未来一分钟事实可提前可见、按追加顺序截取会丢掉真正最新事实、半行与裁剪失败会影响追加结果。按可见时刻筛选排序，区分追加成功与派生维护失败。
- M16：Hindsight 错误包含 HTTP 私密正文、文档路径或 JSON 片段；超时只依赖 fetch 的 abort，忽略取消的正文可永久挂起；正文无限读取。固定安全分类、覆盖整个请求的独立 deadline、取消 reader、8 MiB 运输上限，404 原有契约保留。
- M17：畸形召回字段可进入提示词处理，服务端伪造客户端 sources 可改变长期标记判断。校验召回字段，仅从返回的 source_facts 构建 sources。
- M18：排队后修改聊天对象/称呼/联系人会改变这次提交的事实。排队入口持有快照，完成后清理队列槽，不清除后续排队任务。
- M19：日记/周记变淡日期的数值 Date 构造把 0099 变成1999。使用现有本地日期工厂，不改既定变淡周期。

## 必须继续的工作

1. **M20短消息 ID 来源身份仍有协议边界**：明确源信息的live/backfill/撤回/媒体链及第三批待媒体撤回窗口已处理；仍有ACK-only助手弱身份、缺seq的同秒歧义、孤立legacy wildcard，以及无法准确归属的迟到/重复撤回通知。助手本地ACK时间和NapCat源秒不同，不能伪造来源或以get_msg短ID反查冒充权威。不得把已处理子集称为上游全链唯一身份保证。
2. long-term 状态文件仍缺完整 schema/坏状态策略；完整读写、公共库配置/实体/关系缓存、未来历史、取消/停止及重启失败恢复尚待深入。episodes 顺序与异常时间边界、fading 日期真实性/跨日历边界尚待针对性复现。
3. 遗忘/归档仅检查 bot.lock，没有持有覆盖全过程的停机协调协议；并发启动和外部文件替换仍有 TOCTOU。多文件移动与远端删除不构成事务；失败报告/回收原件需复核，崩溃中途没有自动续跑协议。M21已补feedback等明确结构清单，旧无来源反馈和自由文本仍不能猜测归属。
4. 账本 JSONL 与 head 是两文件发布：中间崩溃保守失败关闭，不能宣称自动恢复或 exactly-once。旧写者必须统一升级；协调文件运行期间不能删除/替换，50ms 仅争锁预算。
5. identity toldSeq 副状态已在M22处理，旧无hash历史及多写者边界保留；timeline仍遵循单写者约定，不宣称多实例安全。全量历史扫描成本与大量联系人/后台队列资源仍需测量。
6. 遗忘公共自然语言日记、外部服务/备份及不明旧 bank 归属仍须人工核实，不能把导出/移动成功称为彻底遗忘。

## 验证与提交

新增43项回归：存储12、审计/账本11、隐私/休眠11及app集成2、API/快照/低年7。关键错误行为先用旧实现证实；进程回归包括两写者24次成功均持久、完整/半行追加故障、head发布前后故障、JSONL后/head前强杀。休眠恢复用实际cpSync到独立临时数据目录后重新构造实例并唤醒；所有网络均为假API/假fetch。

首轮全量2698项仅1项错误文案兼容断言失败（schema分类被脱敏文案遗漏），保留安全schema分类后相关9项通过，最终重新运行全量2698/2698通过：bot2551、转换61、Koishi47、移动35、PWA4。全仓类型、模块登记4项及差异检查通过。未部署、未推送、未访问真实runtime。

独立本地提交：`56409aab`存储与历史；`5f763d3d`审计链/换档/时间线；`9d2675f8`隐私与休眠恢复；`3dabd900`外部API与排队快照。模块未完成，不进入下一模块或社区比较。

## 第二批：来源身份、隐私清单与告知状态

- **M20，部分处理，仍open**：复现合法短ID在新源秒复用被吞、同秒不同原始序号被吞、用户与助手角色碰撞。现贯通 live 三处检查、补回、媒体等待后的复核、responder 和设备 capture 的源序号；补回助手保存明确 sourceTime。原始序号保留大整数字符串和0。旧ACK-only助手显式弱ID兼容，不伪造源时间，后续助手重用漏补仍未解决。
- 撤回 version2 仅对当时未答非keep候选的具体发生条目及内容哈希占位；旧number[]在raw历史中冻结原隐藏条目后才接受新追加，保留孤立旧ID wildcard。覆盖发布前故障、发布后EIO读回确认、重启及同元数据不同正文的危机例外。未知扩展保留，最近200个不同短ID保留顺序持久化；不宣称总metadata只有200行。
- **M21**：privacy-audit遗漏有明确归属的反馈月文件、intimacy按QQ状态、presence.peek好友空间缓存、account好友动作及记忆审计链。按结构补齐混合文件和head清单；同号群/B站uid不当作QQ，旧无来源反馈/坏行仅报告限制，不猜分配。privacy-forget自然进入leave，不移动共享月文件或拆改哈希链。
- **M22**：identity.toldSeq坏JSON/schema/IO被当作-1或可覆盖，副状态未原子发布，也未绑定历史。现失败关闭原件不动、原子发布与读回确认，新toldHash绑定对应账本条目，后续合法追加保持可用。兼容旧只有toldSeq及扩展字段；旧无hash不能证明历史身份，多进程markTold不保证exactly-once。ADR0157明定“提示词放入即告知”，未误改为必须发送后才记。
- **M23**：共享媒体读取器只按短ID合并任务，导致不同源图片乃至不同联系人的解析混用。增加联系人/来源身份，并按任务对象精确清理；真实App合成测试覆盖两张不同源同ID图片、补回等待期间实时复用、两个联系人同ID/秒/序号图片隔离。原“同一语音live+补回”夹具改为相同QQ源时间，保留只解析一次的既定回归意义。
- **M24**：新来源解析在权限判断前对畸形time同步抛RangeError；补充入口安全校验并覆盖实时/缓冲排空，不降级为弱身份。设备capture回传也携带原始序号。整合时类型检查发现临时变量遮蔽设定账本对象，立即改名后重新验证，未提交该中间版本。

新协议与兼容边界见ADR0238。第二批新增28项回归：来源/撤回13、隐私清单6、告知状态5、App集成4。类型检查发现名称遮蔽后已修正并通过；首轮全量仅1处旧重复消息夹具把不同QQ源时间当成同一重投，已对齐来源时间并保持原有一次处理/回复断言，定向复验通过。最终重新全量2726/2726通过（bot2579、转换61、Koishi47、移动35、PWA4），全仓类型、模块登记4项及差异检查通过。记忆审查累计新增71项回归。

本地独立提交：`f4e0b237`告知副状态，`3315dc2c`隐私清单，`8e20f266`明确来源与媒体隔离。未推送、未部署，原未跟踪AGENTS.md未纳入。后续必须继续M20未覆盖的旧助手、原始撤回通知/媒体等待窗口，以及long-term生命周期/schema/缓存/失败恢复，不能因本批通过转入下一模块。

### 下一批首要确证缺陷：待媒体撤回窗口

只读复核代理以真实App和假voiceToText/ocr各做一次独立合成复现：收到合法源事件后让媒体解析held，确认历史userRows=0；对同联系人/短ID发送friend_recall，再释放解析。语音、图片两路均出现historyContainsDecoded=true、promptContainsDecoded=true、userRows=1。`receiveRecall`只查询已经append的ChatHistory，未落盘时返回false并遗失通知。这是**已确认未修复**的竞态，不属于本批M20处理完成部分。

上述窗口已在下述第三批按持久预约协议处理；不是仅内存map、append后补recall或丢弃全部媒体。已保留此处原始复现证据供复核。

## 第三批：待媒体撤回的持久预约协议

协议见ADR0239。旧version2兼容增加pending/kept；待处理输入先登记来源和原载荷，撤回绑定当时的随机token集合。首次解码正文和危机keep决定固定；精确标记先原子发布，再允许JSONL原文追加和生成。新增incomingId把追加结果与预约绑定；已完整发布后异常可读回确认，清理失败不重放，未prepared来源不凭弱元数据吞掉。

处理额外确证守界：首次stage写失败及连续两ID撤回在dirty期间都保留观察；普通读取/准备/追加仍先flush，失败关闭。已回复事实不因残留pending再遮盖；裸append不能绕过已撤回的预约。接收缓冲遇一次入口读失败不再在finally删除原预约，自动恢复无需用户重投。重试按联系人隔离并共享inbox所有者，停止后晚媒体不追加；休眠仅保存此前解码的prepared，不追加/生成，醒来复用，不越过换档since。补充回归确认降档只阻止重放、不擅自删除旧私有prepared，首次集成的删除分支已红→绿改为保留；中断命令同样保留原请求，本地恢复不重新调用命令处理器。

**M28已处理**：pending文件现在含私密原载荷和解码正文，原隐私清单/归档只看JSONL会漏掉它。审计、导出、遗忘补齐精确QQ的recalled.json及实际格式的tmp/corrupt残留；归档同时搬走没有任何JSONL的孤立预约，保持原字节、按QQ可归属名称和其他联系人数据。原CLI全程停机锁/多文件事务限制未改变。

新增37项正式回归：存储19、完整App14、缓冲IO1、隐私/归档3。关键原始媒体、缓冲丢载荷、脏观察及清单遗漏均有旧实现红灯证据；应用层全部使用临时合成角色卡、假语音/OCR/历史/模型，网络访问计数严格为0。最终全量2763/2763通过（bot2616、转换61、Koishi47、移动35、PWA4），全仓类型、模块登记4项及差异检查通过；记忆审查累计新增108项回归。

本地独立提交：`6d12da19`持久预约/观察/追加守界，`b115dfbe`应用接线与恢复，`97230647`隐私/归档覆盖。未推送、未部署，原未跟踪AGENTS.md仍未提交。M20已确认的待媒体撤回窗口完成本批处理，仍保留ADR0238/0239所述协议边界；整个记忆模块未完成。

### 下一组已确认、未修复：long-term

- **M25**：App首个fake putBank held，在尚未retain时stop并释放运行锁；释放putBank后仍新增5次模型/私人及公共记忆请求并写入联系人state。此时所有后续请求都可被取消，不能用“请求已发出”解释。需要实例停止/排队守卫、每个await后检查及app停止接线，同时明确已确认远端写入的进度处理，不能一律丢掉已发生事实或提前释放锁允许旧实例竞争。
- **M26**：合法JSON `retained:[]` 被当作计数字典，远端retain成功后数组字符串属性被JSON丢弃；连续sync同片段两次远端写两次，磁盘仍[]。只有retained计数、没有bankId也能跳过首次建库/写入。需要完整Contact/Common schema与bank身份兼容；ADR0013允许坏进度按稳定document覆盖重写，不能把既定一次恢复重放误报为缺陷或猜测旧迁移。
- **M27**：commonEntities并发A旧请求held，B成功给出新实体，A随后失败却覆盖为其捕获的旧空names，并保持新鲜10分钟。只调用了两次list即可复现；需要singleflight/世代提交与写入失效边界复核，不能让旧结果延长旧缓存。

三个反例均为独立临时目录、假API/App，未改long-term源或真实数据。下一轮先接续M25–M27，再继续long-term剩余字段/模型接口、episodes/fading、CLI协调与资源性能；整个记忆模块仍未完成，不进入下一模块。

## 第四批：长期生命周期、日历边界与停止调用链

以上“下一组已确认、未修复”保留的是第三批结束时的证据和状态；**M25–M27现已在本批修复**。前文“必须继续的工作”中相关schema、实体缓存、episodes/fading及停止链条已有下述进展，不能将旧状态当作本批完成后的结论。未列入本批保证的边界仍须继续审查。

- **M25已修复**：LongTermMemory停止时同步关闭新任务、后续排队任务及每个await之后的派发入口；纯读取可取消等待，晚返回不重新发布缓存或发起写入。已经派发的putBank、retain、模型写入则等待ACK并保存对应已发生进度，重复stop复用同一drain，不把整段尚未完成的模型初始化冒认完成。实际App合成回归确认retain held期间旧实例继续持锁，ACK及进度收尾后才允许释放；idle停止仍可同步收束。SDK调用本身的超时不等于远端取消，不承诺网络exactly-once。
- **M26已修复**：完整校验Contact/Common进度形状、计数与bank身份；数组等坏进度隔离保留原件，依ADR0013使用稳定document ID重新覆盖恢复。合法旧boolean/字符串版本标记及未知扩展保留，换bank不沿用旧库完成计数；真实暂时IO错误不隔离、不覆盖有效进度，也不继续派发远端写入。这是进度可重建状态的恢复政策，不套用需要失败关闭的撤回/启用锚点政策。
- **M27已修复**：公共实体读取singleflight；公共写入使在途读取失效，旧响应不能把失效缓存重新标成新鲜，停止后晚读取不发布。合成回归覆盖并发实体请求、公共写入与读取交错，以及停止期间读取永不返回。
- **M29，片段日期与资源边界已修复子集**：episodes对坏时间及不存在的ISO日历日安全失败，避免ep-NaN和自动滚日；保持合法消息追加顺序、原片段ID与低年份，未以排序改写对话事实。localIso只在真正持久输出时校验本地与UTC四位年及有限瞬时，保留合法0099与现代输出。fading拒绝不存在的日记/周记/阶段ID日期和ISO事件日期，回退合法事件时间；没有合法时间仍保留原undefined行为，不改变lasting策略。淡化天差改按civil日序，Pacific/Apia整日跳过的8天/31天不再误算为7/30个24小时；淡化阈值与重要标记策略不变。实体至少两个Unicode代码点的判断不再全展开字符串：600万字符、48 MiB堆子进程由旧实现OOM退出转为正常完成，单个/两个emoji语义不变。
- **M30，停止调用链已修复子集**：Responder区分纯生成与已派发发送；纯生成/错字延迟可取消等待，已派发发送、撤回等待ACK及必要历史收尾，停止后不再发下一气泡或纠正。发送ACK后的历史/副索引失败不冒充传输失败而重发。diary停止后不再生成/读取下一篇；纯生成和旧日记读取的晚结果不提交，已经派发的日记/总结retain等待ACK并保存written/texts，保存失败明确使drain失败。PromiseKeeper新增stop，阻止新sync、下一联系人/片段和下一次提取；模型取消race覆盖永不返回、同步停止和晚reject，晚结果不写承诺或世界，既有同步提交事实保留。App汇合这些drain后再放数据目录锁；主进程及Koishi宿主等待停止收尾，再断传输/完成卸载。同PID活租约不可重入，旧release重复调用不能删除新租约，忙目录启动在读取角色卡或修改状态前失败，构造失败释放本次租约。

### 新确证仍未修复：M31，撤回后counts-only长期进度留存原文

合成脚本`docs/reviews/repro/memory-recall-progress.mjs`（原工作探针为`work/memory-recall-progress-review.mjs`）使用临时ChatHistory和假Hindsight文档Map证明两个反例；均为30条user-only消息、距最后消息约14.5分钟的开放片段：

1. 尚无助手回复的开放片段达到OPEN_EPISODE_STEP，先完成私人及公共retain，再撤回其中一条user。ChatHistory已返回占位正文，消息条数不变；再次sync仍按相同计数认为完成，私人和公共文档都保留撤回前原文，总retain只有首次两次。
2. 同一开放片段首次sync已捕获正文快照，但putBank held期间撤回；第二次sync排入已遮盖历史。释放首个putBank后，旧快照仍retain私人及公共原文，第二次任务又被相同计数跳过，两个文档依然含原文。

两例仅合成数据，无真实记忆库；这不是“未发出请求可以取消”的停止问题，也不能用本地history已遮盖声称远端已清除。当前进度仅计数，缺少正文变化/撤回的文档更新依据；后续须协调撤回事实与长期文档身份、覆盖/清除及公共库派生事实，不能局部删除计数或换document ID制造更多旧副本。**M31保持open，本批未修改撤回后长期修订协议。**

### 本批验证状态与保留边界

正式新增45项回归：episodes/fading日期与资源7、Promise停止6、diary停止7、Responder停止/ACK9、长期state4、长期SDK生命周期/实体8、根锁3、真实App发送收尾1。全部使用合成卡/聊天、假API/传输、临时目录和受限堆子进程，未访问真实QQ、Hindsight、运行时或隐私数据。真实App另覆盖同PID重启争锁与ACK历史收尾，SDK集成使用独立子进程验证收尾期间不能启动第二实例。日期相关95项、Promise相关51项、runtime及发送相关80项等定向组合通过。

首轮完整2808项有2处失败：旧promise-state夹具假定sync已同步进入模型，与先登记任务/取消监听的新时序不符；增加真实extract开始屏障后保留全部坏状态/世界不写断言。Responder提前返回漏原固定安全日志，恢复文案并保留不派发review的守卫。两处修正后重跑最终完整2808/2808通过（bot2661、转换61、Koishi47、移动35、PWA4），全仓类型、模块登记4项与Git差异检查通过。记忆审查累计新增153项，没有以首轮定向绿灯或失败全量冒认完成。已派发写入的ACK可能不返回；任意不合作fake不能保证drain自行完成，不能用提前放锁换取表面上的停止完成。

独立本地代码提交`4af477f3`（日期/资源）、`0ff67f6c`（长期状态/缓存与停止调用链），协议ADR0240。诊断M31仅保存证据，未计为修复；不推送、不部署，原未跟踪AGENTS.md保留。

保留的具体边界：合法civil日期`2011-12-30`在Pacific/Apia本地整日不存在，当前lastTouched的Date返回接口仍会归到31日；需要后续civil日期接口与消费链协同，未全局改变localDate的原生DST/溢出约定。OneBot源秒相对本地ACK毫秒的倒置仍按发生追加顺序保留，未擅改片段ID/文档身份。B站/presence外层直接发送的ACK持久owner不在本轮drain保证内；真正覆盖CLI全过程的停机锁仍未修。M20旧弱身份、跨崩溃尚未成功持久观察、外部写者及多文件/远端非事务边界继续保留。整个记忆模块未完成，不转入下一模块或社区比较。

## 第五批：撤回后的文档修订、异步派发屏障与模型缓存

上文M31“仍未修复”记录的是第四批结束时的证据，保留两条原始反例，不删除或改写当时结论。**本批已推进M31的本地修订和受控异步协议，并修复M32a本地缓存；外部衍生模型M32b仍open。** 协议、官方源码依据和运维边界见[ADR0241](../adr/0241-memory-document-revision-barrier.md)。旧`repro/memory-recall-progress.mjs`原为缺陷诊断，本批已改为正确的稳定文档遮盖断言；它仅验证同步fake Map语义，真实异步屏障另由SDK与正式回归验证，不把探针成功当作外部全部修订完成。

- **M31，本地进度与快照修订已处理**：保留原消息计数，增加实际提交前缀的SHA-256摘要。同条数正文改变、已提交前缀改变或缩短、旧计数缺少摘要，均用原稳定document ID重新提交；正常未改变的新增消息不足OPEN_EPISODE_STEP仍不触发整段重写。旧只有count的进度需要一次稳定文档重提交建立摘要证据，不拿当前历史的摘要冒认远端已处理。每个联系人/档位有最新sync世代，在排队开始及每次retain派发前守卫旧快照；已派发的事实仍记实际内容摘要，最新任务重读进度继续修订。调用方修改原数组不改变已捕获的快照，未恢复共享可变对象。
- **M31，真实SDK的持久异步屏障已接入**：官方v0.10.2源码证实，异步受理不是完成，同文档串行锁不能阻止退避中的旧任务被新任务超越，同UUID也不校验新正文。因此不以假供应商Map覆盖成功证明真实任务有序。具备submitRetain/retentionStatus能力时，Contact状态在派发前保存UUID、目标库/文档、计数、摘要、不可变请求及requestHash；超时或重启保留同一intent。只有SDK严格确认父任务completed且非空children全部completed，才记实际完成摘要并允许下一版本；每轮有限查询，不无限轮询或占用停止锁。新UUID前按任务类型和total确认bank没有旧pending/processing retain工作，不能用第一页或前100条推断空闲。此检查不构成与外部写者的事务锁。
- **M31，失败恢复不猜结果**：not_found且当前正文相同，才允许原UUID和原请求幂等重投；正文已撤回或改变则失败关闭，不重新外发旧正文。failed/cancelled也不证明旧worker已经结束，不自动清屏障或换UUID。advanced路径的Contact文件已经是关键派发协议状态，坏JSON/schema、请求哈希或归属不一致必须保留原件失败关闭；尚有pending时更换bank前缀同样拒绝覆盖旧状态。上述状态需保留证据、人工核实服务端后恢复。无新协议能力的旧自定义API仍沿ADR0013恢复可重建进度，其void retain完成语义由提供方承担，不获得真实异步屏障保证。pending正文留在原私有`memory/<QQ>-<tier>.json`及其实际临时残留，隐私审计/导出/遗忘既有精确专属清单覆盖，不写进日志或审计正文。
- **M31，App接线与观察恢复已处理**：成功接受撤回后，立即用当前档位及启用边界内的遮盖历史同步记忆；读取或持久观察失败不提交旧正文，不按错误文案猜测观察已经接受。已接受的新RAM撤回观察世代可安排恢复，待媒体撤回的同步标记保留到追加完成。休眠和停止时不派发，重启依持久历史与协议状态恢复。补充的history观察证据使调用方可以区分真实接受的新观察与未成功的尝试，未把仅内存观察升级为跨崩溃耐久保证。
- **M31，公共敏感片段的明确文档清理已处理**：保持ADR0068整段危机内容不进公共库。若既有进度表明旧公共文档可能存在，先等待已知在途operation确认完成，再仅删除该联系人的稳定公共document ID，成功或明确404后才发布skip摘要；删除缺能力或失败保留未确认进度供重试，不清他人文档或整库。已经明确从未公开的skip片段正常增长不额外要求删除能力，也不上传敏感正文。此删除确认不证明外部所有派生事实均已清除。
- **M32a，本地关系/印象缓存精准失效已处理**：修订被识别时和确认完成时，分别失效该联系人的private relationship与公共person model缓存；advanced pending携带修订标记，使重启后的确认也能失效。已在途旧读取只持有被移除的entry，晚返回不能重新填回Map。供应商已经返回fresh内容时，两getter不再继续提供旧缓存；其他联系人和正常追加不强制失效，保留原十分钟读取策略。新的submitRetain和精确deleteDocument同时经审计代理，把异步受理标为accepted而不冒认completed，记录UUID/目标摘要而不复制请求原文。

### M32b仍open：供应商模型与其他衍生事实

新诊断脚本[repro/memory-model-revision.mjs](repro/memory-model-revision.mjs)只用临时合成聊天、假API及文档/模型Map：两份稳定文档已经修订为撤回占位，重新构造LongTermMemory清空本地RAM后，仍能读回供应商未刷新的旧模型正文。它是当前未修缺陷诊断，不是正确行为回归，也不再混入本批已修的本地缓存问题。

官方v0.10.2实现中retain之后还有consolidation和模型刷新链条，文档替换、任务completed、刷新受理或本地缓存失效均不能单独证明全部观察/mental model已经去除撤回内容。需要后续持久派生修订屏障和独立完成证据，不能据本批结果宣称彻底遗忘。日记/周记/阶段总结的直接retain尚未接入本次episode pending协议；旧弱消息身份、所有写者必须统一升级、外部手工重试、CLI全过程停机协调、多文件非事务、强杀未持久观察等既有边界仍在。没有访问真实Hindsight服务、数据库或真实QQ验证部署行为。

### 第五批验证与提交状态

本批新增39项正式回归：正文修订/派发协议15、SDK9、App7、模型缓存3、审计3、history观察2；记忆审查累计新增192项。关键本地反例先红后绿，新增覆盖同count撤回、开放前缀改变、正常新增阈值、旧计数迁移、排队旧快照、在途ACK/停止/重启、UUID原请求重投、未知/失败任务屏障、坏advanced状态、pending换bank拒写、公共危机删除及本地缓存晚读等。全部使用合成资料、假HTTP/API、临时文件和故障注入，没有真实私密输入或外发。

主代理最终确认102项定向组合、全仓类型及完整2847/2847测试全部通过（bot2700、转换61、Koishi47、移动35、PWA4）；没有以定向通过或候选数量代替完整结果。两处原真实App假HTTP夹具同步补齐合法operation receipt/status/children及任务列表，没有关闭advanced来绕过新协议；停止回归现正确断言受理后pending保留、重启核对completed才记count。

- 最终全量结果：2847/2847通过，新增39项，记忆审查累计192项。
- 最终模块登记4项、全仓类型及Git差异检查通过。
- 本地代码提交：`dcbcd460`真实异步协议与审计，`62ba8e13`文档修订、持久屏障、App接线及本地模型缓存；未推送、未部署，原未跟踪AGENTS.md保留。

整个记忆模块仍在深入审查中，不因本批定向通过转入下一模块或社区比较。

## 第六批：派生污染的持久读取与生成保护

第五批M32b诊断保留的是当时“文档已更新、供应商模型仍旧且客户端仍可读出”的证据。**本批已修读取侧和再次生成/提交的泄漏旁路；自动重建派生内容、取得独立完成证据并解除屏障仍未完成。** 不能把客户端暂停使用旧模型等同于供应商数据已清除，也不能把第五批诊断继续读到旧正文作为当前客户端应满足的行为。协议见[ADR0242](../adr/0242-derived-memory-read-barrier.md)。

- **集中持久屏障**：新增私有`memory/derived.json`，按bank保存污染世代、精确document集合和明确qq/tier来源，不保存原文。公共污染不能只挂在源联系人的文件上，否则移动该文件会误解封其他人的公共模型。私人和可能受影响的公共bank通过单次markMany、同一JSON原子发布，消除只写完一侧就崩溃的窗口。同库证据只累积，owner的未知文档范围不会被后来精确范围降级；当前没有clear或自动过期接口。
- **关键状态与故障恢复**：SQLite仅作短同步OS协调，JSON仍为事实源；锁内重读合并，失败保留RAM增量并拒绝未确认读取，发布后错误仅以精确读回确认。首次clean读取也必须发布空状态，已有协调文件或实例曾读过状态后JSON缺失则失败关闭，不能重启后猜clean。坏JSON/schema保留原件，不隔离成空白；运行中不能删除协调文件解除保护。跨进程和发布故障回归覆盖见证、并发合并、别名隔离、未知范围保留及两bank在提交点同时可见；不宣称网络文件系统、断电fsync或exactly-once。
- **接受撤回与legacy恢复**：公开noteRecall在接受撤回后同步建立屏障并失效未派发旧快照，即使标记写入失败，也不能在旧请求ACK后继续retain旧正文。sync入口同样在任何await之前识别已提交前缀修订。ChatHistory仅对真正被持久撤回状态遮盖的视图条目生成recalled:true，剥离原JSONL同名字段，既不改raw也不靠字面占位文本猜来源。App创建回复器前迁移旧已遮盖历史；无法安全取得来源快照时按该owner保守标记，正常无撤回视图不脏化全部旧库。
- **精确读取范围**：脏私人bank屏蔽relationship和观察；脏公共bank屏蔽所有person模型、实体缓存及不可靠来源的派生输出。A的聊天可能污染B的公共印象，不能仅屏A自己的person模型，但B未污染的私人bank仍可使用。明确world/experience且绑定标准、未污染原始episode文档的事实继续可用；污染文档、未知来源、observation和diary/week/phase不因有document_id就冒充原始事实。文档范围未知仅扩大对应owner，不扩大其他owner的原始文档范围。中央状态读失败时不能证明哪些bank干净，相关读取失败关闭。
- **异步出口守卫**：缓存命中前、await后及最终格式化后重新核对世代，旧在途模型、实体、召回结果不能重新发布或返回。覆盖day/week第二次召回期间的新撤回、othersToday按来源过滤，以及格式化回调中新接受撤回的最后出口。直接嵌入SDK者需提供可靠当前快照，不能只等App定时sync微任务才开始保护。
- **日记本地texts旁路已处理**：新增derivedAvailable输入/派发守卫，日记写入器在本地旧日记texts进入生成材料前、读取或生成await后、以及新的日记/周记/阶段总结retain派发前复核。暂停保留旧资料，不把未知/暂停记为空总结或已完成。LongTermMemory在ensureCommonBank等待之后也重查，尚未发出的派生写不外发；已经派发的retain仍等待真实ACK并保存written等实际进度，不把已发生事实改判未发。9项日记回归覆盖旧texts、生成/读取等待、日记和两类总结、屏障故障、旧fake兼容及在途确认。
- **隐私与归档保留守卫**：derived.json及协调见证进入按明确owner.qq识别的共享隐私清单。导出不复制其他人的共享内容，遗忘保留共享状态与协调文件，归档保留活守卫并报告例外；不能因移走源联系人的文件让第三人的旧公共模型复活。新bank按自身状态可用，切回旧bank仍受原有屏障保护。

### 保持open：M32b自动修订与有证据解封

本批只使受污染bank的派生能力暂停，未永久关闭所有记忆：上述未污染原始事实和其他bank保留可用范围。仍需实现独立修订worker，协调源文档完成、fresh consolidation统计（含pending/failed）、任务静止、旧联系人/档位的完整模型清单、安全full重建及刷新outcome。仅completed并更新时间戳可能对应content_preserved_no_new_facts，不能据此解封；也不能用刷新ACK、一个布尔值、删除guard或手工改generation绕开保护。日记/总结的来源依赖与直接retain仍需纳入完整修订证据，本批生成守卫不代替其派发/重建协议。

### 新确认仍open：M33，未回复确认撤回后的约见仍生效

独立合成诊断[repro/memory-promise-recall.mjs](repro/memory-promise-recall.mjs)证明：PromiseKeeper提取模型等待期间，用户撤回一条尚未被助手回复的约见确认；ChatHistory已返回占位，但旧提取结果仍能保存early约见。随后同消息数再次sync没有更正，重启后仍能查询到赴约安排。该脚本是未修缺陷诊断，修复后不应继续要求缺陷断言通过。

目前证据只确认约见保存、同计数跳过及重启继续生效；探针没有安装world动作回调，**未证明world账本已被污染**，不能扩大结论。下一步须贯通承诺提取的来源修订/撤回世代及持久进度，保留“已经回复后记得”和危机保留政策，不把撤回所有确认一律当作取消约见。M33与M32b自动修订worker分别保持open。

### 第六批验证与提交状态

本批正式新增42项回归：集中store10、读取守卫11、App4、日记9、隐私/归档6、视图metadata2；记忆审查累计新增234项。读取守卫关键反例先红后绿；全部使用临时合成资料、假API/HTTP和故障注入，未访问真实runtime、角色私密资料、QQ、记忆服务或数据库，未部署。

主代理先确认47项整合、全仓类型及2887项全量通过；继续复核发现共享derived.json实际临时残留未入隐私清单，追加2项先红后绿。有效tmp按schema/owner.qq归属，半行或坏schema仅报告共享无法归属限制，原件保留、不回显私密文本；不收入任意前缀或虚构隔离后缀。最终49项整合、全仓类型及完整2889/2889通过（bot2742、转换61、Koishi47、移动35、PWA4），没有沿用补丁前结果。

- 最终全量结果：2889/2889通过，新增42项，记忆审查累计234项。
- 最终模块登记4项、全仓类型及Git差异检查通过。
- 本地代码提交：`fa603d38`集中屏障状态，`ea4fde46`读取/生成调用链，`b5ef949c`隐私及归档；未推送、未部署，原未跟踪AGENTS.md保留。

整个记忆模块未完成，后续先处理M33并继续M32b自动修订/有证据解封；不转入下一模块或社区比较。

## 第七批：承诺来源修订、因果恢复与世界事实幂等

第六批M33段落保留了当时未修的提取等待、同计数与重启反例，**本批已修下述有证据的M33路径，并处理独立发现的M34事实ID碰撞**。[repro/memory-promise-recall.mjs](repro/memory-promise-recall.mjs)现已改成正确行为探针：退出0表示拒绝迟到旧结果、对fresh同消息数来源重新抽取且重启不恢复旧约，不再以复现缺陷作为成功。该探针仍不安装world回调；世界相关结论仅限下述单独验证，不扩大旧证据。协议见[ADR0243](../adr/0243-promise-source-effects-and-world-identity.md)。

- **M33，early与闭段统一来源**：PromiseState保持version1，新增可选sources、attemptSources、promiseVersions、loopVersions、uncertainSources。成功来源记录phase、完整片段count/digest及承诺/未了事项的最小before/after效果；失败尝试进度独立保存，不把当前摘要填成旧成功证明。闭段并不等于用户已经被回复，闭段同样核对来源，已extracted的片段发生可证变化时仍能重抽。
- **M33，提取输入双重证据**：提取前冻结片段count/digest、称呼和有效pending/loops上下文，历史读取及world回调的片段参数隔离别名。成功或失败返回后复核当前片段及fresh来源投影后的上下文；任一实际输入失效则丢整次结果，不resolved、不执行world回调、不标early/完成或消耗新来源失败次数。另一来源撤回导致旧pending失效也能拒绝结果。无关的新user-only片段不在原prompt证据中，不因整联系人历史变化而使旧有效提取反复饥饿。
- **M33，恢复原约而非只删early**：改地点、改期、取消、resolved及loops使用统一按ID因果版本和before/after效果，删除保留必要tombstone。来源失效时，只恢复仍匹配自己version与after像的效果；后来有效来源已接管的记录不回滚，多个失效来源按可核对版本链还原。重复同open的变更保留最初已确认base，不把上次临时改约当成已确认before。正式回归覆盖early/closed跨片段更新与取消、原约恢复、闭段新增和loop恢复、后来写者及重启；不是整份state回滚，也不是猜所有历史旧约取消。
- **M33，读口即时核对**：describe、openLoops、plans与约见排期在使用前读取fresh来源并投影，不等下一次sync才停止使用失效来源。已提交prefix未变时，正常追加和助手后来回复不误伤原约，危机keep沿既有政策保留。每次读口对每个联系人至多一次history.load和一次split，复用episode索引；plans和约见排期不再先available后重复加载。长期仍有效的未来early即使旧计数裁剪，也保留来源和恢复依据。
- **M33，未知与无约严格分开**：真实ChatHistory提取后删除临时JSONL已先红复现；来源文件缺失、活片段消失或截短时，日历和日记来源不可确认，不能通过自动undo变成空日历。恢复完整原文件后原约可重新核对；过期且没有活效果的缺源记录不永久阻塞日历。合法旧v1/无version及未知扩展保持兼容；旧状态有可信recalled证据却已丢before像时，持久记uncertainSources并保持待核实，不凭当前值重造原约。没有明确撤回证据时不批量取消旧记录。
- **M33，元数据矛盾失败关闭**：完整校验来源、尝试、before/after、版本与tombstone形状，效果ID匹配且每来源每ID唯一。同一namespace、record ID、effect.version被不同来源认领会使恢复结果依JSON顺序变化，现拒绝该矛盾状态；beforeVersion不要求对应来源永远存在，允许合法裁剪。旧合法ID如constructor、__proto__按自有键字面读写版本，不把原型继承属性当已有版本或误暂停联系人；两ID在同一正式case先红后绿。
- **M34，世界事实身份已处理本批碰撞**：真实PromiseKeeper与世界状态合成回归证明，世界写入成功、承诺进度EIO后重新抽取，模型数组从单笔10变成20、10的重排，会因旧位置ID把20吞掉。新conversation事实ID在既有验证与语义去重后，取contact、episode、kind、有效分钟、amount、target、subject的稳定摘要，不依数组位置。覆盖重排、部分成功、同分钟不同金额/目标及真正keeper进度写失败重试；旧ID保留，原同日/同金额/同目标等保守合并政策不变，不将该证据夸大为所有消费/世界动作均已去重。

### 本批保证以外的恢复与事务边界

本批不会自动逆改已经实际落入世界的动作或物理事实。M34稳定ID使已确认事实的重试不再因数组顺序碰撞，不能据此宣称撤回会自动撤销旧世界账，或模型抽取和所有存储已组成事务。承诺进度与世界事件仍是两份发布；外部手工写者、多实例竞争、强杀前未持久观察和任意网络exactly-once不在保证内。

已经丢失的legacy before像仍无法自动恢复；uncertainSources不能靠一轮fresh模型或手工删字段假装确认。元数据及版本仍被活效果依赖时不能为限量而丢弃，坏状态保原件等待可信恢复。来源、before/after和进度保存在原专属promises文件，既有隐私清单覆盖；未新增包含原文的公开日志。

**M32b自动派生修订worker与有证据解封继续open**，ADR0242的读取/生成屏障仍生效。本批承诺恢复与世界事实幂等不构成模型重建完成证据，不能解除derived guard；下一步继续该独立修订链及剩余记忆审查，不把本轮修复称为整个记忆协议完成。

### 第七批验证与提交状态

本批正式新增40项回归：承诺来源/因果22（21项revision及1项合法原型同名ID对照）、真实App4、来源schema7、世界事实7；记忆审查累计新增274项。新增覆盖关键错误行为的旧红证据、正常追加/已回复/危机keep对照、缺源与恢复、因果链及重启。全部使用临时合成资料、假提取/API和故障注入，未访问真实runtime、QQ、外部模型或私密角色资料，未部署。

主代理最终确认115项定向组合、全仓类型和完整2929/2929测试通过（bot2782、转换61、Koishi47、移动35、PWA4）。整合后继续补真实缺源和矛盾owner检查，以及合法原型同名ID的先红后绿回归；没有在中间类型迁移状态或原型ID失败版本提交。

- 最终全量结果：2929/2929通过，新增40项，记忆审查累计274项。
- 最终life/world/memory三模块生成文档一致，模块登记4项、全仓类型及Git差异检查通过。
- 本地代码提交：`2717f391`世界事实重试身份，`1ba7710a`承诺来源/因果投影协议；未推送、未部署，原未跟踪AGENTS.md保留。

整个记忆模块仍未完成，不转入下一模块或社区比较。

## 第八批：M32b私有关系模型的自动修复子集

新增DerivedRepair有限状态机、固定版SDK证据接口和derived.json v2事件/租约/收据。旧模型读取保护不撤销，而是只有可信单一私人bank、完整已完成QQ来源前缀、精确服务器文档hash及唯一自有模型匹配时才开始。fresh统计同时检查pending/failed consolidation，完整分页检查未结/失败/取消任务；暂停自动刷新并重新等静止，clear读回空内容，再用full、原始world/experience、排除mental models及总结/chunks的安全来源刷新。独立UUID操作完成、typed outcome、严格is_stale=false、配置/目录与精确水位再核验，恢复原auto/间隔之后CAS提交新读取世代。未知、失败、保留旧正文outcome和坏状态不解封。

- **稳定来源与收据**：撤回按真实角色/源时间/消息ID/序号集合生成稳定事件键，重复启动扫描不再次污染已修事件；新撤回增加世代。v1精确已知来源可经完整证据修复，未知allDocuments保留。源文件/进度有缺失不能仅靠当前模型推断安全。
- **同步接线**：真实LongTerm按已完成retained前缀冻结manifest；阶段进行时普通追加仍保存在本地，不改变已确认远端来源，成功后继续正常同步。新撤回立即使旧来源失效并先修订源文档。修复停止取消纯读、等待已派mutation及确认检查点；重启从持久阶段续跑。接线只在完整真实SDK能力存在时开启，旧fake或自定义不完整API不冒充修复器。
- **新增M31前缀余波**：此前pending比较完整episode，合法追加也被判正文变化，not_found不能重交原前缀且错误增加派生污染。现以原count前缀核验，不改不可变原派发意图；真实撤回改变前缀仍禁止重放。正式回归用旧HEAD LongTerm运行时替换确认失败，再对当前源码通过。
- **跨世代未知HTTP旁路**：并行故障复核实证，原auto=false、旧refresh丢ACK无UUID后，新污染可换lease重建并解封，旧HTTP仍可能迟到。新增全journal未结扫描，store begin/commit及worker入口共同阻绕过；覆盖六类未结阶段。已派ACK仍允许归属旧journal确认，但不能清新事件。
- **缓存世代**：关系、公共印象与实体缓存绑定持久读取世代；另一已缓存旧关系的实例也不能在新收据后复活旧正文。正常未修订追加的十分钟策略不变。
- **审计和隐私**：配置/clear/refresh/restore只记bank/model/阶段等元数据，不读取模型正文；刷新只记录accepted且操作UUID只保存hash，不伪称completed。保原ACK及可选接口能力，账本失败不影响主ACK。四类新记录纳严格bank或公共person-owner归属，不凭正文猜人；共享链导出/遗忘保留策略不变。

### 必须保留的修复边界

模型收据不等于历史观测全部净化。官方v0.10.2孤儿观察回归明确：旧bug产生的观察可仍有效、可召回，而指向已不存在的源事实，不会再被consolidation选中。当前fresh统计不检查这种完整性。故本批只解私人relationship模型和已核对原始片段事实；所有曾污染bank的observation在请求与返回两侧仍排除，其他未污染bank原策略保持。公共含跨联系人和日记/周记/阶段总结的派生来源，旧进度无完整输入manifest，继续屏障，不猜删既有已回复事实。

旧世代refresh-pending即使已有UUID，新污染后目前尚无自动settlement仲裁；正式边界回归确认它继续blocked，而不是把可查询证据冒充本实现已处理。旧无UUID/不明ACK、failed/cancelled任务、未知文档/模型及坏高级状态同样需核实恢复。此限制保安全但可能暂停该联系人自动修复，不能手改generation或删journal解锁。后续可实现带独立事实证据的旧世代收尾，以及官方DELETE observations对应的完整清理/重建协议；都必须先排空旧任务并持久记录未知派发，不能只请求删除即宣称干净。

### 第八批最终验证检查点

新增51项正式回归：SDK12、store12、worker12、真实LongTerm8、审计5、隐私2；记忆累计新增325项。store既有10项加新增全部为61项定向，全部通过。另原LongTerm/model/lifecycle/schema30项、审计13项、隐私14项通过，模块登记4项和全仓类型通过；最终完整2980/2980通过（bot2833、转换61、Koishi47、移动35、PWA4），全仓类型与差异检查均通过。旧HEAD LongTerm运行时替换的3个实际行为对照全部失败（未启动修复、pending合法追加、旧缓存恢复），当前8项整合通过；SDK/审计/隐私及跨世代缺口另有先红后绿证据。首轮脚本Windows import路径格式错误不算旧红证据，已改file URL后重跑得到上述断言失败。

ADR0244记录范围、固定版本依据和恢复限制。代码本地提交`342a1e2a`。本批所有资料均为合成事件/临时文件、假HTTP/API和故障注入，未访问真实运行时或模型/数据库，未部署、未推送。记忆模块仍未完成。下一步先接续旧世代已知UUID收尾与独立观察重建/证据，公共日记/总结来源依赖及directretain协议不能用本批私人收据冒充已完成；其余模块待审边界保持。

## 第九批：旧世代known UUID收尾与独立任务身份

实际LongTerm新回归先红：第一次撤回已开始refresh-pending，第二次撤回改变generation；即使服务端后来completed，新来源仍永久blocked。现用严格typed settlement追加旧任务已结束的事实，保留原phase/evidence/新事件/世代，不恢复旧auto、不以旧正文解新污染。新lease承接当前safe paused配置必须有原auto/间隔/模型身份/配置匹配的已settled证据，随后独立重新clear/full/完成核验/恢复auto/CAS。每次最多仲裁一个旧job，无无限轮询；未知无UUID、失败/取消/404/preserved及证据不符继续保护。

独立交叉复核又发现UUID证据复用：第二refresh返回旧UUID、查询只给旧content_written时，新clear后的空模型仍可被误认作新重建成功。临时反例及正式worker回归均实证，已修为同bank每个刷新UUID唯一lease归属（大小写规范化）：worker ACK、store checkpoint及持久schema三处守界，同lease重复ACK允许；跨lease复用保refresh-dispatched未知，不盲改UUID/重POST。

新增17项正式回归：store5、worker7、真实LongTerm5，记忆累计新增342项。覆盖旧新来源、跨重启、await后再撤回、stop取消纯读/晚返回、仅新配置ACK收尾、fresh pending/failed/四态静止、错绑定/配置、发布前后IO与旧UUID复用。此前的“knownUUID跨世代必须人工”边界case改为独立重建后的正确行为，并保留未知及不支持outcome对照。主代理78项最终定向、全仓类型、模块登记4项、差异检查均通过；最终完整2997/2997通过（bot2850、转换61、Koishi47、移动35、PWA4）。代码本地提交`91b71b66`，ADR0245；未推送/部署，AGENTS.md未跟踪状态保留。

### 观察重建只读研究结论：尚未实现

固定v0.10.2 PostgreSQL DELETE observations确实在单事务清所有观察/历史并重置raw fact整合进度，不删raw文档或mental models，不清failed标记，也不自动重建；需另派consolidate并等待全部后继链。同步DELETE没有请求UUID，timeout后原HTTP可能迟到；读回零或第二次DELETE成功仍不能证明第一请求不再执行，不能自动重试后立即重建。fresh stats水位是现存行max(updated_at)，删除后可下降，不应任意要求递增。非PG分支的百万源扫描和外部store事务不同，不能承诺相同保证。官方固定源码/链接与本批边界见ADR0245。现有observation及公共派生屏障保持，不把只读研究算已修。

### 独立审查确认的下一工作单元（全部未修）

- **M35，未来历史进入长期事实**：固定now=12:00，29条已发生消息+12:01的一条未来消息，凑30条后两库retain都含未来正文。另一反例先正常retain两库，再仅追加未来危机行，未新增retain却提前delete现有公共ep。运行`node docs/reviews/repro/memory-future-history.mjs`与`memory-future-crisis.mjs`可复现；它们断言当前坏行为，exit0不是正确性回归。需贯通事实视图、来源摘要、pending/count与clock rollback/旧进度兼容，不只挡episode.end或危机分支；保留实际来源顺序和既定危机政策。
- **M29b，civil接口余波**：Pacific/Apia合法文档日diary:2011-12-30被lastTouched Date接口滚到31日，Jan7仍clear而按8日应vague；phase同样迟一日，日记/总结窗口也受影响。`node docs/reviews/repro/memory-apia-civil.mjs`为未修诊断。另真实recallCommon假provider给occurred_start=2026-02-30、合法mentioned_at=Feb1，会在Mar2窗口输出“3月2日”的该事实；fading已有校验没有贯通long-term的onDay/mentionedOnDay/日期标签。需统一宽兼容provider日历解析及civil日期接口，不能用UTC Date冒充本地Date。
- **M30b，遗忘全过程互斥与续跑**：两独立进程临时复现：forget已move联系人state、停在fake deleteDocument时，另进程真实acquireLock(bot.lock)仍成功并重写聊天。此时强杀没有report，普通重跑已丢历史old-bank目标、远端0次且failures空；正常首轮远端全部503也同样第一轮5失败，第二轮普通重跑0调用且空失败。旧目标仍可在trash/report人工恢复，但没有持久不可变job/自动或显式resume。本大类此前已列open，现补确证；应分全过程真实锁与删除计划/checkpoint恢复两个可验证单元，不能只检查bot.lock或在move后才保存计划。仅临时合成数据、假删除API与子进程，无真实删除。

后续仍在记忆模块内按风险独立推进上述可修单元，同时保留观察/公共日记协议工作；已保护能力不等于所有已确认缺陷已修。用户追问速度后明确要求继续最高标准，不降低审查或验证深度，不转模块/社区比较。

## 第十批：遗忘恢复、未来事实视图与民用日调用链

### M30b：整个维护过程互斥与原计划恢复

forget apply改为审计之前取得真实目录租约，覆盖所有移动、远端请求、报告与CLI审计后才释放。首次move之前在maintenance/forget-jobs/UUID.json持久保存不可变原计划、文件指纹、QQ/根目录、trash和CLI endpoint摘要；逐项记录移动及远端派发/确认，--resume只恢复原目标，不因state已move而生成空清单。真实子进程在rename成功、checkpoint前退出，可按目标hash确认旧移动并继续历史bank。原件改变、QQ/endpoint不符、路径/计划篡改或坏JSON停止，不覆盖恢复资料。

强杀或网络/503等远端未知并未变成自动重放：dispatching/uncertain保留原任务、原目标和启动屏障，resume准确报告未确认；404或真实成功才done。5xx可来自网关，不能证明上游已停止，未增加布尔人工解锁。旧shared derived守卫/账本依原政策保留。API默认不另改共享审计链；CLI在锁内记只含元数据的审计。结果complete仅指该任务请求的步骤，local-only没有冒充外部删除。

主代理实证原PID检查/unlink间存在新写者时，两租约能同时成功；新增bot.coordination.sqlite的长生命周期OS事务，PID仅诊断且尊重旧活写者，同PID租约保护保留。独立进程争stale PID、强杀接管、PID被删/坏而仍有OS持有者、坏coord、发布IO及释放均验证。旧lock夹具模拟“旧进程死亡”时补释放OS租约，没有放宽活租约安全。App在构造/任何prompt或世界修改前查全部未完成job；archive实际操作也全过程持锁、拒绝未完成job，不能通过换bank绕过。OS租约与JSON job分别解决活并发及崩溃后意图，不冒充全目录多文件事务。

恢复日志及实际tmp按严格plan.qq纳隐私mixed清单、不可自动移动或复制整个journal；坏tmp只报告归属未知。交叉复核补修Windows同物理目录大小写别名被误判坏job，以及broken junction的existsSync=false绕过：root身份规范化比较、不改原hash；路径检查直接lstat，仅ENOENT可视缺失。维护目录/coord被外部整体删除或替换仍属不合作写者边界，运行中不可删换，50ms仅争锁预算。

### M35：固定事实视图、来源进度与未知历史重分片

每轮固定now，完整校验后只让已发生消息参与分片、阈值、敏感判断、修订及repair；每await后的实时钟回拨阻未派工作，已派ACK保存真实count并建立时间屏障。新增可选sourceTimes和不可变pending来源证据，旧无字段兼容，not_found仅能核对原前缀后重交原请求。普通未来首/中/尾到时可同步；未来crisis不再提前删除公共旧ep。

继续复核发现首次实现raw先分片会被48小时未来中插截断过去30条为12条，后18条不足阈值失去远端覆盖，已正式红例修复：先筛事实再分片，未发生行不影响45分钟边界；既有ID用已完成/immutable来源首成员锚点保留。时钟追上后若真实重分片造成旧count归属不足/重复ID，保原文档和精确屏障暂停，不猜迁移；含legacy无sourceTimes的同类路径。此病态历史重分片的自动迁移仍待独立证据，不能称已自动恢复。真正过去正文编辑、撤回、stop/restart、known ACK和clock rollback均另有对照。

### M29b：civil日与实际日期出口

lastTouchedDay与civilDayNumber使用UTC中立日序表达民用日期，不强迫Apia不存在的2011-12-30成为当地Date。clarity、summary/diary窗口改用civil，保午夜exclusive、02:00与DST23/25小时规则；旧lastTouched Date只为兼容。providerTime贯通fading、onDay、mentionedOnDay及最终label，坏ISO日历不再滚到另一查询日，合法mentioned可回退。交叉补Z/UTC后缀、空白/小写t前缀绕过；合法RFC/offset/低年/epoch0仍兼容。

### 验证与边界检查点

新增45项正式：CLI恢复11、目录租约6、启动/归档4、维护隐私2、未来事实15、civil helper5、实际日期caller2，记忆审查累计新增387项。旧红证据包括M35首5、M29 helper及两真实caller、CLI原两行为及alias/link、锁3条、App/archive的HEAD运行时替换3条；未把脚本装载错误当源码失败。相关43项日期/未来/lifecycle整合、42项CLI相关、目录租约与模块检查均通过，全仓类型通过；最终完整3042/3042通过（bot2895、转换61、Koishi47、移动35、PWA4），模块登记4项和Git差异检查通过。

原future-history/future-crisis/Apia诊断已改为正确行为探针，与正式回归分开，不能再用旧坏行为断言证明未修。本批ADR0246/0247分别记录恢复及时间协议，代码提交`b9adc611`（遗忘意图/维护租约）与`94352a7a`（事实视图/civil调用链）；只用合成聊天、假API、临时文件/真实子进程和IO注入，没有读取或删除真实运行时、聊天/角色或外部服务数据，没有部署或推送，AGENTS.md保持原未跟踪。

M32b历史观察和公共日记/总结来源协议仍open；本批没有解除那些守卫。旧弱ID、未持久观察/legacy before、未知远端DELETE、病态历史重分片、非合作写者、fsync/网络FS与多文件非事务限制保持。记忆模块仍未完成，不转下一模块或社区比较。

## 第十一批：外层停止所有权、日记回补与只读观察证据

执行期间另有独立时区任务提交`58803856`。本批避开其config/package/Koishi/time-zone及测试改动；其成果不是本批实现，未覆盖或夹带其原修改。代码提交使用显式路径范围，AGENTS.md仍保持原未跟踪。

### M36：外层发送与App停止

presence/browsing.stop此前仅停timer，纯compose晚结果仍可发新动作；已派发送held时App可以先释放目录锁，再有晚ACK写历史/状态。现两实例永久停止，纯read/compose/未commit initiate可取消，已派mutation/send/已commit Responder由tick持有ACK及状态/历史收尾，stop返回可重复的drain，idle保undefined，start/reapply不复活。B站私有signal贯通initiate与sendLink；App汇合两个drain。

真实App合成卡进一步确认封面await之后的子步骤旁路：封面held期间stop后会继续发文本。现每次真正send前查stop/signal，封面真实ACK按本次messageId记历史后不再派文本；已派链接文本则等ACK/ChatHistory完成才放锁。3项App回归在有效合成卡后先红后绿；首轮夹具缺earlySlot period、world people/events的加载失败不是源码反例，已修夹具后重新确认真实红灯。外层新8项加App3项共11，另覆盖在线、说说、戳、链接、DM/recordDm、评论/rpid及晚model/feed。提交`dfb64910`，ADR0249。

范围仅记忆直接调用链的lifecycle，不代表B站/社交完整模块已审。永久不返回的mutation会阻drain；持续历史IO仍无durable发送outbox。资料卡多目标点赞中途停止的逐目标重启去重缺既有状态证据，未在本批臆造新频率政策或宣称全局exactly-once。

### M29c：日记writer民用日期余波

此前M29b只修reader/fading，writer的localDate回补仍可把Apia不存在的2011-12-30滚到31日，并提前把尚未结束的今天写入written；周记重复借31日，phase名义end缺日读入区间外日记。现civil目标先核身份，daily只补已结束且可表示当地日，week/phase以民用区间取真实日记；phase保名义ID/标题而timestamp用区间最后真实日记日。交叉又发现Nuuk晚23点缺时使23:30世界材料进入次日，现仅跨日时收束到本日最后真实瞬时，同日DST语义保持。新7项含Apia、Nuuk、DST/低年对照，确认合成49项重跑通过。旧written/texts未猜迁移；提交`3859cfa8`，ADR0250。

### M32b：只读预检前进与能力证明阻点

SDK新repairObservationStats严格fresh总数/fact-type计数/pending/failed和微秒水位；repairConsolidationStatus严格UUID/consolidation类型，单任务completed不冒充后继链已清。新6项，提交`811ba0af`，ADR0251；只读取，没有新增或调用清理/派发接口，没有解除任何guard，不能计为观察重建完成。

固定官方v0.10.2 HTTP/version与bank/config不能独立证明database_backend及实际store_owned_for(bank)路径；知道版本或PG数据库也不等于观察事实走内置PG事务清理。未用布尔配置假造能力、未访问真实部署/数据库。需可信部署证明或真正后端无关的完整清空证据后，才能继续破坏性worker；同时unknown DELETE与公共旧源依赖屏障保持。

日记直接retain的既有open另补真实writer+LongTerm+SDK假HTTP证据：三篇合法async receipt全pending且GET operations为0，writer已经written/texts，重启也不reconcile。可运行`node docs/reviews/repro/memory-diary-async-acceptance.mjs`，exit0仅证明当前坏行为，不是正确性回归。此不是新编号重复发现；必须prepared固定body/UUID/requestHash/来源manifest与typed实际完成回执一起贯通，不能只让LongTerm回bool而writer每轮重生成另一body。新日历修复和只读API都没有冒充这项已完成。

### 第十一批验证与下一步

正式新增24项（外层8/App3/日历7/读取API6），记忆累计新增411项，其中6项是后续预检接口证据校验，不代表6项清理缺陷已修。主代理最终463/463可确认合成回归通过（memory系列、纯B站卡片及模块登记），全仓类型/差异检查通过；后续ADR/模块映射生成后再核模块4项通过。没有把历史3042全量结果当作本轮全仓验证。

下一步仍先贯通日记prepared/outbox、来源manifest与实际completed，再处理summary对confirmed diary版本的依赖；旧无manifest来源保legacy、不猜净化或删除已回复事实。观察后端能力缺证不以default猜测，继续保护。其余记忆直接CLI/归档多文件恢复、外层发送失败持久outbox与实际资源性能按风险取证；本批不降低验证深度，不转模块或社区比较。

## 第十二批：公共日记的固定意图、完成回执与来源依赖

本批接续M32b的directretain子集，没有解除历史观察或旧公共派生守卫。三路代理分别负责writer/来源、LongTerm/SDK/outbox、独立真实链路回归；主代理整合隐私/归档、App起点与协议复核。没有执行依赖真实角色卡的旧diary/presence/bilibili/app测试或未经核实的全仓npm test。

### 异步accepted与重启

旧真实SDK假HTTP复现已明确：accepted全pending而writer已written/texts，重启不poll。现writer先持久固定body/角色/日期/标题/UUID与材料、提示词及来源manifest；LongTerm在独立written-retain.json先存完整不可变MemoryItem/canonical requestHash，再允许派发。SDK只有对应UUID父任务和非空children全completed才算完成。pending不写written/texts，重启查询同UUID及原正文，不重新生成另一body；新body不能冒认旧完成。failed/cancelled、坏状态及缺JSON见证保留保护；原UUID/not_found依原文与仍有效授权才可重交。

独立written-retain-coordination子目录避免冷读新outbox误创建derived.json的缺失见证。单文档排队；stop取消纯读与未派生成，已派HTTP/真实ACK和本地发布由drain持有，completed发布前后EIO可重启读回原请求。高级pending不能因接口降级走legacy重发；旧无高级任务的fake按原同步完成契约兼容。初始坏或未知新版diary状态保原失败关闭，不quarantine为空。

### 来源、总结与实际POST前守卫

manifest只记录真正入1500代码点材料的消息身份/片段摘要和QQ/tier/since，以及实际计划、上下文、提示词；App传入TierRecord ISO起点，明确known-unbounded与没有callback的unknown。新summary绑定每篇diary的bodyHash和confirmed/sourceHash；已知pending或sourceVerified=false不参与，confirmed消费前fresh核当前来源。旧written/texts保持legacy，允许既有兼容总结但依赖明确legacy与实际bodyHash，不捏造旧收据。

独立回归先红后绿确认两处后续缺口：confirmed后since变仍能生成总结；writer验证以后LongTerm建库await期间since变仍实际submit一次。现前者先持久blocker并保真实written，后者以可重算canSubmit贯通writer→LongTerm→SDK，队列、建库/status以后及SDK内部六次backlog预查后的最后POST前均fresh核验。最终hook只读本地材料，纳共享deadline/AbortSignal与stop守卫，不以入口捕获的布尔当派发时授权。SDK内部held backlog另有正式回归。已派旧body最终完成仅记真实body与sourceVerified=false，query-only不建库/不派新任务；公共屏障不因ACK解开。

交叉复核另修：summary结旧ACK时必须fresh合并writer状态，不能把依赖刚置false又由外层旧state覆盖true。原stop测试从“初始空文件原字节”改核“已持久派发prepared原字节与body/UUID保留、written/texts/confirmed不推进、drain失败”；日历测试保精确日期集合和跨日禁止断言，允许fresh验源重复读取同日材料。没有删除或弱化原安全契约。

### 隐私与归档

新来源变化屏障按公共bank/document持久单调记录，空QQ贡献也不伪造owner。受污染公共派生继续避用，精确未污染标准QQ原始world/experience和其他私人bank仍可用。共享diary.json、完整body的written-retain.json、marker、独立coord及实际tmp纳mixed清单，不复制/移动整份共享正文供单联系人导出/遗忘。archive在既有租约内先核状态，未结/坏状态/缺JSON见证在改tiers或prefix之前拒绝；已完成意图/收据/屏障与marker保活目录，不以归档换bank丢失原身份。

ADR0252记录协议与兼容边界。memory-diary-async-acceptance.mjs已改正确行为探针：pending不written，重启poll同UUID/body，completed才发布匹配收据；不再用其旧坏行为断言作为未修证据。

### 残余边界

本批没有清理服务端历史观察、自动修订旧公共diary/week/phase或提供有证据解封；旧无manifest已接受任务不能自动追认。跨运行时区的pending若MemoryItem hash不匹配，保原失败关闭，不猜迁移。source变化但未能持久观察的强杀恢复、多文件/远端非事务、未知DELETE、旧weak ID/legacy before和不合作外部写者边界不变。SQLite仅OS协调，运行中不可删换，50ms仅争锁预算。真实服务/数据库未访问或验证，未部署、未推送；记忆模块仍未完成。

### 第十二批最终验证与提交

新增39项正式回归：writer/manifest11、真实链路独立整合12、LongTerm/outbox/SDK12、隐私/归档4；记忆审查累计新增450项。主代理最终502/502已确认合成集通过（memory*.test.ts、纯bilibili-dm-card及模块登记），全仓类型、生成模块文档与Git差异检查通过。正确行为探针单独通过。不是新一轮全仓全量，不把历史3042等数量外推。早期两处旧fixture契约失败均在提交前修正并纳最终502完整重跑；Windows import装载错误不算旧红证据。

本地代码提交`2c7f25d5`，含ADR0252和生成模块文档。AGENTS.md保持原未跟踪，没有夹带用户资料或推送。下一轮继续M32b历史观察独立清理/重建、公共派生文档对新manifest的修订与有证据解封；仅本批prepared/completed/客户端来源保护已完成，不能再说accepted仍直接推进writer，也不能声称公共bank已净。其余CLI/归档多文件恢复、外层发送失败持久outbox与性能仍按确证风险接续，不转模块/社区比较。

## 第十三批：完成后的来源变化、归档中断恢复及live清单

### M32b：已完成资料不能永久信任旧来源

真实合成ChatHistory→writer先完成三日记、周记及阶段总结后，撤回/since变更/重启/离开回填窗口均复现receipt仍true：旧代码只有待完成总结才重验，全部完成时直接跳过。该反例不等于App.noteRecall通用保护被绕过。现同步verifySources不限回填窗口核所有新confirmed日记，先持久公共blocker，再失效receipt和已完成依赖；保原文、written及真实远端事实，不猜删旧文档。

独立复核确认非legacy依赖收据缺失不能当legacy；已知legacy正文实际变更也须核现存bodyHash，但缺正文不从远端补读或猜已变。每轮每联系人history/since只读一次并按日分组，真正未入1500尾部的改动不误标。未知history/计划/IO安全拒读，可恢复复核；catchUp显式只核已派UUID，未知的是其它日期也不能让本篇沿旧allowSubmit派发。

LongTerm公共读口注册同步本地验证，App在回复器前接线；读取开始、cache/await之后及格式化最终出口均核验，递归或异常不回退旧正文。真实writer完成后仅变since、未再catchUp也会形成持久保护。私人bank和明确QQ原始事实保持。宿主未提供来源或关闭writer后的证据迁移仍待单独验证，不把本批接线说成任意宿主的全局保证。

### M30c：归档的原计划与崩溃续跑

独立子进程在首chat rename后退出，旧归档已更新tiers/移走聊天但配置仍旧prefix，App会越过维护检查进入业务。现完整不可变archive job先于任何copy/tiers/move/config保存，含原目标、步骤和前后hash；逐步checkpoint，App在卡/业务初始化前挡未完成/坏job。--resume UUID只原计划，配置rename前后退出均可精确核目标并续跑，不重新发现空清单或换新prefix。冲突/坏状态/孤立tmp保原失败关闭，不宣称多文件原子或自动rollback。

交叉主代理反例证明：未完成archive后普通forget确实能移动归档已done目标并破坏续跑。现同目录租约内互查持久维护任务；不开始远端DELETE。新journal含共享配置文本及可能密钥，全部mixed；有效plan精确定位配置文本tmp（包括数据目录外配置），不整份导出/遗忘；坏journal/tmp也只列未知shared并保原，不猜QQ或外部位置。原pending隐私测试的宽泛archive子串计数，改为精确专属chats/archive四文件，另断言共享maintenance journal存在，保留原字节/不恢复旧pending等全部安全断言。

### M32b：后端无关的live证据，不是观察清理

SDK新增metadata-only完整observation及world/experience consolidation清单，固定官方v0.10.2的抽象store list契约，无q/tags/time/entity/doc过滤；严格UUID/字段/状态/稳定total/唯一ID，共享截止预算、10万项及8MiB累计metadata上限，超限拒完整证据。保留孤儿source IDs和微秒时标，不输出正文、不伪造bank/revision回显。

offset分页没有snapshot token，也不能排除同ID改文；live0不证明invalidated archive或无live行的observation_history孤儿已空，更不能证明未知DELETE停止。当前没有清理/trigger/解封。可信写者/任务冻结和实际store一致性能力仍缺独立证明，按ADR0251/0255保持保护。仅官方固定源码研究、假HTTP/合成数据，无真实部署/DB/API访问。

本批ADR0253/0254/0255分别记录来源、归档和只读证据。记忆模块仍未完成，不转模块/社区比较；其余未持久观察、legacy before/weak ID、未知DELETE、病态历史重分片、不合作外部写者及fsync/网络FS边界保持。

### 第十三批最终验证与提交

新增34项正式回归：持续来源13、公共真实读口5、归档恢复6、共享归档隐私/交叉维护3、SDK live证据7；记忆累计新增484项。主代理最终536/536确认合成集通过（memory*.test.ts、纯bilibili-dm-card、模块登记），全仓类型、生成模块文档及Git差异检查全部通过。首轮535/536唯一失败为旧pending隐私测试将新共享archive journal误计为聊天归档；改为精确专属范围并补共享断言后完整重跑536绿，不隐瞒或忽略失败。测试进程仍只用假API、合成角色/聊天、临时文件和实际子进程；没有执行未经核实的全仓npm test或旧真实卡用例。

独立本地提交：`ba66ad1d`（持续来源/读口）、`6fb3456b`（归档原计划/恢复/隐私/互斥）、`248eb426`（只读live证据及模块映射）。App的两处独立接线按index hunk分开提交，没有把未提交依赖混进前一个任务。未跟踪AGENTS.md保留，未部署或推送。

下一轮优先复核完整公共文档来源到远端修订/任务静止的证据协议，观察清理仍不可用live0、稳定total或布尔适配冒证。当前所有已知污染保保护，不能说整库已净。可独立继续writer关闭/来源配置移除的启动迁移、长历史持续验证资源成本、归档各阶段强杀覆盖与外层发送失败持久outbox；这些本轮未声称完成，不重复旧bug列表或为凑数猜重构。
