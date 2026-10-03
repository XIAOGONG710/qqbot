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
- [ ] 转换：legacy TOML → ST 角色卡 JSON + 世界书 JSON（`characters/linmengyao/st/`），能导入 SillyTavern 试聊
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

## 后续（顺序可调整）

- **M2 多人与分档**：联系人 → 档位（男朋友 / 闺蜜 / 同学 / 陌生人 / 群），按档位选择世界书条目与语气；私密信息只对允许的档位出现。
- **M3 时间感知**：作息、课表、每日心情、读书进度；睡觉时段静默。
- **M4 拟人发送与出口检查**：回复延迟、分条发送、已读不回；空消息、助手腔、重复口癖拦截。
- **M5 主动行为与长期记忆**：定时主动消息、纪念日；跨会话记忆。
