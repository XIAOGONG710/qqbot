# 2026-11-19 没人用的导出（只读审查，没删）

- 范围：`packages/bot/src` 的导出值（不含类型），看 `src`、`koishi-plugin-qqbot/src`、`scripts/`、`test/`、`sim/` 里有没有别处用。
- 起因：10-31 指令收敛、11-19 删掉 app.ts 里走不到的指令分支（cf6c3336、1926d502）之后，一批库函数没了调用方。
- 方法：按词边界逐个搜索导出名，再全仓搜一遍排除 `node_modules`；`git log -S` 查最后一个调用方什么时候没的。抽查 8 条（`addSoulRating` `FEEDBACK_NO_TURN` `sizeOf` `contrastHit` `characterTerms` `canPublishExternal` `dshStateFresh` `TRACES_WINDOW_MS`）确认只在定义它的文件里出现。
- 盲点：不同文件里同名的导出会互相遮住，只会漏报，不会误报。
- **同日稍后删了 A 组（除 `addSoulRating` `dshStateFresh`）和 D 组**（用户：「先多开几个子代理，把你手头上的活先完成」）：连同只为它们存在的私有辅助、import 和只测它们的测试用例；41 个基线场景逐字不变，全量测试通过。
  B 组和 `addSoulRating` 跟用户 11-19 定的「`ownerPeek` 开关留着、SOUL 打分先不动」相关，没删；C、E 组是做好还没接线的功能，没删；`dshStateFresh` 可能给 DSH 那边读，没删。
- 删完新冒出来的：`social/external-platforms.ts` 的 `externalPlatformCapability` 没人调了；`interpreter.ts` 里 `Module` 的 `review?` 字段没有模块实现（只剩 `createInterpreter` 筛选时读它，要改线上代码，没动）。
  **11-20 两个都删了**：没有调用方 / 没有实现，删掉不改任何行为；`npm run baseline:fast` 41/41 逐字一致。
- 不在清单里的：只在本文件里用、只是多写了 `export` 的（约 365 个，抽查过是真在用）；只被 scripts 或 Koishi 插件用的（是活的）。

## A. 哪里都没人用（src、测试、脚本都没有，本文件里也没用）

| 位置 | 名字 | 说明 |
|---|---|---|
| `platform/soul-rating.ts:18` | `addSoulRating` | `/好 /一般 /差`，最后调用方 1926d502 删；`ratingSummary` 只读 10-31 前的分数（用户：先不动） |
| `language/speech-feedback.ts:126` | `FEEDBACK_NO_TURN` | `/像AI /像真人` |
| `language/speech-check.ts:242` | `contrastHit` | 调用方 10-30 删（141fa0e7） |
| `life/everyday.ts:199` | `DRAMA_EVENT_DEFS_FOR_TESTS` | 名字说给测试用，测试也没用 |
| `life/traces.ts:17` | `TRACES_WINDOW_MS` | |
| `memory/dormancy.ts:246` | `sizeOf` | |
| `social/qzone-feed.ts:142-143` | `QZONE_LIKE_ACTIONS` `QZONE_COMMENT_ACTIONS` | |
| `social/group-impression.ts:64` | `impressionInput` | |
| `social/external-platforms.ts:70` | `canPublishExternal` | |
| `character-terms.ts:30` | `characterTerms` | |
| `dsh-state-export.ts:45` | `dshStateFresh` | 也许是给 DSH 那边读的，本仓库里没人 import |
| `emotion/felt-then.ts:23` | `FELT_AT_HOUR` | |

## B. 只有测试在用：调用方是今天删掉的指令分支

| 指令 | 位置和名字 |
|---|---|
| `/像AI /像真人` | `language/speech-feedback.ts`：`parseFeedbackCommand` `lastTurn` `recordFeedback` `feedbackReceipt`（不再有新反馈写入；`loadFeedback` `recentFeedback` 仍在读旧的） |
| `/说话习惯` | `language/speech-feedback.ts` `describeFeedbackForOwner`；`language/speech-notes.ts` `describeNotesForOwner` |
| `/说话趋势` | `language/speech-trend.ts` 整个文件（`speechTrend` `describeTrend`），只剩 `modules.ts` 文件清单和测试提到它 |
| `/心境` | `emotion/feeling-review.ts` `describeFeelingsForOwner` |
| `/自我认识` | `life/diary-insights.ts` `describeInsightsForOwner` |
| `/追求` | `life/self-pursuits.ts` `describeForOwner` |
| `/亲热` | `language/intimacy.ts` `armIntimate` `intimateRemaining`；`takeIntimateLine` 仍接在 app.ts，但没人能再设计数，只有旧的 `intimacy.json` 里还有剩余次数时才会出一句 |
| `/主动` | `ProactivePlanner.fireNow()`（`proactive/proactive-planner.ts`），只有 `proactive-now`、`proactive-planner-review` 两个测试调 |

## C. 整个文件没人 import（只在 `modules.ts` 文件清单和测试里）

大多是「先做好、还没接线」的，不是这次删指令删出来的：

- `bilibili/bilibili-inbox.ts`、`bilibili/bilibili-limit.ts`（提交说明写着「未接线」）、`bilibili/bilibili-schema.ts`、`bilibili/bilibili-asr.ts`
- `life/expression-judgement.ts`、`social/official-adapter.ts`（`publishExternalDraft`）、`world/evidence-registry.ts`（`resolveWorldEvidence`）、`world/information-sources.ts`（`informationObservationEvent`）

## D. 只有测试在用：重构时最后一个调用方没了

- `life/her-days.ts` `describeMood`（f813a3ad，11-18；心情 10-30 起不进提示词）
- `life/pursuits.ts` `describePursuits`（32746ee5，11-16，提交说明自己说是死代码）
- `social/group-chat.ts` `recentGroupBrief`（7eace634，11-18）
- `interpreter/interpreter.ts` `runTurn`（3737bc65 拆成感知 / 判断 / 出力三步后没人调）、`reviewTurn`（src 里一直没人调）
- `interpreter/slots.ts` `ALL_SLOTS`（只有一条测试断言）
- `bilibili/bilibili.ts` `videoNewsCard` `videoShareCard`（10-27 改成发封面 + 链接）

## E. 写好以来就只有测试在用（预备的功能，优先级最低）

`emotion/felt-then.ts` `feltThen`、`language/asks.ts` `idleHint`、`language/exemplars.ts` `looksCopied`、
`life/actions.ts` `availableActions` `typedOccupation`（注释说留给以后的选择器）、`life/now-export.ts` `nowFresh`、
`memory/owner-bank.ts` `readOwnerBank`、`platform/modules.ts` `moduleOf`、`social/group-import.ts` `hasHistory`、
`world/external-sources.ts` `validExternalSourceConfig`、`world/weather-evidence.ts` `observedWeatherEvent`、
`world/npc-asks.ts` `npcAsksBetween` `describeAsk`、`world/world.ts` `worldLogger`、
`language/memes.ts` `saveMemes`（src 改用 `replaceMemes`；`docs/reviews/repro/memory-meme-author-race.mjs` 还在用）
