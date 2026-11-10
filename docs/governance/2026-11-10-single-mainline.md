# 只留一条主线（2026-11-10，用户确认后已执行，结果见文末）

用户 11-10：两台电脑改一个项目，仓库主线不清、提交混乱。要求：**只有一条主线，两台电脑的提交都在同一个地方，其余全部去掉。**
这份是方案，确认后照“执行步骤”做；做完把结果补在文末。

## 现状（11-10 本机清点，`git fetch --prune` 之后）

| 远程分支 | 指向 | 情况 |
| --- | --- | --- |
| `dsh/qq-control` | `fd6eb8ec` | DSH 线，线上在跑的代码；11-10 已把 main 的迁移合进来 |
| `merge/main-into-dsh` | `fd6eb8ec` | 和上面是同一个提交，两个名字 |
| `main` | `0088af3a` | GitHub 默认分支；11-09 起不再是工作线，但 11-10 又在上面提交了 8 个（已全部合进 DSH 线） |
| `exchange` | `230134f7` | 交接笔记：10-08 起和代码线分开的另一段历史，523 个提交，691 个文件只在这里（几乎都在 `exchange/` 下） |
| `voice/natural-speech` | `b72d0ed6` | 音色实验：6 个提交不在任何代码线里（ChatTTS + RVC 的 worker、训练集生成、实验记录） |
| `memory-hardening-1105` | `9b6d08ff` | 已全部在 DSH 线里 |

本机另有：`main` 上 1 个没推的提交（`8820f43c`，按 main 旧代码写的心境方案，在 DSH 线上不适用，见 ADR 0336「再合一次 main」）；
三个工作目录（`qqbot` 在 main、`qqbot-merge` 在 DSH 线、`qqbot-consolidation-1105`）。另一台电脑上的本地分支和工作目录本机看不到。

乱的根源：

- **两条代码线各自往前走**，靠合并对齐（11-06、11-09、11-10 三次），每次都要换 ADR 编号（main 的 0263 在 DSH 线上是 0336）、重做基线快照。
- **主线和默认分支不是一个**：GitHub 默认是 `main`，实际工作线是 `dsh/qq-control`；在哪台电脑、哪个工作目录开工，就提交到哪条线（11-10 这次就提交错了地方）。
- **同一个东西有好几个名字**（`dsh/qq-control` / `merge/main-into-dsh`），还有一条和代码无关的长期分支（`exchange`）。
- **“不自动推送”**让两台电脑可以很久不同步，分叉越积越大。

## 目标

1. 只有一条分支：**`main`**。两台电脑都只在它上面提交、推送；GitHub 默认分支就是它（现在已经是）。
2. 其余分支（远程、本机、另一台电脑）全部删掉。没合进 `main` 的先打归档标签再删，历史不丢、需要时能找回。
3. 每台电脑只留一个工作目录，就在 `main` 上。
4. ADR 只有一个编号序列，接着现在最大的号往下编，不再有“main 独有的移到 03xx”这类换号。

## 主线用哪份代码

**`main` 快进到 DSH 线（`fd6eb8ec`）**。理由：

- DSH 线是两条的并集：main 的全部提交都已经合进来（`origin/main` 是 `fd6eb8ec` 的祖先），所以是**快进，不用强推**，任何提交都不丢。
- 线上跑的就是 DSH 线；切到 `main` 后代码一个字节不变。
- 名字用 `main`：已经是默认分支，各种工具、克隆默认都用它。

本机 `main` 上没推的 `8820f43c` 丢弃（过时；为什么没合已经记在 ADR 0336）。

## 其余分支怎么处理

| 分支 | 处理 |
| --- | --- |
| `dsh/qq-control`、`merge/main-into-dsh` | `main` 快进后和 `main` 相同 → 直接删 |
| `memory-hardening-1105` | 已全部在主线里 → 直接删（连同本机工作目录 `qqbot-consolidation-1105`） |
| `exchange` | 打标签 `archive-2026-11-10/exchange` 后删。以后的交接不再单开分支，写在 `main` 的 `docs/handoff/` 里（**待确认**） |
| `voice/natural-speech` | **待确认**：合进 `main`（音色实验的代码和文档进主线），或者打标签 `archive-2026-11-10/voice-natural-speech` 后删 |

已有的标签（`stable-2026-10-27`、`archive-2026-10-27/*` 等）不是分支，留着。

## 执行步骤（用户确认后做）

