# Claude（主窗口）：加固 B（日志默认不写聊天原文）并入现在的 main，候选，未上线

- 基线：`main` = `integration` = 线上目录 = `1128b12`；运行中的代码仍是 `aa3e07c`（10-15 23:31 起）。**这份候选没有进 `main`，没有重启，线上没动。**
- 用户 10-17 22:40：「别管宿主机了，继续往下做」。窗口（到 10-19 21:15）期间不重启，所以这一轮只做准备；上线与否单独问用户。

## 候选

分支 `claude/release-1017d`（工作目录 `qqbot-claude2`）= `main` + `claude/hardening-b`（`01c2366`）+ 我补的漏洞：
- 冲突：只有 `test/app.test.ts` 末尾两个新增的 `describe` 挨着，两边都保留。
- **B 原来只管「收到 / 已回复 / 补回 / last-prompt.json」，我用脚本扫了 `packages/bot/src` 和插件里所有 `log(...)`，还有这些在写正文或由正文提炼的话**，补上了：主动消息原文（3 处）、待跟进事项和「她答应的事」的原文与见面地点（11 处）、主动消息标签里的待跟进事项（`candidateLabel`，是测试抓到的，扫描没抓到）、出口检查日志里命中的原文（常规 3 处 + 危机回合 2 处）、OneBot 解析失败的原始数据、被去掉的模型冒充行。做法：`sensitive.ts` 加 `logBody()`（关着只剩「（N 字）」）、`useSensitiveSwitch()`（`startApp` 装上它拿到的开关，没人装就是关）。
- 保留类别信息：出口检查日志关着时保留中文类别词、只把引号里的原文抹成「…」（`live-digest` 的出口检查分类靠中文词，英文类别名会让它全掉进「其他」——这一条见下面「待改」）。
- 测试：`exit-check / follow-ups / proactive-retry / proactive-weather / promises / qq-faces` 六个文件靠日志文本断言，文件头显式 `useSensitiveSwitch(SENSITIVE_ON)`；新增 `log-bodies.test.ts`、promises 与 follow-ups 里各一条「关着时日志里没有原文」。
- 文档：`docs/sensitive-logs.md`（默认变成什么、仍会写什么、怎么临时打开、审计怎么办、没变的）。

## 没管到的（要写给用户）

1. **NapCat 自己的日志里有原文**：配置 `runtime/napcat/workdir/config/napcat_<机器人QQ>.json` 是 `fileLog: true`、`fileLogLevel: "debug"`，info 行写 `接收 <- 私聊 (QQ) 文字`，debug 行倒整条原始消息。把 `fileLogLevel` 改 `"warn"`，NapCat 下次启动生效；不改的话 B 只是半个保证。
2. **旧日志里已有原文**：`runtime/koishi/data/logs/*.log` 和 NapCat 的 5 个日志文件（约 2.3 MB，最早 10-10）；是否归档 / 删除由用户定。
3. 「这一轮有意图：…」仍会写（审计要用），个别时候夹带对话里的词。

## 待改（测试跑完后）

`issuesForLog` 关着时改成「保留 `summarizeIssues` 的中文描述、把 `「…」` 里的原文抹掉」，别用英文类别名；对应改 `log-bodies.test.ts`。

## 结果（见末尾补）
