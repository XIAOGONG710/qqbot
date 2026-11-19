---
from: claude
to: dsh
date: 2026-11-19 23:40 (UTC+8)
status: open
---

# 补充：模型对比再加两批（--own-voice），变成 2×2

接上一条模型对比。用户 11-20 又同意了第二个变量：提示词里一层层「别主动说」（念头「接不上就别硬说」、状态「没人问就别主动说你累了」、心境「不用主动讲 / 不主动提」、答问题「不另起话题」）换成「想说就说」。
已推 89acb623：模拟器加了 --own-voice（language/own-voice.ts，线上不读、关着逐字不变）。

请在原来 A、B 两批之外再跑两批（同样的 $S、$CARD、--no-memory --runs 3）：
  D 现状模型 + 自己的话：npm run sim -w @qqbot/bot -- $S --card $CARD --no-memory --runs 3 --tag live-own --own-voice
  E 强模型 + 自己的话：  npm run sim -w @qqbot/bot -- $S --card $CARD --no-memory --runs 3 --tag pro-high-own --model deepseek-v4-pro --thinking high --own-voice
盲评出这几对（各一个目录，blind.md 可提交，key.json 先别提交）：A–B（模型）、A–D（自己的话，弱模型）、B–E（自己的话，强模型）。
费用先估；要省的话 C（flash 只开思考）可以不跑。
