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

## 第十四批：已知作者意图的来源覆盖及同步资源成本

### M32b：关闭writer与丢失来源文件

两路子代理分别负责真实调用链缺口及实际资源计数，主代理整合宿主/元数据接口并追直接调用方。合成advanced completed→真实App移除全部schedule/since剪旧史，实际readDiary仍读出旧正文；另保留outbox completed但删除diary.json，重建writer把空confirmed当clean，也实际读出旧body。两个反例均先红，不是只断言缺少hook。

App现在明确注册writer验证或null无来源模式。当前bank有已知作者意图却无writer时动态拒公共派生读取，无作者意图的正常QQ事实和私人bank不变，不把功能关闭永久标为污染。writer核每个current document/UUID对应prepared或confirmed及fresh来源；缺来源动态false，恢复正确原件后可核。confirmed不伪造旧requestHash，其UUID→不可变请求映射由store保证，现存正文另核bodyHash。pending日记/总结同步local-only重算，不远端补原文，不因prepare本身自锁；源真正变更仍按原持久屏障，旧ACK结算与完成事实保留。

直接调用方搜索另发现sim/runner也拥有LongTerm/writer，初始和restart均漏新接线。新增真实模拟宿主合成卡/假API反例，旧运行后actual marker仍可读，现两个实例均保护。早期contacts为空、characterCard缺模板以及捕获实例计数的夹具失败均不算源码红证据；修好夹具后才记录实际正文泄漏红→绿。没有执行旧sim.test或仓库角色卡。

### M32b资源：fresh字节与必要投影

实际3650条/9.45MB合成outbox，三次查询读28.36MB并做21900次SHA，同步约424ms。现仍每次OS锁内读完整新字节、核路径与marker；只有与已完整验证的bytes完全相同才复用私有不可变metadata，对外副本。RMW仍全读/全验，dirty先flush，IO/hash/coord/见证坏不能回退cache。正式计数验证重复parse/SHA为0；同mtime同长度改字节、跨实例/子进程、缓存对象修改及失败RMW污染均覆盖。主代理同规模复测约55ms，agent约51ms，仍读同样完整字节；不是生产SLA或常数时间承诺。

365篇confirmed及5万条无关早期历史，三次来源复核约902ms；可读口单次公共召回原有5次核验。现在仍校验每条旧timestamp，但实际瞬时早于最早所需当地日时省herDay投影，5000旧行正式计数由5104→104；UTC前一日的当地02点有效源仍纳入。同步过滤复用同栈已有结果，保所有await/格式化回调后的fresh检查，实际公共召回最多4次。没有mtime/TTL或world/计划输出缓存。复测同规模约652ms；全历史时间戳校验、文件字节读取及所有confirmed材料重算仍有线性成本，不能声称资源审查完结。

性能探针已保存为可移植的memory-source-resource.mjs及memory-source-resource-diary.mjs；它们报告合成测量，不替代正确性回归。新元数据接口只返回doc/UUID/hash/phase和保护清单，不增加持久隐私文件；旧mixed清单/协调约定保持。ADR0256/0257记录协议。没有服务端观察清理/公共派生重建或解封，没有真实API/部署/运行时访问。

### 第十四批验证与提交

新增18项正式：来源缺失/覆盖及早期历史8、fresh-byte资源8、同步核验次数1、真实模拟宿主1；记忆审查累计新增502项。主553集通过后补模拟直接调用方，最终554/554确认合成集通过；随后类型检查指出undefined/null分支已返回、函数条件恒真，删除冗余条件后15项关联与全仓类型再绿，Git差异/模块登记及生成文档通过。未把过程中的类型错误或夹具错误冒称通过，未运行未经核实的全仓npm test/旧真实卡用例。

独立本地代码提交`0f23a99a`（fresh-byte元数据复用）、`aaf33c17`（已知意图覆盖、App/模拟宿主与资源调用链）。AGENTS.md保持原未跟踪，未推送或部署。接续重点仍为M32b公共原文到远端旧派生的证据修订/清理；新source覆盖不是远端旧观察已净，保持ADR0251/0255的能力、历史行及未知DELETE边界。其余资源/生命周期/多文件恢复按风险证据继续，模块尚未完成。

## 第十五批：来源索引完整性与归档参数入口（2026-11-05）

M32b来源覆盖补查：合成completed outbox保留operations/marker，仅丢current后，旧guardState返回空意图，重启snapshot也接受。两项正式回归先报Missing expected exception。现在每个已知bank/document均须有current；多个completed历史版本仍合法，未完成版本仍必须current。损坏原件保留、恢复正确原件可读，不猜测最新版本；这不是抗恶意整体状态回滚协议。代码7bc1766c。新增2项，556/556核实合成集及全仓类型、模块登记、差异通过。

