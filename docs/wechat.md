# 微信通道：让她用自己的微信号跟别人聊（2026-10-30，进行中）

目标（用户）：**给她一个自己的微信号，让她去跟别人聊天**，不是借用户的号。

## 现在的状态

| 部分 | 状态 |
|---|---|
| id 映射（wxid ↔ 数字） | ✅ `packages/bot/src/platform/wechat-id.ts`，4 项测试 |
| OneBot 事件与动作换算 | ✅ `packages/bot/src/platform/wechat-bridge.ts`，4 项测试 |
| 桥接进程（假装 NapCat） | ✅ `scripts/wechat-bridge.mjs`，dry 模式实测：登录信息、收消息推送、发消息拒绝（未连微信） |
| WeChatFerry 客户端 | ⛔ 没装（要她自己的微信号 + 指定微信版本） |
| Koishi 第二个 adapter | ⛔ 没配（等微信号就绪） |

## 为什么这么做

`packages/bot` 里所有联系人 id 都是 number（QQ 号），聊天记录文件名、档位表、状态页都按数字走。
把 wxid **稳定映射成 52 位以内的整数**（FNV-1a），现有代码一行不用改：
桥接进程负责反查 wxid，`bot.lock`、`chats/<id>.jsonl`、`tiers.json` 全部照旧。

桥接进程**假装成 NapCat**（OneBot 11 的 WS 服务端），Koishi 的 `adapter-onebot` 连上来即可。
这是最省的一条路：不写新适配器、不动插件、不动联系人模型。

## 跑起来要做的三步

### 1. 她自己的微信号（用户侧）

- 独立手机号注册，**不要用主力号**；
- 先正常用 3–7 天（加两三个好友、换头像、发一条朋友圈），别一上来挂机器人；
- 微信 PC 客户端登录这个号（手机和 PC 可以同时在线）。

### 2. WeChatFerry

- 按 [WeChatFerry](https://github.com/lich0821/WeChatFerry) 的说明装**它支持的那个微信版本**（版本绑定，别升级）；
- 起它的 HTTP 服务，默认 `http://127.0.0.1:10086`；
- 把消息回调指到桥的 `http://127.0.0.1:3101/wcf`（WCF 的 callback 配置）。

### 3. 桥 + Koishi

```bash
SELF_WXID=她的wxid node scripts/wechat-bridge.mjs
# 先空跑：DRY=1 只打印要发什么
```

然后在 `runtime/koishi/koishi.yml` 里加**第二个** `adapter-onebot`：

```yaml
adapter-onebot:wechat:
  protocol: ws
  endpoint: ws://127.0.0.1:3100
  selfId: '<桥打印的 self 数字 id>'
```

**注意**：`qqbot` 插件的 `contacts` 要加她微信里的朋友（`qq` 字段填那个数字 id），
档位按亲疏填 `stranger` / `known`；`bot.lock` 仍然只有一个，两个 adapter 共用同一个 bot 实例。

## 边界（写死，不要放宽）

- **被认真问是不是程序，就承认**（ADR 0067；陌生人档已有这条规则）；
- **不主动加人、不群发**；只回好友发来的消息；
- 每天回复上限、群聊默认不插话（还没做，接入前补）；
- 不转账、不点链接、不约见面；
- 她微信的聊天记录**单独一个记忆 bank**，不和用户的私聊混。

## 风险（说在前面）

1. 注入型方案（WCF）**封号率不低**，新号尤其；
2. 被举报会连号一起没，可能连带手机号；
3. 微信条款禁止自动化；
4. 版本绑死：微信一升级，等她换适配版本之前桥就断了。

## 回滚

桥是独立进程，`Ctrl+C` 停掉即可；Koishi 里删掉第二个 adapter 就回到只有 QQ 的状态。
数据留在 `runtime/bot-shadow/wechat-directory.json`（映射表）和 `chats/<数字>.jsonl`（聊天记录）。
