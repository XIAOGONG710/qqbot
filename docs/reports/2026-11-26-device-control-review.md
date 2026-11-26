# 设备控制（ADR 0148，线上 `deviceControl: on`）：安全与正确性审查（2026-11-26）

范围：`packages/bot/src/platform/device-actions.ts`（动作表、令牌、限额、批准）、`device-hub.ts`（取件 / 长轮询）、`device-service.ts`（密钥、装配、看图）、
`device-host.ts`、`device-phone.ts`（ntfy）、`owner-commands.ts` 的 `device()`、`incoming.ts` 的补回过滤、`app.ts` 里的接线（菜单、`deviceHooks`、`pendingAsk` / consent）、
`modules/devices.ts`、`modules/review-exit.ts`（危机回合 `dropDevices`）、`memory/timeline.ts` 的 `timelineFromDevice`、`ops/devices-cli.ts`，
以及电脑那一头的 `scripts/device-agent.ps1` + `device-agent.config.example.json`。参照 ADR 0148、`docs/devices.md`。
行号是修完以后的（基于 `e37cf7cc`）。

结论：6 条要修的问题（A–F），已全部修好、每条都有修之前失败、修之后通过的测试；另有 9 条（G–O）只记录或要用户决定，
其中 **G（她答应看屏幕之后，看到的东西根本没交给她）** 和 **H（过期很久的待批准还会吞掉他说的「批准 / 拒绝 / 取消」）** 是真的 bug，但修了会改变她收到什么、怎么回，按规矩留给用户定。
修复不改她的言行；行为基线 39/39 逐字一致（`devices`、`consent` 场景都在里面）。没有往真的设备派过任何任务（电脑端脚本只把纯函数抠出来单独跑）。

## 先说整体：哪些是守得住的

- **谁能连取件中心**：只绑 `hub.host` 一个地址，`docs/devices.md` 第 3 步的防火墙规则只放宿主机的地址；每个请求都要 `Bearer` 令牌，
  令牌 `init` 时 `randomBytes(32)`（64 位十六进制），比较用 `timingSafeEqual`（长度不同直接拒，只泄露长度）。认证失败 10 分钟 5 次就持久熔断。
- **她的输出能派什么**：只有 `DEVICE_ACTIONS` 里那 11 样；`open_url` / `open_app` 只能说**登记过的名字**，派给电脑的只有名字，地址和路径在电脑端配置里，
  电脑端再查一遍 `allow`（默认拒绝）、`^https://`、`Test-Path`；文字不进任何命令行（toast 走 `InnerText`，定时走 base64 + `-EncodedCommand`）。
  `file:` / `javascript:` 这类 URL 进不来（bot 端 `deviceLinks` 配置只认 `https://`，电脑端也只认 `^https://`，而且她给不了 URL）。音量两头都卡上限（bot 60、电脑端 `maxVolume`）。
- **要批准的**：`lock` / `sleep` 只会变成一个待办；只有 `deviceOwner` 的私聊纯文字「批准」才执行（`owner-commands.ts` 的 `device()` 先查 `event.user_id === deviceOwner.qq`）；
  5 分钟有效、一次一个、执行后清掉（不能重放）、系统时钟回拨超过 5 分钟当过期；同一条消息重投靠 `commandReceipts` 去重；补回的消息里的「批准」只进记录，不执行。
- **看屏幕 / 摄像头**：她的回复里写了一律拒；只有他发 `/屏幕` `/摄像头`，还要她写 `<<同意>>`；隔 10 秒、一天 20 次；图不落盘。
- **危机回合**：菜单不给（`modules/devices.ts`），出口检查在危机回合 `dropDevices()`，选中那一稿的指令行不登记。
- **审计**：`audit.jsonl` 每行只有时间、来源、动作、设备、结果、原因；原因是固定说明、设备回的报错（≤120 字）或配置里登记的名字，没有聊天原文和参数原文；时间线只记「在他的电脑上弹了一条通知」这种。
- **资源**：长轮询只认最新的一个取件者；任务 20 秒没人领、30 秒没交回都失败；结果体上限 8 MB、图片 6 MB 且查文件头；`/result` 交过一次就从 `inFlight` 删掉，不能重交。

## 修好的

### A. `<device:constructor>` / `<device:__proto__>` 让整轮回复抛错（中）

- 位置：`device-actions.ts:168`（原来 `const spec = DEVICE_ACTIONS[action]`）。
- 场景：令牌正则的动作名是 `[a-z_]{1,24}`，`constructor`、`__proto__` 都匹配；`DEVICE_ACTIONS` 是普通对象字面量，这两个名字从原型链上拿到
  `Object` / `Object.prototype`，`spec` 为真，`spec.cls` 不是 `capture`，接着 `spec.check(...)` 抛 `TypeError: spec.check is not a function`。
  `parse` 在联系人流水线 `clean()` 里调（挑候选时每一稿都调），抛出来这一轮回复就没了。线上 `deviceControl: on` 时才会走到（关着或服务没起来时走 `stripDeviceTokens`，不抛）。
  模型自己写错、或者外面读到的文字（视频、评论）里夹着这串让她照抄，都能触发。
