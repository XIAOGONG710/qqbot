# K、G、I 隔离实机联调

本轮使用临时状态目录、虚构账号、假模型和假 OneBot。没有启动正式 Koishi，没有改桌面正式配置，没有连接 NapCat 或发送真实 QQ。

| 模块 | 已验证 | 待验 |
| --- | --- | --- |
| K 质量出口 | Koishi 4.18.11 和 OneBot 适配器 6.9.4 启动实际项目插件。合成草稿声称要打电话，审计记为不支持的动作，原文、草稿标记和账号不进审计。K 阶段实际发送调用为 0，故意注入的发送探针返回 403。G 的待核对回话单独计数，只被假 OneBot 接收。 | 第三方日志范围沿用 K 的原交接。 |
| G 执行恢复 | 在 `b11ad4f5` 上，假 OneBot 将续办请求送进实际 Koishi，Koishi 通过工作桥交给实际常驻，常驻执行已安装的 DSH CLI。回环代理丢弃一次完整回执，Koishi 只返回「回复内容待核对」。重启常驻后，重放原消息并用新消息继续同一任务，记录仍为已完成，DSH 总执行次数为 1，额外工作回话为 0。 | 本轮 Koishi 保持运行，重启的是常驻。 |
| I 记忆隔离 | 安装版 DSH Desktop Host 通过正式会话 RPC 创建会话并运行实际记忆插件。原账号先读到合成源消息、Hindsight 摘要及上一场收尾。宿主关闭后，实际 Koishi 接受假 OneBot 撤回并写盘。重新启动宿主、新开会话时只见撤回占位，旧原文、摘要和收尾都未出现在模型请求。换成另一合成账号再开会话，只读到该账号的对照消息。 | 本次覆盖桌面宿主以及正式会话 RPC，共四场会话，未操作 Electron 窗口。 |

## 复跑

```powershell
$env:QQBOT_DRILL_DSH_BIN = '<installed DSH lib/bin.js>'
$env:QQBOT_DRILL_DESKTOP_EXE = '<installed DeepSeek Harness.exe>'
node scripts/koishi-receive-only-drill.mjs --quality
node --import tsx --test --test-name-pattern '已落地但丢失' packages/bot/test/resident-guard.test.ts
Remove-Item Env:QQBOT_DRILL_DSH_BIN
Remove-Item Env:QQBOT_DRILL_DESKTOP_EXE
node --import tsx --test --test-name-pattern '撤回后新桌面|隔天接续|两天联动' packages/bot/test/soul-plugin.test.ts packages/bot/test/app.test.ts
```

验收以 Electron 的 Node 模式启动打包的 Desktop Host，跳过外壳的单实例转发。宿主的用户目录、应用数据、临时目录、DSH 配置和角色状态都指向合成临时目录。宿主禁止出站 socket，模型和 Hindsight 请求均被替换为合成响应，父进程只连宿主回环 RPC。没有借用正在使用的桌面会话或配置。

同步 Claude 的 22 个提交到 `b11ad4f5`。本地修改从备份恢复，三个重叠文件均自动合并。逐项检查了召回上限 16、上下文说明及 120 条阈值，并保留上游记忆熔断、配置校验和应用重构。原始本地修改的 Git stash 暂留，未混入提交。

人设后续需求是把主动挑逗、高攻低防和看回应收住写入核心人设，让私聊和群聊都体现。这份联调交接仅涵盖 K、G、I。
