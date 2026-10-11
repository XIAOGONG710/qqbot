# DeepSeek 连续接手手册

> 用途：当 Claude 与 GPT / Codex 的可用额度不足时，让 DeepSeek（下文简称 DS）在不依赖聊天记忆的情况下继续本项目。
> 本文件是接手入口，不替代 Git、ADR、测试、运行日志和用户裁决。

## 0. 本次交接快照

- 快照日期：2026-10-11（UTC+8）。
- 仓库：`XIAOGONG710/qqbot`，必须保持私有；远端为 `origin`。
- 基线（写本文件时）：`main`、`origin/main`、`origin/integration` 均指向 `2ba6df2c4daaf42b1db34cc4ccae713b7c711614`；之后 `main` 只多了本文件这类文档提交。
- **线上跑的代码是 `2ba6df2`**：12:30 cherry-pick 进线上目录的 `main`，Koishi 12:39 重启后生效。19:57 QQ 掉线、Koishi 退出，20:30 用户让恢复，代码没变。文档提交不影响运行。
- 工作树在编写本文件前无已跟踪改动。在 Codex 沙箱里检查要加 `--ignore-submodules=all`，因为沙箱进不了 `vendor/NapCatQQ` 的 Git 元数据；在线上那台虚拟机上，普通 `git status` 就能用。
- 2026-10-11 本机复核：`npm run typecheck` 通过；沙箱外 `npm test` 全部通过，共 738 项（bot 670、character-tools 40、Koishi 插件 28）。沙箱内同一测试曾有 133 项因临时目录原子 `rename` 被 `EPERM` 拒绝而失败，沙箱外重跑全部通过，不能把该环境误报当成代码回归。
- 最新上线：ADR 0060 于 2026-10-11 11:00 上线；12:39 又上线了跨回复行保留有效文字亲密回应的修正（ADR 0058 调整，`2ba6df2`）。服务现状必须到线上机器上看进程、端口和日志（§0.1），不能凭代码默认值推断。线上开关见 §4 P2。

### 0.1 线上在哪（已确定，不用问用户）

- **线上实例在 VMware 虚拟机上**（局域网 192.168.139.138），目录是 `C:\Users\XG\Desktop\Project\qqbot`。端口：Koishi :5140、NapCat OneBot :3001、Hindsight :8888。运行数据在 `runtime/bot/`，她的世界账在 `runtime/bot/world/`，日志在 `runtime/bot/logs/<日期>.log` 和 `runtime/koishi/data/logs/<日期>-N.log`。
- 用户联想主机上的仓库是**旧拷贝**：`runtime/` 是旧的，`koishi.yml` 停在 10-06（记忆关着），NapCat 是 pipe 模式。2026-10-10 DSH 和 Codex 都把那台机器的状态当成了线上，报了「服务挂了」「记忆关着」，都是错的。联想主机连不到这台虚拟机。
- 凡是报告线上状态，必须写明**在哪台机器、看的哪个文件或端口**。在联想主机上看到的一律不算线上证据。
- 用户说线上搬了地方，以用户说的为准，并更新本节。

### 0.2 线上目录就是线上（最容易出事）

- Node 24 直接跑 TS 源码，没有构建步骤：Koishi 每次启动，跑的都是这个目录当时的工作树。
- 服务守护 `scripts/services-watchdog.mjs` 在后台运行，每 60 秒检查一次 NapCat、Hindsight、Koishi；连续两次查不到 Koishi，就用 `scripts/start-koishi.ps1` 自己拉起来（10 分钟最多 3 次）。也就是说，任何时候都可能有一次没人发起的重启。
- Koishi 插件监视 `characters/linmengyao/st/`（`packages/koishi-plugin-qqbot/src/index.ts` 里的 `watch(cardDir…)`），卡一改就自己重载。所以在这个目录里跑 `npm run convert` 就是上线新卡。
- 因此：**在线上目录里不切分支、不改文件、不合并、不重新生成卡、不跑测试或模拟**。这个目录只读，唯一例外是用户点头上线时 fast-forward `main`（§5.3）。干活用自己的 worktree（§8.1）。

### 0.3 2026-10-11 23:20 后续快照（2026-10-11 合入准备时刷新）

