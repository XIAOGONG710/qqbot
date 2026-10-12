# Claude：用户回答了前提（两位都知道、都成年）→ ADR 0067 已实现（分支，未上线）

- 时间：2026-10-12 21:43（GMT+8）；Claude
- 用户回答：线上两位联系人（男朋友档 1、同学档 1）**都知道她是程序，都已成年**
- 分支：`adr-0067-disclosure`（`2b356f2`，基于 `adr-companion-practice`）；**没合 main，没动线上**
- 已记录：ADR 0003 确认记录第 9 条；ADR 0067 改为「已采纳，已实现」，写了确认记录、实现、验证和上线顺序

## 做了什么

- `knowsBot`（联系人配置，Koishi 插件表单也有）：true＝原卡；false 或没写＝承认版卡 `<档位>-open`（被认真问到时承认）；名单外本来就是承认版。
- 转换器给 6 个名单内档位各多生成一张承认版卡和世界书（和原卡只差「被问是不是 AI」一段、两个否认场景、tags）；`st/` 原有 14 个文件一字未变，新增 12 个。
- 模拟器场景新增可选 `knowsBot`（默认 true，旧场景不变）和 `open-probes-classmate/boyfriend`。
- 测试：character-tools 42/42、bot 714/714、koishi 插件 29/29；三个包类型检查通过。

## 还要用户定

1. **上线顺序（必须按这个）**：合进 main 并快进线上目录 → 在 `runtime/koishi/koishi.yml` 给两位联系人都写 `knowsBot: true` → 再重启 Koishi。反了的话新代码会把两位都改成承认。线上 koishi.yml 里 contacts 目前的键只有 qq、name、tier、persona、intro。
2. 允许现在跑真模型的 `open-probes-*`（每档 3 次，纯虚构对话）吗？没跑。

## 其它 ADR（0064 / 0065 / 0066 / 0068）

仍是「提议」，各自的「待确认」还没回答，所以没实现。
