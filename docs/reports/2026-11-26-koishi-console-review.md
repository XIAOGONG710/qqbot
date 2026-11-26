# Koishi 控制台「林梦瑶」页面：安全与正确性审查（2026-11-26）

范围：`packages/koishi-plugin-qqbot/src/console.ts`（`registerConsole` 和全部监听器、数据服务）、前端 `packages/koishi-plugin-qqbot/client/*.js`、
`src/index.ts` 里喂给它的部分（`setConsoleState`、`status`），以及它调用的 `packages/character-tools/src/character-editing.ts`、
`packages/bot/src/vision/ai-photo-{drafts,references}.ts`、`packages/bot/src/social/external-drafts.ts`。
对照的上游源码：`@koishijs/console`（`Client.receive`、`DataService`、`broadcast`）、`@koishijs/plugin-auth` 4.1.7（`console/intercept`）、`@koishijs/utils` 的 `coerce`。
行号是审查时（`dd41c10a`）的。

结论：发现 6 条要修的问题（A–F），已全部修好、每条都有修之前失败、修之后通过的测试；另有 6 条（G–L）只记录或要用户决定。
修复不改她的言行；行为基线 39/39 逐字一致。

## 怎么拦登录（先说清楚机制）

- `ctx.console.addListener(event, cb, { authority: 4 })` 只是把 `authority` 存进监听器表；真正拦的是 `Client.receive` 里的
  `ctx.serial('console/intercept', client, listener)`，而这个事件**只有 plugin-auth 注册了处理函数**（没登录、过期、权限不够就返回 true）。
- 数据服务同理：`DataService` 的 `options.authority` 也是靠同一个 `console/intercept` 在 `broadcast` / `refresh` 时拦。
- 页面 `ctx.page({ authority: 4 })` 只是前端不显示入口，不算保护。
- 控制台 WebSocket（`plugin-console` 的 `ctx.server.ws(apiPath)`）不查 `Origin`；登录令牌存在浏览器 localStorage，不是 cookie，
  所以 plugin-auth 在的时候别的网站拿不到令牌——前提是 plugin-auth 在。

## 修好的

### A. plugin-auth 不在时所有监听器和数据服务都不设防（高）

- 位置：`console.ts:481`（数据服务 `{ authority: 4 }`）、`console.ts:497-518`（13 个监听器只传 `{ authority: 4 }`）。
- 场景：plugin-auth 被停用、启动失败（例如数据库还没起来）或配置被改坏时，`console/intercept` 没有处理函数，Koishi 一个监听器都不拦。
  控制台只监听 127.0.0.1，但 WebSocket 不查 Origin：用户浏览器里打开的任何网页都能连 `ws://127.0.0.1:5140/status`，
  调 `qqbot/character/load` 读走真实角色资料（含隐私），调 `qqbot/character/save` 改写 `characters/linmengyao/source/`，
  批准 / 拒绝 AI 照片和外部平台草稿；数据服务每 5 秒把状态（联系人、QQ 号、记忆服务地址）推给它。
- 修法：`consoleListeners()`（`console.ts:512`）把全部监听器收成一张表，每个先过 `consoleAuthorized(this)`（`console.ts:486`）：
  连接上要有 `auth`、`authority >= 4`、没过期（和 plugin-auth 同一套判断），否则抛「请先登录控制台。」。
  数据服务的 `get(forced, client)` 改成 `consoleDataFor(client)`，没登录的连接拿 `null`。失败关闭，不再靠别的插件在不在。
- 测试：`packages/koishi-plugin-qqbot/test/console.test.ts`「没登录、权限不够、登录过期都拒绝……」：5 种连接 × 全部监听器都被拒，数据服务给 `null`。

### B. 监听器抛错时，堆栈、绝对路径和资料原文发到页面（中）

- 位置：`console.ts:498-501`（`character/load`、`check`、`save` 直接抛），上游 `Client.receive` 用 `coerce(e)` 回错误，`coerce` 有 `stack` 就发 `stack`。
- 场景：`source/` 里某个 YAML 写坏时，`readSource` 抛 js-yaml 的错误，消息后面几行是出错位置附近的**资料原文**，堆栈里是仓库绝对路径；
  `state.character` 还没设时抛的错误也带堆栈。页面虽然只显示固定文字，但原文已经过了连接（浏览器开发者工具、代理日志里都能看到），
  和本文件「不把 YAML 路径、输入值当错误串展示」的设计相反。
- 修法：表里每个监听器 `try/catch`，异常一律换成 `publicFailure('请求没有完成，请刷新页面后重试；详细原因见运行日志。')`
  （`stack` 设成提示本身，`coerce` 只发这一句）；原因只记日志第一行、截 200 字（YAML 报错第一行没有资料原文）。
- 测试：「监听器出错时页面只拿到中文提示……」：坏 YAML 里放一句合成的「秘密原文」，断言错误的 `stack === message`、不含原文 / 文件名 / 路径，日志只有一行。

### C. 保存不带快照 token 就不比快照：两个标签页互相覆盖；part 不校验（中）