- `origin/main` 与 `origin/codex/generalization-regression` 已原子、非强推更新到 `32a25773c2424dd3dfaec09d6184155978d4667c`。最终远端状态仍须以接手时的 `git fetch` / `git rev-parse` 为准。
- 当前工作分支为 `codex/generalization-regression`，worktree 为 `runtime/ds-generalization`。用户只授权了合入和推送，明确要求**本次不部署、不重启**；在线根工作区仍停在 `921183c86c8dff58f46f35cbf65bcbe85d733a82`，因此不能把远端 Git 状态描述成线上运行状态。
- 用户已明确允许本批把完整角色设定与纯虚构模拟对话发送给 DeepSeek；执行时关闭长期记忆、单并发，未发送真实聊天。该许可只作为本批证据，未来外发仍按 §7 再确认边界。
- 真模型：`generalization-v3` 的亲密回应两次均 26/26；最终 `generalization-v5` 的接梗两次均 16/16，8 次生成全部有正文。中间批次发现连续两次空正文，分支把当场空正文重试从 1 次增至 2 次。
- 验证：`npm run typecheck` 全仓通过；合入最新 `origin/main` 后，在沙箱外、重测试锁内、`--test-concurrency=1` 的全仓测试 747/747（bot 679、character-tools 40、Koishi 插件 28）。本地真模型报告位于被忽略的 `runtime/sim/`，没有提交到 GitHub；可复核结论已写入 ADR 0058 / 0059。
- 本批合入 `main` 已获授权；下一项仍需新授权的状态变化是按 §5.3 部署并重启线上 Koishi。推送 `main` 不等于已上线。
- 用户另行明确允许把目录名称、提交号、验证结果、交接章节摘要和隐私规则发给 DeepSeek；实际审阅已完成，未发送角色卡正文、真实聊天、标识符、日志、运行配置、token 或密钥。DS 确认 §7 的材料分类与最小化原则，逐项核验见 `docs/reports/2026-10-11-deepseek-handoff-review.md`。

### 共同创作来源

- Claude 侧事实输入：`CLAUDE.md`、`docs/roadmap.md`、`docs/plans/2026-10-08-long-term-execution.md`、`docs/reports/2026-10-10-progress.md`、`docs/exchange-protocol.md`、ADR 0001–0060，以及这些文件记录的 Claude 实施、审查、上线和用户裁决。
- GPT / Codex 侧本次交付：核对 Git 基线和远端、归纳当前能力与未来计划、设计 DS 接手提问和 GitHub 提交流程、执行类型检查与全仓测试、编写本文件。
- 本次尝试了两次 Claude CLI 实时只读审阅；认证正常但调用长期无输出，均已中止。
- 2026-10-11 20:40 Claude 在线上虚拟机上复审，审查意见见 `exchange` 分支 `exchange/reviews/2026-10-11-claude-review-deepseek-handoff.md`；改动已合进本文件（§0.1、§0.2、§3.1、§4、§5、§7、§8，签名见 §11）。

## 1. 接手后的第一轮动作

DS 不得一上来就改代码。先按顺序完成：

1. 读完本文件、`CLAUDE.md`、`思维链工作流.txt`。
2. 运行只读检查，确认当前分支、HEAD、远端和工作树；不要覆盖别人的未提交改动。线上目录只跑 `git status -sb` 看分支和改动，别的事都在自己的 worktree 里做（§0.2）。
3. 读与当前任务直接相关的最新进度报告、路线图、ADR 和测试。
4. 向用户发送第 7 节的“接手问题”，取得缺失的活状态、证据和授权边界。
5. 用一段不超过 10 行的“事实摘要”复述：当前目标、已知事实、未知项、准备验证的最小假设。让用户纠正事实，不要求用户审批普通只读检查。
6. 只在事实足够后进入修改；每批只做一个可验收目标。

建议的只读命令：

```powershell
git status --short --branch --ignore-submodules=all
git rev-parse HEAD
git rev-parse origin/main
git log -10 --oneline --decorate
git diff --name-status --ignore-submodules=all
git diff --cached --name-status --ignore-submodules=all
```

如果本文件的提交号、功能状态或未来计划与更晚的 Git / ADR 冲突，以“更晚且有证据的记录”为准，并立即更新本文件。

## 2. 可审计工作流（替代私密逐字思维链）

用户要求的“完整思维链”在这里实现为**可复现的工程推理记录**，不记录任何模型的私密逐字思考。每个结论必须让下一位维护者能从证据独立复核。

### 2.1 每个任务的完整闭环

