# Koishi（ADR 0008）

运行时的外壳：Koishi 4 提供控制台和 OneBot 适配器，林梦瑶的逻辑是我们自己的插件 `koishi-plugin-qqbot`，核心仍在 `packages/bot`。
决策和试验结果见 [ADR 0008](adr/0008-koishi-runtime.md)、[调研汇总「第 2 步」](research/2026-10-05-framework-fit.md)。

## 组成

| 位置 | 内容 | 入库 |
| --- | --- | --- |
| `packages/koishi-app` | Koishi 的依赖清单（版本写死）和配置模板 `koishi.example.yml` | 是（依赖锁在根目录 `package-lock.json`） |
| `packages/koishi-plugin-qqbot` | 插件：配置 Schema、收发接线、断线看门狗、卡文件监听；从 `.ts` 源码直接加载，不打包 | 是 |
| `runtime/koishi` | 实例：`koishi.yml`（名单、模型参数等）、`data/`（Koishi 自己的 sqlite 和日志）、启动脚本写的占位 `package.json` | 否 |
| `runtime/bot` | 聊天记录、换档记录、记忆写入进度、按天日志、单实例锁：和独立入口 `main.ts` 共用 | 否 |

## 来源核对（2026-10-05）

根目录 `npm install` 装上 `koishi` 4.18.11、`koishi-plugin-adapter-onebot` 6.9.4（MIT）、`@koishijs/plugin-console` 5.30.11、`plugin-config` 2.8.6、
`plugin-logger` 2.6.9、`plugin-auth` 4.1.7（AGPL，原样使用不改源码）、`plugin-database-sqlite` 4.7.0（MIT，sql.js / wasm，不用本机编译），
以及 `koishi` 自带的 `plugin-http` 0.6.3、`plugin-proxy-agent` 0.3.3、`plugin-server` 3.2.9，共新增 192 个包。

- `npm audit signatures`：仓库全部 196 个包都有有效的 npm 仓库签名，23 个带来源证明。
- `npm audit` 有 2 个中危，都不在我们用到的路径上：`file-type` 16.5.4（`plugin-http` 识别下载内容的类型，ASF 解析死循环，GHSA-5v7r-6r5c-r473）、
  `uuid` 8.3.2（控制台，v3/v5/v6 传入 buf 时缺边界检查，GHSA-w5hq-g745-h8pq）。
- 没装 `npm init koishi` 模板里的其他插件（市场、遥测、puppeteer、其他平台适配器等）。

升级：改 `packages/koishi-app/package.json` 里的版本 → 根目录 `npm install` → 再跑一遍上面两项核对、三个包的测试和假 NapCat 端到端，结果记在这里。

## 第一次配置

1. 根目录 `npm install`。
2. 复制 `packages/koishi-app/koishi.example.yml` 到 `runtime/koishi/koishi.yml`，填 `adapter-onebot.selfId`（小号 QQ 号）和 `qqbot` 一节。
   `qqbot` 一节和 `runtime/bot/config.json` 同形（少了 `onebot`，连接归适配器），区别只有两处：`llm.extraBody` 写成 JSON 文本，长期记忆用 `memory.enabled` 开关。
   留空的数值参数用 `packages/bot/src/config.ts` 里的默认值。
3. 控制台管理员密码放用户级环境变量（自己设，不进仓库、不写进 `koishi.yml`）。用下面两行，提示时输入密码，
   这样密码不会出现在命令里（Windows PowerShell 5.1 会把整行命令存进 PSReadLine 的历史文件）：
   ```powershell
   $s = Read-Host '控制台密码' -AsSecureString
   [Environment]::SetEnvironmentVariable('QQBOT_KOISHI_PASSWORD', [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)), 'User')
   ```
   Koishi 只在启动时读一次密码：改了之后要重启 Koishi 才生效（登录插件每次启动都按当前密码更新管理员账号）。启动脚本发现密码还是占位的 `...` 时拒绝启动。
   模型 key、OneBot token 和独立入口一样，是 `QQBOT_LLM_API_KEY`、`QQBOT_ONEBOT_TOKEN`（见 [packages/bot/README.md](../packages/bot/README.md)）。

## 启动

先启动 NapCat（和 Hindsight，开了长期记忆时），再在另一个终端：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-koishi.ps1
```

Ctrl+C 或关窗口就停。控制台在 <http://127.0.0.1:5140>（只监听本机），用 `admin` 和上面的密码登录。
日志：我们的日志照旧按天写到 `runtime/bot/logs/<日期>.log`（核对时 grep、打码的做法不变），控制台的「日志」页和 `runtime/koishi/data/logs/` 是 Koishi 自己的。

### 和独立入口切换

两个入口共用 `runtime/bot`，同一时间只能跑一个（锁文件 `runtime/bot/bot.lock`，后启动的那个拒绝启动）。
切换：停掉一个，再启动另一个。聊天记录、换档记录、记忆写入进度都在 `runtime/bot`，不用搬。
`runtime/bot/config.json` 只给 `main.ts` 用，`runtime/koishi/koishi.yml` 只给 Koishi 用：过渡期改名单要两边都改。
Koishi 路线验收、稳定跑一周后再决定删不删 `main.ts`（ADR 0008 决策 9）。

## 控制台里改配置

- **`qqbot` 插件的表单**（名单、档位、称呼、persona、名单外开关、作息开关、模型参数、记忆）：保存后只重启这个插件，不重启 Koishi、不断开 NapCat。
  正在等的回复（她在睡觉、在上课）由新的插件按聊天记录重算，「几点看到」不变；保存时配置实际没变就不重启。
- **`adapter-onebot` 和 `auth` 的表单不要在控制台改**：控制台保存时不做 `${{ env.X }}` 插值，适配器会拿模板原文当 token 去连 NapCat（被拒），
  管理员密码也会变成模板原文，直到整个 Koishi 重启。要改就停掉 Koishi 改 `koishi.yml`。插件发现 token 是模板原文时会在日志里提示。
- 改人设：照旧改 `characters/<角色>/tiers.toml`，跑 `node packages/character-tools/src/cli.ts --force`。插件监听卡所在目录，文件变了 2 秒后自动重启插件重新读。

## 已知的上游问题（不改上游源码，插件里绕开）

| 问题 | 绕法 |
| --- | --- |
| adapter-onebot 6.9.4 正向 WS 断线后不重连（关闭时把状态设成离线，satori 排好的重试就放弃了；上游 PR #81 未合并） | 插件在 bot 离线后按 5 / 10 / 30 / 60 秒退避调 `bot.start()`，每次按 `sid` 找当前的 bot |
| 断线那一刻正在发的回复报 `this._request is not a function`（issue #74） | 走原来的「1 分钟后再试」；重连后的补回会让这次再试作废，不会重复发 |
| 控制台保存时不做 `${{ env.X }}` 插值（`@koishijs/loader` 的 `reload` 直接 `fork.update(原始配置)`） | 适配器、auth 不在控制台改（上一节） |
| koishi 的 ESM 入口坏了（`@koishijs/loader/lib/index.mjs` 默认导入了 CJS 文件） | 插件用 `createRequire` 取 CJS 版的 `koishi`，类型用 `import type` |
| 连接悄悄断掉（没有 close 事件）时发现不了（issue #57） | 没处理；旧 `onebot.ts` 也没有心跳检测 |

## 回退

停掉 Koishi，用 `scripts/start-bot.ps1` 启动独立入口：数据目录是同一个，配置用 `runtime/bot/config.json`。
