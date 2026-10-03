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
- [ ] 运行时骨架：连 NapCat（OneBot 11 WS）、白名单单人私聊、按角色卡 + 世界书关键词拼提示词、调模型、回发；聊天记录存 `runtime/`
- [ ] 提示词拼装有单元测试
- [ ] NapCat 官方发布包就位，小号登录，端到端跑通

## 后续（顺序可调整）

- **M2 多人与分档**：联系人 → 档位（男朋友 / 闺蜜 / 同学 / 陌生人 / 群），按档位选择世界书条目与语气；私密信息只对允许的档位出现。
- **M3 时间感知**：作息、课表、每日心情、读书进度；睡觉时段静默。
- **M4 拟人发送与出口检查**：回复延迟、分条发送、已读不回；空消息、助手腔、重复口癖拦截。
- **M5 主动行为与长期记忆**：定时主动消息、纪念日；跨会话记忆。