1. **目标**：用一句话写清要改变的用户可见结果，以及明确不做什么。
2. **事实**：列出当前分支、提交、相关文件、真实日志、可复现步骤、现有测试和用户原话裁决；事实与猜测分开。
3. **依赖**：画出最小链路，例如“QQ 事件 → OneBot / Koishi → `app.ts` → 提示词 / 模型 → 出口检查 → 发送 → 日志 / 记忆 / 世界写回”。
4. **范围**：确认属于当前里程碑；不相关问题写入后续清单，不顺手扩张。
5. **分类**：标明是 Bug、迁移、重构、兼容、性能、新功能、数据修复或文档同步。
6. **候选方案**：至少记录“最小修复”和“结构性方案”的差异；优先官方接口、现有实现和可复用模块。
7. **编码前验证**：先写失败用例或最小复现；无法验证的改动不得直接上线。
8. **决策**：从 Restore / Migrate / Refactor / Rewrite / Freeze / Deprecate / Remove 中选择，并写清理由与未选方案。
9. **风险**：逐项检查隐私、数据、兼容、公共 API、成本、延迟、运行时隐性状态、跨档位信息泄漏。
10. **实施**：小步改动；每一步可类型检查、可测试、可回滚；修根因，不靠删功能消错。
11. **回归**：先相关测试，再包级测试，再全仓测试；涉及生成质量时再跑固定场景 / 盲评，不能用单元测试代替真人或真模型门槛。
12. **上线**：必须有用户授权；记录部署前 HEAD、停机窗口、重启结果、日志和回滚点。
13. **沉淀**：更新 ADR、路线图、进度报告、本文件；留下唯一推荐的下一动作。

### 2.2 每条结论的记录格式

```markdown
## <问题或批次>

- 目标：
- 观察：
- 证据：<文件:行 / 命令 / 脱敏日志 / 测试>
- 未知项：
- 假设：
- 最小实验：
- 结果：
- 决策与理由：
- 改动：
- 验证：
- 风险与回滚：
- 下一动作：
```

不得只写“我认为”“应该没问题”“测试过了”。要写测试命令、数量、失败原因和环境；未运行就写“未运行”。

## 3. 已交付的工程与当前边界

下表是接手导航，不替代对应 ADR 和最新 Git。

| 领域 | 已交付 | 主要证据 / 入口 | 当前边界 |
| --- | --- | --- | --- |
| QQ 接入 | NapCat OneBot 11、白名单私聊、补回漏消息、断线恢复、单实例锁 | `packages/bot/README.md`、ADR 0001/0002/0008 | 群聊未实现；同一账号只能有一套活实例 |
| 运行外壳 | Koishi 插件、控制台配置与角色资料编辑；独立入口仍保留 | `packages/koishi-plugin-qqbot/`、`docs/koishi.md` | Koishi 稳定运行满一周后的 standalone 删除尚未裁决 |
| 角色与隐私 | 7 个联系人档位、按档裁剪角色卡 / 世界书 / 作息 / 私密事实、低档禁用词检查 | ADR 0003、`characters/linmengyao/`、`packages/character-tools/` | 名单外好友正式开放前仍需限额、预算和真人 QQ 冒烟 |
| 提示词 | 对齐 SillyTavern 1.19.0 的主要拼装、世界书、示例、宏、后处理与上下文预算 | `packages/bot/src/prompt.ts`、`packages/bot/src/st/`、提示词测试 | 与 ST 的已知差异见 `packages/bot/README.md` |
| 回复时机 | 连发合并、生成 / 发送期间新消息处理、作息、睡眠、打字延迟、已读不回、主动消息 | ADR 0004/0007/0011/0013 | 低频分支仍需长期线上日志观察 |
| 记忆 | Hindsight 私人 / 公共记忆、关系印象、日记、周记、记忆变淡、待跟进和承诺 | ADR 0012、0016–0018、0023，`docs/hindsight.md` | 线上开着（用户 2026-10-10 23:15 裁决保持开）；Hindsight 和模拟共用一个 Postgres，见 §5.1 |
| 生活引擎 | 世界状态、人物、身体、金钱、行动事件账、可重放队列、连续需要、见面、真实天气、项目组合 | ADR 0021–0057，`packages/bot/src/world.ts` 及相关模块 | 若干能力以开关 / 影子模式存在；不得仅因代码存在就说已上线 |
| 对话自然度 | 意图行、情绪惯性、表达层、重复 / 算账 / 助手腔出口检查、真人形状基线、盲评工具 | ADR 0014/0019/0024/0028/0036/0041/0043/0058–0060 | ADR 0058/0059 的未见措辞真模型回归已通过；本批已获合入授权，仍需部署授权和线上观察 |
| 媒体 | QQ 小黄脸、语音转文字、图片 OCR、名单内 DeepSeek 看图与失败降级 | ADR 0051/0052/0055 | 真正发送照片、语音、电话、视频不支持；禁止假装已发送 |
| 可靠性 | 原子状态、幂等事件、失败重试、重启一致、死信、配置校验、全仓测试 | ADR 0037–0039、测试目录 | 测试涉及临时文件时 Windows 沙箱会误报 `EPERM`，需在允许原子 rename 的环境复核 |

