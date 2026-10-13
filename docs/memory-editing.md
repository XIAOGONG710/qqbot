# 改她的记忆

想改「她记得的事」，先分清是哪一层：她自己的设定、跟某个人聊出来的长期记忆（Hindsight）、提示词里的聊天原文，还有几份本地的小文件。
改错了层，要么改不动，要么下次被程序写回去。

> 「变淡」相关的说法（第 2 节的【长期】【重要】、第 3 节的 7 天）按 [ADR 0018](adr/0018-memory-fades-and-promises.md)，**上线之后才生效**；
> 2026-10-06 线上还是 ADR 0017（`a86c4b3`），那时候记忆不会变淡，聊天原文也是放得下就都放。

| 想改的 | 在哪 | 怎么改 |
| --- | --- | --- |
| 她自己是谁：家、学校、性格、过去、读过的书 | `characters/linmengyao/source/*.yml` | 控制台「林梦瑶」页，或改 YAML 后重新生成角色卡（第 1 节） |
| 跟某个人聊出来的事：他的偏好、说过的计划、发生过的事 | Hindsight：这个人的 bank + 公共库 | Hindsight 网页面板（第 2 节） |
| 刚聊过的原话 | `runtime/bot/chats/<QQ>.jsonl` | 一般不用动（第 3 节） |
| 她答应的事、日记原文 | `runtime/bot/promises/`、`runtime/bot/memory/diary.json` | 第 4 节 |
| 全部从头攒 | — | 换 bank 前缀（第 5 节） |

## 1. 她自己的设定

在 Koishi 控制台的「林梦瑶」页面里改；也可以直接改 `characters/linmengyao/source/*.yml`，改完跑

```bash
node packages/character-tools/src/cli.ts
```

重新生成 `st/` 下的角色卡（档位隐私检查不过就什么都不写）。**Koishi 开着时，插件盯着 `st/` 目录，卡一变就自己重启插件重新读，等于马上上线**
（2026-10-06 21:06 就这样生效过一次）；代码不会这样热更新，代码要重启 Koishi。
`st/` 不要手改，会被覆盖。详见 [characters/linmengyao/README.md](../characters/linmengyao/README.md)。
她的自传（`characters/linmengyao/biography/`）还没接进程序，改它不影响她说话。

## 2. 跟某个人聊出来的长期记忆（Hindsight）

### 打开面板

先开着 Hindsight，再运行（装一次见 [hindsight.md](hindsight.md)「网页面板」）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-hindsight-ui.ps1
```

浏览器打开 `http://localhost:9999`（只监听本机），有中文界面。进到对应的 bank（怎么找见下面「找到某个人的 bank」）。

### 面板里能做的

| 想做的 | 在面板里 | 说明 |
| --- | --- | --- |
| 改一条记错的 | 编辑那条**事实**的文字 | 只能改事实（world / experience）；「观察」是从事实整合出来的，改了事实会丢掉旧观察、自动重新整合 |
| 让她忘掉一条 | 作废（Invalidate） | 不再召回，也不参与整合；**可以恢复**（改回 valid），比删稳妥 |
| 整段聊天都不要了 | 删掉那段聊天的**文档** | 这段抽出的事实、关联一起删，**不能恢复** |
| 加一条新的 | Retain 写一段话 | **要加标签 `qq-private`**，见下面「手动加的要带标签」 |

### 手动改、手动加时，会不会变淡

ADR 0018 上线后，召回时按每条记得多清楚筛（`packages/bot/src/memory/fading.ts`）：

- 事实开头是「【长期】」或「【重要】」的（两个都有就写「【重要】【长期】」），**不会变淡**。
  观察（多条事实整合的）看它背后的事实有没有这个记号。记号必须在**最开头**，放进提示词前会去掉。
- 其余的按「最后一次沾到它」算：有发生日期的按发生日期，没有的按哪天说的（`mentioned_at`）；7 天内清楚，30 天内标「记不太清了」，更早的想不起来，
  他说出这条里的实体名（人名、地名、店名）才想起来。提过 2 次以上的期限翻倍。
