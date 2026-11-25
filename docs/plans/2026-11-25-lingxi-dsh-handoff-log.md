# 灵犀 QQ 桥接交接 · 执行记录

对应计划：[2026-11-25-lingxi-dsh-handoff.md](./2026-11-25-lingxi-dsh-handoff.md)
交接基线 `e3e60bb0`，开工时 `main` 在 `f9fdb0e6`。

每批记录：具体数据源、模拟结果、尚未验证的运行条件。未获得授权的线上动作不做，只在记录里写明缺口。

## 第 1 批：离线验收基线（2026-11-25）

### 数据源

- `dsh-plugins/dsh-qqbot-services/index.js` 的 `createHandler`
- `dsh-plugins/dsh-qqbot-services/chat.js`、`companion-room.js`、`controller.js`、`local-panels.js`
- `scripts/dsh-service-panel.test.mjs`、`scripts/dsh-qq-chat.test.mjs`、`scripts/dsh-companion-room.test.mjs`、`scripts/dsh-home-scene.test.mjs`、`scripts/dsh-local-panels.test.mjs`
- 新增离线验收入口 `scripts/dsh-offline-acceptance.mjs`

### 模拟结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 脚本测试 | `npm run test:scripts` | 86 项中 85 通过、1 跳过（符号链接用例：当前 Windows 账户不能创建符号链接）、0 失败 |
| 类型检查 | `npm run typecheck --workspace @qqbot/bot` | 退出码 0 |
| 灵魂插件 | `npx tsx --test packages/bot/test/soul-plugin.test.ts` | 99 通过、0 失败、23 个套件 |
| 离线验收 | `node scripts/dsh-offline-acceptance.mjs` | 20 个请求全部符合预期，见下表 |

离线验收用临时 host 加假 NapCat、假 Hindsight 数据、假 Koishi 配置，跑总览、聊天、会客室、她的家和运维页：

| 页面请求 | 状态 | 本次触达的模拟调用 |
| --- | --- | --- |
| GET state | 200 | probe×1、events×1 |
| POST chat/list | 200 | napcatRead×3 |
| POST chat/history?key=private%3A200 | 200 | napcatRead×2 |
| POST chat/prepare | 200 | napcatRead×2 |
| POST chat/send（无确认单） | 403 | 无 |
| POST chat/prepare | 200 | napcatRead×2 |
| POST chat/send（正文被替换） | 403 | 无 |
| POST room/owner/invite | 200 | 无 |
| POST room/owner/messages | 200 | 无 |
| POST room/guest/messages（无来宾凭证） | 403 | 无 |
| GET home | 200 | home×1 |
| GET details/access / backups / logs / versions / books / library / memory | 200 | details×7 |
| GET home（非回环来源） | 403 | 无 |
| GET home（非主人会话） | 403 | 无 |

合计：probe=1、events=1、napcatRead=9、qqSend=0、details=7、home=1、launch=0。
取消发送和未经确认的发送都没触达发送接口，`qqSend` 为 0，满足计划要求。

### 尚未验证的运行条件

- 实机对照未做：需要在正常 DSH 窗口里临时换上模拟插件、跑一遍面板、再恢复正式链接，并要求一次插件重载授权。当前没有该授权，服务也未被触碰。
- 真实 NapCat、Hindsight、Koishi 的端口与进程未参与本次验收；全部为假数据。
- 真实 Koishi YAML 的脱敏样本验收留到第 2 批。