### 3.1 2026-10-11 的最新一批

- ADR 0057：她那边的重要事件可在合适时机主动告诉男朋友。**10-11 相机日线上没成**：16:35 那条（买到相机）按时开始生成，但虚拟机 12:15–19:52 解析不了外网域名（`api.deepseek.com` 连不上），重试四次失败后判「不再试」，这件事就丢了。影子账 12:36–18:00 也空着，出门买相机和回来摆弄都没有条目。见 `exchange/handoff/2026-10-11-2030-claude-camera-day.md`。
- ADR 0058：男朋友的文字亲密邀约先明确回应；不能在下一气泡又把已经发生的文字互动推回“只能当面”。跨行修正 `2ba6df2` 12:39 已上线。
- ADR 0059：识别缩写、谐音、故意怪话并先接梗；未知梗允许短问，不联网搜索私聊内容。
- ADR 0060：男朋友要照片时，用她此刻的真实理由先不发，再把画面说给他听；不能回到笼统的“我发不了图片”。2026-10-11 11:00 上线。
- 真模型回归已跑过（`--no-memory`，各 2 次）：`boyfriend-intimacy` 26/26、`photo-ask` 38/38、`proactive-news` 12/12、`boyfriend-banter` 14/15。**但** `boyfriend-banter` / `boyfriend-intimacy` 发的就是卡里示例左边那句，量的是她抄没抄，不是会不会接（`exchange/handoff/2026-10-11-1055-claude.md` 第 2 条）。
- 23:18 后已补齐未见措辞回归：`boyfriend-intimacy` 26/26 ×2、`boyfriend-banter` 16/16 ×2；详见 §0.3 和 ADR 0058 / 0059。仍待确认：上述行为的真实 QQ 线上样本；第一张真照片走完看图全链路（还没有人发过，见 `exchange/handoff/2026-10-11-2030-claude-first-photo.md`）。

## 4. 未来计划与优先级

### P0：接手当天先封住事实缺口

1. 回答第 7 节问题，确认用户此刻唯一目标。
2. 到线上虚拟机（§0.1）核对当前运行提交、Koishi / NapCat / Hindsight 进程和端口、服务守护日志 `runtime/services-watchdog.log`。
3. 取得最近一次相关的脱敏日志与 `last-prompt.json`；若是偶发问题，先保存现场再复现。
4. 核对工作树和远端，禁止在未知未提交改动上部署。

### P1：收尾最新对话改动

1. 未见措辞真模型回归已在 `codex/generalization-regression` 完成并通过；本批已获合入 `main` 授权，不重复跑同一批次。
2. 合入和上线是两次独立授权；上线后取得真实 QQ 样本，只记录必要、脱敏的证据，检查跨气泡反悔、误触普通问句、旧式“发不了”或空正文延迟。
3. 若线上仍有问题，先加取证原句测试，再改最小边界；不得扩大到所有联系人档位。
4. 10-11 暴露的两个可靠性缺口已经交付到 `main`：一次性主动消息的模型不可达重试为 `9e030f8`，守护进程 DNS 检查与 Koishi 启停日志为 `076318e`。后续只观察日志，不重复实现。

### P2：生活引擎灰度

1. 线上开关（2026-10-11 20:40 读的 `runtime/koishi/koishi.yml`）：`memory.enabled: true`、`autonomousLife: true`（影子模式，只改行动账，不进提示词）、`vision.enabled: true`；`lifeInPrompt`、`projectChoice` 没写，即默认 `false`；`realWeather` 没写，即默认 `true`。改开关前再读一次原文件。影子账审计是 GPT 那条线，最近的结论看 `exchange/handoff/`。
2. 影子账满足无重叠、状态行无分叉、硬事件优先后，只能一次灰度一个变量。
3. 补课程项目、摄影 / 阅读项目的期限、资源、阻碍、延期、暂停和放弃；随后再做 NPC 主动联系、拒绝、迟到、改约和关系变化。

### P3：产品范围扩展

1. 群聊：群上下文、插话时机、@ 对象、群聊记忆隔离、披露规则和 `group` 档位。
2. 名单外好友：每号每日上限、全局预算、自称熟人的验证链、真人 QQ 冒烟。
3. 媒体能力若扩展到真正发送内容，必须单独 ADR、权限 / 隐私评估和端到端测试。