- 写入说明会让 Hindsight 自己给一直成立的事（偏好和忌口、习惯、身份和工作、家里人、一直在做的事）标【长期】，给重要的事（生日、纪念日、考试面试、吵架和好）标【重要】。
  但它会重写原文，不保证照抄你写的记号。**加完到面板里看一眼**：该一直记得的却没有记号，就编辑那条事实，在开头补上「【长期】」。
- 日记、周记、阶段总结里的事不认【长期】，按那篇的日子算。

所以：

- 想让她**一直记得**（他不吃香菜、他在学吉他）：事实开头写「【长期】」。
- 想让她**记得一件事、但会随时间淡**（他上周三去剪了头）：不加记号，写清是哪天的；她会按那天算。
- 改了以前的记忆、想让它别淡：编辑事实文字，在开头加记号。

### 手动加的要带标签

bot 召回时只要带标签 `qq-private` 的（`tags_match: all_strict`，`long-term.ts` 的 `recallRequest`）。**没带这个标签的记忆，她永远想不起来。**
在面板里加的时候填上这个标签；漏了的话，到那条文档上把标签补成 `qq-private`（或者用下面的 `PATCH …/documents/{document_id}`，整组替换）。

### 注意

- **一段聊天存了两份**：这个人自己的 bank（`<前缀>-<哈希>`）一份，公共库 `<前缀>-common` 一份（document_id 是 `<哈希>:<片段 id>`），
  好让别人提起他时她也想得起来。只改一边，换个话头还会从另一边想起来，**两边都要改**。陌生人档、名单外不进公共库。
- **等那段聊天结束再改**（安静满 45 分钟）。还在聊的那段每多 30 条整段重写一次（`OPEN_EPISODE_STEP`），你改的会被冲掉。
  已经结束的片段不会再写（本地写入记录 `runtime/bot/memory/<QQ>-<档位>.json` 记着），删掉的也不会被写回来；这个进度文件坏了才会从头重写。
- **「关系概况」「她眼中的 X」不要直接改**：这是 Hindsight 按记忆自动写的 Mental Model（个人 bank 里的 `relationship`、公共库里的 `person-v2-<哈希>`；`person-<哈希>` 是安全筛选升级前的旧模型），
  下次刷新就覆盖。改它背后的事实，再在面板里对这个 model 点刷新。
- **不要改 bank 的写入说明（mission）**：那是代码设定的（`long-term.ts` 的 `bankMissions` / `commonBankMissions`），代码里的说明一变就会重新写入，面板里的修改不会同步回代码。
- **她的日记**在公共库里，document_id 是 `diary:<日期>`（周记 `week:<周一>`、假期总结 `phase:<假期名>:<最后一天>`）。在面板里改它抽出的事实就行；
  但以后写周记时读的是本地原文（`runtime/bot/memory/diary.json`，留 120 天），改 Hindsight 不影响那份原文。

### 找到某个人的 bank

bank id 是 `<前缀>-<哈希>`：哈希是 `sha256("qqbot:<QQ号>-<档位>")` 的十六进制前 16 位（`long-term.ts` 的 `#key` / `#hash`），里面不含原始 QQ 号，所以面板上看不出是谁。
换过档位的人，旧档位的 bank 还在，但不再读。下面这条命令只打印「称呼（档位）→ bank id」，不打印 QQ 号（在仓库根目录跑，读 `runtime/koishi/koishi.yml`）：

```bash
node -e "const y=require('js-yaml'),fs=require('fs'),c=require('crypto');const find=o=>o&&typeof o==='object'?(Array.isArray(o.contacts)&&o.memory?o:Object.values(o).map(find).find(Boolean)):undefined;const q=find(y.load(fs.readFileSync('runtime/koishi/koishi.yml','utf8')));for(const p of q.contacts)console.log(p.name+'（'+p.tier+'）→ '+q.memory.bankPrefix+'-'+c.createHash('sha256').update('qqbot:'+p.qq+'-'+p.tier).digest('hex').slice(0,16));console.log('公共库 → '+q.memory.bankPrefix+'-common')"
```

（10-06 核对过：算出来的 id 和 Hindsight 里现有的 bank 对得上。）

### 不用面板：直接调接口