并行归档CLI输入审查发现缺值回退默认路径：--data/--config/--koishi/--prefix末尾无值会到达真实archiveTestData入口，dryRun=false；用registerHooks替换纯capture后端取证，没有实际运行时读写。修复与最终验证见本批后续记录。

并行模拟宿主生命周期审查确证：background relationship读取held，runScenario返回并删除两个测试bank后再释放失败，sim.log新增67字节，已返回steps.logs同时被改变。仅合成card/fake API，未改sim源；此问题待后续独立修复，不能把batch14来源接线称为完整模拟生命周期保障。restart/final所有者stop/drain及高级API转发需要连贯复核；高级API能力降级目前是代码线索，尚未作完整行为验证。

远端公共旧派生与observation独立清理仍受既有证据阻点限制，本批未DELETE/触发整合/解除guard，不读取真实部署或角色数据。

归档CLI修复已完成：单次parser先拒缺值/下一flag/空白、重复/未知及config/no-config冲突，合法路径/前缀/演练/原resume保持；5项正式回归先3红2绿后全绿，相关11项通过，全仓类型通过。代码b6e9223b。本批新增7项，记忆累计509项。最终整合重跑见进度检查点；首次561集560通过、模块文档一项失败，原因写补充时误建第二份0254文件导致模块扫描选错路径，已删除该临时误建文件并补回原ADR，模块4项独立复核通过，非生产缺陷。未弱化断言。

模拟未修证据保存为docs/reviews/repro/memory-sim-owner-lifecycle.mjs；默认结束和--restart两种模式均是坏行为诊断，exit0不表示修复。restart时旧请求还能写入新step日志。下一轮优先修旧owner stop/drain及清库顺序，保已派发ACK事实，再验证switchable高级API能力是否被降级；不声称其余归档强杀阶段已全部覆盖。

最终重跑561/561全绿（核实合成集，非全仓全量），全仓类型及差异检查通过。代码任务分别7bc1766c与b6e9223b；原未跟踪AGENTS.md保持，未推送/部署。

## 第十六批：上下文摘要来源与模拟宿主记忆协议

上下文摘要沿直接调用链确认旧key只看length/末条时间/正文。前文撤回但末条相同，内存、在途完成及重启缓存继续返回旧隐私摘要；3项合成回归先红后绿。改为实际summaryRequest完整内容的source-v2 SHA，覆盖实际使用的末200条材料、角色名、时区呈现与系统规则，派发复用同一请求快照。旧弱key不追认，实际未进入模型的更早材料不造成额外生成；默认关闭/窗口策略不改。提交99dd4017，全仓类型通过；旧context-window.test含真实角色加载，未执行。

模拟Hindsight包装确认丢失advanced能力：真实runScenario＋真实SDK假HTTP全部retain仍pending但旧writer记3篇written。动态代理现在保真实能力、原api this、参数与取消；缺省仍缺省，down拒业务请求、deleteBank保清理例外。正式新增4项，相关17绿、全仓类型通过，提交d013e5b0。首次memory:true步骤夹具被parseScenario拒绝不计源码证据，修为memory:'sync'后才得到written=3的真红。

生命周期正在独立修复。上轮--restart探针与本轮第一版回归按generate总次数判断重启，误把后台提取算对话；该特定证据口径更正，须识别实际重启后对话并在旧源码重证，不能用原错误触发点宣称旧实例跨restart。普通final晚读日志/报告、步骤异常、try前构造失败、已派retain尚未ACK却先清bank等反例已各自确证。交叉审另用realRain＋无效mood合成证明构造失败留下全局天气，已要求纳入同生命周期收尾。这里只记录证据，最终实现及验证见后续补记。

生命周期最终实现c656ad9e：小型owner集合贯通早期构造异常、restart/final和forget；先失效旧epoch/插话timer和纯摘要生成等待，再同时stop全部owner，等待已派mutation ACK/状态及planner.running后替换或清bank。provider获得的log绑定派发epoch，晚raw/onPrompt/fact记录不改结束或新step报告；summary微任务派发前再查取消，重启/forget重建signal。天气早构造失败也按原约定恢复undefined，不声称并行场景global隔离。

生命周期新增7项全绿。修正重启夹具后，以用户“合成重启后问候”实际prompt识别释放时机，registerHooks隔离加载d013e5b0旧runner，真实重启case仍明确红（lateDuringRestart true），新源绿；原“第2次generate”触发的旧证据撤回。portable探针普通/--restart均已改正确行为（lateLog0、报告不变），不再用旧坏行为断言。交叉代理独立天气及承诺抽取late logger探针也绿。

类型验证更正：d013e5b0提交前主代理将npm类型输出重定向后接git diff --check，后者成功覆盖shell退出码，误报类型通过；实际两处新MemoryItem夹具缺context/document_id/tags/metadata。补齐必填字段提交76010813，相关4项重新通过，全仓类型实际exit0。没有修改生产协议规避类型。99dd4017的独立类型检查当时通过。最终575/575核实合成集绿，夹具修正后4项及全仓类型重新绿、差异/模块通过；不是全仓角色依赖测试全量。本批新增14（context3/capability4/lifecycle7），记忆累计523。

