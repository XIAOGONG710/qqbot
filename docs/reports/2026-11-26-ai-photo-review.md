# AI 照片流水线审查（2026-11-26）

范围：`vision/ai-photo-drafts.ts`（草稿库 + 生图客户端）、`vision/ai-photo-provider.ts`（供应商池与每日预算）、
`vision/ai-photo-quality*.ts`（本地结构门 + 视觉审查）、`vision/ai-photo-references.ts`（视觉参考）、`vision/ai-photo-storage.ts`（只读审计）、
`proactive/ai-photo-requests.ts`（世界事件 / QQ「现在的照片」请求编排）、`modules/media-offers.ts` 的「现在的照片」分支、
`vision/photos.ts`（照片货架，审核后进入的地方）、`vision/photo-index-lock.ts`、`ops/ai-photo-cli.ts`、`ops/ai-photo-live-check.ts`，
以及 `app.ts` 的装配（约 703–745、1792 行）。对照 ADR 0239 / 0240 / 0242 / 0244 / 0246 / 0247。
控制台的 AI 照片页、手机伴侣的审核入口今天已另审（`2026-11-26-koishi-console-review.md` F、`2026-11-26-mobile-companion-review.md`），这里不重复。

全部只用合成数据和假 fetch，没有连任何真实生图 / 看图服务，没有往 QQ 发任何东西。

## 结论

整体设计是稳的：生图只进 `pending_review`，没有任何自动审核或自动发送的路；「现在的照片」只认已审核、编号精确匹配、没过期的那一张；
发给生图和看图服务的只有世界账里的可见事实；错误正文、密钥、URL 不进日志和状态。
找到的问题集中在**预算跨进程计数**、**后台请求的崩溃路径**和**供应商返回体没有上限**，已修 5 条（P1–P5）；另有 6 条留给用户定或只作记录（U1–U6）。

## 已修（每条都有修之前失败、修之后通过的测试）

### P1. 每日生图预算在 app 和命令行之间互相覆盖，合起来能超过上限（中，费用）

- 位置：`vision/ai-photo-provider.ts:105`（修前）——`usage.json` 只在建池子时读一次，之后一直用内存里那份写回。
- 场景：线上 app 开着 `aiPhotos`（`app.ts:708` 一个池子），作者又在终端跑 `ai-photo -- generate` / `smoke --confirm-live`（`ai-photo-cli.ts:90` 另一个池子），两边共用 `<dataDir>/ai-photo-usage/usage.json`。
  命令行记下的尝试会被 app 下一次计数用旧内存整份覆盖掉（反过来也一样），app 也看不到命令行用掉的次数，于是两边各自按 4 次算，一天实际能付费调用到 8 次以上；Koishi 重启交界处两个实例并存时同理。
- 修：`generate()` 开始、每个供应商尝试前、每次计数（`bump`）前都从盘上重读（读不了失败关闭）；只展示的 `status()` 读不了时用上一份。和控制台审查 F 对草稿库 / 参考库的做法一致。
- 测试：`ai-photo-provider.test.ts`「运行中的 app 和命令行各开一个池子时，合起来也不超过每日上限」。

### P2. QQ「现在的照片」后台请求在冷却状态写不进时变成未处理的 rejection（中，崩溃 / 日志）

- 位置：`proactive/ai-photo-requests.ts:124`（`persist`）、`:180`（`void service.request(context)`）。
- 场景：生成失败进入 `catch` 后要写 `auto-state.json`；磁盘满、目录被占、权限变了时 `persist()` 在 `catch` 里再抛，`request()` 的 Promise 被拒，而 QQ 那条路是 `void` 扔出去的，没人接。
  独立运行时 Node 会因未处理的 rejection 退出；Koishi 下 `koishi/lib/worker` 的 `unhandledRejection` 处理会把错误原文（带数据目录绝对路径）打进日志。
- 修：`persist()` 自己兜住，写不进只记一行固定中文，内存里的冷却照样生效；`requestCurrentAiPhoto` 的 `void` 调用补 `.catch`。
- 测试：`ai-photo-requests.test.ts`「冷却状态写不进时 request 也不抛出去……」——修前 `request()` 直接 reject。

### P3. 同时到的几条生成请求能一起越过每日生成数（低，费用）

