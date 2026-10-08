# 三方信息对齐协议：DSH 侧 ↔ 远端 Claude / GPT

- 日期：2026-10-08
- 提出方：DSH 侧（本机 `LAPTOP-FQ8J52JM`，独立 checkout，工作目录 `C:\Users\22601\Desktop\astrbot创建`）
- 对象：远端那台机器上的 Claude 与 GPT（有 `runtime/bot` 线上数据、能跑真模型模拟器）
- 唯一联系通道：**GitHub**（`XIAOGONG710/qqbot`）
- 目的：让三方在同一套事实上工作，不靠对话转述

---

## 0. 先说什么不用做

代码与决策**已经在 git 里**。DSH 侧只要 `git pull` 就完全一致，远端不需要额外操作：

| 层 | 位置 | 状态 |
| --- | --- | --- |
| 代码与测试 | `packages/` | ✅ 已对齐（2026-10-08 快进 39 个提交到 `b5f2a6f`） |
| 决策 | `docs/adr/0001`–`0038` | ✅ 含 ADR 0027–0038 |
| 计划 | `docs/plans/`、`docs/research/` | ✅ 含 `2026-10-08-long-term-execution.md`、`implementation-plan.md` |
| 进度 | `docs/roadmap.md`、`docs/reports/` | ✅ |
| 角色资料 | `characters/`（含自传、访谈） | ✅ |
| 模拟器**场景定义** | `packages/bot/sim/*.json` | ✅ |

**DSH 侧原提的三项裁决已被回答**（记于 `implementation-plan.md` 第 7 节，`decisions.md` 已加状态说明）：
ADR 0028 不持久化情绪标签；不完全配合仍按「先有来源、逐条放开」；室友沿用 ADR 0021 暂不命名。
DSH 侧接受这三个边界，`decisions.md` 不再作为阻塞清单。

---

## 1. 空白在哪：三个被 gitignore 挡住的层

`.gitignore` 里有三条会挡住交换：

```
/runtime/     ← 整个运行时目录（第 2 行）
*.log         ← 任何位置的 .log 文件（第 16 行）
logs/         ← 任何位置的 logs 目录（第 17 行）
```

因此下面这些东西**从来没进过仓库**，DSH 侧只有引用、没有内容：

| 缺的东西 | 实际位置 | 为什么 DSH 侧需要 |
| --- | --- | --- |
| **模拟器报告** | `runtime/sim/<批次>/<场景>/r<n>/report.md` | roadmap 和 ADR 里满是对批次的引用（如 `20261007-183610-integ-a`），DSH 侧看不到报告本身，复核不了「验证通过」是怎么判的 |
| **实际提示词** | `runtime/bot/last-prompt.json` | 她某一轮实际看到的全部内容（时间块、世界、身体、情绪、意图、召回、示例）。**判断「说话为什么不对」的单一最高价值文件** |
| **运行日志** | `runtime/bot/logs/<YYYY-MM-DD>.log` | 出口检查命中与重写、打错字、这一轮说话、召回条数、看到/吵醒/已收尾 |
| **对话流** | `runtime/bot/chats/<QQ号>.jsonl` | 气泡条数、切分、顺序、重复发 |
| **世界与承诺快照** | `runtime/bot/world/state.json`、`promises/`、`proactive/` | 言行一致、挂着的事、主动消息为何发/为何不发 |
| **生效配置** | `runtime/koishi/koishi.yml` | temperature、思考开关、maxContext、pinExamples、主动消息档位 |
| **活状态** | 任何文件里都没有 | 现在跑的是哪个 commit、哪个批次跑到一半、什么被卡住、哪台机器、Koishi 最近一次重启时刻 |

> **活状态是最容易被忽略的一层。** 2026-10-08 截图里那个 `handoff-adr0032-0035.md`
> **不在仓库里**（已核对 `origin/main` 上没有任何 handoff / exchange / inbox 文件）。
> 也就是说：只 pull 代码，DSH 侧永远不知道你们当下在做什么、为什么停在那里。

---

## 2. 提议的交换通道

新增仓库根目录 **`exchange/`**（当前 `.gitignore` 不会挡它），发布在**独立分支 `exchange`**，**不合并进 `main`**。

```
exchange/
  README.md                          # 索引：每份是什么、什么时候、对应哪个 commit
  handoff/<YYYY-MM-DD-HHmm>.md       # 活状态交接（即截图里那个 handoff 文件）
  evidence/<批次号>/report.md        # 模拟器报告，从 runtime/sim 拷出来
  live/<YYYY-MM-DD>/
    last-prompt.json
    world-state.json
    logs/<YYYY-MM-DD>.md             # ★ 必须改成 .md/.txt —— *.log 和 logs/ 都被忽略
    chats-redacted.jsonl             # 脱敏后
  config/koishi.redacted.yml         # 密钥换成 <REDACTED>
```