- 修法：只认动作表自己的键（`Object.hasOwn`），别的当「没有这个动作」拒掉、照常审计。
- 测试：`device-actions.test.ts`「原型链上的名字不是动作」——修之前抛错，修之后两条都被拒、同一轮合格的 `notify` 照样认。

### B. 数字参数：没写音量当 0、十六进制 / 科学计数也认（低）

- 位置：`device-actions.ts:52`（新 `integerArg`），用在 `timer` 的秒数和 `volume set` 的音量。
- 场景：原来是 `Number(x)`：`<device:volume|set|>`、`<device:volume|set| >` 变成「设成 0」（她漏写数字，结果是静音），`0x10` → 16、`1e1` → 10、`6e2` → 600 秒都当合法。
  没有越过上限的路（上限照样查），但「写错了」被当成另一个动作执行了。
- 修法：只认 1–6 位十进制整数（前后空白照旧去掉）。菜单里教她的写法（`set|数字`、秒数）都还能用。
- 测试：`device-actions.test.ts`「数字参数只认十进制整数」——修之前空音量、`0x10`、`1e1`、`6e2`、`600.0` 都被认，修之后都拒，`set| 0 ` 和 `600` 照样认。

### C. 名单里第二个男朋友档的人，她回他的指令行会操作 deviceOwner 的设备（中）

- 位置：`app.ts:1069`（菜单的 `allowed`）、`app.ts:1788`（联系人流水线的 `devices: deviceHooks`），原来都按 `contact.tier === 'boyfriend'` 放行。
- 场景：ADR 0148 第 10 条写的是「只给男朋友档那个联系人（`deviceOwner` = 名单里第一个 `boyfriend`）」，`app.ts:1789` 的注释也说名单里可能有多个同档的人。
  但菜单和指令登记按档位给：第二个男朋友档的人（小号、测试号、以后加的人）跟她聊时，她能看到「替他操作他的电脑」的菜单，回复里写的 `notify` / `open_app` / `volume` 直接在 deviceOwner 的电脑上执行，
  `lock` / `sleep` 的待批准提示发给 deviceOwner——他会看到一条不知道从哪来的「她想锁屏」。
- 修法：两处都改成 `contact.qq === deviceOwner?.qq`（行数不变，app-size 不涨）。第二个人那边指令行照旧摘掉、不给他看，只是不登记。
  `pendingAsk` / consent 本来就按 QQ 号存、只给 deviceOwner 设，不受影响。
- 测试：`app.test.ts`「名单里第二个男朋友档的人」——修之前第二个人那一轮派出了 `notify`，修之后不派、提示词里没有菜单，deviceOwner 本人照常能用。

### D. `hub.host` 换个写法就能绑全部网卡（中）

- 位置：`device-service.ts:30`（新 `specificHubHost`），`validSecrets` 用它（`device-service.ts:41`）。
- 场景：原来只拒 `'0.0.0.0'` 和空串。`::`、`[::]`、`::0`、`0:0:0:0:0:0:0:0`、`::ffff:0.0.0.0` 在 Node 里都是「监听全部」（IPv6 双栈连 IPv4 一起收），
  `0`、`0.0`、`000` 这种纯数字的「主机名」会被解析成 `0.0.0.0`。设计上「取件中心只绑一个地址」的承诺就落空了，只剩令牌一道门（和 Windows 防火墙）。
- 修法：IP 字面量不能是全零（IPv6 用 `URL` 规范化后比 `[::]` / `[::ffff:0:0]`）；不是 IP 的必须像主机名（只含字母数字点横线、至少一个字母）。
  `init` 生成的是第一张非回环网卡的 IPv4，不受影响。
- 测试：`device-service.test.ts`「hub.host 换个写法的『绑全部网卡』也不行」——修之前 `::` 就通过了校验，修之后上面这些都拒，`192.168.x.x`、`::1`、`fd00::5`、`localhost` 照样认。
- 提醒用户：如果线上 `runtime/bot/secrets/devices.json` 的 `hub.host` 手改成过 `::` 一类的写法，下次重启设备控制会不启动（日志写「devices.json 的格式不对」）。我没有读线上的密钥文件。

### E. 取件中心本身不拒空令牌（低，纵深防御）