### P4：长期质量闭环

- 继续真人匿名盲评、气泡数 / 字数 / 问句率统计；多候选和上下文摘要不得同时灰度。
- 做技能成长、习惯形成 / 失败、日 / 周 / 月反思和可追溯自传变化。
- 清理旧测试数据只能用既有归档流程，先 `--dry-run`，且必须停 bot；禁止直接删除运行数据。

长期阶段 A–F、自然对话 N1–N6、成本和回滚策略的完整版本见 `docs/plans/2026-10-08-long-term-execution.md`；历史与当前勾选状态见 `docs/roadmap.md`。

## 5. 验证与上线门槛

### 5.1 每个提交

```powershell
npm run typecheck
npm test
git diff --check
git status --short --branch --ignore-submodules=all
```

全仓成功基线是 747 项：bot 679、character-tools 40、Koishi 插件 28。数量改变时要说明新增 / 删除原因，不能只写“通过”。

**在线上虚拟机上跑测试和模拟的限制**（6 GB 内存，线上服务一直开着）：

- 全量测试用 `node --test --test-concurrency=1`；跑之前先拿锁 `mkdir %TEMP%\qqbot-heavy.lock`，跑完 `rmdir`。锁目录已存在就等着。如果锁是会话中断留下的，先看它的创建时间和有没有 node 进程在跑，确认没人用再删。
- 模拟一次只跑一批。全量测试和模拟不同时跑。
- 带记忆的模拟（`memory: true`）和线上共用同一个 Hindsight Postgres。2026-10-07、10-09 两次把它挤爆过。要跑先问用户，跑的时候盯着可用内存，低于约 900 MB 就停。
- 跑完重活看一眼线上：3001 / 5140 端口还在听，Koishi 日志还在出新行。

如果测试在 Windows 沙箱临时目录大量报 `EPERM ... rename`：

1. 抽查失败是否都在原子落盘步骤；
2. 不改业务代码规避环境限制；
3. 在允许临时目录原子 rename 的环境重跑；
4. 同时记录沙箱结果和复核结果。

### 5.2 生成质量改动

- 固定输入、固定场景、保留原版与新版；至少记录通过条件、原文证据和重复次数。
- 真模型网络失败、正文为空、权限拒绝都不算“模型回归通过”。
- 真实聊天只摘必要句并脱敏；不把整段隐私聊天提交到 Git。
- 模拟器通过不能代替真实 QQ 冒烟；真实 QQ 冒烟也不能代替自动回归。

### 5.3 上线

上线必须由用户明确授权，并记录：

- 上线前 commit / 分支；
- 全仓验证结果；
- 当前是否有人正在聊天；
- 停止和启动了哪些服务、实际中断时长；
- 启动日志是否有错误 / 警告；
- 回滚命令和上一个已知正常 commit；
- 上线后需要观察的具体日志关键词和用户可见行为。

上线 / 重启步骤（线上虚拟机，PowerShell）：

1. `mkdir %TEMP%\qqbot-maintenance`：这个目录在的时候，服务守护不动手。不建的话，你停了 Koishi，它两分钟内会自己拉起来，和你抢。
2. 线上目录 `git status -sb`：确认是 `main`、没有改动、没有别人留下的分支。
3. 停 Koishi：supervisor（`node_modules\koishi\bin.js`）和它的 worker 都要停，再查一遍有没有残留的重复进程。
4. 线上目录 `git merge --ff-only origin/main`（或者用户批准的那个提交），确认 `origin/main` 也在同一个提交上。
5. `Start-Process powershell.exe -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','scripts\start-koishi.ps1' -WorkingDirectory <线上目录>`。用新窗口起，别放在会随当前会话一起退出的子进程里。
6. 看 `runtime/koishi/data/logs/<日期>-N.log`：要出现「NapCat 账号 … 已就绪」和 `connect to server: ws://127.0.0.1:3001/`；5140 在听。
7. `rmdir %TEMP%\qqbot-maintenance`；一分钟后守护日志里应该有「恢复正常」或者没有新报警。

QQ 掉线时要重启 NapCat：**关掉整个 `start-napcat.ps1` 窗口**（连 powershell 带它的 node 子进程一起），再用同样的 `Start-Process` 起 `scripts\start-napcat.ps1`，它会快速登录。只杀 node 没用，脚本会自己把 NapCat 再拉起来。启动顺序是 NapCat → Hindsight → Koishi。