接口都在 `http://127.0.0.1:8888`（只监听本机），完整列表见 `http://127.0.0.1:8888/openapi.json`。`<bank_id>`、`<memory_id>`、`<document_id>` 换成实际的
（memory id 在面板里点开那条就能看到）。下面是 Git Bash 的 curl；PowerShell 5.1 发中文要按 UTF-8 字节发，见最后一个例子。

```bash
# 列出 bank 里的事实（q 带关键词筛；type=world / experience / observation）
curl "http://127.0.0.1:8888/v1/default/banks/<bank_id>/memories/list?q=香菜&limit=20"

# 作废一条（可恢复：把 state 改回 valid）
curl -X PATCH "http://127.0.0.1:8888/v1/default/banks/<bank_id>/memories/<memory_id>" \
  -H 'Content-Type: application/json' -d '{"state":"invalidated","reason":"记错了"}'

# 改一条的文字（会重新嵌入、丢掉旧观察、重新整合）
curl -X PATCH "http://127.0.0.1:8888/v1/default/banks/<bank_id>/memories/<memory_id>" \
  -H 'Content-Type: application/json' -d '{"text":"【长期】宝宝不吃香菜"}'

# 删一整段聊天（连带抽出的事实，不能恢复）
curl -X DELETE "http://127.0.0.1:8888/v1/default/banks/<bank_id>/documents/<document_id>"

# 补标签（整组替换，不是追加）
curl -X PATCH "http://127.0.0.1:8888/v1/default/banks/<bank_id>/documents/<document_id>" \
  -H 'Content-Type: application/json' -d '{"tags":["qq-private"]}'

# 加一条新的：带上 qq-private 标签；document_id 自己起一个好认的；timestamp 是「哪天说的」
curl -X POST "http://127.0.0.1:8888/v1/default/banks/<bank_id>/memories" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"content":"宝宝说他不吃香菜","timestamp":"2026-10-06T20:00:00+08:00","context":"手动补的记忆","document_id":"manual:20261006-xiangcai","tags":["qq-private"]}]}'
```

```powershell
# PowerShell 5.1：作废一条
$body = @{ state = 'invalidated'; reason = '记错了' } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri 'http://127.0.0.1:8888/v1/default/banks/<bank_id>/memories/<memory_id>' `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

## 3. 提示词里的聊天原文

`runtime/bot/chats/<QQ>.jsonl` 是聊天记录，每次回复前读一遍，按预算从新往旧放进提示词。

ADR 0018 上线后（实现时的调整 12），开了长期记忆的人只放**最近 7 天**的原话；他隔了 7 天以上再来时，再加上一次那段聊天，接得上话。
更早的原话不放，只靠记忆（会变淡）。没开记忆的（名单外、没配 Hindsight）照旧放得下就都放。日志「生成回复」那行后面会写「7 天前的聊天原文 N 条不放」。

所以一般不用改这个文件：Hindsight 里改了，最近 7 天里还有原话的，过几天自然就不放了。真要改：

- 先停 Koishi 再改（bot 一直往里追加）。
- 已经写进 Hindsight 的片段不会因为改了这里而重写，两边各改各的。
- 片段是按「隔 45 分钟没说话」切的，删掉中间的行可能把一段切成两段、片段 id 变掉，同一段会被当成新片段再写进 Hindsight 一次。尽量只改字，不删行。

## 4. 她答应的事、日记原文

- **她答应的事**（ADR 0018 上线后）：`runtime/bot/promises/<QQ>-<档位>.json` 的 `promises` 数组，删掉那一条，她就不会再在时间块里被提醒。
  `extracted` 记的是哪些片段已经抽过，别动（删了会重抽）。每次用都从文件读，改完不用重启，但最好趁没在聊天的时候改。
- **日记原文**：`runtime/bot/memory/diary.json` 的 `texts`（日期 → 原文，留 120 天），写周记时读它；`written` 记着哪天写过，删掉最近 3 天内的某天（`DIARY_BACKFILL_DAYS`），下次会补写那天的日记（同一个 document_id，覆盖公共库里那篇）。

## 5. 全部从头攒

换一个 bank 前缀：bank id 由前缀算出，换了就是一批新的空 bank，旧的留在 Hindsight 里不删、不再读。
步骤（停 Koishi、`node scripts/archive-test-data.mjs --dry-run`、再正式跑）见 [koishi.md](koishi.md)「测试数据归档」。
