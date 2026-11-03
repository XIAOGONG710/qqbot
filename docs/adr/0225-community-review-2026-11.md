# ADR 0225：社区方案对比与简化取舍（2026-11）

## 状态

已完成第一轮对比；后续每轮缺陷审查继续沿用“先证据、后小改动、再回归”的规则。

## 对比结论

### Koishi 控制台

Koishi 官方的数据交换文档建议用 `DataService` 为自定义页面提供数据，并通过服务刷新把变化推到前端。项目原本已经采用这条路线，因此本轮没有另起 HTTP 接口，而是把状态页优化为：

- 保留现有 `qqbot` DataService 和 5 秒刷新；
- 增加运行总览、连接健康灯、实时天气新鲜度、DSH 开关状态；
- 联系人筛选只在前端处理已脱敏状态摘要；
- 编辑页继续复用 Koishi `k-form`，不复制一套表单校验。

### 手机伴侣

社区 Android 伴侣通常采用“手机 App ↔ 网关 / 中继”的配对方式，常见实现会用一次性链接或二维码完成配对，再通过长连接传递消息和动作。项目因此先落地传输无关协议、版本 / nonce / 时间校验和动作白名单，后续接 WebSocket / HTTPS 时沿用同一 envelope；没有把 token 或高权限 shell 直接塞进 App。

## 不采用的部分

- 不照搬提供任意 `/shell`、键盘注入、读取短信、安装应用或支付的实现；这些能力无法用“默认授权”替代审计和撤回。
- 不把社区项目的整套 UI / 中继服务引入仓库，避免为了一个伴侣 App 扩大依赖面。
- 不让 DSH 自动介入每一轮 QQ 回复；只有显式 `/dsh` 命令才带有限上下文，保持费用、隐私和失败边界清楚。

### 客户端形态

本轮先采用零依赖 PWA（`packages/mobile-companion-app`）作为可安装客户端：它能复用浏览器的 WebSocket、HTTPS 和 Service Worker，先验证配对、连续对话、媒体引用和动作确认，再决定是否封装成原生 Android WebView。这样不需要先引入 Flutter / React Native 的大依赖，也不会在原生权限尚未审计前扩大权限面。

### 会话与断线处理（2026-11-03 复核）

OWASP 的会话管理建议同时设置空闲超时和失效后的重新认证；MDN 对 WebSocket 也建议在页面离开时主动关闭并在恢复时重连。项目据此保留两条简单规则：

- WebSocket 连接关闭时立即释放绑定；
- HTTPS 没有可靠的 close 事件，网关默认 30 分钟无流量回收会话，回收后仍需一次性配对码；

没有引入复杂的 refresh-token / 中继服务，避免把“重连”变成另一套身份系统。

## 依赖审计发现

最初复核发现 `koa-body@6.0.1 → zod@3.25.76` 命中 GHSA-mrhx-c7xc-m3w5 高危公告。根据公开修复线（Zod 4.6.6+），本轮在隔离工作区加入根级 `zod@4.6.7` override，并用 `koa-body` 运行时校验、Koishi 插件测试、完整工作区测试和类型检查验证兼容性；当前 `npm ls zod` 已确认运行时只解析到 4.6.7，`audit:gate` 通过。若未来 Koishi 上游发布原生兼容版本，应优先回归上游依赖并移除本地 override。

2026-11-03 07:50 的依赖链复核：

```text
koishi 4.18.11
└─ @koishijs/plugin-server 3.2.9
   └─ @cordisjs/plugin-server 0.2.9
      └─ koa-body 6.0.1
         └─ zod 4.6.7（根级 override）
```

社区当前的 `koa-body 8.0.1` 已切到 zod 4，但它要求配套的新 Cordis server 主线；`@cordisjs/plugin-server 1.7.0` 的 peer 是 `cordis ^4.0.0-rc.6`，不能直接塞回本项目仍使用的 Koishi 4 / Cordis 0.2 组合。因此本项目选择最小化修复：只在依赖解析层 override zod，不跨主版本升级 Koishi/Cordis；若未来上游组合稳定，再单独评估整条升级路径。

2026-11-03 07:59 的缺陷复核：