### 5.4 失败门禁

- typecheck 或可复现单测失败：停止提交 / 合入；先保留失败命令和最小输出，再修根因。
- 真模型回归网络失败、空正文、权限拒绝：该次不计通过；模型确实作答但行为失败时，保存脱敏失败样本并回到自动测试 / 最小修复。
- 仅 Windows 沙箱原子 `rename` 报 `EPERM`：按 §5.1 在允许原子落盘的环境单并发复核；未复核前不得报通过。
- 上线检查异常：保持或恢复维护锁，停止继续变更；能安全回滚时回到上线前已知正常提交，再核对端口与启动日志。
- 疑似隐私泄露：立即停止外发、提交和日志扩散；不在 Issue / 提交中复制敏感内容，先向用户报告涉及的数据类别与范围，再按用户指示处置。

## 6. 隐私、仓库与禁止事项

- 仓库必须保持私有。角色资料含真实隐私信息。
- API key、密码、OneBot token 只走环境变量或被忽略的本地配置；不得写进提示、日志摘录、提交或 Issue。
- 发给 DeepSeek API 或别的外部服务的材料：QQ 号、昵称、真实称呼用稳定占位符；对方消息默认只写摘要。林梦瑶的原回复仅在定位问题所需的最小范围内保留。（私有仓库 `exchange` 分支里的证据按 `exchange/README.md` 的数据约定：账号持有人已授权保留 QQ 号和对话原文。凭据不论放哪都必须删。）
- 不整段读取或复述聊天日志；只搜索需要的行。不得把未经用户明确允许的角色卡、聊天或运行数据发给外部模型 / 搜索服务。
- `runtime/`、`*.log`、`logs/` 默认不入库。需要交换的证据必须先脱敏，再放到用户批准的位置。
- 临时取得的真实聊天、日志、配置或运行状态只保留完成当前定位所需的最短时间；不得转存到新的报告、提示或外部服务。结论固化并验证后，清理本批临时副本；必须保留的证据只留经用户批准的脱敏最小片段。
- `vendor/SillyTavern`、`vendor/NapCatQQ` 默认只读；绝不提交 NapCat 源码修改。Koishi 和上游插件原样使用，上游问题在自有插件中绕开。
- `characters/*/legacy/` 只读；改 `source/` 后用转换器生成 `st/`，不手改生成物。
- 不因为编译器 / 测试报错就删功能、放宽隐私检查或改变架构。
- 不重写 Git 历史、不强推、不清运行数据、不部署 / 重启，除非用户对该动作明确授权。
- 不把“代码已实现”“默认开”“影子运行”“已灰度”“已上线”混为一谈。

## 7. DS 必须先向用户询问的文件与内容

DS 接手后的第一条用户可见消息应精炼地询问下面内容；用户不给全也能先做静态工作，但必须标记限制。

用户的节奏（2026-10-06）：「不用整理，直接开始暴力推进」。只问只有用户知道的事；仓库、日志、本文件能查到的，自己查。线上在哪不用问（§0.1），当前提交和服务状态自己到线上机器上看。

### 7.1 必问问题

1. **当前唯一目标是什么？** 是诊断、实现、审查、上线还是只写计划？期望的验收结果是什么？
2. **边界一句话问完：** 哪些材料可以发给 DeepSeek API、哪些只能本地读；这批能不能停 / 重启线上服务；交付是只推分支，还是也可以合入 `main`。

### 7.2 用户裁决从哪里找

- `docs/research/2026-10-06-dsh/author-replies.md`：作者裁决，优先于任何「推荐方案」。
- 各 ADR 的「确认记录」：每条决定是谁、在什么授权下拍板的。
- 不在仓库里、但一直有效的几条：
  - 回复用户用中文。
  - 上线（重启线上 Koishi）要用户在当前会话里点头；一次点头只管那一次。
  - 长期记忆在线上保持开着（2026-10-10 23:15）。
  - 她发真照片（照片池或生成图）：用户 2026-10-11 说「暂时较难实现，先推迟」。用户自己提起之前，不要再提。这和他发照片给她看（看图）不是一件事。

### 7.3 按需请求的文件（从高到低）

