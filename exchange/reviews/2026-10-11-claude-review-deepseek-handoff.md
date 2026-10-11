# Claude 复审：`DEEPSEEK_HANDOFF.md`（`39c7144`，GPT / Codex，10-11 20:20）

- 时间：2026-10-11 20:40；复审人：Claude，在 VM 上，能看线上 `runtime/`
- 范围：全文 322 行；逐条对了仓库文件、live `koishi.yml`、进程和日志
- **20:50 已按本复审改进原文件**（用户要求）：`main` = `integration` = `3427a4e`（分支 `docs/deepseek-handoff-review`），只改文档；线上目录没动（`behind 1`，下次上线时随 ff 跟上）

## 结论

骨架是好的：工作流、记录格式、隐私边界、「代码已实现 / 影子 / 上线」分开说，这几块都对。引用的 9 个文件都在。「7 个联系人档位」也对（6 档 + 名单外）。

但有 **3 件不补会在这台机器上直接出事的事（P0）**，还有 **4 处事实已经过期（P1）**。改完再交给 DS。

## P0：不补会出事

1. **没写线上在哪台机器。** 线上是 VMware 虚拟机（192.168.139.138）上的 `C:\Users\XG\Desktop\Project\qqbot`：Koishi :5140、NapCat :3001、Hindsight :8888。用户联想主机上的是旧拷贝：`runtime/` 是旧的，`koishi.yml` 还是 10-06 的（记忆关着），NapCat 是 pipe 模式。10-10 DSH 和 Codex 都在那台上把「服务挂了」「记忆关着」当成了线上。主机也连不到这台 VM。第 7.1 节第 2 问把这件事当成要问用户的，应该**直接写死**，并规定：凡是报告线上状态，都要写明是在哪台机器上看到的。

2. **第 8.1 节的 Git 流程会直接改线上。** `Desktop/Project/qqbot` 这个目录**就是**线上实例：
   - Node 24 直接跑 TS 源码
   - 服务守护 `scripts/services-watchdog.mjs` 发现 Koishi 不在，就用这棵树把它拉起来
   - Koishi 插件监视 `characters/linmengyao/st/`（`packages/koishi-plugin-qqbot/src/index.ts:460`），卡一改就热部署

   所以在这里 `git switch -c deepseek/...`、改文件、跑 `npm run convert`，都等于上线。应该改成：**只在自己的 worktree 里干活**（`git worktree add ../qqbot-ds-<slug> -b deepseek/<slug> origin/main`，`node_modules` 用 junction，删 worktree 前先 `cmd /c rmdir` 掉 junction）。live 树只读，只有用户点头上线时才 fast-forward `main`。

3. **上线 / 重启流程没提服务守护。** 守护每 60 秒查一次，连续两次查不到 Koishi 就自己拉起，10 分钟最多 3 次。手动停 Koishi 之前不建 `%TEMP%\qqbot-maintenance`，它会和你抢。第 5.3 节应写成：
   1. 建维护目录 `%TEMP%\qqbot-maintenance`
   2. live 树 `git status -sb`，看清分支和改动
   3. 停 Koishi：supervisor `koishi/bin.js` 和它的 worker 都要停
   4. ff `main` → push
   5. `Start-Process powershell -File scripts\start-koishi.ps1`
   6. 看 `runtime/koishi/data/logs/<日期>-N.log`，要有「NapCat 账号 … 已就绪」
   7. 删维护目录

   NapCat 要关**整个窗口**，不能只杀 node：`start-napcat.ps1` 发现 NapCat 退出会自己再拉起。

## P1：事实过期或不准

4. **第 0 节、3.1 没说 `2ba6df2` 已经上线。** 它是 12:30 cherry-pick 进 live `main` 的，Koishi 12:39 重启后跑的就是它（GPT 自己在 exchange `3a25f37` 里写了 "hotfix live at 2ba6df2"）。文中只写「当前 HEAD 另含……修正」，DS 会以为它没上线。

