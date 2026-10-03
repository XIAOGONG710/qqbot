# 路线图

按 [ADR 0002](adr/0002-standalone-runtime.md) 推进。每个里程碑小步提交，每步可验证；完成后在这里打勾并写明验证方式。

## M1 最小闭环：私聊一人

男朋友在 QQ 私聊林梦瑶的小号，收到一条按角色卡生成的回复。

- [x] 环境：Node.js LTS（≥ 20）
  - 验证：v24.21.0 zip 的 SHA-256 与官方 `SHASUMS256.txt` 一致，`SHASUMS256.txt.sig` GPG 验签通过（签名者在 nodejs/node 的 release keys 名单中）；
    `node -v` → v24.21.0，`npm -v` → 11.19.0
- [x] SillyTavern 能启动，数据目录在 `runtime/`
  - 验证：`scripts/start-sillytavern.ps1` 启动 1.19.0，日志显示 `Using config path` / `Using data root` 均在 `runtime/sillytavern/`；
    `http://127.0.0.1:8000/` 返回 200（标题 SillyTavern）；子模块 `git status --short --ignored` 只有被忽略的 `node_modules/`
- [x] 转换：legacy TOML → ST 角色卡 JSON + 世界书 JSON（`characters/linmengyao/st/`），能导入 SillyTavern 试聊
  - 验证：`npm run convert -w @qqbot/character-tools` 生成，`npm test` 覆盖转换规则；角色卡和世界书已导入 SillyTavern 1.19.0（角色列表与世界书列表里都有）；
    效果由用户确认：2026-10-04 通过 bot 在 QQ 上实测十余轮（同一份角色卡 + 世界书），回复内容与卡里设定一致（如「土豆」是楼下的三花猫）。
    未在 SillyTavern 界面里试聊
- [x] 运行时骨架：连 NapCat（OneBot 11 WS）、白名单私聊（都按男朋友处理）、按角色卡 + 世界书关键词拼提示词、调模型、回发；聊天记录存 `runtime/`
  - 验证：`npm test`（51 项）覆盖拼装、后处理、配置、回复清理、生成期间来新消息、模型请求重试；
    2026-10-04 实测（DeepSeek `deepseek-flash`，关思考模式）：白名单号私聊「在干嘛」，日志显示命中世界书「熟人随口招呼」，
    `runtime/bot/last-prompt.json` 里是 semi 后处理后的 system + 聊天记录，回复发回 QQ，`runtime/bot/chats/<QQ>.jsonl` 记下双方消息；
    之前回复失败的两条在下一次生成时一并带上。非白名单号的私聊被忽略这一条未实测（只有日志分支，没有第二个非白名单账号发消息）
- [x] 提示词拼装有单元测试
  - 验证：`npm test` 通过。`packages/bot/test/world-info.test.ts`、`prompt.test.ts` 对照 ST 1.19.0 源码，覆盖扫描深度、名字前缀、正则 / 次关键词逻辑、
    概率、预算、排序、插入位置、宏、消息顺序、聊天记录截断，并用林梦瑶的真实角色卡和世界书验证
- [x] NapCat 官方发布包就位，小号登录，端到端跑通
  - 验证：来源核对与补丁见 [docs/napcat.md](napcat.md)；小号扫码登录后，OneBot WS 用 token 连上，`get_login_info` / `get_status` 正常（在线），
    错误 token 被拒（1403）；2026-10-04 01:12 白名单号私聊「嘿嘿」，1 秒后收到回复「嘿嘿什么 笑得我心里发毛」。
    首轮实测 5 次模型调用有 3 次连接超时（`UND_ERR_CONNECT_TIMEOUT`，网络时断时续），已加连接失败重试；
    重启后实测：01:17:30 连接超时 → 1 秒后重试成功；生成期间对方又发一条，丢弃草稿带上新消息重新生成，01:17:33 回复

## M1 之后的收尾（2026-10-04 与用户对齐）

