# NapCat 运行包（Windows）

按 [ADR 0001](adr/0001-repository-structure.md) 决策第 3 条，NapCat 用官方 Release 构建产物，放在 `runtime/napcat/`（不入库）。

## 当前安装（2026-10-03）

| 项 | 值 |
| --- | --- |
| 包 | `NapCat.Shell.Windows.Node.zip`，[v4.18.28](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.28)（作者 github-actions[bot]） |
| SHA-256 | `fb64fa3b036ad2df1a5d7c204c482694c20e4b763978c8a4968fd3474c05b4a8`，与 GitHub Release 资产摘要一致 |
| 程序目录 | `runtime/napcat/NapCat.Shell.Windows.Node-v4.18.28/` |
| 数据目录 | `runtime/napcat/workdir/`（`NAPCAT_WORKDIR`：`config/`、`logs/`、`cache/`） |

为什么选 `Shell.Windows.Node` 而不是 `Shell`：本机没装 QQ NT。`Shell.Windows.Node` 里自带 CI 从 QQ 安装包抽出的运行文件和 `node.exe`，
不用安装 QQ（打包过程见 `vendor/NapCatQQ/.github/workflows/release-publish.yml` 的 `assemble-windows-node`）。
`Shell.Windows.OneKey` 是从另一个资源仓库直接拷贝的，不是 CI 构建的，不用。

### 来源核对

- QQ 的文件（`wrapper.node` 及各 DLL）：Authenticode 签名有效，签名者 Tencent Technology (Shenzhen) Company Limited。
- `node.exe`：Authenticode 签名有效，签名者 OpenJS Foundation。
- NapCat 自己的二进制（`QQNT.dll`、`napcat/NapCatWinBoot*`、`napcat/native/**`，均未签名）以及 `napcat.bat`、`index.js`：
  与子模块 v4.18.28 tag 下仓库里的同名文件逐字节一致。
- `napcat/*.mjs` 等 JS 产物由官方 CI 构建，只能靠 Release 摘要保证。

### 补丁：缺 `crypto.dll` 和 `ssl.dll`

官方包启动即报 `Error: The specified module could not be found. ...\wrapper.node`，上游 [#2069](https://github.com/NapNeko/NapCatQQ/issues/2069) 同一问题，截至 2026-10-03 未解决。

原因：读 `wrapper.node` 的 PE 导入表，它依赖 `crypto.dll`、`ssl.dll`（QQ 自带的 OpenSSL），
而 CI 抽取 QQ 文件的固定清单（`QQ_TARGETS`）里没有这两个。

处理：从 CI 用的同一个 QQ 安装包里取出这两个文件，放进程序目录：

1. 安装包 `QQ_9.9.31_260528_x64_01.exe`（工作流里的 `QQ_URL`，托管在第三方仓库 `Rodert/qq-versions`）：
   SHA-256 `0beb5cb4ff776cba822caa0abadbd53f5892f12628a86dabea1b372c82c086bc`，与工作流锁定的 `QQ_SHA256` 一致；安装包本身有有效的腾讯签名。
2. 用 7-Zip 26.03（作者官方仓库 `ip7z/7zip` 的 Release，摘要已核对）解出 `Files/versions/9.9.31-49738/resources/app/` 下的文件：
   其中 `wrapper.node` 与 NapCat 包里的逐字节一致，证明是同一构建。
3. `crypto.dll`（`2a143d94…f5f3`）和 `ssl.dll`（`fbadd7a2…965c`）均有有效的腾讯签名；它们的依赖只有系统 DLL 和彼此。

升级 NapCat 时先看新包是否已经带上这两个文件，没带就按上面的步骤补。

## 配置

`runtime/napcat/workdir/config/`：

- `onebot11.json`：只开一个 WebSocket 服务端，`127.0.0.1:3001`，`messagePostFormat: array`，`reportSelfMessage: false`，设了 token。
  NapCat 首次登录后会另存一份 `onebot11_<QQ 号>.json`，之后以那份为准。
- `webui.json`：WebUI 只监听 `127.0.0.1:6099`（默认是 `::`，会暴露到局域网）。WebUI 的登录 token 在 NapCat 启动日志里。

OneBot token 同时存在用户环境变量 `QQBOT_ONEBOT_TOKEN` 里，bot 从这里读取。

## 启动

```powershell
.\scripts\start-napcat.ps1
```

首次启动会在控制台打印登录二维码（`workdir/cache/` 下也有图片），用小号的手机 QQ 扫码。