- 位置：`device-hub.ts:66`。
- 场景：`authorized()` 里没带 `Authorization` 头时 `given` 是空 Buffer；如果 `options.token` 也是空串，两边长度都是 0、`timingSafeEqual` 为真——谁都能领任务、交截图。
  现在唯一的调用方先过了 `validSecrets`（≥ 32 位），所以线上没有暴露；但 `hubOverrides` 能覆盖 `token`，门不该只靠调用方。
- 修法：`createDeviceHub` 里令牌不是字符串或短于 32 位就直接抛错，不起。
- 测试：`device-hub.test.ts`「令牌是空的或太短：不起」——修之前三种都能建起来，修之后都抛。

### F. 电脑端：`volume set 0` 实际是 4%；60 个表情的通知 bot 认、电脑拒（低）

- 位置：`scripts/device-agent.ps1:98`（新 `Get-VolumeKeys`）、`scripts/device-agent.ps1:89`（`Test-Text`）。
- 场景一：原来 `1..([int][Math]::Round($level / 2)) | ForEach-Object { 加 }`。PowerShell 里 `1..0` 是 `@(1, 0)`，所以 `set 0` 和 `set 1`（银行家舍入成 0）都按两次「加」，
  她说「我把音量关了」，电脑上停在 4%。（在本机 PowerShell 5.1 上核对过 `@(1..0).Count` 是 2。）
- 场景二：bot 端按码点数字数（`[...text].length ≤ 60`），电脑端按 UTF-16 数（`$value.Length`），一个表情 bot 算 1、电脑算 2；带表情的长通知 bot 放行、电脑报 `bad text`，审计里一条莫名的 failed。
- 修法：音量改成先 50 次「减」、再按 `Round(level/2)` 次「加」，用计数循环，0 次就是 0 次；`Test-Text` 先把代理对折成一个字再数。脚本保持纯 ASCII。
- 测试：新的 `scripts/device-agent.test.mjs`（`npm run test:scripts` 会跑）只把 `Get-VolumeKeys` / `Test-Text` 两个函数定义抠出来交给 `powershell.exe` 跑，
  不运行整个小程序、不按键、不连取件中心；没有 Windows PowerShell 的机器上跳过。修之前：`Test-Text`（60 个表情）为 False、旧的范围写法 `set 0` 按两次「加」；修之后 0 / 1 一次都不按、60 个表情能弹、61 个不能。
  另加一条「脚本保持纯 ASCII」。
- 电脑端脚本要用户自己复制到宿主机才生效（`docs/devices.md` 第 4 步）；我没有动宿主机上的那一份。

## 只记录 / 要用户定的

### G. 她答应看屏幕 / 摄像头之后，看到的东西没交给她（中，要用户定）

- 位置：`app.ts:1094`（consent 的 `claim().run`），对照 `device-service.ts:203`。
- 现象：10-30 加「她有权拒绝」（`47e37737`）时，把原来 `outcome.run()` 之后「`kind: 'message'` 就作为他这一条消息交给回复器」那一步（`target.receive(handled.text, …)`）换成了
  「只有 `kind: 'reply'` 才发给他」。于是她写 `<<同意>>` 以后：截图真的截了（电脑弹提示）、真的送去云端看图模型、用掉一次当天额度，
  但描述（`[他让你看了一眼他的电脑屏幕：…]`）被丢掉——她没看到，他也什么都没收到。只有失败（`kind: 'reply'`，比如「隔得太近」「看图没开」）才会回他一句。
  `docs/devices.md` 和 ADR 0148 第 6 条都写着「描述作为他这一条消息交给回复器，她自然地回」。`memory-app-device-*` 里有 4 条相关测试一直是 skip（「待按同意流程重写」），所以没被发现。
- 为什么不修：修好以后她会收到他屏幕的描述、并就此开口——这是改变她看到什么、说什么，按规矩要先 `ask-her`、用户点头。
- 建议：在 `claim().run` 里 `handled.kind === 'message'` 时照原来那样交给这个联系人的回复器（带上他那条 `/屏幕` 的 message_id 和时间），并把那 4 条 skip 的测试按同意流程补上。修之前，`/屏幕` 每次都是白截一张。

### H. 过期很久的待批准，会吞掉他之后说的「批准 / 拒绝 / 取消」（中低，要用户定）

- 位置：`device-actions.ts:383`（`isOwnerCommand` 只看 `pending !== undefined`）、`device-actions.ts:400`（`DECLINE` 不查过期）。
- 现象：她提议锁屏、他没理；过期的待办不会自己清掉（只有她下一次提议、或他说「批准 / 拒绝」时才清）。几小时甚至几天以后，他在聊天里随口回一句「取消」（比如说约会取消了），
  这句话被当成设备命令吞掉，回他一行「（取消了）」，她根本没看到；说「批准」会收到「（已经过期了…）」。