后续：M32b公共diary/week/phase旧远端派生和历史observation清理/独立证据解封仍未实现，已有阻点不变；本批客户端来源和模拟owner不替代远端静止证明。新只读线索：App contextWindowFor创建的contextSummarizer有idle但无stop，App.stop尚未统一持有它，需用真实App合成held模型验证停止后是否仍写context/<QQ>.json/日志；这是候选，不能当已确证。之后按证据续审其它维护多文件和资源边界，记忆未完，不跳模块。未访问真实卡/runtime/部署/外部模型或数据库，AGENTS.md保原未跟踪。

## 第十七批：App摘要停止与联系人缓存残留

真实App+合成card/history/假generate证明：摘要held时await stop并释放bot.lock，随后旧成功仍写context/10001.json，旧失败和授予generate的log回调仍记日志。两条正式先红后绿，额外断言重复stop复用drain。core返回OwnedSummarizer，保原纯读取Summarizer类型；同步永久停止新派发/缓存读取，取消race与计时器后idle/drain可结束，不等不合作底层模型，晚成功/失败不写文件/cache/retry/log。派发微任务也复查stopped。已确认文件不删除，新实例仍按完整请求hash复用。App持有全部实际摘要实例并合并stop drain，再释放目录锁，另守授予模型的log。模拟器既有可重启adapter不误套永久stop。

core新增5正式；旧文件registerHooks控制4项真实效果红（晚落盘/晚错误日志/微任务新派/停止后缓存供给），另1项仅新增API契约红，不算旧功能反例。App新增2，相关13项及随后582合成集/全仓类型绿；代码52c72e39。App responder集合只初始化与缺席时新增，没有现行同实例替换路径，交叉审的“替换时需失效”假设未列确证或阻点。

隐私同类确认：真实writeJsonAtomic rename EIO且cleanup EPERM产context/QQ.json.tmp-PID-seq，真实坏JSON隔离产QQ.json.corrupt-time，两者含合成正文却audit artifacts为空；jokes/idioms实际失败写入产QQ.json.tmp同样漏。审计与forget-job ownedPath新增共享精确匹配，避免只加清单后apply schema拒绝；仅各目录真实命名，他人/近似号码/伪suffix/shared不纳入个人删除。新5正式覆盖真实残留/导出/完整apply+resume/归档后清单/链接；旧4业务红，链接案例初版empty-dir清理夹具错误已修，不计源缺陷。现有archive保留context/jokes/idioms政策不变，保留项仍能隐私审计/导出/遗忘。代码1cbd042e；ADR0043及0246补说明。

最终587/587核实合成集、全仓类型实际exit0、模块登记及差异检查通过。本批新增12（core5/App2/privacy5），记忆累计535。只合成卡/聊天、假API、temp，未跑旧角色依赖suite，未推送/部署，AGENTS.md仍原未跟踪。

下一步候选：startApp catch构造异常仅release租约，createApp内部在返回App对象前已创建memoryTimer和其它owner；若后续context文件读取等构造失败，可能旧任务仍持活，须假timer/真实App合成复现，未确证前不可称漏写或修复。M32b远端旧公共派生/历史observation清理与独立证据解封仍受已记录服务端证据限制；本批不提供远端清除保证，不转下一模块。

## 第十八批：App构造失败资源收尾

候选已真实合成确证：context文件EIO在memoryTimer创建后令startApp抛错；旧bot.lock被移除且同目录租约可重取，timer未clear、LongTerm仍可派发。独立设备probe进一步证明late startup访问未初始化stopped导致TDZ，service.stop零次，授予say仍外发。两者都是构造失败路径，不重复第十七批正常stop摘要缺陷。

新增构造收尾scope，stopped在任何资源前初始化。每项取得后登记失败关闭，构造成功commit清登记；失败先同步停止所有已建资源，再等实际异步收尾后释放租约，保持同步抛原错误。登记天气首refresh/全局天气/interval、生活timer、双media、photoAbort、heartbeat、tastes两timer、pending设备及late服务stop、memory/promises/diary/context/responders与memoryTimer。presence/browsing/risk/replies/planner仅connected后启动，不能把不存在实例算遗漏。设备授予log/say/onAudit门控，late stop拒绝原promise交allSettled诊断，不吞成成功。

天气无stop接口，首refresh已派请求不能靠clearInterval撤回。保存完整首刷新promise，故障关闭全局读口/定时器后仍持租约，让原两城市刷新成功缓存或失败正常收尾。正式假fetch成功两份原子写时锁均存在，失败不造缓存；未猜取消内部后继请求。未回滚构造期间已发生同步有效写入，不承诺多文件事务。正常stop设备/天气完整drain仍须独立验证；不合作startup/stop可使租约持续保留，global天气多实例隔离无新增保证。