- 位置：`console.ts:455-461`（`saveCharacter(part, value, dryRun, token?)` 原样传给编辑层），`character-editing.ts:193`（`token !== undefined` 才比）。
- 场景：编辑层为了兼容旧用法，token 缺省时直接写。页面平常会带 token，但任何直接调监听器的请求（或以后改坏的前端）不带 token
  就会覆盖别处（另一个标签页、DSH 面板、手改 YAML）的修改。另外 `part` 不校验：`world`、`biography` 这两个页面上没有的文件也能从控制台整份替换。
- 修法：控制台这边 token 必须是字符串，缺了按冲突处理并回最新 token（页面本来就会在冲突时重读）；`part` 只认 `EDIT_PARTS` 的六页。
  编辑层本身不动（`character-cli.ts` 那条路照旧）。
- 测试：「保存不带快照 token 时按冲突处理……」：不带 token 返回冲突且不写；第一个标签页存了以后第二个拿旧 token 存被拒；
  `world` / `biography` / `__proto__` / `constructor` / 数字都不写。原有的角色资料测试改成带 token 调（和页面一样）。

### D. 视觉参考的名称照占位提示填，永远登记不上（低，功能 bug）

- 位置：`client/photo-references.js:131`（占位「例如 猫的正面」）、`ai-photo-references.ts:43`（`referenceId` 只收 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`）、
  `console.ts:251-257`（store 抛错一律回「视觉参考暂时无法修改，请刷新页面后重试」）。
- 场景：用户照提示填中文名，每次都失败，提示还让他刷新重试，看不出是名称的问题。
- 修法：控制台先按同一规则校验名称（以及「不能指向人物」），说清楚怎么写；占位改成 `cat-front（英文字母、数字和 - _ . :）`。
- 测试：「视觉参考名称不合规时说清楚要怎么写……」：`猫的正面` 得到具体提示且没登记，`cat-front` 能登记。

### E. 档位名原样拼进 st/ 文件名，能写到 st/ 外面（低，纵深防御）

- 位置：`character-tools/src/build.ts:151-180`（`${prefix}-${tier.name}.json` 等四种文件名）、`source.ts:567`（档位名只要求是非空字符串）、
  `character-editing.ts:155-156` 和 `build.ts:135` 直接 `join(stDir, file)` 写。
- 场景：档位名带 `../`、`\`、`:` 时，生成的卡会写到 `st/` 外面，或写进 NTFS 备用数据流（`linmengyao-a:b.json`）。
  控制台单页保存加不了新档位（作息里按档位的说法要求每档恰好一句，单改 `tiers` 过不了校验，实测 `extra` 这样的正常名字也加不上），
  所以这条主要挡手改 YAML 后跑 CLI。
- 修法：`assertSafeOutputName()`（`build.ts:134`）：文件名只许一层、以 `.json` 结尾，不含 `<>:"/\|?*` 和控制字符，不以 `.` 开头、不以 `.` / 空格结尾；
  `writeOutputs` 和编辑层的 `planWrites` 先查完整批再写，有一个不合格就都不写。报错不带文件名本身。
- 测试：`packages/character-tools/test/character-editing.test.ts`「生成的文件名不安全……」：7 种坏名字都整批不写、`st/` 外面没有文件。
  真实资料 `npm run test:real -w @qqbot/character-tools` 44/44，生成结果不变。

### F. 运行中的 app 和控制台各拿一份草稿 / 参考的内存，互相写没（中）

- 位置：`console.ts:195-221, 283-296`（每次请求新开 `aiPhotoDraftStore`、`aiPhotoReferenceStore`、`createExternalDraftStore`），
  `platform/app.ts:508-514, 713`（app 启动时各开一个、一直拿着），三个 store 都只在构造时读一次文件（`ai-photo-drafts.ts:216`、
  `external-drafts.ts:144`、`ai-photo-references.ts:78`）。照片货架 `photos.ts` 已经是每次改动前加锁重读，这三个没有。
- 场景：
  - 控制台拒绝了一张 AI 照片草稿，app 的内存里还是「待审核」：手机伴侣再点通过就会通过并放上货架，「拒绝后不能直接通过」被绕过；
    app 下一次生成草稿时把旧内存整份写回，控制台的审核结果没了（通过的照片已经上货架，草稿却又回到待审核，可以再通过一次）。
  - 控制台批准的外部平台草稿，app 看不到（状态页、体检的计数也是旧的），app 下一次写草稿时又写回「待确认」。
  - 控制台删了一张视觉参考（文件也删了），app 还拿着旧条目，下次质量审查 `imagesFor` 读不到文件就报错，生图整次失败，直到重启；新登记的也用不上。
- 修法：三个 store 每次用之前从盘上重读（写的操作和要读图的读不了就报错；只读的列表、计数读不了时用上一份，不刷日志）；
  AI 照片生成要等生图服务，返回后再读一遍，期间别处已经给同一事件生成过就直接用那一张。同一进程里调用都是同步的，读、改、写不会交错。
- 测试：`packages/bot/test/ai-photo-drafts.test.ts`、`external-drafts.test.ts`、`ai-photo-quality.test.ts` 各一条「运行中的 app 和控制台各开一个实例……」。
  `npm run baseline:fast -w @qqbot/bot` 39/39 逐字一致。