- 为什么不修：修了以后这些话会交给她、她会回——改变她收到的话。
- 建议：过期超过一个宽限（比如再过一个 TTL，即提议 10 分钟后）就悄悄清掉待办、按普通的话处理；宽限内照现在这样回「已经过期了」。

### I. 补回时的命令过滤漏了几种写法（低）

- 位置：`incoming.ts:108`。
- 现象：补回（重启后恢复没处理完的消息）时，过滤列表只有 `批准`、`拒绝`（整句）和 `/屏幕` `/摄像头` `/设备` 开头的；`/看屏幕`、`/拍照`、`/批准`、`/拒绝`、`取消`、`批准。` 这些 `device-actions.ts` 也认的写法会被当成普通聊天记进聊天记录、交给她。
  不会被执行（补回只记历史），所以不是安全问题；但她会在记录里看到一条「/看屏幕」。
- 建议：过滤直接用 `device-actions.ts` 的那几个正则（导出来复用），改的是她看到的历史，所以列在这里。

### J. 写错格式的指令行会原样发给他（低）

- 位置：`device-actions.ts:136`（`TOKEN`）、`stripDeviceTokens`。
- 现象：只摘完全合格的令牌；`<device:Lock>`（大写）、参数超过 80 字、参数里带 `<`、少了 `>` 的，既不认也不摘，`cleanUpReply` 也不管，原样出现在发给他的消息里。
- 建议：摘令牌时再宽松地摘一遍任何 `<device:…>` 形状的东西（只摘、不认）。改的是发出去的字，留给用户定。

### K. 熔断以后菜单照样给（低）

- 位置：`device-service.ts:164`（`available()` 不看 `devicesBreaker`）。
- 现象：认证失败熔断后 `dispatch` 一律回「设备控制熔断中」，但菜单还在，她照样会提议、审计里一串 failed；待批准的照样发提示，他批准了再收到「没做成」。
- 建议：熔断时 `available()` 不报电脑（菜单随之消失）。改的是她的提示词，留给用户定。

### L. 熔断可以被局域网里的人用 5 个错令牌触发（信息）

- 位置：`device-hub.ts:176-178`。
- 现象：未认证请求就能计数，5 次就持久熔断、只有本机命令行能恢复——这是「宁可关掉」的取舍；防火墙只放宿主机时只有宿主机能触发。
  另外未认证请求的时间戳都存进数组（10 分钟窗口），被刷时内存线性涨（每次 8 字节，刷一百万次约 8 MB），影响很小。

### M. 令牌明文走 HTTP（信息）

- 取件中心是 `http://`，令牌每 25 秒随长轮询过一次 VMware NAT 网段；同网段的其他虚拟机能嗅到并冒充电脑端（领任务、交伪造的截图）。电脑端也不校验取件中心的身份。
  威胁面是同一台宿主机上的其他虚拟机，ADR 0148 接受了。要更稳可以换成 HTTPS + 固定证书指纹，或者在宿主机侧限制 NAT 网段。

### N. 电脑端完全信任取件中心发来的「看屏幕」（信息）

- `capture_screen` 在电脑端只看 `allow`，不看是谁、为什么要的；虚拟机这边被攻破，攻击者就能在额度外随时截他的屏（取件中心的限额在虚拟机这边）。
  `announceText` 每次弹提示是唯一的提醒。ADR 0148 写的「最后的决定权在设备那头」对 capture 只到「开或不开」这一级。建议用户确认宿主机配置里 `capture_screen` 真的需要开；需要的话可以在电脑端加一个每天上限。

### O. 小处（信息）

- `device-hub.ts:88` `deliver()` 给排队后才领走的任务固定用 30 秒超时，不管 `submit()` 传的 `timeoutMs`；现在唯一的调用方用默认值，没有影响。
- 限额、去重、待批准都在内存里，重启清零（重启要用户点头，影响有限）。
- 通知文字只挡 C0 控制字符和尖括号，不挡 C1 控制字符和双向文字控制符（`U+202E` 之类）；是她自己写给他看的字，风险很小。

## 验证

- 新增 / 改的测试：`device-actions.test.ts` +2、`app.test.ts` +1、`device-service.test.ts` +1、`device-hub.test.ts` +1、`scripts/device-agent.test.mjs` 新文件 3 条；每条都先在没修的代码上跑过、确认失败。
- `node --test` 跑 `device-*.test.ts`、`app-size`、`memory-app-device-*`、`timeline`、`consent`：78 通过、0 失败（4 条 skip 是原来就有的，见 G）。`app.test.ts` 139/139。
- `npm run typecheck` 通过；`npm run baseline:fast -w @qqbot/bot` 39/39 逐字一致；`app.ts` 行数没变（2674 ≤ 2675）。