正式新增5（context构造EIO1，设备2，天气成功/失败2），均旧源真红→新源绿；设备/天气4用registerHooks仅换e8d67bdd App得到4/4红。相关13项先绿，最终592/592确认合成集，全仓类型实际exit0、模块新增ADR后4项再绿、差异通过。代码3ce7d0bc，ADR0259。记忆累计540项；未读真实卡/runtime、未外联QQ/天气/模型/DB、未部署推送，AGENTS.md未跟踪保留。

下一轮：正常成功构造后的App.stop目前仍只void deviceService.stop/清weatherTimer，需复用合法合成天气/设备fixture独立验证held首刷新、后续interval刷新、设备startup/stop以及已派通知ACK与释放租约顺序，再按证据修（不能假定构造scope也覆盖正常stop）。M32b公共旧派生/历史observation独立清理与有证据解封仍受远端证据阻点，记忆尚未完成，不跳模块。

## 第十九批：正常停止的设备通知与天气收尾

独立真实App合成确认：无其它owner掩盖时，pending设备startup、held service.stop、已派say成功/失败ACK尚未结束，旧App.stop返回undefined并释放锁；首weather与后续interval刷新也在锁释放后落缓存。不是上一批构造失败的重复反例。

共享幂等stopDevices聚合startup、服务stop和已派通知，构造失败与正常stop共用；late服务关闭一次，停止后拒新回调。交叉复核进一步真正确证公开transport同步调用app.stop时，原“调用后登记通知”漏入stop快照，成功/失败ACK期间锁已释放，同步throw还迟到诊断。改为调用前预登记settlement，仍立即发、不排队，成功/失败/同步throw均settle且已停止不日志。不新增通知聊天历史或重发策略，保已派事实。

天气App层统一refresh入口，Set跟踪完整两城市singleflight任务；停止置位后不派新轮，正常stop快照全部weatherDrains，构造rollback也allSettled后汇总，保租约到落盘/失败降级结束。重复interval不重复底层请求；不改provider、不假取消后继城市。按同类重入风险新增fake fetch函数体同步stop验证，当前本来通过：withWeatherDeadline微任务边界让任务先登记，故无额外天气重入缺陷及生产重构。

新增13项（设备9/天气4）：设备最初4和补重入3真红→绿，另startup/stop拒绝2为边界验证；天气最初3真红→绿+同步fetch1边界绿。相关20/8定向通过，最终605/605核实合成集、全仓类型实际exit0/模块/差异通过。代码a9f64d95，ADR0259补正常停止约定；记忆累计553项。仅合成卡、假timer/fetch/service/transport/temp，不访问真实角色/runtime/QQ/天气/模型/DB，不推送部署，AGENTS.md保原未跟踪。

边界：不合作startup/service.stop/transport可阻drain，保证退出等待不等于强杀可恢复；无持久通知outbox、跨QQ+JSON事务或任意重试exactly-once，全局weather多实例隔离未解决。后续统一盘点App其余与记忆相关后台工作（优先tastes.reflect的定时启动、模型await后持久及stop链），用合成证据确认后修；尚未验证，不称新缺陷。M32b公共旧派生/历史observation远端清理与独立证据解封仍未完成，不以已完成owner工作代替该保证，不转下一模块。

## 第二十批：偏好反思停止所有权与后台任务盘点（2026-11-05）

真实 App、临时合成卡、六条合成 watched 经历、假 120 秒 timer 和 held generate 复现两条旧行为：stop/目录租约释放后成功结果写 tastes.json/lastReflectAt/时间线；失败及授予模型的 log 晚写日志。不是清 timer 就能完成的停止。代码 8d796d31：Tastes 登记每次任务，停止同步拒新、取消纯模型 race 并 drain 本体；微任务派发和 await 后复查，迟到结果不再写。App 正常 stop/构造回滚均登记；timer、模型 log、onChange 额外守宿主停止。原已确认文件、新实例读取和既有反思间隔保留，不改偏好证据/频率策略。底层不合作纯模型无需等完，但不声称远端已取消或任意模型自身副作用被终止；未扩展为并发 RMW 协议。

新增 6 项正式回归：App 两项先红后绿；核心四项包括派发前停止、held 成功/失败、重复 drain、已确认文件与新实例。最终 611/611 核实合成集通过，全仓类型实际 exit 0、模块及 git diff --check 通过。记忆累计新增 559 项。仅 memory*.test.ts + 纯 bilibili-dm-card + modules；没有运行旧真实角色依赖 suite，也不是新全仓全量结果。

### 本轮盘点及下一确证

