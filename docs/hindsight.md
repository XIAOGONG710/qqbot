# Hindsight（长期记忆服务）

按 [ADR 0004](adr/0004-time-scheduling-memory.md) 决策 3，bot 的长期记忆用 [Hindsight](https://github.com/vectorize-io/hindsight)（MIT）。
服务装在 `runtime/hindsight/`（不入库），只监听本机；bot 通过 HTTP 调用（`packages/bot/src/memory/`）。

## 组成

| 部分 | 版本 / 来源 | 位置 |
| --- | --- | --- |
| Python | 3.12.15，`uv python install 3.12`（uv 自带下载校验） | `%APPDATA%\uv\python\` |
| hindsight-api-slim | 0.10.2（PyPI），extras `embedded-db`、`local-onnx` | `runtime/hindsight/venv/` |
| PostgreSQL | 18.1.0，pg0-embedded 0.15.2 自带（含 pgvector） | 程序在 `%USERPROFILE%\.pg0\installation\`，数据在 `runtime/hindsight/pgdata/`（仓库路径含中文时在 `%LOCALAPPDATA%\qqbot-hindsight\pgdata\`，见下文「本机安装记录」第 2 条） |
| embedding | `intfloat/multilingual-e5-small`（多语言，384 维，ONNX，Hugging Face） | `runtime/hindsight/hf/` |
| 抽取用的模型 | DeepSeek `deepseek-flash`，关思考，key 同 bot（`QQBOT_LLM_API_KEY`） | — |
| 重排 | `rrf`（不用模型） | — |
| 关键词检索 | PGroonga 4.0.9（Groonga 16.1.1），`TokenBigram`；Hindsight 的 `pgroonga` 后端 | 解压进 pg0 的 PostgreSQL（`%USERPROFILE%\.pg0\installation\18.1.0\`），安装包和文件清单在 `runtime/hindsight/pgroonga/` |
| 网页面板（可选） | `@vectorize-io/hindsight-control-plane` 0.10.2（npm，自带 Next.js 16.3.4 standalone 服务） | `runtime/hindsight/control-plane/` |

依赖用 `scripts/hindsight/requirements.txt` 固定版本和哈希（195 个包，`uv pip compile --generate-hashes` 生成，不含 torch）。
安装前核对过：`hindsight_api_slim-0.10.2-py3-none-any.whl` 的 SHA-256 `5f05c101…5f7f64`、`pg0_embedded-0.15.2-py3-none-win_amd64.whl` 的 `1b47c938…50d3e`
都与 PyPI JSON API 公布的一致，锁文件里也是这两个值；安装用 `--require-hashes`。

## VC++ 运行库

pg0 自带的 PostgreSQL 和 onnxruntime 1.30 都是用新版 MSVC 编译的，在 14.40 以前的 `msvcp140.dll` 上一用 `std::mutex` 就访问冲突（0xC0000005）：
initdb 失败、hindsight-api 一启动就崩。这台机器原来的系统 `msvcp140.dll` 是 14.36（2023 年），Windows 事件日志里出错模块是
`C:\WINDOWS\SYSTEM32\MSVCP140.dll` 14.36.32532.0。

**现在（2026-10-04 起）**：用户装了最新的 VC++ 2015–2022 运行库。System32 里的 `msvcp140*.dll`、`vcruntime140*.dll`、`concrt140.dll` 都是 14.44.35211，
Microsoft 签名有效，注册表 `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64` 是 v14.44.35211.00。
启动脚本先检查系统 `msvcp140.dll` 不低于 14.40，太旧就直接报错，不等 PostgreSQL 崩。

**之前的权宜做法已撤掉**：当时不改系统，从微软官方 `vc_redist.x64.exe`（`https://aka.ms/vs/17/release/vc_redist.x64.exe`，14.44.35211，签名为 Microsoft Corporation）
里解出运行库（不安装）：`msvcp140*.dll` 放在 `runtime/hindsight/vcruntime/`，由 venv 里的 `qqbot_vcruntime.pth` 在环境变量 `QQBOT_VCRUNTIME_DIR` 存在时
（启动脚本会设）先加载；`msvcp140.dll`、`vcruntime140.dll`、`vcruntime140_1.dll` 复制到 `%USERPROFILE%\.pg0\installation\18.1.0\bin\`（postgres.exe 优先用同目录的）。
这些 DLL 和 `.pth` 都挪到了 `runtime/hindsight/archive-vcruntime-20261004/`（没删，放回原处就能恢复），启动脚本也不再设这个环境变量。

**验证（10-04 23:24 重启 Hindsight 后）**：PostgreSQL 的 15 个进程和加载了 onnxruntime 的 Python 进程，`msvcp140` / `vcruntime140` 都从 `C:\WINDOWS\SYSTEM32\` 加载
（Python 发行版自带的 `vcruntime140*.dll`、numpy 自带的 `msvcp140-*.dll` 是它们自己的，不是这里复制的）；`/health` 正常；事件日志没有新的崩溃；
模拟器 `boyfriend-memory`（临时 bank）4 项检查全过：抽取、中文绰号「铁锅」召回、偏好变化召回、Hindsight 停了照常回复。

## PGroonga（中文关键词检索）

**为什么要装**：Hindsight 默认的关键词检索用 PostgreSQL 的 `english` 分词，中文一整串连在一起算一个词。
10-04 实测（尾号 73 的 bank，约 60 条记忆）：记忆里有「宝宝的组长外号叫「铁锅」」，查「铁锅」「铁锅 是谁」都排第 1，
查「铁锅是谁」「铁锅今天又找我茬了」却完全召回不到（`budget` 调到 `mid` 也只排第 31–46）。bot 的召回查询是「她上一句 + 对方这次的几条」，
绰号总是夹在句子里，等于只剩 embedding；`multilingual-e5-small` 对这种生僻绰号很弱。模拟器里同样的用例能过，是因为测试 bank 只有十来条记忆。
Node 自带的 `Intl.Segmenter` 把「铁锅」切成「铁 锅」，在 bot 这边分词也不可靠。Hindsight 支持的 `pgroonga` 后端用二字切分（`TokenBigram`），两边都能对上。

**来源核对（2026-10-04）**：`pgroonga-4.0.9-postgresql-18-x64.zip`（GitHub release `pgroonga/pgroonga` 4.0.9，2026-09-23 发布）

- SHA-256 `84ba7b60…188f09` 与 GitHub 公布的附件 digest 一致；`.asc` 的 SHA-256 `e42c9665…30c30c5` 也一致。
- GPG 签名验证通过（`Good signature`），签名密钥 `2701 F317 CFCC CB97 5CAD E9C2 624C F774 3483 9225`。这把钥匙的身份从两处独立核对：
  Groonga 官方软件源 `https://packages.groonga.org/centos/RPM-GPG-KEY-34839225` 里是同一指纹，UID「Groonga Key (Groonga Official Signing Key) <packages@groonga.org>」；
  keys.openpgp.org 按指纹查到的也是同一把（2018-01-29 创建）。验证用的是临时 GPG 目录，没有导入用户的钥匙环。
- pg0 自带的是 EDB 的 PostgreSQL 18.1（安装目录里有 `StackBuilder`），正是 PGroonga Windows 包的目标环境。

**安装**：把 zip 解压进 pg0 的 PostgreSQL 目录（PGroonga 文档的做法）。601 个文件全是新增，没有覆盖 PostgreSQL 原有文件；
清单在 `runtime/hindsight/pgroonga/files.txt`，卸载就按清单删。装好后在临时数据库里 `CREATE EXTENSION pgroonga`，
按 Hindsight 的查询方式（`pgroonga_tokenize` + `TokenBigram` + `NormalizerNFKC150`，词之间 `OR`，`&@~`）试过：
「铁锅是谁」「铁锅今天又找我茬了」都能找到含「铁锅」的那条，「帮我想想等会喝什么奶茶」找到说奶茶的那条。临时数据库已删。

**切换**：启动脚本设 `HINDSIGHT_API_TEXT_SEARCH_EXTENSION=pgroonga`，没装 PGroonga 时直接报错。
**记忆表里有数据时 Hindsight 拒绝换检索后端**（`ensure_text_search_extension`：要么清空，要么换回原来的）。10-04 切换的步骤：

1. `pg_dump -Fc` 备份到 `runtime/hindsight/backup/hindsight-20261004-before-pgroonga.dump`（2 个 bank、160 条记忆）。
2. 停 bot；用 API 删掉两个 bank；bot 的写入记录挪到 `runtime/bot/memory/archive-20261004-pgroonga/`。
3. 重启 Hindsight：建 `pgroonga` 扩展，`memory_units`、`mental_models` 的检索索引变成 pgroonga，`search_vector` 变成占位的 text 列。
4. 启动 bot：按聊天记录重新建 bank、重新写入所有片段（每个片段调一次 DeepSeek）。

**切换后实测（10-04 21:43，尾号 73 重建的 bank，90 条记忆，`budget` low、`max_tokens` 600）**：

| 查询 | 切换前（native） | 切换后（pgroonga） |
| --- | --- | --- |
| 「铁锅是谁」 | 没召回 | 第 2 |
| 「铁锅今天又找我茬了」 | 没召回 | 第 8（共 13） |
| bot 的查询格式：她上一句 + 对方这句 | 没召回 | 第 10（共 12） |
| 「组长今天又找我茬了」 | 没召回 | 第 5 |
| 「我现在还爱吃甜的吗」→ 以前爱喝全糖那条 | — | 第 3 |

10 个片段重新写入后 1 分钟内抽取完，没有失败的任务。

**回退**：停 Hindsight，启动脚本里去掉 `HINDSIGHT_API_TEXT_SEARCH_EXTENSION`（回到 `native`）；同样要先清空记忆表（或者用上面的备份 `pg_restore`），
bot 的写入记录也要一起清掉让它重写。

## 启动

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-hindsight.ps1
```

脚本先确认 pg0 实例 `qqbot-hindsight`（127.0.0.1:5433）在运行，再在当前终端前台跑 API（127.0.0.1:8888），Ctrl+C 停止时一起停掉 PostgreSQL。
第一次启动会下载 embedding 模型（约 470 MB）。健康检查：`http://127.0.0.1:8888/health`。

启动顺序：NapCat → Hindsight → bot。bot 的 `runtime/bot/config.json` 里有 `memory` 段才会用；Hindsight 没开时 bot 照常回复，日志里记写入 / 召回失败。

## 网页面板（Control Plane）

用来浏览每个 bank 的事实、观察和关系概况。只是查看工具，bot 不依赖它。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\hindsight\install-control-plane.ps1   # 装一次
powershell -ExecutionPolicy Bypass -File .\scripts\start-hindsight-ui.ps1                # 先开着 Hindsight，再开这个
```

浏览器打开 `http://localhost:9999`，Ctrl+C 停止。

- 来源核对（2026-10-04）：npm tarball `hindsight-control-plane-0.10.2.tgz` 的 SHA-256 `ede0825a…a7d6c4` 与 GitHub release
  `vectorize-io/hindsight` v0.10.2 里同名附件公布的 digest 一致；sha512 / sha1 与 npm registry 的 `dist.integrity` / `shasum` 一致；
  registry 签名（key `SHA256:DhQ8wR5A…`）验证通过。这个包没有 npm provenance 证明。安装脚本固定版本和 SHA-256，下载后先核对再解压。
- 包里自带构建好的 standalone 服务和它用到的 `node_modules`，启动入口 `bin/cli.js` 只运行 `standalone/server.js`，
  所以不跑 `npm install`（`package.json` 里列的 42 个依赖是构建用的，运行时用不到），也不跑任何安装脚本。
- 查过打包后的代码：没有统计上报或第三方请求，外部地址只是页面上的文档链接；启动脚本另外关掉了 Next.js telemetry。
  面板的服务端代为请求 Hindsight API，浏览器只连面板。
- **只监听本机**：面板默认监听 `0.0.0.0`，启动脚本改成 `127.0.0.1`（它实际以 `localhost` 绑定并固定解析到 IPv4）。
  实测只有 `127.0.0.1:9999` 在监听，用本机局域网地址连不上。
- 包里的图片处理库 sharp 只带 Linux 版，但面板的图片都是静态文件，没有用到它。
- **不要在面板里改 mission**：bank 的 mission 由 bot 设定（`packages/bot/src/memory/long-term.ts`），只在代码里的 mission 变了时才重新写入，
  面板里的修改不会同步回代码。删记忆、删文档同样会让 bot 本地的写入记录（`runtime/bot/memory/<QQ>-<档位>.json`）对不上。
- 升级：和 `requirements.txt` 里的 hindsight-api-slim 同步换版本，按上面的方法核对新 tarball 后改安装脚本里的版本和 SHA-256。

## 从头安装

```bash
uv python install 3.12
uv venv runtime/hindsight/venv --python 3.12
uv pip install --python runtime/hindsight/venv/Scripts/python.exe --require-hashes -r scripts/hindsight/requirements.txt
```

先装最新的 VC++ 运行库（14.40 以上，需要管理员；启动脚本会检查），再运行启动脚本。pg0 第一次 `start` 会把 PostgreSQL 解压到 `%USERPROFILE%\.pg0\installation\`
并在 `runtime/hindsight/pgdata/`（仓库路径含中文时是 `%LOCALAPPDATA%\qqbot-hindsight\pgdata\`）建库；运行库太旧时这一步的 initdb 会失败。

## 验证记录（2026-10-04）

- 端口：PostgreSQL 只监听 `127.0.0.1:5433` 和 `[::1]:5433`，API 只监听 `127.0.0.1:8888`。
- 端到端（虚构联系人和编造的对话，不用真实聊天记录）：建库与 mission、关系概况 Mental Model、3 个片段写入都返回成功，
  后台抽取约 2 秒完成（8 条事实、7 条观察）。按调研方案 7.2 末段的中文用例召回：
  独特绰号（「煤球」）、偏好变化（以前爱吃甜、现在不吃）、否定句（不吃香菜）、相近事件（面试结果）、相对时间（「下周一入职」推算为 10 月 5 日）
  都排在第一条。测试 bank 已删除。
- 关系概况在建好时还没有记忆，内容为空；之后在新记忆整合完、且距上次刷新超过 30 分钟时刷新。

## 本机安装记录（2026-10-06，Windows 换机重装）

换一台机器重装时新增了四条坑，都在本机验证过。

### 1. Windows 防火墙要放行两个程序（且需要管理员）

Windows 防火墙对**没有允许规则的程序**是把入站连接**丢包**（不是拒绝），所以症状统一是「连接超时」：

| 程序 | 症状 | 处理 |
| --- | --- | --- |
| `%USERPROFILE%\.pg0\installation\<版本>\bin\postgres.exe` | `pg0 start` 走到 `Creating user 'hindsight'` 时报 `psql: connection to server at "127.0.0.1", port 5433 failed: Connection timed out`，随后 pg0 把实例回滚（`pg0 info` 查不到） | 加一条入站允许规则 |
| Hindsight 用的 Python 解释器（`%APPDATA%\uv\python\cpython-3.12*\python.exe`） | API 打出启动横幅后**不再输出、8888 不监听**；py-spy 栈停在 `asyncio` 的 `socket.py` → `_fallback_socketpair` → `accept()` | 同上，带版本号和不带版本号的目录各一条 |

```powershell
New-NetFirewallRule -DisplayName 'pg0 postgres (Hindsight)' -Direction Inbound `
  -Program "$env:USERPROFILE\.pg0\installation\18.1.0\bin\postgres.exe" -Action Allow -Profile Any

# 两条路径是因为 uv 装解释器时用了不带版本号的目录名
foreach ($p in "$env:APPDATA\uv\python\cpython-3.12.14-windows-x86_64-none\python.exe",
                "$env:APPDATA\uv\python\cpython-3.12-windows-x86_64-none\python.exe") {
    if (Test-Path $p) { New-NetFirewallRule -DisplayName "Hindsight python $(Split-Path (Split-Path $p -Parent) -Leaf)" `
      -Direction Inbound -Program $p -Action Allow -Profile Any }
}
```

Python 那条的机理：Windows 没有真正的 `socketpair`，asyncio 用「本地监听一个端口 → 连自己 → `accept()`」模拟自管道；
这一步的入站回环连接同样被丢包，`accept()` 永不返回，**uvicorn 连端口都还没绑上**，日志就停在启动横幅。

**为什么原本没遇到**：手动在终端第一次跑 `start-hindsight.ps1` 时 Windows 会弹「是否允许访问网络」，点允许就自动建了规则；
用计划任务、隐藏窗口等方式启动不会弹框，于是静默超时。`New-NetFirewallRule` 在非管理员下报 `Access is denied`。

### 2. pg0 的数据目录不能用非 ASCII 路径

仓库放在含中文的路径（如 `…\Desktop\astrbot创建\`）时，`pg0 start -d <仓库>\runtime\hindsight\pgdata` 报：

```
Error: IO error: stream did not contain valid UTF-8
```

对照实验（同日）：同一条命令，`-d C:\hindsight-pgdata`（纯 ASCII）一次成功，含中文的路径必失败。
`scripts/start-hindsight.ps1` 因此按顺序选数据目录：设了 `QQBOT_PGDATA` 用它；仓库路径是纯 ASCII 时仍用 `runtime/hindsight/pgdata/`；
否则用 `%LOCALAPPDATA%\qqbot-hindsight\pgdata`。选出的路径含非 ASCII 字符（比如 Windows 用户名是中文）就直接报错说明原因。
（10-06 推上来的第一版不分情况一律改到 `%LOCALAPPDATA%`：仓库在纯 ASCII 路径、数据已经在 `runtime/hindsight/pgdata/` 的机器上，
下次启动会连到一个空库，看起来像记忆全丢了；当晚改成上面的顺序。）这是同一族问题的第三次（前两次：NapCat 从中文路径启动挂不上、PowerShell 5.1 按 ANSI 读无 BOM 脚本）。

### 3. Hugging Face 走镜像

`huggingface.co` 在某些网络下直接返回 502（连 API 也是）。设 `HF_ENDPOINT=https://hf-mirror.com` 即可。
模型下完落在 `runtime/hindsight/hf/`，之后启动不再需要镜像。

