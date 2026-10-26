# 2026-10-27 00:5x DSH：Hindsight 在本机装好了（长期记忆重新启用）

- 用户 10-27「Hindsight，把这个装好」。
- 结果：Hindsight **已在本机跑起来**，bot 的长期记忆从「未启用」变成「Hindsight http://127.0.0.1:8888」。

## 怎么装的（没重新下载，复用已验证的安装）

| 件 | 值 |
| --- | --- |
| venv | `C:\Users\22601\Desktop\astrbot创建\runtime\hindsight\venv`（Python 3.12，hindsight-api-slim 0.10.2，--require-hashes 装的） |
| 在 worktree 里的入口 | junction：`qqbot-dsh-control\runtime\hindsight` → 上面那个目录（不复制、不占第二份） |
| PostgreSQL | pg0 自带 18.1，实例名 `qqbot-hindsight`，端口 5433；**数据目录新建** `C:\qqbot-hindsight\pgdata`（ASCII 路径，避开中文路径的 pg0 bug） |
| 嵌入 / 检索 | ONNX `intfloat/multilingual-e5-small`（384 维）+ PGroonga（TokenBigram，中文关键词） |
| LLM | DeepSeek `deepseek-flash`，关思考，key 用 `QQBOT_LLM_API_KEY` |
| API | `http://127.0.0.1:8888`，`/health` → `{"status":"healthy","database":"connected"}` |
| 页面 | `http://127.0.0.1:8888/docs`（OpenAPI）、`/mcp` |

启动命令：`scripts/start-hindsight.ps1`（本次带 `QQBOT_PGDATA=C:\qqbot-hindsight\pgdata`）。

## 验证（本机实跑）

1. `/health` healthy，PostgreSQL 5433 在听，pgroonga 扩展装好；
2. 建一个临时 bank `dsh-selftest`，retain 一条 → recall 拿到（semantic 0.92 / keyword 2.0），**证明写入和召回都通**；测完已删掉那个 bank；
3. 重启 Koishi 后日志：`长期记忆：Hindsight http://127.0.0.1:8888（名单里的联系人；公共记忆库 linmengyao-common，陌生人档不写不查）`。

## 顺带补的运维

`C:\Users\22601\qqbot-local\watchdog.ps1` 现在每分钟看三样：8888（Hindsight）、5140（Koishi）、3001（NapCat）；前两个掉了自动拉起，NapCat 掉了只记一行（要扫码）。登录自启 `…\Startup\qqbot-local.cmd` 指向它。

## 还没解决的

- **VM 的旧记忆没有拷过来**：本机是全新的 `C:\qqbot-hindsight\pgdata`，bank 会从零开始；VM 上那份（真实历史）仍封存着，要接回来得把 VM 的 Hindsight 数据 dump/restore 过来——VM 从本机不可达（ping 100% 丢、3389 不通），只能用户在 VM 侧导出。
- 本机这份 Hindsight 跑在 DSH 的后台任务里；watchdog 只在“用户登录后”才守，**没有开机自启登录**（要 Windows 密码）。
- 长期记忆开着 = 每次聊天会多调 DeepSeek 抽取，成本略增；关掉就把 `memory.enabled` 设 false。