- 已有取消提交守卫：照片/食物发现共享 photoDiscovery.signal，core 每 await/提交前复查；周报同步入口，无待收尾异步任务。本轮不重做旧视觉缺陷。
- 新确证未修：小梗后台提取。node docs/reviews/repro/memory-app-jokes-owner.mjs 用真实 App、42 条合成 history、临时两张合成卡与假 API，connected 派发 held extractor；stop 释放 bot.lock 时小梗文件尚不存在，释放结果后 lateFileExists=true、lateJokeCount=1、late 成功日志 1。退出 0 只是报告坏行为，不是正确性回归。App refreshAllJokes 只有入口 stopped，jokes await 后 save/log；下一批优先贯通 owner、取消和 fresh 来源核验及 stop/restart，先增加正式红绿回归。
- 仅源码风险，尚未复现：口头习惯 await 后 save；watch/feed/memes 的 connected/interval 异步链以及 stickers queue/discover/mirror 无统一 stop/drain。不能将这些称已确认缺陷；图片表情收藏等已派 mutation ACK 需保真实事实，与纯读取/模型取消分开。B站/社交模块仍未整体审。

M32b 远端公共 diary/week/phase 旧派生与历史 observation 清理/独立证据解封仍未完成。现有保护不解；本地任务取消不证明服务端 worker 静止。官方固定版 HTTP 及 live inventory 不能替代实际 store、可信 writer/task fence 和独立完成证据，未知 DELETE 不盲重试/猜成功。不访问真部署/角色/runtime/服务，记忆未完不转模块。

## 第二十一批：小梗后台所有权与在途来源保护（2026-11-05）

代码6e76e4f8，ADR0114补记。真实App停机成功/失败两项先红后绿：旧held extractor在目录租约释放后写jokes文件或授予log及catch日志。独立jokeRefresher拥有本地任务，调用时冻结source，微任务前登记，stop同步拒新并取消纯模型race、复用drain；App构造与正常停止等待本体，模型授予日志另守宿主。已确认文件及新owner/standalone原刷新间隔保留；取消不表示provider远端停止。

A在途来源另有真实App红：42条同长度消息，未回复的两条唯一phrase来源被撤回占位，旧提取仍保存并进入下一轮实际prompt。现在App freshHistory贯通；微任务派发前及await后按完整原前缀role/time/content复查（回调后再守stop），正常尾追加允许但进度仅记实际消耗42条。改写、截短或fresh读取EIO不提交旧结果。独立调用不提供freshHistory只有快照语义。实际A新源绿，提示词未再含phrase/origin。夹具起初按connected立即假定extracts1，不适应新增微任务owner，已改until真实派发；不把夹具extract0算缺陷。

新增16项正式回归（核心13/Appstop2/Apprecall1），记忆累计575；最终627/627核实合成集、全仓类型实际exit0、模块及差异全部通过。合成集仍是memory*.test.ts + 纯bilibili-dm-card + modules，不是新全仓全量，未运行旧真实角色suite。旧memory-app-jokes-owner.mjs已变正确stop探针，不再用旧坏断言。

### 下一检查点：已完成小梗来历的持久依赖仍未修

运行node docs/reviews/repro/memory-app-jokes-revision.mjs可比较两mode：held现在storedJokes0/promptHasOrigin=false；completed-restart仍storedJokes1/promptHasOrigin=true、extracts1。B先完成写入（origin唯一来自一条未回复消息，phrase另两条仍出现），撤回唯一origin来源，stop/restart且20小时窗口内不重抽，fresh历史已无origin，但旧文件供给实际prompt仍含origin。探针exit0只是报告事实，尤其B仍是未修缺陷。不能以phrase仍有两次或简单清RAM宣称解决；需持久完整来源/读口、重启及旧无manifest兼容，保已回复/危机语义，不猜迁移或删除全部既有事实。

下一批优先该B，再按风险接idioms/watch/feed/memes/stickers源码候选（尚未逐项确证）。M32b远端公共旧派生/历史observation清理和独立证据解封仍未完成。现有保护保留；固定官方API/live inventory不能代替真实store一致性与可信writer/task fence，未知DELETE不盲重试。仅合成卡/聊天/fakeAPI/temp，未读真角色/runtime或访问外部服务，未部署推送。

## 第二十二批：小梗已完成来历的持久来源与重启（2026-11-05）

代码c777db5a，ADR0114补记。B真实App正式先红：完成保存后撤回origin唯一来源、phrase仍有另外两条，重启20h内不重抽，但旧origin进实际prompt。现每份缓存存source版本、完整历史前缀count/historyHash、派发前固定requestHash及jokesHash。生产提示词读口及状态可用数均fresh核验；前缀修改/截短/来源撤回遮盖整份派生内容，保原文件。新请求传副本，provider改参数不篡改本地指纹；请求hash不是远端回执。正常尾追加、已回复忽略撤回、危机keep未改事实均保持，未强迫危机轮显示小梗。