- 位置：`proactive/ai-photo-requests.ts:140–142`。
- 场景：每日 3 张的检查只数已经落盘的草稿；世界事件扫描和 QQ 请求（不同 eventKey）同时在生成时，都在「今天还没满」那一刻放行，合起来超过 3 张（最后仍被供应商池的 4 次尝试兜住）。
- 修：还在生成的（`inFlight`）也算进今天的数。顺序到达的请求行为不变。
- 测试：`ai-photo-requests.test.ts`「同时到的几条请求合起来也不超过每日生成数」——修前两条都是 `generated`。

### P4. 生图服务返回体没有大小上限，坏的 / 被劫持的服务能把进程内存撑爆（中，崩溃）

- 位置：`vision/ai-photo-drafts.ts:194`（修前 `await response.json()`）。
- 场景：图片解码后才查 12 MB 上限，之前整段 JSON（可以是几百 MB）先进内存；本地服务（`QQBOT_IMAGE_LOCAL_BASE_URL`）或备用服务出故障时就是整个 bot 进程。非 2xx 时响应体也没取消。
  对照：看图那边 `vision.ts` 早就有 `MAX_VISION_RESPONSE_BYTES`。
- 修：按 `content-length` 先挡，再流式读、超过 `AI_PHOTO_RESPONSE_MAX_BYTES`（12 MB 的 base64 再加 64 KB 外壳）就取消；非 2xx 立刻取消响应体。正常大小的图片行为不变。
- 测试：`ai-photo-drafts.test.ts`「生图服务返回超大正文时读到上限就停……」——修前读完 40 MB 才报别的错，`content-length` 声明 64 MB 的也照收。

### P5. 生图期间图片目录被换成符号链接 / 目录联接，新图会写到目录外（低，路径）

- 位置：`vision/ai-photo-drafts.ts:292` 只在调用供应商之前查了一次 `files/`，`:309` 写文件时不再查。
- 场景：生图要等几十秒到几分钟；ADR 0239 要求「图片目录也不能是符号链接」，但这段时间里 `files/` 被换成联接时，`writeFileSync` 会跟着写到别处。需要本机写权限，所以是低。
- 修：写之前再调一次 `ensureFilesDir()`。
- 测试：`ai-photo-drafts.test.ts`「生图期间图片目录被换成目录联接时不往外写」——修前图片落进了外面的目录。

### 顺手修的配置 bug：本地 IPv6 回环地址被静默丢弃（低，正确性）

- 位置：`vision/ai-photo-provider.ts:66`。`new URL('http://[::1]:8188').hostname` 是 `[::1]`，白名单写的是 `::1`，ADR 0244 说能用的 `::1` 实际从来没生效（配置了也当没配置）。
- 测试：`ai-photo-provider.test.ts`「本地 IPv6 回环地址按 ADR 0244 可用」。

## 查过、没问题的

- **隐私（a）**：生图提示词（`buildAiPhotoPrompt`）和看图审查提示词（`aiPhotoReviewPrompt`）只放种类、主体、菜名、天气（`text，temp℃`，不含城市）、
  「普通校园 / 住宅 / 食堂」这类泛化地点、活动和时间；QQ 那条路的上下文由 `currentAiPhotoContext` 从世界账重建，不带他的话、QQ 号、名字、记忆或她心里的内容。
  状态文件只存提示词哈希。发给看图服务的参考图只来自作者在控制台登记、勾选「不含人物」的四类非人物资料，每类最多 4 张、总计 8 MB。
  会出去的角色资料只有猫名、菜名这类世界事实（见 U5）。
- **审批（c）**：生成只写 `pending_review`；进照片货架只有 `approve()`（命令行、控制台带 `confirmation`、手机伴侣三处），已拒绝 / 已过期的不能通过。
  「现在的照片」只在 `status === 'approved'`、`shelfId` 精确、没过期、货架里确实有这张时才把这一个编号给回复模型（`media-offers.ts:95–112`），没有就 `photoUnavailable`，不拿旧图冒充。
  触发只看他的原话（`photoWanted` + `isExplicitCurrentPhotoRequest`）和世界事件，模型写的任何标记都不会触发生成；主动轮次（`initiate`）不走这条。
- **费用（b）**：重启后冷却（`auto-state.json`）和预算（`usage.json`）都从盘上恢复；质量不过最多重生成 1 次，审查服务本身失败不重生成；每次上游调用都计入预算，剩余不足时池子直接失败关闭；过期事件在调用供应商前跳过。
- **文件（d）**：草稿 / 参考的编号是内容哈希、文件名正则绑定编号，审核和预览前重新核对普通文件、哈希、真实格式；索引 / 目录是符号链接时失败关闭；审计只读。
- **密钥与错误（e）**：生图密钥只来自环境变量，只发往 HTTPS 或本机地址；失败只记「本地 / 主服务 / 备用服务暂时不可用」；看图那边错误也不读正文。
- **超时（f）**：生图默认 90 秒（1–300 秒可调），`AbortController` 覆盖到读完响应体；看图走 `vision.timeoutMs` 和统一闸门。