1. **另一台电脑先做**：把本地所有没推的提交推上来，推到 `dsh/qq-control` 上（`git status`、`git log origin/dsh/qq-control..` 都为空才算推完），告诉这边推完了。**这一步之前本机不删任何东西。**
2. 本机：`git fetch --prune`；如果 `dsh/qq-control` 上有新提交，先接上（快进或合并），跑全量测试和行为基线。
3. 本机：`main` 快进到 DSH 线：`git push origin dsh/qq-control:main`（远程会拒绝非快进，所以不可能误删提交）。打标签 `stable-2026-11-10`。
4. 本机：给 `exchange`（和不合的 `voice/natural-speech`）打归档标签并推送标签。
5. 本机：删远程分支 `dsh/qq-control`、`merge/main-into-dsh`、`memory-hardening-1105`、`exchange`、`voice/natural-speech`。
6. 本机：工作目录 `qqbot` 切到 `main` 并对齐 `origin/main`；删掉工作目录 `qqbot-merge`、`qqbot-consolidation-1105` 和本地其余分支；`git fetch --prune`。
7. **另一台电脑**：先确认没有没推的改动；`git fetch --prune`、`git switch main`、`git reset --hard origin/main`；删掉本地其余分支和多余的工作目录。
   线上 bot 跑在这台：切换前后是同一个提交，代码不变；`runtime/` 不在 Git 里，不受影响。之后线上只跑 `main`。
8. 改 `CLAUDE.md` / `AGENTS.md`：写上下面的规矩（其中“提交后推送”改掉了原来的“不自动推送”，**待确认**），提交、推送。

## 以后的规矩（两台电脑）

- **只在 `main` 上提交**，不开新分支，不开第二个工作目录。
- **开工前先拉**：`git pull --rebase`，拿到另一台的提交再动手。
- **做完一项就推**：测试 → 提交 → `git pull --rebase` → `git push`。推送被拒就再 `pull --rebase`，**不强推**。历史保持一条直线，不做合并提交。
- **同一块代码同一时间只让一台改**：开工前在交接里说一声（`docs/handoff/` 里写“我在改 X”）。
- **线上只跑 `main`**（DSH 那台），部署前 `git pull`。
- 需要试的东西：在本机改着不提交，或者小步提交到 `main`；要真开分支，用完当天合回、删掉。

## 要用户定的

1. `voice/natural-speech`：合进主线，还是归档后删？
2. `exchange`：归档后删、以后交接写进 `main` 的 `docs/handoff/`，可以吗？
3. 规矩里把“不自动推送”改成“做完一项就推送”，可以吗？
4. 方案整体同意后，先让另一台电脑做第 1 步，推完告诉这边，再执行其余步骤。

## 用户的决定（11-10）

1. 声音模块（`voice/natural-speech`）：另一台电脑还在做、没完成，不用推。远程分支归档后删；那边本地接着做，做完直接接到 `main` 上提交（见下面“另一台电脑”）。
2. `exchange`：只要固定一条主线、统一提交就行 → 归档后删。交接写在 `main` 里（`docs/handoff/`），不再单开分支。
3. 打开自动推送：做完一项就推到 `origin/main`（已写进 `CLAUDE.md` / `AGENTS.md`）。
4. 另一台电脑最近只在做声音模块，没有别的要推，不用等它推完再整理。

## 执行结果（11-10，本机）

- `main`：`0088af3a → deb3e579` 快进（不是强推），内容就是原来的 DSH 线。GitHub 默认分支本来就是 `main`。
- 归档标签：`archive-2026-11-10/exchange`（→ `230134f7`）、`archive-2026-11-10/voice-natural-speech`（→ `b72d0ed6`）。
- 删掉的远程分支：`dsh/qq-control`、`merge/main-into-dsh`、`memory-hardening-1105`、`exchange`、`voice/natural-speech`。**远程只剩 `main`。**
- 本机：只剩一个工作目录 `C:UsersXGcodeqqbot`、一个分支 `main`；删了工作目录 `qqbot-merge`、`qqbot-consolidation-1105` 和本地分支
  `merge/main-into-dsh`、`memory-hardening-1105`、`voice/natural-speech`；main 上过时的本地提交 `8820f43c` 丢弃。
- 整理完打标签 `stable-2026-11-10`。

## 另一台电脑要做的

它本地的分支还在（远程删了不影响本地），声音模块的改动不会丢。按顺序：

1. `git fetch --prune`（远程的 `dsh/qq-control` 等会从列表里消失）。
2. 线上 bot 用的工作目录：确认没有没提交的改动后 `git switch main`（新建时 `git switch -c main --track origin/main`）、`git pull --rebase`。
   代码和原来的 `dsh/qq-control` 最新一版相同，加上这份整理的提交；`runtime/` 不在 Git 里，不受影响。
3. 声音模块：留在本地分支上接着做；**做完**之后 `git rebase origin/main`，再并到 `main`（`git switch main && git merge --ff-only <那个分支>`），测试、推送，然后删掉那个本地分支。
   在那之前不推它。
4. 删掉别的本地分支和多余的工作目录（先 `git log origin/main..<分支>` 看一下，有东西没进 `main` 的先问用户）。
5. 以后照上面“以后的规矩”做。