旧无manifest保原暂避；显式坏source/集合hash不匹配拒读及刷新。保原20h冷却和40条窗口门槛，来源失效/legacy到期可绕MIN_NEW与旧cursor重新提取，不能永久等不到新消息；旧origin仅在原source有效时才能carry，新完整前缀包含全部继承依赖。失效/legacy旧内容不能借新hash洗白。sim作者明确预置梗接口不变。未新增原文/绝对路径/sidefile，现jokes/QQ.json与精确.tmp隐私规则仍覆盖。

交叉故障核验另确证badJSON、readEIO、invalid-source诊断抛错会落原catch空白legacy，实际modelCalls1/refreshedtrue覆盖旧bytes；现除明确ENOENT外未知读取/schema状态统一source:null，诊断失败不绕屏障，原文件不动。最初all-log-throws只证明异常逃逸，不算覆盖缺陷；定向invalid诊断抛错才确证wash，最终回归更强为所有log抛错仍拒覆写。ENOENT正常首次写是正对照，不算缺陷。

新增16（core12/App4），记忆累计591；最终643/643核实合成集、全仓类型实际exit0、模块和差异全部通过。仅memory*.test.ts+纯bilibili-dm-card+modules，不是新全仓全量。两mode memory-app-jokes-revision.mjs已改正确断言：A不落盘不进prompt；B保原1条及字节但不进prompt，extracts均1。勿再把B旧坏断言当当前未修。未跑旧真实角色suite，无外部服务/部署/推送。

下一轮：优先合成验证idioms的后台owner与在途/已完成来源依赖（目前仍源码候选，不冒称已确证）；小梗重叠刷新RMW尚未作为本批覆盖，按具体证据补查。watch/feed/memes/stickers仍候选。记忆模块尚未完成，M32b远端公共旧派生/历史observation清理及独立完成证据仍未打通，现保护不解，不能以本地hash/source/stop等同远端净化。既有真实部署不可访问、未知DELETE、旧weakID/legacybefore/未持久观察、跨时区pending、多文件非事务及不合作写者边界保持。

## 第二十三批：口头习惯停止/来源与重叠提交（2026-11-05）

真实App使用临时合成卡、64条用户消息跨4日、假模型/transport/network拒真实访问；8项正式先4红4绿：停机后held成功写文件、失败/授予log晚写；在途4条依据撤回仍保存；已完成撤回3/4仅余一次，重启actual prompt仍称“平时爱说”。全撤时原idiomLine鲜度检查已拦，是绿对照，不冒称该场景泄漏。已回复忽略撤回、危机keep、正常append正对照保持。

代码bd0cf0ad（ADR0138）：idiomRefresher拥有所有本地任务，微任务前登记/停止拒新、纯模型等待可取消且drain，App构造/正常stop接线及model log守界。freshHistory前缀核验贯通派发前/await后；持久source绑定完整role/time/content、请求指纹、items及blocked集合hash，生产提取/读口同idiomBlockedFor。旧分类来源失效暂避保原，legacy到期重学不被旧cursor永久挡，坏source/JSON/IO及诊断失败保原拒覆盖。原20h/60消息/20新消息/30日/4次3日/300x60输入与展示概率不改。无新raw/路径/sidefile，现idioms精确文件隐私链继续覆盖。独立低层调用不提供freshHistory仍只有自身快照，不宣称任意外部来源一致。

并行实际文件确证两组重叠提交：小梗旧42条held，54条新结果先提交后旧结果把进度回退42；口头习惯64/84同样回退64。小梗fff7b97b先独立27定向+全仓类型+diff绿后提交，口头习惯随后正式先红再修入bd0cf0ad。保存前重读比较派发时状态摘要，改变则弃旧结果；新发布失败的对照仍允许旧任务正常提交，不伪造已发生事实。同步读比写依赖App目录单写者，非跨进程原子CAS，不消除重复模型成本，不泛称全并发已证明。

新增30（小梗重叠2、口头习惯core18/App8/重叠2），记忆累计621。先671/671及类型绿后新增idioms重叠修复，最后完整重跑673/673、全仓类型实际exit0、模块/差异绿；最终结果覆盖最后代码，不沿用前一版。仍仅核实memory*.test.ts+纯bilibili-dm-card+modules，非新全仓全量，未跑旧真实卡suite。

下一轮先真实App合成验证watchJob/feedJob的停止所有权、已派响应后落watched/feed/历史与后继外部请求；尚源码候选，未确证勿称缺陷。memes/stickers也待风险复核，照片/食物已取消守卫不重做；B站/社交模块未整体审。本轮小梗/idioms具体旧覆盖反例已修，不重复旧清单。M32b远端公共旧派生/历史observation清理及独立证据解封仍未完成，真实部署/服务不可访问，现保护不解，不把本地source/stop当远端净化。记忆仍未完成不转模块。

## 第二十四批：观看/推荐流停止与持久风险收尾（2026-11-05）

