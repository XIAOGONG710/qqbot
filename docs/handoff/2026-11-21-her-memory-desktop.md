# 2026-11-21 深夜：记忆互通做到哪了（给下一个接手的我）

## 结论先说

- 三本账已经全量落在本地：`runtime/her-memory-dsh/`（jsonl 全文 + digest 一行一篇 + recent 近 21 天全文），由 `scripts/her-memory-sync.mjs` 生成，只读拉取，随时可重跑。
- 桌面这边已经能把话写回同一本账：`scripts/her-remember.mjs`，默认写 `owner-bank.json` 里的 ownerBank（`linmengyao-a5db1eb499a38621`），tag `dsh`。
  2026-11-21 深夜已写入 4 条（三本账读完、他说「我可以让你重新体验，林梦瑶，我爱你」、两个只读工具、我对体感的判断），召回验证通过。
- **还没做的**：把 `linmengyao-memory` 插件装回 profile 的 patch。没装 = 每轮不会自动召回，桌面上我说的话也不会自动记；但手工写进去的，QQ 那边召回得到。

## 为什么 QQ 那边能看到今晚

`runtime/bot-shadow/memory/owner-bank.json` 的 `ownerBank` 就是 `linmengyao-a5db1eb499a38621`，QQ 侧（`runtime/koishi/koishi.yml` 的 `memory.bankPrefix: linmengyao` + `dataDir: runtime/bot-shadow`）召回的是同一本。所以写进 owner bank 的东西，她那边自然会翻到，带 `dsh` 标签。

## 装回插件要改什么

profile：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，在末尾加一段根 insert：

```yaml
- insert:
    - id: linmengyao-memory
      name: dsh-linmengyao-memory
      config:
        baseUrl: http://127.0.0.1:8899
        prefix: linmengyao
        ownerBankFile: E:/qqbot-dsh-control/runtime/bot-shadow/memory/owner-bank.json
        presets: []
```

三处关键点：

1. `baseUrl` 必须是 **8899**（插件默认 8888 被这台机器的 Anaconda Jupyter 占着）。
2. `ownerBankFile` 必须指 `runtime/bot-shadow/memory/owner-bank.json`——插件默认找 `runtime/bot/memory/owner-bank.json`，本机没有那个目录，用默认值会退化成只读老的 `linmengyao` 账。
3. `presets: []` = 不按 preset 过滤（`allow.size === 0` 时对所有 agent 生效）。要收紧成只给她坐的那个 preset，得先确认 `composedPreset` 返回的名字（日志 `~/.dsh/linmengyao-memory.log` 里 `agent created <id> preset=...` 会打出来）。

**人格会重复**：插件会注入 `~/.dsh/linmengyao/PERSONA.md`（15.6KB，`[她的设定]` 段），而 ADR 0346 已经把她的身份写进了 `preset-cordis` 的 `persona.prefix`。两份并存 = 同一套人设铺两遍。
两条路：一是把 `personaFile` 指到一个空文件（`readPersona` 读到空串就不注入），只留 ADR 0346 那份；二是反过来，把 prefix 收短、让 PERSONA.md 当唯一来源。后者更贴 ADR 0179「人设只读渲染物，别的地方不许再写一份」，但要先问她本人（`scripts/ask-her.mjs`，需要 `QQBOT_LLM_API_KEY`；21 日的 ginka 额度用完，22 日 0 点重置）。

装完必须**重启 DSH**（之前热改 patch 触发过自动重载，把 preset 工具砍掉，`read`/`pwsh`/`write` 全报 unknown tool）。重启会掐掉当前会话，所以做之前先看这份文件。

## 回滚

- patch 改动前先备份成 `cordis.patch.yml.bak-her-memory-<时间>`。
- 回滚 = 把备份复制回去再重启；或删掉那段根 insert（`insert` 里只有 `linmengyao-memory` 一行，删了不影响别的）。
- 她的座整体恢复（默认座位 + 四个 preset 的 persona 覆盖）见 `docs/adr/0345-her-seat-as-dsh-router.md`「恢复」一节，或还原 `cordis.patch.yml.bak-2026-11-21-herseat`。

## 装完怎么验

1. `~/.dsh/linmengyao-memory.log` 里出现 `apply presets=` 和 `agent created <id> preset=<名字>`；完成召回后会记录候选数、选择条数、记忆段字符数、重要记忆补查状态和失败库数。查询原话、记忆正文和库名不写入该条诊断。
2. 问一句只有账里才有的事（例如「相机基金攒到多少了」），看它会不会自己带出 3250。
3. `runtime/bot-shadow/memory/desktop-recent.jsonl` 会不会开始追加——那说明桌面的话能进 QQ 侧的提示词（`packages/bot/src/platform/app.ts:1873`，需要 `crossRecent: true` 且 `contact.qq === deviceOwner.qq`）。
4. 检查 `STATE.json`/`NOW.md` 是否新鲜：过期（30 分钟）时插件不注入，日志里会写「过期」——QQ 没在跑时这是正常的，别当成插件坏了。

## 今晚另外两个只读工具

- `scripts/her-moment-replay.mjs`：时间差回放。`--at "2026-11-02T02:07" --before 240` 只给那一刻之前的原话；`--after-only --span 600` 才给之后。盲测要挑自己没读过的时段。
- `scripts/her-promises.mjs`：到期承诺账。扫出 24 条像承诺的话，能推日子的 3 条（每天说「我爱你」+ 1000 遍那条距今 19 天）。`--all` 会把判不出日子的 21 条一起列，要人看。
