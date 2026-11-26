# CLAUDE.md

**规则、结构、指令收敛这些跟 `AGENTS.md` 是同一份，以 `AGENTS.md` 为准。** 这个文件只记 Claude 那台机器的环境实测值；
同一份规矩写两遍等于每轮前缀付两遍钱，所以不复述了。

## 环境（这台）

- Git 以 `where git` 为准（这台 2026-11-27 实测：`C:\Program Files\Git`，git 2.56.0.windows.4；Git Bash 里 `where git` 先列出 `ucrt64\bin\git.exe`）。
- Node.js v24.22.0 LTS（npm 12.2.1；这台 2026-11-27 实测），官方 MSI 安装到 `C:\Program Files\nodejs`（2026-10-18 安装，PATH 中实际解析到这份）；以 `node --version` / `npm --version` 为准。SillyTavern 要求 Node `>= 20`。
  `node.exe` 的 Authenticode 签名有效（OpenJS Foundation）；安装包的 SHA-256 与 `SHASUMS256.txt` 及其签名**未核对**。升级前先核对 SHA-256 与 `SHASUMS256.txt` 一致、`SHASUMS256.txt.sig` 由 nodejs/node README 所列 release key 签名有效，再安装。
- GitHub CLI v2.103.3，官方 `gh_2.103.3_windows_amd64.zip` 解压到 `%LOCALAPPDATA%\Programs\gh`（`bin\` 已加入用户 PATH，新终端生效；这台 2026-11-27 实测 `where gh` 能找到、v2.103.3）。
  安装前核对过：zip 的 SHA-256（`98d0cfa7…0a22e0`）与 GitHub Release 资产摘要、官方 `checksums.txt` 三者一致；`gh.exe` 的 Authenticode 签名有效（GitHub, Inc.）。登录账号须是 XIAOGONG710（令牌存于 Windows 凭据管理器）。
- 从 Claude / Codex 桌面应用里的命令写到 `AppData` 下的文件和用户 PATH 会被应用隔离，普通终端里看不到；装到 `AppData` 下的工具要在用户自己的终端里装。
- 长期记忆服务 Hindsight 装在 `runtime/hindsight/`（Python 3.12 由 uv 安装），来源核对、VC++ 运行库的处理和启动方法见 `docs/hindsight.md`。
