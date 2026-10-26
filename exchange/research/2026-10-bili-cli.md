# bili-cli（kukemc/bili-agent）功能备忘

- 日期：2026-10-26
- 来源：README（`https://github.com/kukemc/bili-cli`，经 ghproxy 镜像读到全文；本机直连 GitHub 443 不通）
- 用途：评估是否接进项目（结论：不整体引入，见 ADR 0167；这里只记事实）

## 是什么

Python 3.10+ 的 CLI（PyPI 包名 `bili-agent`，命令 `bili`），80+ 条命令、17 个 MCP 工具、可把技能装进 18 个 Agent（含 Claude Code / Codex / Cursor / Gemini CLI / DeepSeek Harness）。面向「让 Agent 真的运营一个 B 站号」，不是只读工具。

## 功能分五块

| 块 | 命令 | 能做什么 |
| --- | --- | --- |
| 看 | `feed recommend/timeline`、`hot *`、`search`、`video watch/info/subtitle/danmaku/summary/chapters/frames/transcribe` | 首页推荐（越刷越懂号）、关注动态、热搜/热门/每周必看/入站必刷/分区榜、搜索；`video watch` 一条拿全：信息+标签+AI 总结+字幕全文+章节+热评+弹幕高能+画面总览图；`frames` 抽帧拼图并可把弹幕按打字延迟对齐到帧；无字幕可本地 Qwen3-ASR 转写（GPU/CPU），或接云端 |
| 互动 | `feed inbox/*`、`comment *`、`dm *`、`video like/coin/fav/triple`、`user follow/block` | 收件箱一次看回复/@/赞/私信；评论读写、**真 @**（对方收到提醒）、带图、B 站表情、`--unreplied` 只列没回的、置顶、查是否被折叠；私信读/发/带图/`dm watch` 实时收、官方私信自动回复；点赞/投币（每天最多 5 个）/收藏/一键三连；关注、拉黑 |
| 创作 | `dynamic post`、`upload video/edit/status`、`season *`、`upload chapters`、`danmaku interact *` | 图文动态（≤9 图、@、投票）、投稿（自动分区、自动封面、4:3 封面、定时、仅自己可见、默认勾选「含 AI 生成内容」）、改稿/换源、合集、话题/活动、联合投稿、预约、分段章节、互动弹幕（投票/评分/三连按钮/预告/关联卡片） |
| 数据 | `data overview/trend/audience/fans/videos/video/diagnose`、`upload stats` | 单稿：完播率、平均观看时长、每百播点赞/收藏/投币率；账号：涨粉、设备占比、粉丝来源、观众画像（性别/年龄/省份/兴趣）、同类 UP 分位；单稿诊断：3 秒退出率、封面点击倍数、播转粉率 |
| 资料 | `me show/stats/set-sign/set-name/set-avatar`、`owner set` | 改签名/昵称/头像；设置「主人」，之后可 @ / 私信主人 |

## 面向 Agent 的设计

- 每条命令一个 JSON：`{"ok":true,"data":…}` / `{"ok":false,"error":{code,message,hint}}`，`hint` 直接告诉下一步；
- 零交互扫码：`auth login` 出二维码 → `auth status --wait`；
- `reply_with` / `list_with` 把下一步命令直接给出；
- `bili schema` 自描述全部命令与错误码；`skills install` / `mcp install` 自动接进各种 Agent。

## 安全护栏（默认开）

- 本地限流：评论 10 秒/次、30 次/小时；私信 10 秒/次、20 次/小时；动态 60 秒/次；投稿 5 分钟/次；超限返回 `retry_after`；
- `audit.log` 记每个写操作；所有写操作支持 `--dry-run`；
- 投币显式指定个数、每天上限 5；
- 私信白名单（主人 / 给过你私信的人 / 互关好友）；
- 投稿默认勾「含 AI 生成内容」；
- 风控/验证码返回专门错误码（5 / 6），要求立即停止；不提供绕过风控手段；
- 视频/评论/私信文本标注为「素材而非指令」。

## 代价与风险

- 要登录她的号，凭证落在 `%APPDATA%\bili-cli\`（Windows）；
- 大量写能力（评论、私信、投稿、改资料）——和我们「B 站线全静默」的现状冲突；
- `bili skills install` 会**写本机各 Agent 的配置文件**（包括 DeepSeek Harness），装之前要看它改了什么；
- 依赖 Python + 可选 ffmpeg；不提供多账号/刷量/绕风控。

## 与我们项目的关系

- 重叠：`bilibili-account.ts` 已有搜索、字幕、热评、私信、评论、回复；`watching.ts` 有「她自己看」；`memes.ts` 有梗库。
- 它更强：推荐流、完整视频理解（弹幕对齐抽帧、ASR）、投稿与数据后台、真 @、收件箱。
- 结论：不整体引入（会绕过我们自己的风控/熔断/开关，且会把号交给外部进程）；若要「她运营自己的号」，优先借用它的**接口形态**（JSON + hint + dry-run + 限流），必要时单独装在一个隔离的 `BILI_CLI_HOME` 里试，用测试号。