代码90cbec56，ADR0130/0168补记。观看真实App两项先红：held账号nav在stop后继续search/view/player/subtitle后继请求，held字幕stop后写watched。timeline:true确认字幕装饰器晚成功/失败副写；核心另两红后修，评论mutation ACK及signal/receiver透传作正对照。App ownPassiveRead派发前登记，watch/feed各自running与统一lifetime，构造/正常stop取消本地纯读/模型等待、sleep及后继派发，等待任务本体再释放目录。watchOne内部8段等待与BiliAccount search/subtitle的nav钥匙/view/player/字幕fetch/text全部贯通单次signal；不全局中止共享mutation，已确认观看文件不回滚。

推荐流真实App7项先5红2绿：nav fetch/body与推荐fetch/body held均晚写feed，dryRun晚写draft；已同步完成on/dryRun保原是绿对照。feedOnce逐层取消request/text且保response this，晚nav不能派推荐；cancelled与done区分。公开awake/Date回调同步stop的分类、toLocaleString后draft、trim/getFullYear后save另实证并守最后提交；watchDue/trim同类单独真红后修。不能将所有新边界case都算独立缺陷。

生产特有余波另2真红：不注入bilibiliRequest（该注入原会绕过breaker），使用fake全局fetch持有初nav HTTP429或200体-352，旧App heldLease=false后才写实际breaker。现真实guard完整请求在派发前登记settlement，正常/构造stop等待持久风险观察后才释放租约；保已派风险事实，不一律丢弃。纯假read/model仍可本地取消不等不合作provider，但带持久副作用guard若不合作可阻drain。只保证已派guard与本轮watch/feed链路，未接owner的其它任务将来再发请求不是该快照自动覆盖的保证。

新增49（观看core22/App4、推荐流core12/App7、timeline4），记忆累计670。提前类型检查真实exit1发现ensureKeys新增required参数破坏旧mutation调用、closure丢mode narrowing、readonly text测试赋值；修为默认request/入口mode快照/defineProperty。最终完整722/722核实合成集、全仓类型实际exit0、模块/差异绿。仅memory*.test.ts+纯bilibili-dm-card+modules，不是新全仓全量，未跑旧卡suite。全部临时合成卡/凭证/聊天/假fetch/API，不访问真实账号/runtime/外网服务，不部署推送。

下一轮先真实App合成验证refreshMemeJob：held accountSource/fetchLists/ask/gather后stop是否继续新请求、落memes或RAM/日志；目前源码候选，不冒称已确认。优先核其共享账号来源返回后新派guard不在前一stop已派快照的问题；不以本批guard登记假称全部后台任务已经关闭。stickers/replies/risk仍需直接owner证据盘点；B站/社交未整体审，photo/food及本批watch/feed旧反例不重复。M32b远端公共旧派生/历史observation清理与独立证据解封仍未完成，当前保护不解、不访问真部署DB，记忆未完不转模块。

## 第二十五批：热梗后台读取与停止所有权（2026-11-05）

代码08ef50fd，ADR0129补记。真实App7项先6红1绿，使用fake globalfetch经过真实realRequest/guardRequest而不注入绕过breaker的request。初始accountSource held后stop，旧代码从1次请求继续到12次（popular三页、hotword、weibo、baidu、搜索、view、player、字幕与热评），并晚落memes；列表JSON body、候选模型、gather搜索、解释模型分别held也能晚落盘，失败与授予模型logger可晚输出。正常完成后重启遵守12h间隔是绿对照。held账号/search的已派生产guard依旧按stop→释放响应→await drain收尾，不能误把必要的持久风险等待算取消失败。

App refreshMemeJob复用ownPassiveRead/passiveRead/passiveLifetime，派发前登记任务，停止同步拒后续入口并取消本地纯模型/读取等待，scoped logger及最终RAM重新加载守停止。memes.ts新增可选signal：fetchLists逐fetch/json/分页/来源循环，gatherEvidence逐search/sleep/subtitle/hotComments，refreshMemes逐模型、来源格式化、日期与提交检查；catch不吞取消后继续下一来源。最终待保存对象先计算再检查，已确认保存事实不回滚。账号search/subtitle单次signal透传；公共热评使用passiveFetch。既有guard的完整持久风险settlement仍归宿主drain，不全局中止mutation。保持四来源、候选与证据限额及12h策略，不新增重试。

新增24（核心17/App7），其中边界对照不是24组缺陷；核心覆盖四个held阶段真实旧落盘、fetch/json/间隔/字幕/热评、普通失败降级、日期回调同步停止以及提交后停止保事实。最终746/746核实合成集、全仓类型实际exit0、模块/差异检查通过。只执行memory*.test.ts+纯bilibili-dm-card+modules，不是全仓全量；所有卡/凭证/事件均临时合成，API/HTTP均假服务，不访问真实角色/runtime/账号/服务，不推送部署。