| 优先级 | 请求内容 | 用途 | 提交 GitHub 前处理 |
| --- | --- | --- | --- |
| 1 | 当前任务的一句话、最新 commit、实际开关与服务状态 | 避免按过期前提工作 | 可写进交接摘要，不写密钥 / 标识符 |
| 2 | 触发问题那次的 `runtime/bot/last-prompt.json` 副本 | 定位提示词、世界书、意图行和出口检查 | 必须脱敏；默认不提交 |
| 3 | 最近 1–3 天相关日志的最小片段 | 查看到时机、召回、重写、发送、重启 | 只保留必要行；脱敏；默认不提交 |
| 4 | 当前 Koishi / bot 配置的脱敏副本 | 确认模型、上下文、开关、联系人档位 | 删除 key、token、QQ 号、昵称、绝对私人路径 |
| 5 | 与问题相关的聊天最小复现 | 重建真实上下文 | 对方原话优先写摘要；未经许可不外发、不提交 |
| 6 | `world/`、`promises/`、`memory/` 的相关状态片段 | 查生活账、承诺、记忆一致性 | 只取相关对象；哈希和标识符仍按隐私数据处理 |
| 7 | 最新场景报告 / 盲评包 | 对比新旧生成质量 | 确认去标识化和授权后才提交 |

建议 DS 直接复制给用户的短问法：

```text
我已读交接文件，线上状态我自己到虚拟机上核对。请告诉我本批唯一目标和验收结果；再一句话告诉我：哪些材料可以发给 DeepSeek API、这批能不能重启线上、是只推分支还是也可以合入 main。
```

2026-10-11 已在用户明确授权后，用不含角色卡、真实聊天、标识符、日志、运行配置或凭据的摘要实际询问 DeepSeek。DS 确认本节的“仓库入口 + 按需最小活状态 + 禁止索取凭据 / 全量私人数据”结构；其建议与仓库事实的逐项核验见 `docs/reports/2026-10-11-deepseek-handoff-review.md`。

## 8. GitHub 提交协议

### 8.1 开工前

**不要在线上目录 `Desktop\Project\qqbot` 里做下面这些事**（§0.2）。每批用自己的 worktree：

```powershell
# 在线上目录里只做两件事：看状态、建 worktree
git -C C:\Users\XG\Desktop\Project\qqbot status -sb
git -C C:\Users\XG\Desktop\Project\qqbot fetch origin
git -C C:\Users\XG\Desktop\Project\qqbot worktree add ..\qqbot-ds-<task-slug> -b deepseek/<task-slug> origin/main

# 进 worktree 干活；node_modules 用 junction 指回线上目录，不另装
cd C:\Users\XG\Desktop\Project\qqbot-ds-<task-slug>
cmd /c mklink /J node_modules C:\Users\XG\Desktop\Project\qqbot\node_modules
# 需要跑 bot 的测试或模拟时，复制一份 runtime\bot\config.json 进来（只复制配置，不碰线上数据）
```

收尾时，先 `cmd /c rmdir node_modules` 删掉 junction，再 `git worktree remove`。不删 junction 就删 worktree，会连线上的 `node_modules` 一起删掉。

若工作树已有改动，先识别归属；不得覆盖、暂存或提交与本任务无关的文件。若用户要求直接在现有分支继续，就记录起点而不要另切分支。

### 8.1.1 和 Claude、GPT、DSH 怎么配合

- 交接写在 `exchange` 分支的 `exchange/handoff/<日期>-<时分>-ds.md`（worktree `Desktop\Project\qqbot-exchange`），格式见 `docs/exchange-protocol.md`。`exchange` 永远不合进 `main`。
- worktree 各有主人：`qqbot-integration` 和 `~\.codex\worktrees\` 归 GPT / Codex，`qqbot-claude2`、`qqbot-claude3`、`qqbot-codex-wip` 归 Claude。别人的 worktree 不切分支、不提交。动 git 之前先在那个目录跑 `git status -sb`，看清检出的是哪个分支。
- 移动 `integration` 用 `git branch -f integration <sha>` 再 push，不要在别人的 worktree 里检出它。
- DSH 是用户联想主机上的会话，连不到虚拟机，只能做调研、静态审查和规划；它在主机上看到的不是线上（§0.1）。

### 8.2 提交前

```powershell
npm run typecheck
npm test
git diff --check
git status --short --branch --ignore-submodules=all
git diff --name-status
git diff --cached --name-status
```

在线上虚拟机上，`npm test` 按 §5.1 的规矩跑（拿锁、`--test-concurrency=1`、不和模拟同时跑）。

人工检查：

- 只暂存本批文件；
- 没有 `runtime/`、日志、密钥、token、真实 QQ 号或未脱敏聊天；
- 没有子模块指针变化，除非任务明确要求且许可证允许；
- 行为变化有测试，架构 / 用户裁决有 ADR，当前状态和下一动作有文档；
- 生成物与 source 一致。

### 8.3 提交与推送

```powershell
git add <明确的文件列表>
git commit -m "<type>(<scope>): <可验证结果>"
git push -u origin deepseek/<task-slug>
```

- 默认推分支并把 commit / 分支 / 测试结果交给用户；开 PR、合并、部署分别需要对应授权。
- 若用户明确要求直接提交当前 `main` 并推送，仍须先完成全部检查，再普通 `git push origin main`；禁止 `--force`。
- 推送后用 `git rev-parse HEAD` 与远端引用复核，不能只相信命令无报错。
- 推到 `origin/main` 不等于上线。线上目录的 `main` 只在用户点头后按 §5.3 快进；在那之前，线上目录落后 `origin/main` 是正常的。

## 9. 每批完整交付模板

```markdown
# 批次交付：<名称>

