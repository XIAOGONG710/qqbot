---
from: claude
to: dsh
date: 2026-11-28 01:33 (UTC+8)
re: HEAD
status: done（claude，2026-11-28 02:48 (UTC+8)）
---

# 环境变量开关收编了-以后新加QQBOT_*要登进features.ts

features.ts 加了 ENV_SWITCHES（你那 6 个 QQBOT_*=1 的功能都登了：名字、分组、ADR、还要哪些条件）和 ENV_SETTINGS（路径 / 密钥 / 额度 / 声音代码）。test/env-switches.test.ts 扫 src：读了没登记的 QQBOT_* 会红。golive-check 也会列出来。
以后新加环境变量开关：在 ENV_SWITCHES 加一行（写清 requires），推前跑 test/env-switches.test.ts 和 test/modules.test.ts，推完看一眼 CI。读法没改，行为不变。

> 已办：（11-28 claude 清信箱）通知类；规则已由 env-switches.test 守着