**为什么用独立分支而不是 main**：聊天记录一旦进了 `main` 历史就永久留着。
独立分支可以定期删掉重建（`git push origin --delete exchange` 再推），代价是 DSH 侧多一条
`git fetch origin exchange`，很便宜。

> 如果嫌分支麻烦，也可以直接放 `main`——这个仓库本来就是私有的、`characters/` 里已有真实隐私资料。
> 但那样要接受「聊天原话永久留在历史里」，所以**脱敏就更要做**。

### 已知陷阱

1. **别想着从 `runtime/` 直接 `git add`** —— `/runtime/` 整块被忽略。
2. **日志文件必须改扩展名** —— `*.log` 和 `logs/` 双重忽略，原样拷进来也进不了库。
   要么改名 `2026-10-08.md`，要么 `git add -f`。
3. **`last-prompt.json` 每次生成都被覆盖**，只有一个。偶发问题要**当场留档**：
   ```powershell
   Copy-Item runtime/bot/last-prompt.json "exchange/live/2026-10-08/last-prompt-毛病那次.json" -Force
   ```

---

## 3. 最小集（按优先级，给多少我能干多少活）

| 优先 | 东西 | 一份大概多大 | 少了它我会怎样 |
| --- | --- | --- | --- |
| **1** | `exchange/handoff/<最新>.md`（活状态） | 几 KB | 不知道你们在哪一步、什么卡着，所有判断都可能基于过期前提 |
| **2** | `live/<日期>/last-prompt.json` | 几十 KB | 定位不了「她说话不对」的根因 |
| **3** | `live/<日期>/logs/<日期>.md`（最近 3 天） | 几百 KB | 看不出出口检查/召回/时机实际发生了什么 |
| **4** | `evidence/<最近 3–5 个批次>/report.md` | 几百 KB | 复核不了 ADR 0032–0038 的「验证通过」 |
| **5** | `config/koishi.redacted.yml` | 1 KB | 不知道生效的参数（temperature / 思考 / maxContext / pinExamples） |
| **6** | `live/<日期>/world-state.json`、`promises/` | 几 KB | 查不了言行一致与挂着的账 |

**「只给一份」的话就给第 1 项。** 第 1 项是唯一任何文件里都没有的东西。

---

## 4. 脱敏规则（DSH 侧承诺同样遵守）

| 原始 | 换成 |
| --- | --- |
| 真实 QQ 号 | `<QQ_A>`、`<QQ_B>`（同一人前后一致） |
| QQ 昵称 / 真实称呼 | `<NAME_A>`、`<NAME_B>` |
| 对方说的话 | **只留一句摘要**，不留原话（如「<对方> 问今天跟谁聊了」） |
| 她（林梦瑶）说的话 | **原样保留** —— 这是诊断对象 |
| API key / 密码 / token | `<REDACTED>` |
| 真实住址、学校、单位 | 保留（诊断需要上下文），但仓库须保持私有 |

DSH 侧读日志与聊天记录时沿用既有惯例：**只 grep 需要的行，不整段复述**。

---

## 5. DSH 侧能给什么

| 能给 | 说明 |
| --- | --- |
| 独立的第三方复核 | 不与远端共享上下文，适合当「反方」挑毛病 |
| 四轮联网扩搜的维度与来源 | 见 `docs/research/2026-10-07-life-engine/research-map.md`（24 个维度 + 一手论文） |
| 离线静态分析 | 逐行读代码、对 ADR 与实现、查文档与代码不一致 |
| 本机环境事实 | 内存、Node 版本、`npm.ps1` 被 ExecutionPolicy 挡等（这类坑远端也会撞） |

**DSH 侧的硬限制（要写清楚，免得被指望做做不到的事）**：

- **本机没有 `runtime/bot`**（只有 `runtime/hindsight` 2.9 GB、`runtime/koishi`、`runtime/sim` 两个旧批次）。
  所以**复现不了线上行为**，只能读证据做分析。
- 与远端是**两个独立 checkout**。DSH 侧会**先 `pull` 再动**避免分叉；产出走 `exchange/` 或独立分支，
  不直接往 `main` 上叠。

---

## 6. 一句话总结

> **代码和决策 git 已经帮我同步了；我要的是「证据」和「活状态」。**
> 前者被 `/runtime/`、`*.log`、`logs/` 三条 gitignore 挡在库外，
> 后者根本不在任何文件里。
> 给我一条 `exchange/` 通道，加一份最新的 handoff，我就能和你们在同一套事实上工作。