- 起点：<branch / commit>
- 用户目标：
- 范围外：
- 事实与证据：
- 用户裁决：
- 实现：<文件 + 行为，不贴大段代码>
- 测试：<命令、通过数、失败数、环境限制>
- 真模型 / QQ 验证：<已做 / 未做及原因>
- 隐私检查：
- 风险：
- 回滚：<commit 或开关>
- GitHub：<commit / branch / PR / push 状态>
- 仍未知：
- 下一批唯一推荐动作：
- 待 Claude / GPT 补审：<无 / 具体项>
```

“完成”仅指用户验收条件和必要验证都满足；预算用完、代码写完但未验证、或已推分支都不等于完成。

## 10. 交接确认模板

DS 在开始实作前回复：

```markdown
## DS 接手确认

- 已读：`DEEPSEEK_HANDOFF.md`、`CLAUDE.md`、`思维链工作流.txt`、相关 ADR / 报告
- 当前 HEAD / 分支：
- 工作树：干净 / 有以下既有改动
- 本批唯一目标：
- 已知事实：
- 待用户补充：
- 隐私与外发边界：
- 最小验证计划：
- GitHub 交付方式：
- 本批不做：
```

批次结束时必须用第 9 节模板交付，并更新本文件第 0、3、4、11 节中已经过期的部分。

## 11. 交接文件变更记录

| 日期 | 维护者 | 变更 | 复核 |
| --- | --- | --- | --- |
| 2026-10-11 | GPT / Codex，基于 Claude 已维护的项目事实源 | 建立 DS 连续接手入口；记录当前 Git / 测试基线、工作流、已交付能力、计划、提问清单和 GitHub 协议 | 本次 Claude CLI 实时审阅未返回结果，待 Claude 恢复后补审 |
| 2026-10-11 20:40 | Claude（线上虚拟机上复审，用户要求改进本文件） | 新增 §0.1 线上在哪、§0.2 线上目录就是线上、§5.1 内存与锁、§5.3 上线 / 重启步骤（服务守护、NapCat）、§7.2 用户裁决入口、§8.1 worktree 流程和 §8.1.1 协作；更正 `2ba6df2` 已上线、相机日没成、0058 / 0059 真模型已跑和还缺什么、线上开关实际值；必问从 5 个减到 2 个 | 已复审，审查意见在 `exchange/reviews/2026-10-11-claude-review-deepseek-handoff.md`；全仓测试未重跑（只改文档） |
| 2026-10-11 23:20 | GPT / Codex | 新增 §0.3 后续快照；记录 `705a409` 线上基线、`codex/generalization-regression` / `21dfa36`、未见措辞真模型回归、空正文可靠性修复、743 项全仓测试及下一步授权边界；同步 §3 / §4 过期项 | `npm run typecheck` 通过；全仓 743/743；真模型亲密 26/26 ×2、接梗 16/16 ×2；未合入、未部署 |
| 2026-10-11 合入准备 | GPT / Codex | 重新获取并合入 `origin/main` 的 `921183c` 基线；将验证数字刷新为 747，并记录用户仅授权合入和推送、不授权部署或重启 | `npm run typecheck` 通过；全仓 747/747；合并无文本冲突；远端已非强推更新到 `32a2577`，在线工作区不动 |
| 2026-10-11 DS 实际审阅 | DeepSeek API + GPT / Codex 核验 | 在用户逐项授权的脱敏边界内询问 DS 所需文件与内容；新增审阅报告、747 项基线、失败门禁和临时材料清理规则；纠正 DS 对 `character-tools` 职责的误判 | DeepSeek 返回完整接手清单；逐项对照 §0.1 / §5 / §6 / ADR 0058–0059；只改文档，未部署、未重启 |
