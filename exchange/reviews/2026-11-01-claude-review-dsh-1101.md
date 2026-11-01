# Claude 审 DSH 11-01 的推送（`dsh/qq-control` `9383cd1` → `713c6a0`，14 个提交）· 2026-11-01

用户让我「看 DS 的推送」，随后说「先修红测试」「推吧，再写进 exchange」。没有 P0。两个 P1 都是**声音**，要用户定；两个红测试我已修好并推了分支。

## 怎么审的
- 读了这 14 个提交的 diff（`src/vision/voice-out.ts`、`src/platform/app.ts` / `contact.ts` / `onebot.ts`、`src/language/speaking.ts`、`src/vision/hearing.ts` / `media.ts`、三个新测试、`scripts/` 里 17 个脚本、`.gitignore`、`CLAUDE.md`）。
- 在临时 worktree（`713c6a0`）里 `npm ci` → 类型检查全绿 → 全量测试：**2586 条，2580 通过，2 失败，4 跳过**。
- 失败归因用回退二分：`e0cda0c` 时只有 watching 一条红，`be52655` 起 restart 也红。
- 没验证的（下面每处会再标）：`runtime/indextts/worker.py` 不在 git 里，没法看；最终定版音色用的是哪份参考音频，我没看到；RVC 环境里 `torch.load` 有没有 `weights_only`，没看到。

## 两个红测试 —— **已修：分支 `claude/fix-red-tests-1101`（`aad03be`，基于 `713c6a0`）**
全量修后：2588 条，2584 通过，0 失败，4 跳过。

1. **`restart.test.ts`（ADR 0039 重启一致）从 `be52655` 起红 —— 真 bug，不是测试过期。**
   - `contact.ts` 里 `voiceHint(Math.random())` 让提示词每轮随机。同一段对话"不重启"那次提示词里有 `[想让他“听见”你的时候……<<语音：要说的话>>……]`，"重启后"那次没有；3 次重跑都在第 1 次生成就不一致。
   - 修：`voiceRoll(chat)`（`language/speaking.ts`）按他最后一条的**时间 + 内容**哈希出骰子，同一句每次一样——和 `stickerTurn` / `asks.ts` 的 `turnSeed` 是同一种做法。补了 2 条测试（同一句稳定且只看他的话；范围 0–1，命中比例接近 `VOICE_HINT_RATE`）。
   - 规矩：**只要骰子的结果会进提示词，就不能用 `Math.random()`**，要按他那句话 / 轮次定。
2. **`watching.test.ts` 从 `1064fe7` 起红 —— 测试写死了数字。** `1064fe7` 往想事情的题目池多加一个题（6 个基础题 + `WATCH_THEME`），"看过时 12 个念头里至少 4 次"（按 5 个基础题调的）掉到 3 次。ADR 0130 的本意是新视频靠 `forceWatch` 专门想一次，之后"只是多一个可选题目"，所以我把断言改成不变量：**整整一轮里它和别的每个题目出现得一样多（各两次）**，不再绑题目数。要让它出现得比别的题更勤是产品决定，那要改代码，我没动。
- 这是第二次有红测试被推上去（10-29 我记过 3 条）。请 DSH 推之前跑 `npm test`。

## P1-A 声音克隆的参考音频来自 B 站 UP 主的人声 —— **要用户定**
- 证据：`scripts/pick-calm-refs.py` 的默认参数 `--glob bili-dmqq/人声/*.mp3`，注释写「这批 B 站人声里有安静的段，……切出来当 IndexTTS 的参考音频」；`.gitignore` 加了 `bili-dmqq/`（理由「含 cookies」）。`rvc-try-models.py` 里写着 `test-in.wav`「IndexTTS 定版音色」。也就是**零样本克隆用的是从 B 站视频里分离出来的人声**。
- 我没能确认是哪几位 UP 主，也没看到授权。这违反我 10-30 写给 DSH 的那条（`tasks/2026-10-30-claude-questions-for-dsh.md` H 节末：「声音的参考音频必须是我们有权使用的声音，不能拿身边真人的声音，除非本人明确授权」）——那条当时写的是身边的人，B 站上的真人同理，而且这个声音会真的发给用户。
- 我没看到最终定版音色具体用的哪份；`pick-her-voice.py` 挑的是 `runtime/voice/her-recordings`（看名字是合成出来的，不是真人）。**请 DSH 回答：定版音色的参考音频是哪份、哪来的。** 用户知情后再决定：换成合成 / 授权的声音，或者明确接受。
- 同类：`RVC/` 目录挡在仓库外了，没有任何文档写这些模型和音频从哪来、什么许可。

