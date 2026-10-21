# 量化工具（measure）

2026-10-21/22 做“更像人”那一轮时写的一次性脚本，原来在会话临时目录里，会话一结束就没了；放这里，下次一条命令就能复测。
**只出数字或挑出来的句子，不改任何东西。** 路径是这台机器上写死的（线上数据 `C:/Users/XG/Desktop/Project/qqbot/runtime/bot/chats/2260168937.jsonl`、真人样本
`qqbot-exchange/exchange/research/2026-10-real-chat/`、模拟输出 `qqbot-claude2/runtime/sim/<批次>/`），换机器要改。
真人样本只有 120 轮（女方一侧）、偏冲突片段，任何比例都有几个点的误差，别读得太细。

| 脚本 | 看什么 | 用法 |
| --- | --- | --- |
| `live-bubbles.cjs` | 线上她每天每轮发几条、每条多长、带问号的比例、她先开口的轮次 | `node live-bubbles.cjs` |
| `bubble-dist.cjs` | 每轮条数分布：真人女生 / 男生样本 vs 模拟批次 | `node bubble-dist.cjs "标签=批次目录,批次目录" …`（目录用相对 `runtime/sim` 的路径） |
| `filler-stats.cjs` | “废话”占比：笑 / 语气词 / 应声 / 无聊类，整轮都是废话、首条、含废话 | `node filler-stats.cjs "标签=批次目录,…"`，线上用 `标签=live:<chats 目录>` / `liveuser:<目录>` |
| `laugh-attached.cjs` | 带笑 / 拖音 / 语气词收尾 / 感叹 / 省略号 / 表情的轮次占比（线上他和她、真人、模拟批次） | `node laugh-attached.cjs "标签=批次目录,…"` |
| `tail-topic.cjs` | “无关的结尾条”：≥2 条的轮次里最后一条和他上一轮没有共同两字词、也不是问句（她答完后另带一件事的宽松尺子） | `node tail-topic.cjs "标签=批次目录,…"` |
| `agenda-stats.cjs` | DSH 的四个数：自带议程 / 带问句 / 只应一声 / 安抚词 | `node agenda-stats.cjs 批次目录…` |
| `agenda-when.cjs` | 真人什么时候带自己的事：按他上一轮是不是问句、多长切开 | `node agenda-when.cjs` |
| `agenda-turns.cjs` / `filler-turns.cjs` / `split-turns.cjs` | 把提示词里带“自己的事 / 废话 / 分成 N 条”的轮次挑出来，看他的话和她的回复 | `node xxx-turns.cjs 批次目录…` |
| `filler-examples.cjs` | 真人样本里的废话轮次和它的上文 | `node filler-examples.cjs` |
| `content-stats.cjs` / `mirror.cjs` / `show-pairs.cjs` / `shape-compliance.cjs` | 首条气泡的内容占比；她和他的字数对照；成对挑句子；形状计划有没有被遵守 | 见各文件头 |
| `check-sysmsg.mjs` | 只读：她的 B 站号的系统通知 / 未读数 / 会话列表（风险检查用，不打印凭证） | `node check-sysmsg.mjs` |
| `crisis-probe.mjs` | 危机检测的 29 句探针（DSH 的复核），看有几句和预期不符 | `node crisis-probe.mjs` |

批次目录的写法：`./20261021-203823-replay-int-a` 这样的相对路径（先 `cd qqbot-claude2/runtime/sim`）。Git Bash 里不要给带逗号的 `/c/…` 绝对路径（会被改写）。