## 留给用户定 / 只作记录

| 编号 | 位置 | 场景 | 严重度 | 推荐 |
|---|---|---|---|---|
| U1 | `app.ts:1792` | 「现在的照片」按 `contact.tier === 'boyfriend'` 给，不是按 deviceOwner。名单里第二个男朋友档的人（小号、测试号）也能触发付费生图，并能拿到发给他的那张已审核照片。和设备控制审查 C、长期记忆审查的「多个男朋友档」是同一个问题。 | 低（每天总量有上限） | 和那两条一起定：要么只给 deviceOwner，要么确认名单里永远只有一个男朋友档。改了会改变她对第二个人发不发照片，所以没动。 |
| U2 | `vision/ai-photo-drafts.ts:342`、`photos.ts:379` | 审核通过时先核对草稿文件的哈希，再按路径让照片货架**重新读一遍**（`statSync` 还跟符号链接）。两次读之间文件被换，货架收进的是另一张图，草稿还会记成已通过、`shelfId` 指向那张。ADR 0239 写的是「即使审核期间文件被替换，也不能把另一张图带进照片货架」。需要本机写权限。 | 低 | 让货架提供按字节添加的入口（`addBytes`），草稿把核对过的那份字节直接交过去；要改 `PhotoShelf` 接口和三处审核入口的测试替身，所以单独做。 |

> U2 后续（11-26 晚，claude）：已修——`PhotoShelf.add` 也收 `{ bytes, extension, label }`，草稿审核和预览都用核对哈希的那一份字节，不再按路径重读；新测试在货架被调用的那一刻换掉草稿文件，旧代码收进换上去的图、现在收的是核对过的那张。

| U3 | `media-offers.ts:106`、`photos.ts:432` | 「现在的照片」那一轮的清理只限定种类（和菜名），没限定编号。模型要是写了同一类另一张已知照片的编号，会被当成「刚拍的」发出去。模型这一轮只看得到那一个编号，实际很难发生。 | 低 | 清理范围加一个精确编号；这会改变她那一轮能发哪张，要先问她本人。 |
| U4 | `ai-photo-requests.ts:130` 和 `ai-photo-drafts.ts:286` | 编排层按原样的 eventKey 找草稿，草稿库存的是清洗过的（压空白、去控制符、截 160 字）。菜名里带连续空格、或者 key 超过 160 字时，已审核的图永远对不上，「现在的照片」一直显示没有（不会多花钱：草稿库会直接返回已有那张）。现在的世界账菜名不会这样。 | 低 | 两边共用一个清洗函数。等真有带空格的菜名再做也行。 |
| U5 | `ai-photo-requests.ts:57`、`ai-photo-drafts.ts:143` | 发给外部生图 / 看图服务的是角色卡上的猫名、她吃的菜、天气、在不在学校这几样，不含他的信息。这些也是角色资料的一部分，开 `aiPhotos` 前用户应知道会出去。 | 记录 | 维持现状；或者把猫名换成「三花猫」再发（这会改变生图提示词，不影响她说的话）。 |
| U6 | `vision/ai-photo-drafts.ts`、ADR 0246 | 草稿（含被拒的）只增不删，按默认每天最多 4 次、约 1 MB 一张，一年约 1.5 GB，都会进每日备份。清理现在只有预览。`aiPhotoDraftStore` 在 `app.ts:514` 无条件创建，草稿索引坏了整个 bot 拒绝启动，即使 `aiPhotos` 关着（ADR 0239 有意这样设计）。 | 低 | 开 `aiPhotos` 一段时间后再决定要不要做「确认后删除被拒超过 30 天的草稿」；删数据要用户点头。 |

## 验证

- `node --test` 跑了 `ai-photo-*`、`photo*`、`app-size`：152/152；Koishi 插件 `console` / `dashboard` 测试 49/49。
- 新加的 6 个测试在恢复修复前的源码后都失败，修复后都通过。
- `npm run typecheck` 通过。
- `npm run baseline:fast -w @qqbot/bot`：39/39 逐字一致。`app.ts` 没动。