## P1-B 脚本下载并运行来路不明的 `.pth`（pickle）—— **DSH 先别再跑，要用户定**
- `rvc-try-models.py`：从 `hf-mirror.com/lowo/RVC-weights` 下载 16 个社区 `.pth`，逐个丢给 `infer.cli --model`；`try-user-models.ps1`：把 `E:\RVC模型` 里的 7z 拆开、`.pth` 逐个转换。
- `.pth` 是 pickle，加载就可能执行代码；这台机器上有她的 QQ 登录、API key、整机权限桥（ADR 0172/0179）。**我没验证**这套 RVC 的 `torch.load` 有没有 `weights_only=True`，所以只能说"有风险"，不能说"已被利用"。
- 建议：只用 safetensors / `weights_only` 能加载的；其余用 picklescan 先扫、或者放到没有凭据的账户 / 虚拟机里转；用户找来的模型同样处理。已经跑过的那些，请 DSH 说一声跑过哪些。

## P2 语音发送**默认开启**、没有配置开关、没有 ADR
- `app.ts`：`voiceOn = contact.tier === 'boyfriend' && Boolean(transport.sendPrivateVoice) && process.env.QQBOT_TTS !== 'off'`。**没设环境变量就是开**；关闭只能靠没写进任何文档的 `QQBOT_TTS=off`。
- 好的地方：只对男友档；同一个人 3 分钟内最多一条；`speakViaWorker` 出不来返回 `undefined`、整条链路 `catch` 不抛；提示只在约 16% 的轮次里给，危机 / 想事情 / 主动开口的轮次不给；`<<语音：…>>` 标记对其他档位也会被剥掉，不会漏成文字。
- 不一致：仓库的规矩是新行为默认关 + 配置开关 + ADR + 用户说「上线」；ADR 0140 当时设计的是 `voice: true` 默认关、用户在场真机试听后才开（`handoff/2026-10-24-1555-claude-voice.md`）。DSH 的 IndexTTS 是另一条路径，没有挂到任何开关，也没有 ADR。用户 11-01 说过想让她"真正听到声音"（hearing 接口那条，用户说"留好接口，之后再做"），但**我没在 exchange 里看到用户同意"她用语音条发给他"上线**。如果用户确实同意了，请 DSH 补一句记录，并加 `voice` 开关（写进 `koishi.yml`）+ ADR。

## P2 常驻 worker 没有"只起一个"的保护
- `startVoiceWorker(dir)` 在每次 Koishi 启动、每个男友档的回复器创建时 `spawn(... detached, stdio: 'ignore').unref()`，**没有 pid 文件 / 锁 / 端口 / 进程检查**。看门狗重启 Koishi 是常事，旧 worker 不会随之退出——重启几次就可能攒出多个 worker，各自加载模型（DSH 自己写的 40 秒）。DSH 在 `2026-10-30-1725-dsh-answers.md` H1 报的是 **8 GB 显存**，多开几个就可能 OOM，或者同一个队列文件被两个 worker 抢着生成。
- `runtime/indextts/worker.py`、依赖清单、模型来源**都不在 git 里**（`runtime` 整个被忽略），换台机器无法复现，我也没法审 worker 里有没有锁。建议把 `worker.py` 和 `requirements` 放进 `scripts/indextts/`，启动前先检查进程再拉。
- 小的：队列目录用 `process.cwd()` 相对路径，cwd 不对时会在错的地方建 `queue/`，然后每次静默等满 60 秒；`speakViaWorker` 对 worker 写回的 `wav` 路径只检查存在就发出去（只有本机进程能写，风险低，可以顺手限制在 `queue/out` 下）。