独立确证尚未修复：memory-meme-author-race.mjs启动真实作者CLI（显式--dir临时绝对目录），后台候选模型held期间remove成功、文件0条；释放旧模型后原缓存条目被bump并保存回来。当前cliRemoved=true、afterRefresh含合成喵梗、authorRemovalPreserved=false；exit0仅事实报告，不是正确性回归。下轮先贯通后台和CLI原子跨进程读改写/作者意图、冲突重读、崩溃及IO，不以无锁状态摘要检查假称跨进程协议。CLI缺--dir值可能回默认路径仅源码候选，未执行可能触及真实默认目录的命令，不计确证缺陷。

本批不涵盖该并发删除、不宣称远端请求已物理取消；不合作生产guard可持续阻drain。stickers/replies/risk直接owner仍待实证，B站/社交未整体审。M32b远端旧公共派生与历史observation清理/独立证据解封仍受既有可信store/writer/task证据边界保护；本地source/完成/停止不证明远端净化，不访问真部署DB。记忆模块未完成，继续本模块。

## 第二十六批：热梗作者并发与实际读口（2026-11-05）

代码74ecf5dc，ADR0129补记；新增meme-store.ts归语言模块，派生及作者混合缓存沿记忆直接链继续审查。生产写入清单只有refreshMemes与meme-cli；saveMemes显式替换也统一上锁，不遗漏未来调用。原真实CLI remove/add/update与两个ABA及发布后EIO共6行为红；两个App实际prompt原仍带作者已删/修的旧解释，另2真红。只锁最终rename或无锁hash比较无法解决这组问题。

短SQLite OS锁在完整同步RMW期间持有，JSON为事实源；锁外模型结果提交时fresh重读，按作者世代+条目身份合并仍有效的旧词观察，旧删除不复活、旧解释不覆盖、独立新增保留。无界墓碑改为全局作者世代保护未知新词，作者介入则旧轮新学习保守延后；较旧轮迟到保持较新的refreshedAt。删除后下一全新榜单轮仍可按原政策学习，不额外发明永久禁用。旧合法v1缺revision字段视0，坏schema/JSON/计数溢出/坏协调库保原拒绝，不静默隔离成空白。所有写者须升级、运行中不能删换coord或手改JSON，无非合作旧写者/人工删库/断电fsync/networkFS保证。

测试正式16并发/恢复项覆盖两进程各6次增量、busy回调不执行、强杀持锁进程、rename前后强杀、发布前EROFS与后EIO、ABA、legacy/坏库/安全整数上限及旧轮时间不回退。发布后异常锁内精确bytes读回承认事实，不能把已成功的作者动作伪报失败并自动重试；未知状态不盲重发。强杀夹具最初closure读取重写后的argv，在执行前复核改冻结变量，不计产品缺陷；新增API缺失也不计旧缺陷。边界绿与故障对照数量不等缺陷数量。

App移除启动/刷新后RAM热梗快照，每次实际男友档提示词fresh读作者提交；2真实App新测试先因合成QQ时间小数被忽略而超时，改合法整数源秒后才取得旧解释断言真正失败，修后绿，不把夹具超时当原缺陷。新严格读取暴露refreshDue入口在try外，真实App坏库connected抛错，交叉追加1回归修为保原跳过后台；不是把新兼容余波混成既有严重问题。CLI缺--dir值旧fallback通过无IO原parser表达式证实；新纯parser5项覆盖拒缺/flag/空白/重复未知、合法选项和原默认行为，解析先于路径解析/任何读取。没有运行可能触及真实默认runtime的旧坏命令。

新增24（并发16/App读口2/参数5/App坏库1），记忆累计718。初全仓类型实际exit1为schema字符串与closure narrowing，已显式typeof及局部const修复。最终787/787核实合成集：memory*.test.ts+纯bilibili-dm-card+modules共770，另本次完整核实memes.test.ts17项全temp和假API，无角色卡/外部读取，坏库旧1断言按有意协议加固更新且其余不弱化。全仓类型实际exit0、模块/差异全部通过，非全仓全量。正确行为probe现在断言CLI删除保持，原结果已不再是未修证据。未访问真角色/runtime/账号/服务/DB，无部署推送。

新coord只承载OS协调不存正文/联系人，JSON只增整数元数据，不猜新增联系人归属；共享memes及残留不能按号码整份遗忘。本轮不解决远端M32b公共旧派生或历史观察清理，可信store/writer/task冻结与独立完成证据仍缺，既有屏障保持。下一轮从App discoverStickers/消息collect真实合成held链验证借用owner和停止：trend/favorites/download/describe/decide纯读取与favorites.add远端mutation ACK必须区别；只读候选尚未确证，不盲给外部共享StickerShelf加全局stop。replies/risk与其它性能继续按证据审，B站/社交未整体审，记忆模块未完成。