- [x] 仓库推到 GitHub 私有仓库（XIAOGONG710 账号；装 gh CLI 建仓，推送前扫一遍历史里有没有密钥）
  - 验证：推送前扫描全部历史 blob，OneBot token 与 DeepSeek key 原值 0 命中，其余疑似项均为公开的哈希 / 指纹；
    `gh` 登录账号 XIAOGONG710（id 304879021），建 `XIAOGONG710/qqbot`，API 返回 `private=true`，远程 `main` 与本地 HEAD 一致，无 `runtime/`。
    推送凭据只在本仓库配置（`git config --local credential.https://github.com.helper` → `gh auth git-credential`）
- [x] `scripts/start-bot.ps1`：用户在自己的终端里运行 bot；同一时间只允许一个 bot 实例
  - 验证：`test/lock.test.ts`；实测 bot（PID 9128）运行中再用脚本启动第二个，拒绝并提示「已有一个 bot 在运行（PID 9128）」，退出码 1，没有连 NapCat
- [x] 补回漏掉的消息：启动和重连 NapCat 时拉白名单里每人最近 20 条私聊，补进聊天记录（按 QQ 消息 id 去重，小号自己发的算她说的）；
  最后一条没回的消息在 3 小时内就回一次，更早的只补记录
  - 验证：`test/backfill.test.ts`；2026-10-04 01:43 停掉 bot，用户两个号分别发了 1 条和 3 条，01:44:24 重启后日志「补回 1 条」「补回 3 条」，
    随即各回复一次；聊天记录里补回的消息按时间接在原有记录之后、带 QQ 消息 id。被强杀留下的锁文件在这次启动时被接管

## M2 多人与分档（私聊）

按 [ADR 0003](adr/0003-contact-tiers.md)：每个档位一张角色卡，私密信息靠「不写进去」保护。
档位为 boyfriend / bestie / girl_friend / known / classmate / stranger，外加名单外好友用的 unlisted（被认真问到时承认是 AI）。

- [x] 提示词顺序改为 ST 实际使用的 `dummyId 100001`（多出 `personaDescription`），支持联系人的可选人设描述
  - 验证：`npm test`（67 项）。`prompt.test.ts` 断言人设描述排在世界书 before 之后、角色描述之前且宏已替换，对照 `Default.json` 100001 与 `openai.js:1433`；
    没配 `persona` 时拼出的消息与 100000 相同（原有顺序测试不变）。`runtime.test.ts` 覆盖配置里 `persona` 的校验。
    尚未实测：目前没有联系人配了 `persona`
- [ ] `characters/linmengyao/tiers.toml`（可见性表 + 改写字段 + 各档禁用词）；转换器按档位生成 7 张角色卡和场景世界书，
  测试保证低档位的卡里没有高档位的事实
- [ ] 运行时：联系人配置加 `tier`，按档位加载角色卡；名单外好友走 unlisted；联系人换档位时提示清理聊天记录
- [ ] 用户给出联系人名单，逐档实测（至少男朋友、同学、名单外各一个号）

## 后续（顺序可调整）

- **群聊**（从 M2 拆出）：什么时候插话、@ 谁、群上下文怎么取；旧资料里的 group 档位。
- **M3 时间感知**：作息、课表、每日心情、读书进度；睡觉时段静默。
  - 实测发现：她不知道今天星期几（2026-10-04 是周日，她说周四）；所在位置前后矛盾（先说躺在宿舍，又说「回去了发你」）。
- **M4 拟人发送与出口检查**：回复延迟、分条发送（按行拆成多条、固定间隔 1 秒已在 M1 之后做了）、已读不回；空消息、助手腔、重复口癖拦截。
  - 实测发现：会答应做不到的事（「回去了发你照片」，bot 发不了图）；回复里出现动作描写「（停顿一下）」，违反输出规则。
  - 低档位的禁用词拦截（ADR 0003 后果一节，词表在 `tiers.toml`）。
- **角色卡**：实测里她说「明天二模」，「二模」是高中的说法，与在读大学生不符。
- **M5 主动行为与长期记忆**：定时主动消息、纪念日；跨会话记忆。