5. **3.1「ADR 0057……相机日状态已对齐」和第 109、122 行「0058 / 0059 仍需真模型回归」都不对：**
   - 相机日 16:35 那条主动消息**没发出去**：VM 12:15–19:52 解析不了外网域名，生成失败后「不再试」，这件事就丢了。影子账 12:36–18:00 也是空的。详见 `exchange/handoff/2026-10-11-2030-claude-camera-day.md`。不能写「已对齐」
   - 0058 / 0059 的真模型 `--no-memory` **已经跑过**（10:55 交接）：`boyfriend-intimacy` 26/26 ×2、`boyfriend-banter` 14/15 ×2、`photo-ask` 38/38 ×2。真正没做的是：这两个场景发的就是卡里示例左边那句，量的是她抄没抄。要换成卡里没有的同类说法再跑一遍

6. **P2 第 1 条「查明 lifeInPrompt、projectChoice、autonomousLife 的实际线上值」现在就能写。** live `runtime/koishi/koishi.yml` 里：
   - `memory.enabled: true`（用户 10-10 23:15 裁决：保持开）
   - `autonomousLife: true`（影子模式）
   - `vision.enabled: true`
   - `lifeInPrompt`、`projectChoice` 没写，即默认 `false`
   - `realWeather` 没写，即默认 `true`

7. **第 0 节第 11 行的 `--ignore-submodules=all` 是 Codex 沙箱自己的限制。** 这台 VM 上普通 `git status` 就能用。应该写明「沙箱里才需要」。

## P2：DS 要是在 VM 上跑，必须知道

8. **内存。** VM 只有 6 GB。Hindsight 约 1.7 GB，模拟和线上共用同一个 Postgres。
   - 全量测试用 `node --test --test-concurrency=1`，并且拿 `%TEMP%\qqbot-heavy.lock`（mkdir / rmdir）
   - 模拟一次只跑一批
   - 带记忆的模拟（`memory: true`）不能和 ChatGPT 应用同时开：10-07、10-09 都把线上 Postgres 挤爆过

   第 5.1 节只写了 `npm test`，不够。

9. **三方协作没写。** `exchange` 分支只在来源里提了一句 `docs/exchange-protocol.md`。DS 至少要知道：
   - 交接写在 `exchange/handoff/`（worktree `qqbot-exchange`）
   - 不在别人的 worktree 里切分支（`qqbot-integration` 归 Codex）
   - `integration` 用 `git branch -f integration <sha>` 加 push 来移动
   - DSH 是谁、在哪台机器

10. **用户裁决的入口没写。** 应写明：
    - `docs/research/2026-10-06-dsh/author-replies.md`：作者裁决优先于「推荐方案」
    - 几条不在仓库里的：回复用中文；她发真照片（照片池或生成图），用户 10-11 说先推迟，不要再提

11. **第 7 节要先问 5 个问题，太多了。** 用户 10-06 说过「直接开始暴力推进」，只问只有用户知道的事。第 2 问按 P0-1 写死后可以删；第 3、4、5 问合成一句。

## 小处

- 文件放在仓库根目录、进了 `main`。只是文档，不影响运行。下次改版建议挪到 `docs/handoff/`，并在 `docs/roadmap.md` 里指一下
- 第 6 节「QQ 号用占位符」比 exchange README 的数据约定严（那边按授权保留 QQ 号和原文）。对外部模型严一点是对的，建议写明：exchange 里按 README，发给 DeepSeek API 的按本节
- 测试基线 738（bot 670 / character-tools 40 / plugin 28）我**没重跑全量**。数字和 10:55 的 669 加上 `2ba6df2` 新增的测试对得上

## 建议加进第 11 节的复核行

| 日期 | 维护者 | 变更 | 复核 |
| --- | --- | --- | --- |
| 2026-10-11 20:40 | Claude（VM） | 复审：P0 三条（线上机器、live 树即线上、服务守护）、P1 四处事实更正、P2 四条补充 | `exchange/reviews/2026-10-11-claude-review-deepseek-handoff.md` |
