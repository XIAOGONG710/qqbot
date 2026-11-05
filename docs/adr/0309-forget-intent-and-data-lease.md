# ADR 0309：遗忘意图恢复与全目录维护租约

状态：接受，2026-11-05。接续 ADR 0300、0302、0303、0305、0308。

## 证据

M30b独立进程实证：forget移动联系人state后等待删除，另一进程仍能取得bot.lock并写回聊天。此时强杀没有报告，普通重跑已丢历史bank目标；普通503返回后也会再次零调用、空failures。另在PID检查与unlink之间插入第二持有者，原锁会删掉新锁，使两写者成功。

## 决定

1. 数据目录使用持久bot.coordination.sqlite的OS事务租约，覆盖整个App运行或维护过程；没有业务表或聊天。PID文件仅诊断并兼容拒绝旧活写者，同PID活租约仍不可重入。锁内检查/清理陈旧PID，释放先处理本次PID再关事务；强杀由OS释放，坏协调文件失败关闭。旧写者须统一升级，运行中不可删换协调inode，50ms仅争锁预算，不是工作截止时间。
2. forget apply从审计前到移动、远端确认、报告及可选CLI审计一直持有同租约。archive实际操作也全过程持锁；App在构造前、archive在修改前检查未完成遗忘任务。任务错误或未完成时不得清prompt、读卡/写世界或换bank前缀。干净构造失败释放本次租约，读侧导出/演练保只读。
3. 任何本地移动之前，maintenance/forget-jobs/UUID.json原子保存不可变原计划、QQ/数据根、trash、原文件size/hash、远端精确目标与CLI endpoint摘要；不存正文。逐项持久moved和远端pending/dispatching/uncertain/done，最后complete。JSON为事实源。--resume UUID只恢复该计划，不重新发现已移动后丢失的目标，不采用新的commonBank扩大范围；绑定QQ/endpoint，校验路径、链接、计划hash及原/目标文件hash。Windows根目录大小写别名按同一物理身份比较，不改不可变原计划。
4. 本地rename成功、检查点之前退出，可凭目标hash确认原移动继续；source/target冲突、原件改变或计划坏形状保留文件并阻断。原子发布后报错只在完整读回匹配时确认。缺final但有实际tmp不得猜不存在；坏状态不自动隔离成空白。
5. 远端派发前先持久dispatching，成功或明确404才done。timeout、503及其他无结束证明的错误保uncertain；重启dispatching同样不盲重发。网关5xx可能先返回而上游仍执行，不能用一次新的DELETE成功或GET不存在证明原请求已经停止。无人工布尔解锁按钮；仅--resume展示原目标并如实保持未完成，需独立核实服务端后可信恢复。本批不承诺远端未知请求自动续跑。
6. 启动/归档屏障包含所有未完成job，不能靠普通新forget、换prefix或陈旧PID接管绕过。完成日志及实际tmp按校验后的plan.qq进入隐私mixed清单；作为维护意图原地保留，不自动移动、整份导出或删除。无效残留只报告归属未知。CLI审计在锁内、只记元数据；API默认不额外改共享账本。

## 边界

回收资料和任务日志是必要恢复依据；移回文件不代表未知删除已停止。JSON、多个本地文件、审计链和远端仍非全局事务。外部直接写/删maintenance目录、替换协调文件、fsync断电耐久、网络FS与任意网络exactly-once不在保证内。未知旧库、自然语言公共日记及共享资料继续如实列leave/限制，不猜归属或删除已回复事实。

验证仅临时合成文件、假删除API、真实独立进程、强杀/退出与IO注入；未操作真实runtime、模型/数据库或角色资料，未部署。

## 2026-11-05 联系人缓存的实际残留

真实json-file写入rename失败且临时清理失败会留下context/QQ.json.tmp-PID-sequence，坏JSON读取会隔离到QQ.json.corrupt-timestamp；jokes/idioms各自原子写失败留下固定QQ.json.tmp。此前联系人审计只认主文件，导致这些含正文的副本不进入导出/遗忘计划。现在审计与持久forget-job的ownedPath共享同一精确匹配规则，只纳对应目录生产者实际后缀；他人/相近号码/伪后缀和共享日记仍不混入，路径/链接验证保持。

正式合成回归覆盖真实失败生产的文件、导出、apply/resume原计划以及归档后审计。现有archive不移动context/jokes/idioms的政策不变，保留的残留仍可被后续隐私流程识别；不宣称归档已经删除隐私或实现全局多文件事务。
