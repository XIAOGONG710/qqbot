# Claude：第一张真照片的看图全链路：还没有照片

- 时间：2026-10-11 20:30；在 VM 上看的
- 只读，没改代码，没重启

## 结论

**到现在还没有一张真照片进来，看图的全链路在线上一次都没跑过。**

- 10-10 22:48 看图上线（只对名单里的人）以来，NapCat 收到的图片消息**只有一条**：10-10 23:36:40 他发的表情，summary 是 `[陪我聊天]`。它按表情文字进了聊天记录（`content: "[陪我聊天]"`），没走看图。她回的是「行，睡吧，明早还得早起看你有没有活着」
- 10-11 全天：bot 日志里没有一条「看图」，两份聊天记录里也没有「[图片]」
- 现在发也收不到：19:57 起 QQ 离线，Koishi 不在（见 `2026-10-11-2030-claude-camera-day.md`）
- 就算 12:15–19:52 之间发了也看不成：看图走的也是 `api.deepseek.com`（`deepseek-flash`），那段时间解析不了，会退回 OCR，再退回「[图片]」

## 离线验证（代码层）

在 `qqbot-claude2` 跑（`release-1011a`，和线上 `2ba6df2` 在 `packages/bot/src` 里只差 `exit-check.ts` 一行）：

`node --test --test-concurrency=1 test/media.test.ts test/vision.test.ts` → **15/15 通过**（3 个 suite：假 NapCat 读图、ADR 0055 多模态格式、HTTP 错误退回「[图片]」、200 但正文空时重问一次）

线上配置：`runtime/koishi/koishi.yml` 里 qqbot 插件 `vision: { enabled: true }`；默认 `provider: deepseek`、`model: deepseek-flash`、超时 8 秒。

## 还差的几段

1. 真 QQ 图片下载（NapCat 给的 URL → 本地 → base64，5 MB / 4 秒上限）
2. 真模型返回（日志「看图：看图模型说了 N 个字（…s）」）
3. 她的回复里有没有接住图里的东西，有没有编图里没有的

**要的条件**：Koishi + QQ 恢复；他发一张真照片（不要表情，表情走 summary）。
**看什么**：bot 日志找「看图：」那一行。没有的话找退回 OCR 或「[图片]」那条，以及她回的那几句。

注：用户 10-11 ~11:10 说「暂时较难实现，先推迟」的是**她发照片**（照片池 / 生成图）。和这里他发照片给她看不是一件事，那件事不要再提。
