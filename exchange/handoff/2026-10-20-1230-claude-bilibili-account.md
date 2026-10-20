# 2026-10-20 12:30 Claude：B 站账号层（ADR 0089）——做完，未合并、未上线、未开启

- 用户 11:30：「dsh 有个可以刷 bilibili 视频的插件，在 github 上，c1overzz 的 dsh-bili-scroll，你去看一下能否化用到我们这里」；我报告「代码不能直接用，读字幕必须登录，匿名可以按口味搜」并建议先不做登录那层；用户：**「我还是倾向对方的形式」** → 按「功能先做着，暂时不要开启」（10-19）在分支上做完整的账号层，默认全关。
- 分支 `claude/bilibili-account`（从线上 `ad1e387` 拉出），提交 `3013bee`（账号层）+ 私信一提交（见 git log，已推送 origin/claude/bilibili-account，没进 main）。**线上没动。**

## 实测结论（匿名，只读 GET）
- 播放器信息 `need_login_subtitle=true`、字幕轨 0：**读字幕必须登录**。
- `x/web-interface/view` 匿名 412（5 次都是，是接口要访客 Cookie，不是频率）；搜索匿名成功 1 次（20 条）。
- 登录二维码 generate / poll 对真实 B 站实测过：145 字符链接、32 位 key，轮询返回「未扫码」。

## 用户 10-20 12:5x 的补充：评论代替 QQ 分享，改成私信
用户：「代替，到时候可以在QQ说宝宝你看b站我发你的私信」。所以送达方式 = **B 站私信**（配置 `bilibiliDm`）：她写私信（链接 + 一两句话，走和聊天一样的生成，试运行模式不发 QQ）→ `sendDm` 发到他的 B 站 → QQ 上只发一句提醒。私信发不出去退回 QQ 发链接；提醒正聊着延后、3 小时放弃；私信记进聊天记录 `[B 站私信]`；连败 2 次到重启前不再试私信。评论 @ 保留为独立开关（默认关）。**他的 B 站要先关注她的号**（没关注时 B 站限制私信，没验过）。

## 做了什么（细节见 ADR 0089）
- `bilibili-account.ts`：扫码登录（凭证在轮询响应的 Set-Cookie 里）、凭证文件 `<数据目录>/secrets/bilibili.json`、WBI 签名（和文档向量逐字一致）、搜索、读字幕、发评论（真 @：`at_name_to_mid`）、评论复核。
- `bilibili.ts`：账号层开着时按口味搜（每天一个关键词）、前 3 个候选挑第一个有字幕的、字幕摘录进说明（标明是素材）；评论（分享之后、限额很低、2 分钟 / 20 分钟复核、两次找不到停一周、失败停 24 小时、连 3 次停到重启、分享试运行则评论只写草稿）。
- `bilibili-comment.ts`：评论用最低隐私档的卡写 + `cleanQzoneText`。
- `bilibili-login.ts` / `bilibili-login-cli.ts`：`npm run bilibili-login -w @qqbot/bot -- [--data-dir 目录] [--check] [--no-open]`；二维码用 `vendor/qrcodegen.js`（Nayuki MIT，固定提交 `3c6d0b3`）。
- 配置（插件设置页也有）：`bilibiliAccount`（布尔）、`bilibiliDm`（off / dryRun / on）、`bilibiliComment`（off / dryRun / on）、`bilibiliAtName`、`bilibiliAtUid`（私信和评论 @ 都用），默认全关。

## 测试
- 第一遍全套（收紧之前）：bot 1207/1207、插件 35/35、工具 43/43。收紧（复核拖太久不下结论、候选去重、评论区关了不算失败、热评简介标明是素材）之后重跑了 B 站相关的 58 项 + app 的 6 项接线，全过；收紧之后的全套结果见下一行（跑完补）。
- 新增测试：bilibili-account 23、bilibili-account-flow 16、bilibili-comment 4、bilibili-login 5、app 接线 4、配置 1。变异检查：去掉「分享试运行则评论只写草稿」的判断，对应测试变红。

## 上线要什么（每步各要用户一句明确的话）
1. **专用 B 站号**（不是用户自己的）；用户的 B 站昵称 + uid。
2. 在线上目录跑 `npm run bilibili-login -w @qqbot/bot`，用那个号的 App 扫码确认。
3. 合并 + 重启一次；`koishi.yml` 先只开 `bilibiliAccount: true` + `bilibiliDm: dryRun`，看一周草稿（`presence/drafts.md`：私信和 QQ 提醒）和日志。
4. 再改 `bilibiliDm: on`；**第一次真私信用户在场**，确认私信到没到（他先关注她的号）、QQ 提醒说得自然不自然。公开评论 @ 另算，同样先 dryRun。
- 落地脚本的 `-Allowed` 要包含：`packages/bot/src/vendor/[^/]+$`、`packages/koishi-plugin-qqbot/src/[^/]+$`、`packages/bot/package\.json$`、`docs/adr/(0084|0089)-[^/]+\.md$`（比上次多这几类）。
- 没验过的：用真账号的搜索 / 读字幕 / 发私信 / 发评论 / 复核；WBI 真请求（私信接口是否要签名）；`at_name_to_mid` 是否真通知到人；新号评论会不会被拦；他没关注她时私信被怎么限制。

## 风险（用户知情）
封号（自动化评论违反用户协议，新号常被风控）；评论里真 @ 用户的号 = 公开把「她」和「他」连起来；凭证文件是账号钥匙，`runtime\bot` 的备份里也有。