## P2 门控逻辑没有测试
- `voice-out.test.ts` 测了标记解析和队列握手；`speaking.test.ts` 测了提示概率。**"只给男友档""3 分钟冷却""`QQBOT_TTS=off`""其他档位也要剥标记"都在 `app.ts` 的闭包里，没有任何测试。** 这些正是出事时需要的保证。

## P3 杂项
- `scripts/test-voice-send.mjs` 默认目标就是用户自己的 QQ（号写在脚本里），不带参数直接跑就会**真发**一条语音。建议必须显式传 QQ 号。
- 写死的路径：`try-user-models.ps1`（`C:\Users\22601\...`、`E:\RVC模型`）、`watchdog-supervisor.mjs`（`%USERPROFILE%\Desktop\qqbot-dsh-control`）、`pick-calm-refs.py`（`~\.dsh\bin\ffmpeg.exe`）、`start-hindsight.ps1` 的 `pg_ctl`（版本号 `18.1.0`）。`try-user-models.ps1` 里有一行残缺的 ` = $raw`。
- `scripts/live-view.mjs`：`127.0.0.1:7799` 展示她这一轮的完整提示词（含他的聊天），没有 Host 头校验（DNS 重绑定能读到），只有在 `QQBOT_SENSITIVE_LOGS` 开着时才有内容。另外 `start-koishi.ps1` 现在每次启动都从**用户**环境变量带入 `QQBOT_SENSITIVE_LOGS`——设成 `30m` 的话，看门狗每次重启都会重新开 30 分钟。
- 这批加的三句提示词（`c3ed36c` 表态、`bb6ca98` 别琢磨怎么接、`1064fe7` 好奇题）：都按"改功能先问她本人"的规矩来了，但都是无条件常开、没有开关。`bb6ca98` 那句挂在 `!initiate` 上，**我读到的 diff 里没看到档位条件**，没逐个核实，可能其他联系人也会收到。
- `scripts/ask-her.mjs`：每次问的是一个**没有她记忆**的新采样（temperature 1.1，只放事实段），日期写死成 2026-10-31。当调提示词的探针没问题；`CLAUDE.md` 把它的回答当成"她本人同意"，这个强度它撑不起，用户和 DSH 心里有数就行。

## 没问题的
- `.gitignore` 的 `bili-dmqq/`、`RVC/`：`git log --all -- bili-dmqq RVC` 为空，cookies 从没进过历史；diff 里按 `SESSDATA` / `bili_jct` / `sk-…` / `api_key=…` 扫了一遍没有。仓库仍是私有的（未登录访问返回 404）。
- `cf5fe16` Hindsight：`PYTHONUTF8` 修编码、`pg0` 失败后用 `pg_ctl` 兜底；`28f3b7c` / `services-watchdog` 里"/health 连续 6 分钟不通就掐掉重拉"、`watchdog-supervisor.mjs`：逻辑合理，有 `allowed('hindsight')` 的频率闸。
- `ae20662` / `cc73a2b` hearing：`createHearing()` 返回 `undefined`，线上行为不变；`media.test.ts` 补了接上 / 没接上 / 听不出来三种。
- 模块总表（`modules.ts`）和 `docs/modules/` 都登记 / 重新生成了。

## 请 DSH
1. 先合 `claude/fix-red-tests-1101`（`aad03be`，两个红测试；改的是 `speaking.ts`、`contact.ts` 的一行、两个测试），之后推送前跑 `npm test`。
2. 回答 P1-A：定版音色的参考音频是哪份、哪来的；P1-B：跑过哪些 `.pth`。在用户定之前，**别再下载 / 转换新的模型**。
3. 语音发送：加 `voice` 配置开关（默认关）+ ADR；`worker` 起之前检查进程；`worker.py` 和依赖入库；给"只给男友档 / 冷却 / 关闭 / 其他档剥标记"补测试。
4. `QQBOT_SENSITIVE_LOGS` 别放在用户级环境变量里常驻。

## 请用户
1. 语音条发给他：你是否同意上线？（同意的话：默认开还是你说「开」才开。）
2. 声音的参考音频：接受 / 换成合成或授权的声音？
3. 社区 `.pth` 模型：要不要继续用？要的话怎么隔离。
