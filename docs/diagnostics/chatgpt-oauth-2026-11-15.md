# ChatGPT Windows 桌面端 OAuth 登录失败 —— 只读诊断报告

日期：2026-11-15 22:20 (UTC+8)
主机：Windows 11 家庭版 中文版 10.0.26100
应用：OpenAI.Codex 26.1111.2228.0（Microsoft Store / MSIX）
包族名：OpenAI.Codex_2p2nqsd0c76g0
代理：Clash Verge Rev，Mixed 7897，系统代理开，Global 模式，TUN 关

## 1. 症状

应用内点击登录 → Edge 打开 `http://127.0.0.1:1457/auth/callback?code=...`（部分尝试为 1455）
→ 浏览器 `ERR_CONNECTION_TIMED_OUT`。
ChatGPT 网页版同一时刻可正常使用。

## 2. 进程与端口

```
ChatGPT.exe 31076  (父 6156)   21:56:34
 ├─ ChatGPT.exe 38172/41908/10620/41136/27148/42544/5080/4036/21704 (渲染/工具进程)
 └─ codex.exe 41412  21:56:37
```

```
netstat -ano | findstr :1455
  TCP 127.0.0.1:1455 0.0.0.0:0 LISTENING 41412

Get-NetTCPConnection -OwningProcess 41412
  127.0.0.1:62342 → 127.0.0.1:7897  Established   （codex.exe 确实走系统代理）
  127.0.0.1:1455  → 0.0.0.0:0        Listen
```

监听存在，但：

```
Test-NetConnection 127.0.0.1 -Port 1455      → TcpTestSucceeded : False
python socket.connect(('127.0.0.1',1455), 3s) → TimeoutError 3.01s
python socket.connect(('::1',1455))           → ConnectionRefused 10061
```

连接超时说明 SYN 无人应答（不是连接被拒），且全程 `Get-NetTCPConnection` 里没有 ESTABLISHED / SynReceived 条目。

## 3. 对照组：同机回环正常

```
python 监听 127.0.0.1:1459 → 连接 CONNECTED 0.00s
Test-NetConnection 127.0.0.1 -Port 5140  → True
Test-NetConnection 127.0.0.1 -Port 3001  → True
Test-NetConnection 127.0.0.1 -Port 9880  → True
Test-NetConnection 127.0.0.1 -Port 9890  → True
```

结论：**回环网络本身正常**，只有应用自己的 1455/1457 不接受连接。

## 4. 排除项（均有命令输出）

| 方向 | 检查 | 结果 |
| --- | --- | --- |
| AppContainer 限制 | `TokenIsAppContainer`（P/Invoke GetTokenInformation 类 29） | ChatGPT.exe=NO、codex.exe=NO → **非容器应用，回环豁免无关** |
| 回环豁免列表 | `CheckNetIsolation.exe LoopbackExempt -s` | 空列表（据此排除“未加豁免”这一常见原因） |
| 防火墙 | `Get-NetFirewallRule -Direction Inbound` | ChatGPT 6 条规则均为 **Allow**，无 Block |
| 端口排除 | `netsh int ipv4 show excludedportrange protocol=tcp` | 无排除范围 |
| 端口占用 | `netstat -ano` | 1455 仅由 codex.exe 监听，无第三方抢占 |
| 代理拦截 localhost | `ProxyOverride` | 含 `localhost;127.*;<local>`；对照组回环正常 → 排除 |
| 系统时间/证书 | 系统代理与浏览器正常 | chatgpt.com 走代理返回 200 |

## 5. 决定性证据：应用日志

路径：
```
%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\Codex\Logs\2026\11\15\
codex-desktop-a98119f5-…-22836-t0-i1-135341-0.log
```

```
2026-11-15T13:53:46Z warning sa_server_request_failed "Workspace routing is unavailable"
2026-11-15T13:53:55Z info    response_routed method=account/login
2026-11-15T13:56:29Z info    remote_chatgpt_login_abort_requested loginId=9f858d72-…
2026-11-15T13:56:29Z info    remote_chatgpt_login_port_forward_stop_skipped trigger=aborted
2026-11-15T13:56:29Z info    remote_chatgpt_login_cancel_requested
2026-11-15T13:56:29Z info    account_login_completed success=false
2026-11-15T13:56:29Z info    app_server_connection.state_changed cause=stop_process
2026-11-15T13:56:29Z warning [IpcRouter] Socket error EPIPE
```

关键点：登录用的是 **`remote_chatgpt_login_port_forward`（远程端口转发到本地 1455）**，并非应用直接应答本地回调。
转发未建立（日志里 `port_forward_stop_skipped trigger=aborted`、`success=false`），因此**本地端口在监听但不 accept**，浏览器必然超时。

> 说明：13:56:29 的 abort 与当时对应用进程的重启操作在时间上重合，属本次诊断过程中的干扰项，不能单独作为“应用自身崩溃”的证据。

## 6. 上游诱因（旁证）

同一台机器、同一代理链路上，Codex CLI 设备码登录在换取 token 时返回：

```
Error logging in: device auth failed with status 504 Gateway Timeout
```

浏览器可打开网页，但**认证类接口在该免费代理节点上不稳定（504/TLS 抖动）**。
远端转发依赖与 OpenAI 认证端点的稳定连接，节点抖动 → 转发建不起来 → 本地回调端口不收连接。

## 7. 根因判定

**已确认的故障环节**：本地 OAuth 回调依赖的「远程端口转发」未建立成功；`127.0.0.1:1455` 处于 LISTEN 但不接受连接，导致浏览器回调超时。

**已排除**：AppContainer 回环限制、防火墙、端口冲突、系统代理劫持 localhost、回环网络故障、端口排除范围。

**最可能诱因（强旁证，未最终闭环）**：代理节点对 `auth.openai.com` 不稳定（实测 504），转发建立失败。

## 8. 最小化修复方案（未执行，待批准）

方案 A（不改系统配置）：
1. Clash Verge「代理」页把节点**手动固定**为已验证可过 chatgpt 的节点（本次候选：🇮🇹 意大利 IPV4 (8)，202.50.253.99:19999），关闭「自动选择」带来的节点漂移；
2. **不中途结束应用**，在应用内点击一次登录；
3. 登录期间实时采集：`Get-NetTCPConnection -LocalPort 1455` 是否出现 ESTABLISHED、`codex.exe` 到 `127.0.0.1:7897` 的隧道是否持续、日志里 `remote_chatgpt_login_port_forward` 是否出现 ready/established；
4. 回调页出现后不刷新、不关闭，等待自动完成。

影响范围：仅当前节点选择。
回滚：Verge「代理」页改回「自动选择」；代理配置已备份 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\profiles.yaml.bak-20261115`。

方案 B（A 失败时）：改用 API Key 方式（Codex `model_provider` + `env_key`），彻底绕开本机回调与代理稳定性要求。

## 9. 验证状态

**未验证**。修复未执行；验证结果待方案 A 完成后补录（判定标准：回调页正常返回、应用内显示已登录、`codex login status` 为已登录、且之后重启应用仍保持登录）。