- 全量 bot 回归第一次发现 4 个旧夹具失败，原因是新加的 `dsh` 配置被旧的 `startApp()` 直接调用方省略；改为缺失即关闭后，bot 1956/1956 全绿。这条兼容规则保留在运行时代码中，不要求所有外部夹具立即迁移。
- DSH CLI 的 `--help` 改为先显示用法再加载运行配置，并与 Koishi 配置一样复用 `dsh.baseUrl` / `model` / `timeoutMs` 覆盖；无运行目录时仍能查看帮助。
- 解除手机配对现在会同时清掉宿主侧按设备保存的 DSH 短期上下文；手机伴侣协议回归 29/29，避免旧设备语境残留。
- 进一步覆盖“模型等待期间撤销配对”和“旧请求误减新队列计数”的竞态：旧请求不会把回答写回新上下文，也不会污染新配对状态；手机伴侣协议回归更新为 32/32。
- 媒体上传 / HTTPS 动作轮询原先只查 session 归属，不执行网关的空闲 TTL；现在 `clientForSession()` 也会回收过期 session，过期会话不能继续上传媒体或读取动作队列，并新增媒体 HTTP 回归覆盖。
- 全工作区回归再次通过：bot 1956/1956、角色资料 43/43、Koishi 插件 47/47、手机伴侣 32/32、PWA 3/3；全 workspace typecheck 与 `git diff --check` 通过。
- PWA 的 Service Worker 原先会把所有同源 GET 当成静态资源缓存；现已限制为明确的静态 URL，动作轮询与 Koishi API 不再被缓存，并新增 PWA 回归（3/3）。
- `hello.capabilities` 现在限制为最多四个不重复的协议能力，避免重复列表在大 envelope 内造成无意义的解析负担；手机伴侣回归仍为 32/32。
- `action.result.error` 与服务端错误统一限制为 500 字符，避免客户端回执把超长错误带入日志或响应。
- DSH 脱敏补上 URL 查询串中的 `api_key` / `token` / `secret` / `password` 参数，且保留非敏感查询参数；DSH 连接层定向回归 7/7、bot typecheck 通过。
- 真人式数值的最新消息判断改为取最大时间戳，补回消息暂时无序时不会错误增加沉默 / 降低关系连续性；human-values 回归 9/9。
- 状态目录离线核验仍为 16 项通过，工作树差异格式检查通过；未执行重启、合并或部署。
- PWA 状态层新增 `acceptDownlink()` 薄转发，原生客户端可复用同一动作校验；PWA 回归保持 3/3、typecheck 通过。
- 媒体仓库对直接调用也执行与协议相同的 `clientId` 格式校验，避免异常设备标识污染归属索引；手机伴侣回归保持 32/32。
- PWA 页面原先收到 `action.request` 后直接执行，没有复用客户端的下行 nonce 防重放边界；现已增加本地 256 项滚动 nonce 记录、基本 envelope 校验和重连清理，PWA 回归更新为 4/4。
- HTTP / Koa 适配器对重复 `x-companion-session` 头不再静默选一项或新建 session；现在统一拒绝歧义认证头，手机伴侣回归更新为 33/33。
- 宿主下行监听器抛错不会再让 `requestPhoneAction()` 假失败；动作仍保留在轮询队列中，避免上层误重试导致重复动作。
- Koishi server 的 `post()` 默认会先运行 `koa-body`；媒体上传路由现标记 `noParseBody`，保留原始二进制流给媒体仓库，Koishi 插件回归 47/47、typecheck 通过。
- 进程内一次性配对票据增加 64 条上限，超出时淘汰最早未使用票据；手机伴侣回归更新为 34/34，避免重复 `/dsh pair` 在 TTL 内无界累积。
- DSH 伴侣按设备保存的短期对话上下文增加默认 64 台上限并按最近使用淘汰，防止大量临时 `clientId` 让上下文 Map 无界增长；手机伴侣回归更新为 35/35，全 workspace typecheck 通过。
- bot 内的 `createMobileCompanion()` 也暴露 `maxClients`，默认策略与底层 DSH 适配器一致，避免集成层无法调小资源上限。
- 现实天气解析增加 2 MiB 响应体、14 天逐小时数组和数组长度一致性限制，异常公开响应不会直接进入缓存；天气定向回归 13/13、bot typecheck 通过。
- zod GHSA-mrhx-c7xc-m3w5 高危告警通过 `@qqbot/koishi-app` 的运行时 zod 4.6.7 依赖与根级 override 消除；完整工作区测试、类型检查、`npm ls zod` 和 `audit:gate` 均通过，基线同步移除已消失的高危公告。

## 参考

- [Koishi Data Exchange](https://koishi.chat/en-US/guide/console/data)
- [Koishi Plugin Guide](https://koishi.chat/en-US/guide/plugin/)
- [Pony：Android companion / pairing relay](https://github.com/oroplex/pony)
- [OpenClaw Hands：Android companion capabilities](https://github.com/CipherSatoru/openclaw-hands)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [MDN：Writing WebSocket client applications](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications)
- [MDN：Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
