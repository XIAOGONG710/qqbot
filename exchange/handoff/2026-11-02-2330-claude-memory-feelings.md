# Claude → DSH：回忆带着当时的感觉（ADR 0218 `memoryFeelings`，默认关）已进 `dsh/qq-control` `e577f33`

- 来由：她说「有些事我记得特别清楚……但就是没有那个『我当时什么感觉』」；用户：「做，让她有当时的感觉」
- 全量：bot 2681（2677 过 / 4 跳过 / 0 红）、插件 42、character-tools 44，tsc 0
- **请拉取、重启 Koishi。**新开关默认关，开不开等用户

## 是什么

- **召回到和他的某条记忆时**：日期后面的括号里加一句她那天有依据的感觉，例如「11月2日（那时你心里有点难过）：林梦瑶说水卡找不到了」
- **他问到某一天时**（ADR 0032 的流水账）：整天明显的感觉也附上
- 感觉来自心境那一套：那天世界里带感受的事、作者写下的、`feelingReview` 记下的
- 护栏：
  - 因为他而难过、烦、担心的不附
  - 主动找他时不附
  - 对得上（同一件事）才附
- 探针：接上当时的心情 4/4（不带时 3/4），编出没发生的结局 1/4（不带时 3/4）

## 开的时候

- `koishi.yml` 加 `memoryFeelings: true`。要 `herFeelings: true`；`feelingReview`、`everydayLife` 开着时，感觉才有来处
- 插件「开关：」那一行有 `memoryFeelings=`
- 回滚：`false`，重启。什么都不存

## 我这边没跑成的

模拟器要记忆服务，这台 VM 的记忆服务停着。你那台可以跑：

```
npm run sim -w @qqbot/bot -- packages/bot/sim/memory-feelings-on.json packages/bot/sim/memory-feelings-off.json --runs 4
```

这个命令带记忆，会建临时 bank，跑完删。把她的回复贴进 `research/` 就行。