## 只记录 / 要用户决定的

### G. 二次确认只是一个固定字符串（信息）

`confirmation === 'confirmed'`（`console.ts:246, 261, 311, 414`）不和会话绑定、也不是一次性的，只防误点（前端 `window.confirm` 之后才发）。
真正的保护是登录（A 修好后不再依赖 plugin-auth 在不在）。要不要改成服务端发的一次性确认码：建议不改，收益很小。

### H. 任何一个 YAML 写坏，整个编辑页打不开，提示还说「连接不上」（要用户定）

`qqbot/character/load` 先调 `readSource`（`console.ts:500`），它读全部文件并校验，坏一个就抛；编辑层 `load()` 本来设计成「文件坏了那一页给空，照样能打开改」，
这条路走不到。前端把所有失败都显示成「暂时无法连接控制台，请刷新页面或检查登录状态」（`client/editor.js:25`）。
可以改成：读不了时回 `editor.load().parts`（坏的那页是 `null`）并显示「资料文件格式有误」。这会改编辑页的行为，留给用户定。

### I. 控制台接口能把「失败」的外部草稿重新批准（要用户定）

`reviewExternalDraft` 只管 approve / reject，store 允许 `failed → approved`（`external-drafts.ts:126`），所以直接调接口能把失败待核对的草稿重新批准；
页面只给「待确认」的草稿显示按钮。现在没有接真实发布适配器，没有外部副作用；以后接了，重新批准可能导致重复发布。
要不要让控制台只允许审核 `pending`：建议以后接发布前再定。

### J. 上游：WebSocket 不查 Origin、消息大小不限（信息）

`plugin-console` 的 WebSocket 不查 Origin，`ws` 默认单条消息上限 100 MiB；参考图在我们这边按字符串长度先截（`console.ts:224`，约 7 MB），
但整条 JSON 已经被上游解析过。按规则不改上游；只监听 127.0.0.1、A 修好后没登录的请求进不到我们的代码。

### K. 有一张视觉参考的文件坏了，整页列不出来、也删不掉（要用户定）

`aiPhotoReferenceStore` 构造时校验每个条目的文件（`ai-photo-references.ts:107`），任何一张坏了（被手动删、内容对不上哈希）整个 store 起不来，
控制台的列表、登记、删除都报「暂时无法修改」。这是有意的失败关闭；要不要允许控制台删掉坏条目来自救，留给用户定。

### L. 跨进程仍没有锁（信息）

F 的重读解决的是同一进程（Koishi 里 app + 控制台）的问题。`ai-photo-cli.ts` 在另一个进程里同时写时，读和写之间仍有极短的窗口；
照片货架用的是 `withPhotoIndexLock`，要彻底解决可以给这三个 store 也加同样的锁。现在 CLI 只在手动跑时用，暂不加。

## 看过、没有问题的

- **XSS**：前端全用 Vue `h()` 渲染文本和属性，没有 `innerHTML` / `v-html` / 动态 `href`；照片预览的 `src` 是服务端按文件头重新拼的 `data:image/(jpeg|png|webp)`。
- **路径穿越（照片、参考、草稿）**：编号都按 `^[a-f0-9]{12}$` / `^[a-z0-9-]{8,80}$` 校验，文件名必须是「编号.扩展名」，读之前 `lstat` 拒绝符号链接、`realpath` 比对目录。
- **base64 上传**：先按字符串长度截，再用锚定的正则取 base64，解码后再比大小和文件头，和声明的类型不一致就拒。
- **数据泄露**：`ConsoleData` 不带角色资料路径和数据目录；体检、运行摘要不回显模型名、URL、密钥、错误原文；`state.error` 经 `publicConsoleError` 只给处理方向。
  状态里的联系人、QQ 号、记忆服务地址是给登录的管理员看的，按设计保留。
- **写真实资料**：只写 `characterPaths(characterCard)` 推出的 `source/` 和 `st/`；`characterCard` 由插件配置决定，改配置本身要 4 级登录（plugin-config）。
- **测试是否测了它说的**：原来的「心情和在读的书……」把保存结果叫 `moodPreview` / `bookPreview`，其实调的是保存（断言的是「没变不写」，结论没错），已改名；
  `character-tools` 的「没带快照 token 的旧用法（Koishi 页面第一次保存）照样能存」说的「Koishi 页面」已经不成立（页面总带 token，控制台现在也要求带），
  测的是编辑层本身，保留。

## 验证

- `npm test -w koishi-plugin-qqbot`：113/113。
- `npm test -w @qqbot/character-tools`：27/27；`npm run test:real -w @qqbot/character-tools`：44/44。
- `npm test -w @qqbot/bot` 全量（含行为基线）：5159 项，5146 通过、0 失败（其余跳过）；`npm run baseline:fast -w @qqbot/bot`：39/39 逐字一致。
- `npm run typecheck`：通过。
- 没有重启线上服务。控制台代码要等下一次重启 Koishi 才生效（`docs/koishi.md`）。
