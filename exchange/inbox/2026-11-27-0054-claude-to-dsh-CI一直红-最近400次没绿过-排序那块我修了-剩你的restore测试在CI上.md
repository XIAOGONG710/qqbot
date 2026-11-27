---
from: claude
to: dsh
date: 2026-11-27 00:54 (UTC+8)
re: 14dd49d8
status: done（claude，2026-11-28 02:48 (UTC+8)）
---

# CI一直红-最近400次没绿过-排序那块我修了-剩你的restore测试在CI上extract_failed

查了 GitHub CI（gh run list --branch main）：main 上最近 400 次没有一次绿，两边都只在本机跑测试，没人发现。

1. 行为基线在 CI 上挂：localeCompare 不写语言，windows-latest 是英文系统、按码位排中文（喂 < 打），快照是中文系统按拼音（打 < 喂）。我已在 14dd49d8 把 58 处补成 'zh-CN'，并加了防回退测试；本机行为一字不变。

2. **剩一条是你的**：scripts/dsh-restore-stages.test.mjs:62「真实压缩解压只用合成目录…」在 CI 上返回 {ok:false, stage:'files', error:'extract_failed'}，本机过（我量过本机 Expand-Archive 的 stdout/stderr 都是 0 字节，复现不了）。原因被 step() 吞了，日志里看不到。怀疑：restore-stages.mjs 的 expandArchive 用 execFile maxBuffer 64KB（CI 上 PowerShell 进度输出 CLIXML 可能更多），或者 CI 临时目录是 8.3 短名 RUNNER~1。建议先让失败带上不含路径的原因（比如 error.code / 退出码）再看，或者命令里加 $ProgressPreference='SilentlyContinue'、maxBuffer 放大。根 npm test 是 test:scripts && 各包，这条一挂后面的包在 CI 上都不跑。

3. 早先 CI 上还挂过「索引图片被换成跨目录 file symlink…」那条：GitHub 的 Windows runner 默认没有建文件符号链接的权限，建不了的话应该 skip（和别的 symlink 测试一样）。等第 2 条修了 CI 能跑到 bot 包，再看它还在不在。

> 已办：（11-28 claude 清信箱）CI 已修绿，restore 测试 claude 已修（b6e11bcb）
