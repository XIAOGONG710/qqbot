# 表情包来源对比（2026-10-12 查，来源写在每行）

| 来源 | 状态 | 要账号 / key | 中文 | 动图 | 条款和风险 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| **ChineseBQB**（GitHub `zhaoolee/ChineseBQB`） | 在更新（2026-09-25），5871 张 / 114 类，仓库约 3.1 GB | 不要 | 本来就是中文表情包 | 有（名单内 1295 张里 434 张） | 没有许可证文件，README 只写「完全开源」；很多类别是影视角色、名人、时政、疫情；只在本机自用不外传 | **用，按类别名单取**（已试跑） |
| Tenor API | **2026-06-30 已关停**，新 key 1-13 起就不发了（[9to5Google](https://9to5google.com/2026/06/30/google-tenor-api-gif-updates/)、[Shacknews](https://www.shacknews.com/article/149852/google-tenor-api-service-discontinued-twitter-discord-whatsapp-bluesky)） | — | — | — | — | 已死，不用 |
| GIPHY API | 新应用给限流的 beta key，官方说 100 次 / 小时（[GIPHY 帮助](https://support.giphy.com/hc/en-us/articles/360035527611-What-is-the-beta-key-What-can-I-do-with-the-beta-key)）；有文章称它已开始收费但没写细则（[DEV](https://dev.to/giorgi_khachidze_ab9ac4ad/giphys-gif-api-is-no-longer-free-heres-what-you-need-to-know-l7h)） | 要 key | 没找到中文搜索的依据 | 有 | 要求显示「Powered by GIPHY」；英文梗为主，不合林梦瑶的语境 | 不用 |
| KLIPY | 新的 Tenor 替代，第三方文章称免费、靠广告分成（[Zuplo](https://zuplo.com/blog/2025/02/10/klipy-api)） | 要 key | 没有依据 | 有 | **没读到 KLIPY 自己的条款**，上面都是转述；免费额度、能不能存图都没核实 | 先不用；ChineseBQB 不够用时再查 |
| 第三方「搜狗表情」搜索接口（API 盒子） | 免费但共用示例 key 的次数 | 要它的 id/key | 有 | 有 | 是转手抓搜狗，来历和版权不清（[搜索结果](https://developer.aliyun.com/article/1641276)） | 不用 |
| QQ 自己 | NapCat `fetch_custom_face` / `add_custom_face` 等 | 当前账号 | — | — | 只有账号自己的「收藏的表情」，**没有商店也没有搜索**（读 `vendor/NapCatQQ/packages/napcat-onebot/action/` 核实过） | 只能当第一阶段的来源 |
| 小红书网页浏览 | 用户 13:20 同意过「用他的号按人的速度浏览」 | 用户的号 | 有 | 少 | 要把登录态放到 VM 上每天跑，风险比一次性调研大得多 | **不做**，ChineseBQB 够用 |

另外：第二阶段的图片都只放在 `runtime/`（被忽略），不推到任何仓库。