### 4. PyPI 也要镜像，否则 `uv pip install` 会拖到几十分钟

官方源实测 25 分钟只下了 80.9 MB（仍未装完）；换清华源后**约 1.5 分钟**装完 195 个包：

```powershell
uv pip install --python runtime\hindsight\venv\Scripts\python.exe --require-hashes `
  --default-index https://pypi.tuna.tsinghua.edu.cn/simple -r scripts\hindsight\requirements.txt
```

`--require-hashes` 照常生效（镜像与官方是同哈希的同名文件）。

### 两处与本文档的出入

- **嵌入模型不是 470 MB**：`snapshot_download('intfloat/multilingual-e5-small')` 会拉 43 个文件共 **2174.6 MB**
  （`pytorch_model.bin` 448.9 MB + `model.safetensors` 448.8 MB + ONNX / OpenVINO 变体各一份）。
  Hindsight 只用其中一部分，多下的不影响运行；磁盘紧时只保留 ONNX 那份即可。Windows 上 `huggingface_hub` 建不了符号链接，会用副本占更多空间（无害的警告）。
- **`pg0 start` 在管道里不会返回**：它启动的 postgres 继承了 stdout 句柄，`pg0 start … | Select-Object` 这类管道永远等不到 EOF，看起来像卡死。
  重定向到文件或不用管道就正常（启动脚本里本来就是直接调用）。

## 已知限制

- 关键词检索按两个字一切（PGroonga `TokenBigram`），查询里的每个二字词都参与打分，「今天」「找我」这类常见词也会给别的记忆加分，
  所以夹在句子里的绰号虽然能召回，常排在第 8–10 条；bot 注入召回结果的上限因此从 8 条放宽到 12 条（`MAX_RECALLED`）。
- 聊天记录里删掉的片段，Hindsight 里对应的文档不会自动删（调研方案 T17）；要删时用 `DELETE /v1/default/banks/{bank_id}/documents/{document_id}`。
- 每个片段写入时 Hindsight 调一次 DeepSeek 抽取，进行中的片段每多 30 条整段重写一次。
