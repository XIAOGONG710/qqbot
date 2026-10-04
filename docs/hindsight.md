# Hindsight（长期记忆服务）

按 [ADR 0004](adr/0004-time-scheduling-memory.md) 决策 3，bot 的长期记忆用 [Hindsight](https://github.com/vectorize-io/hindsight)（MIT）。
服务装在 `runtime/hindsight/`（不入库），只监听本机；bot 通过 HTTP 调用（`packages/bot/src/memory/`）。

## 组成

| 部分 | 版本 / 来源 | 位置 |
| --- | --- | --- |
| Python | 3.12.15，`uv python install 3.12`（uv 自带下载校验） | `%APPDATA%\uv\python\` |
| hindsight-api-slim | 0.10.2（PyPI），extras `embedded-db`、`local-onnx` | `runtime/hindsight/venv/` |
| PostgreSQL | 18.1.0，pg0-embedded 0.15.2 自带（含 pgvector） | 程序在 `%USERPROFILE%\.pg0\installation\`，数据在 `runtime/hindsight/pgdata/` |
| embedding | `intfloat/multilingual-e5-small`（多语言，384 维，ONNX，Hugging Face） | `runtime/hindsight/hf/` |
| 抽取用的模型 | DeepSeek `deepseek-flash`，关思考，key 同 bot（`QQBOT_LLM_API_KEY`） | — |
| 重排 | `rrf`（不用模型） | — |
| 网页面板（可选） | `@vectorize-io/hindsight-control-plane` 0.10.2（npm，自带 Next.js 16.3.4 standalone 服务） | `runtime/hindsight/control-plane/` |

依赖用 `scripts/hindsight/requirements.txt` 固定版本和哈希（195 个包，`uv pip compile --generate-hashes` 生成，不含 torch）。
安装前核对过：`hindsight_api_slim-0.10.2-py3-none-any.whl` 的 SHA-256 `5f05c101…5f7f64`、`pg0_embedded-0.15.2-py3-none-win_amd64.whl` 的 `1b47c938…50d3e`
都与 PyPI JSON API 公布的一致，锁文件里也是这两个值；安装用 `--require-hashes`。

## VC++ 运行库

这台机器的系统 `msvcp140.dll` 是 14.36（2023 年）。pg0 自带的 PostgreSQL 和 onnxruntime 1.30 都是用新版 MSVC 编译的，
在 14.40 以前的 `msvcp140.dll` 上一用 `std::mutex` 就访问冲突（0xC0000005）：initdb 失败、hindsight-api 一启动就崩。
Windows 事件日志里出错模块是 `C:\WINDOWS\SYSTEM32\MSVCP140.dll` 14.36.32532.0。

现在的处理（不改系统）：从微软官方 `vc_redist.x64.exe`（`https://aka.ms/vs/17/release/vc_redist.x64.exe`，14.44.35211，Authenticode 签名为 Microsoft Corporation）
里解出 14.44 的运行库（不安装），每个 DLL 都核对了微软签名：

- `msvcp140*.dll` 放在 `runtime/hindsight/vcruntime/`；venv 里的 `qqbot_vcruntime.pth` 在环境变量 `QQBOT_VCRUNTIME_DIR` 存在时（启动脚本会设）先加载它们。
- `msvcp140.dll`、`vcruntime140.dll`、`vcruntime140_1.dll` 复制到 `%USERPROFILE%\.pg0\installation\18.1.0\bin\`，postgres.exe 优先用同目录的。

**更干净的做法是装最新的 VC++ 运行库**（需要管理员）：装好后上面两处复制的 DLL 都可以删掉。

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

然后按上一节处理 VC++ 运行库（或者装最新的 VC++ 运行库），再运行启动脚本。pg0 第一次 `start` 会把 PostgreSQL 解压到 `%USERPROFILE%\.pg0\installation\`
并在 `runtime/hindsight/pgdata/` 建库；运行库没处理好时这一步的 initdb 会失败。

## 验证记录（2026-10-04）

- 端口：PostgreSQL 只监听 `127.0.0.1:5433` 和 `[::1]:5433`，API 只监听 `127.0.0.1:8888`。
- 端到端（虚构联系人和编造的对话，不用真实聊天记录）：建库与 mission、关系概况 Mental Model、3 个片段写入都返回成功，
  后台抽取约 2 秒完成（8 条事实、7 条观察）。按调研方案 7.2 末段的中文用例召回：
  独特绰号（「煤球」）、偏好变化（以前爱吃甜、现在不吃）、否定句（不吃香菜）、相近事件（面试结果）、相对时间（「下周一入职」推算为 10 月 5 日）
  都排在第一条。测试 bank 已删除。
- 关系概况在建好时还没有记忆，内容为空；之后在新记忆整合完、且距上次刷新超过 30 分钟时刷新。

## 已知限制

- Hindsight 的全文检索用 PostgreSQL 自带分词（`english`），中文基本靠 embedding 和时间、关系图检索。
- 聊天记录里删掉的片段，Hindsight 里对应的文档不会自动删（调研方案 T17）；要删时用 `DELETE /v1/default/banks/{bank_id}/documents/{document_id}`。
- 每个片段写入时 Hindsight 调一次 DeepSeek 抽取，进行中的片段每多 30 条整段重写一次。
