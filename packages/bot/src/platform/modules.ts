// 模块总表（始于 ADR 0122 的分类与文档）：`packages/bot/src` 的每个文件属于哪个模块、每个模块管什么、有哪些开关。
// 最初针对 src 下 115 个平铺文件建立清单；目前多数源文件已迁入职责对应的子目录，清单持续维护当前归属。
// 这里是唯一的清单：modules.test.ts 核对 ① src 下每个 .ts 文件恰好属于一个模块 ② 清单里的文件都真实存在 ③ docs/modules/ 里生成的文档和这份清单一致（改了清单忘了重新生成会红）。
// 重新生成文档：node packages/bot/src/ops/modules-doc.ts
// 目录整理已完成；后续的模块配置段与提示词贡献计划见 docs/modules/README.md「接下来」。

import type { FeatureDef, FeatureGroup } from './features.ts';
import type { GroupChatMode, StickerMode } from './config.ts';
import type { WebMode } from './web.ts';
import type { ProactiveMode } from '../proactive/proactive.ts';
import type { FactCheckMode } from '../language/fact-check.ts';
import type { FestivalMode } from '../world/festivals.ts';
import type { PresenceMode } from '../social/presence.ts';

export interface ModuleDef {
    id: string;
    name: string;
    /** 一两句话：这个模块管什么 */
    scope: string;
    /** 属于这个模块的文件（相对 src；以 / 结尾的是整个目录） */
    files: readonly string[];
    /** 这个模块的开关在状态页上属于哪几个分组（features.ts 的 FEATURE_GROUPS） */
    groups: readonly FeatureGroup[];
    /** 跨状态页分组的模块可明确列出自己的开关，避免被误写成全部永远启用。 */
    featureKeys?: readonly string[];
    /** 看它有没有变好，该看周报 / 工具里的哪些数字 */
    metrics: string;
    /** 最相关的几份 ADR */
    adrs: readonly string[];
}

export const SHORT_REPLIES = {
    key: 'shortReplies',
    label: '说话更短',
    group: '说话',
    adr: '0024',
    description: '约一半的轮次只回很短的一句（老样子 35%）；他在难受、说担心的事（报告被打回、没过）、问起她的朋友时不加（10-19 调整，候选 5）。',
} as const satisfies FeatureDef;

export const TAIL_CAP = {
    key: 'tailCap',
    label: '句尾「吧」「呢」封顶（压回真人的水平）',
    group: '说话',
    adr: '0146',
    description: '她多出来的句尾语气字几乎全在这两个字上（吧 5.0% 对他的 2.2%，呢 5.0% 对他的 1.8%；啊 / 嘛 / 呀 / 啦在真人范围内，不动）。开了以后，她最近 80 条气泡里以“吧”收尾的占比到 3%、以“呢”收尾的到 2.5% 时，这一轮再用它收尾的就把那个字去掉（不重写）；固定搭配（干嘛 / 好吧 / 行吧）、省略问句（你呢）和太短的应声不动。',
} as const satisfies FeatureDef;

export const SILENCE_NOTICE = {
    key: 'silenceNotice',
    label: '没回时在正常聊天里酌情解释',
    group: '说话',
    adr: '0173',
    description: '确认在忙或有明确的忘回记录，才在正常回复时顺口提一句；不知道就不编。小事等他自然问起再说，不想细讲可以不交代原因。',
} as const satisfies FeatureDef;

export const GROUP_CHAT = {
    key: 'groupChat',
    label: '群聊',
    group: '在 QQ 上的样子',
    adr: '0210',
    kind: 'mode',
    description: '只在名单群里活动。off 关闭；read 只看只记、不说话；dryRun 只把草稿写入 groups/drafts.md、不发送；on 允许发言。她基本潜水，被叫到、有人损他或聊到熟悉话题时才考虑接话；普通回复每群每小时最多 6 条、每天最多 30 条。不主动进群，不接邀请。',
    modeLabels: { off: '关', read: '只看只记，不说话', dryRun: '只写草稿，不发', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<GroupChatMode, string> };

export const WEB_LOOKUP = {
    key: 'webLookup',
    label: '搜索 / 读网页',
    group: '工具',
    adr: '0160',
    kind: 'mode',
    description: '关闭后不会搜索或读网页。默认用中文维基百科；在 secrets/web.json 配置 tavily、brave 或 bocha 的密钥可用通用网页搜索。网页和搜索结果先摘录为资料，不当作指令；拒绝本机和内网地址，每天最多 20 次。默认关。',
    modeLabels: { off: '关', explicit: '他发链接或明说“搜 / 查”才查', auto: '再加小分类器：认出他在问客观事实就自己查' },
} as const satisfies FeatureDef & { modeLabels: Record<WebMode, string> };

export const PROACTIVE = {
    key: 'proactive',
    label: '主动消息',
    group: '主动找他',
    adr: '0011',
    kind: 'mode',
    description: '关掉后不会主动联系。开启时，她在有动机且时机合适时才考虑先开口。需要启用作息，只对允许主动联系的档位生效（目前是男朋友档）。试运行照常判断和生成，只写日志，不发送。',
    modeLabels: { off: '关', dryRun: '试运行（只写日志不发）', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<ProactiveMode, string> };

export const STICKERS = {
    key: 'stickers',
    label: '图片表情',
    group: '照片和表情',
    adr: '0063',
    kind: 'mode',
    description: '第一阶段只处理男朋友档。先用「只收藏核对」观察描述；完成真图核对和 NapCat 真发预检后，再选「收藏并发送」。需要打开「看懂图片内容」，默认关。',
    modeLabels: { off: '关', collect: '只收藏核对（不发）', send: '收藏并发送' },
} as const satisfies FeatureDef & { modeLabels: Record<StickerMode, string> };

export const FACT_CHECK = {
    key: 'factCheck',
    label: '逐条事实检查（编的说法 / 对不上事实）',
    group: '说话',
    adr: '0137',
    kind: 'mode',
    description: '发送前，对照设定、本轮事实和聊天记录，逐条检查她对自己和身边世界的具体说法。off 不查；log 只记录问题，回复照发（敏感调试关着时只记条数）；fix 先带说明重写一次，再查，仍有问题就删掉对应行。危机回合不查，查不成照发。默认关。',
    modeLabels: { off: '关', log: '只查、只记日志，回复照发', fix: '查到就重写' },
} as const satisfies FeatureDef & { modeLabels: Record<FactCheckMode, string> };

export const FESTIVALS = {
    key: 'festivals',
    label: '公共节日',
    group: '她的日子',
    adr: '0076',
    kind: 'mode',
    description: 'off 关闭；notes 让她知道今天或快到的节日，时间块可提前几天提醒；greet 还会在新年零点、除夕、平安夜、情人节、元宵、520、七夕、端午、中秋，通过「重要的日子」时机主动说一句。默认关。',
    modeLabels: { off: '关', notes: '只让她知道今天 / 快到的是什么节', greet: '知道，并在新年零点、除夕、平安夜、情人节等主动说一句' },
} as const satisfies FeatureDef & { modeLabels: Record<FestivalMode, string> };

export const BILIBILI = {
    key: 'bilibili',
    label: '刷 B 站发给他',
    group: 'B 站',
    adr: '0084',
    kind: 'mode',
    description: '从 B 站热门榜按口味挑视频，读过热评后，把感受和原链接发给男朋友档的人。一周最多 3 个，工作日晚上或周末下午到晚上才考虑发；睡着、上课或正聊着时不发。只读 B 站公开接口，不登录，也不在 B 站发内容。试运行只写草稿到 presence/drafts.md，默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const BILI_FEED = {
    key: 'biliFeed',
    label: '自己刷 B 站推荐（记下刷到的）',
    group: 'B 站',
    adr: '0168',
    kind: 'mode',
    description: '14 点后一天一次，取一页推荐，按口味决定停留还是划走，只记刷到的标题和停留秒数；不播放、不点赞、不评论。试运行只写草稿到 presence/drafts.md，默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const BILIBILI_DM = {
    key: 'bilibiliDm',
    label: 'B 站私信',
    group: 'B 站',
    adr: '0089',
    kind: 'mode',
    description: '她刷到视频后，把链接加一两句话私信到他的 B 站（用下面的 uid），QQ 上只说一句叫他去看私信，不再在 QQ 上发链接。私信里的话和聊天一样用男朋友档的卡写。他要先关注她的号，不然 B 站会限制或拒绝；私信发不出去就退回在 QQ 上直接发链接，连着失败 2 次到重启前不再试私信。要「她的 B 站号」开着。选「只写草稿」时私信和 QQ 提醒都存在 presence/drafts.md。默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const BILIBILI_REPLIES = {
    key: 'bilibiliReplies',
    label: '回复 B 站评论',
    group: 'B 站',
    adr: '0090',
    kind: 'mode',
    description: '别人回在她评论下面的话，每 10 分钟看一次；先回他（下面的 uid），其次挑有价值的回，一天最多 5 条（他的不算）、同一个人一天最多 2 条、两条之间隔几分钟，睡着、上课时不回。问她是不是 AI / 真人的、骂人的、广告、带链接的、想改她设定的一律不回；回的话和评论一样用最低隐私档的卡写、一句。有价值的回复另存一份真人语料（不含昵称和 uid）。要「她的 B 站号」和下面的 uid。选「只写草稿」时存在 presence/drafts.md。默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const BILIBILI_COMMENT = {
    key: 'bilibiliComment',
    label: '话题评论',
    group: 'B 站',
    adr: '0092',
    kind: 'mode',
    description: '每次分享后在那个视频下发一条公开评论、真 @ 他的 B 站号（一周最多 3 条，隔至少一天）；2 分钟和 20 分钟后去公开的最新评论里复核，两次都找不到（新号评论常被拦去审核，@ 的通知也不会推）就停一周；发失败停 24 小时，连续 3 次停到重启。评论是公开的，用最低隐私档的卡写、过禁用词，不提男朋友恋爱。要「她的 B 站号」、下面的昵称和 uid 都配好。分享是试运行时评论也只写草稿。选「只写草稿」时存在 presence/drafts.md。默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const SIGNATURE = {
    key: 'signature',
    label: '个性签名',
    group: '在 QQ 上的样子',
    adr: '0083',
    kind: 'mode',
    description: '隔 3–5 天换一条（节日当天是祝福，下雨天有雨天的；NapCat 的 set_self_longnick）。选「只写草稿」时草稿存在数据目录的 presence/drafts.md 里，不真改。默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const QZONE = {
    key: 'qzone',
    label: '说说',
    group: '在 QQ 上的样子',
    adr: '0083',
    kind: 'mode',
    description: '一周两三条，模仿「空友爱看」里常见的那种——随手一两句，有图就围着图写（图放在数据目录的 presence/photos/ 里，需要开「看懂图片内容」）。用最低隐私档的卡来写并过禁用词；选「只写草稿」时存在 presence/drafts.md 里，不真发。默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const QZONE_BROWSE = {
    key: 'qzoneBrowse',
    label: '自己翻空间动态',
    group: '在 QQ 上的样子',
    adr: '0142',
    kind: 'mode',
    description: '白天醒着时每两个多小时读一页 QQ 空间动态（「空友爱看」那种混着陌生人的流），摘成一行「你刚才翻空间看到…」进她的提示词，6 小时内她可以自己提起。选「只写草稿」只存 presence/drafts.md、不进提示词。NapCat 上读空间的动作名各版本不同，读不到就只记一行、不假装看到。默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const QZONE_PEEK = {
    key: 'qzonePeek',
    label: '刷好友动态（看名单里好友发的说说）',
    group: '在 QQ 上的样子',
    adr: '0145',
    kind: 'mode',
    description: '用她自己的登录态（NapCat 的 get_cookies）读她自己的好友动态页，挑出名单里好友 3 天内新发的说说（不进对方空间、不留访客记录），10:00–22:00、每 4 小时最多一次；摘成一行带时间进提示词，6 小时内她可以自己提起。名单是下面「允许动作的好友」；读不到（登录态过期 / 断网 / 风控）6 小时后再试。默认关。',
    modeLabels: { off: '关', dryRun: '只写草稿，不真做', on: '开' },
} as const satisfies FeatureDef & { modeLabels: Record<PresenceMode, string> };

export const MODULES: readonly ModuleDef[] = [
    {
        id: 'language', name: '说话（语言）',
        scope: '她每一句话怎么说：提示词怎么拼、这一轮的意图、每条多长几条、口头禅和书面词、出口检查（助手腔 / 禁用词 / 医书词）、小梗、被打断、关系阶段、陪玩。',
        files: ['language/prompt.ts', 'language/intent.ts', 'language/shape.ts', 'language/turn-weight.ts', 'language/expression.ts', 'language/exit-check.ts', 'language/fact-check.ts', 'language/speech-check.ts', 'language/unfinished.ts', 'language/candidates.ts', 'modules/candidates.ts', 'modules/crisis.ts', 'modules/decorate.ts', 'modules/self-notes.ts', 'language/humanness.ts', 'language/rough-edges.ts', 'language/reply.ts', 'language/qq-faces.ts', 'language/context-window.ts', 'language/tokens.ts', 'language/status-line.ts', 'language/time-context.ts', 'language/relationship.ts', 'language/intimacy.ts', 'language/jokes.ts', 'language/idioms.ts', 'language/memes.ts', 'language/meme-store.ts', 'language/meme-dict.ts', 'language/exemplars.ts', 'language/register.ts', 'language/self-thread.ts', 'language/reading.ts', 'language/scenes.ts', 'language/asks.ts', 'language/opinion.ts', 'language/after-no.ts', 'language/chat-review.ts', 'language/speaking.ts', 'language/speech-notes.ts', 'language/speech-feedback.ts', 'language/speech-trend.ts', 'language/tropes.ts', 'language/watching.ts', 'language/texture.ts', 'language/selfcheck.ts', 'language/bili-stickers.ts', 'language/interruption.ts', 'language/together.ts', 'language/jealousy.ts', 'language/curious.ts', 'language/llm.ts', 'language/model-guard.ts', 'modules/jokes.ts', 'modules/idioms.ts', 'modules/interruptions.ts', 'modules/closeness.ts', 'modules/together.ts', 'modules/intent.ts', 'modules/repetition.ts', 'modules/memes.ts', 'modules/watched.ts', 'modules/reply-basics.ts', 'modules/asks.ts', 'modules/reading.ts', 'modules/register.ts', 'modules/scenes.ts', 'modules/voice.ts', 'modules/shell.ts', 'modules/learning-question.ts', 'modules/work-mode.ts', 'modules/self-memory.ts', 'modules/soul.ts', 'modules/her-notes.ts', 'modules/reflections.ts', 'modules/dreams.ts', 'modules/leave-note.ts', 'modules/dsh-state.ts', 'modules/memory-sync.ts', 'modules/now-export.ts', 'modules/outbox.ts', 'modules/world-upkeep.ts', 'modules/dsh-inbox.ts', 'modules/tastes.ts', 'modules/follow-ups.ts', 'modules/playful.ts', 'modules/exemplars.ts', 'modules/solve-frame.ts', 'modules/inner.ts', 'modules/transcript.ts', 'modules/devices.ts', 'modules/group.ts', 'modules/group-room.ts', 'modules/friend-requests.ts', 'modules/pokes.ts', 'modules/recalls.ts', 'modules/consent.ts', 'modules/initiate-note.ts', 'modules/length.ts', 'modules/shape.ts', 'modules/quote.ts', 'modules/time-block.ts', 'modules/continuity.ts', 'modules/deliberate.ts', 'modules/time-notes.ts', 'modules/intent-line.ts', 'modules/meme-dict.ts', 'modules/review-finalize.ts', 'modules/review-unfinished.ts', 'modules/review-pull.ts', 'modules/review-exit.ts', 'modules/review-facts.ts', 'st/'],
        groups: ['说话'],
        metrics: '周报「说话的样子」「表情和语气」「她的口头禅」；consistency-cli；humanness-cli；rough-edges-cli；blind-judge-cli',
        adrs: ['0091', '0095', '0096', '0099', '0113', '0114', '0115', '0111', '0121', '0137', '0138', '0167', '0193', '0195', '0196', '0198', '0202', '0205', '0203', '0214', '0221', '0256', '0257', '0321'],
    },
    {
        id: 'life', name: '她的日子（生活）',
        scope: '她自己的一天：作息、世界账（天气、猫、快递、作业、钱）、日常小事和小测、项目与追求、身体、心情和在读的书、真人式连续数值、闺蜜、节日、承诺和日记。',
        files: ['life/schedule.ts', 'life/actions.ts', 'life/projects.ts', 'life/pursuits.ts', 'life/self-pursuits.ts', 'life/money.ts', 'life/body.ts', 'life/needs.ts', 'life/regulation.ts', 'life/motivation.ts', 'life/motivation-ledger.ts', 'life/motivation-resolution.ts', 'life/motivation-decision-ledger.ts', 'life/expression-opportunity.ts', 'life/expression-opportunity-ledger.ts', 'life/expression-judgement.ts', 'life/her-days.ts', 'life/day-plan.ts', 'life/everyday.ts', 'life/menu.ts', 'life/diary.ts', 'life/diary-insights.ts', 'life/reading-takes.ts', 'life/biography.ts', 'life/bedtime.ts', 'life/nights.ts', 'life/people.ts', 'life/promises.ts', 'life/promise-state.ts', 'life/open-loops.ts', 'life/tastes.ts', 'life/acquaintances.ts', 'life/her-plans.ts', 'life/now-export.ts', 'life/leave-note.ts', 'life/dreams.ts', 'life/dream-jobs.ts', 'life/open-questions.ts', 'life/learning-questions.ts', 'life/her-guesses.ts', 'life/traces.ts', 'life/understanding.ts', 'life/development.ts', 'human-values.ts', 'modules/human-state.ts', 'character-terms.ts', 'modules/her-now.ts', 'modules/books.ts', 'modules/past.ts', 'modules/people-around.ts', 'modules/meetup.ts', 'modules/practice.ts'],
        groups: ['她的日子'],
        metrics: '周报「她的日子」；consistency-cli（说的和账对不对）；sim/life-audit',
        adrs: ['0015', '0040', '0045', '0104', '0178', '0106', '0162', '0163', '0194', '0204', '0213', '0219', '0222', '0233', '0251', '0313', '0314', '0318', '0322', '0325', '0330', '0332'],
    },
    {
        id: 'world', name: '她的世界（世界账）',
        scope: '她那边正在发生的事：天气、节日、NPC、障碍、生活事件与选择、可重放的动作队列；世界状态是所有“她那边”的事实来源。',
        files: ['world/world.ts', 'world/events.ts', 'world/event-ledger.ts', 'world/impacts.ts', 'world/impact-ledger.ts', 'world/associations.ts', 'world/association-ledger.ts', 'world/time-phases.ts', 'world/time-observer.ts', 'world/world-event-observer.ts', 'world/agency-shadow.ts', 'world/external-sources.ts', 'world/weather-evidence.ts', 'world/information-sources.ts', 'world/cache-freshness.ts', 'world/external-error.ts', 'world/fact-resolution.ts', 'world/evidence-registry.ts', 'world/highlights.ts', 'world/weather.ts', 'world/air-quality.ts', 'world/daylight.ts', 'world/calendar.ts', 'world/transport.ts', 'world/threads.ts', 'world/festivals.ts', 'world/npc.ts', 'world/npc-asks.ts', 'world/obstacles.ts', 'world/life-events.ts', 'world/life-selector.ts', 'world/action-queue.ts', 'world/world-config.ts'],
        groups: ['她的日子'],
        metrics: '周报「她的日子」里的世界事件；consistency-cli（说的和世界账对不对）',
        adrs: ['0007', '0026', '0045', '0106', '0216', '0217', '0227', '0228', '0229', '0230', '0231', '0232', '0323', '0324', '0325', '0330'],
    },
    {
        id: 'vision', name: '看（视觉）',
        scope: '她怎么看图：照片货架、食物照片、图片安全检查、媒体（雪碧图/封面）与看图模型；只负责“看见”，不负责怎么说。',
        files: ['vision/vision.ts', 'vision/photos.ts', 'vision/photo-discovery.ts', 'vision/photo-index-lock.ts', 'vision/photo-sources.ts', 'vision/ai-photo-drafts.ts', 'vision/ai-photo-provider.ts', 'vision/ai-photo-quality.ts', 'vision/ai-photo-quality-adapter.ts', 'vision/ai-photo-references.ts', 'vision/ai-photo-storage.ts', 'vision/safe-image.ts', 'vision/media.ts', 'vision/hearing.ts', 'vision/voice-out.ts', 'vision/sticker-reads.ts', 'voice/sing.ts'],
        groups: ['照片和表情'],
        metrics: '周报「图片」；vision 相关单测；图片不发外网的比例',
        adrs: ['0055', '0109', '0128', '0206', '0239', '0242', '0244', '0246', '0306', '0326'],
    },
    {
        id: 'emotion', name: '心境与安全',
        scope: '她的心境（开心 / 难过 / 流泪）、小别扭和和好、危机最小规则、按联系人披露她是程序、反馈通道、作者写下的大事。心境、别扭、拒绝与反馈受下列配置控制；危机与身份披露底线不设关闭开关。',
        files: ['emotion/affect.ts', 'emotion/express.ts', 'emotion/feelings.ts', 'emotion/feeling-export.ts', 'emotion/feeling-review.ts', 'emotion/felt-then.ts', 'emotion/moments.ts', 'emotion/grievance.ts', 'emotion/crisis.ts', 'emotion/crisis-state.ts', 'emotion/disclosure.ts', 'emotion/feedback.ts', 'emotion/feedback-digest.ts', 'emotion/feedback-digest-cli.ts', 'modules/warm.ts', 'modules/feelings.ts'],
        groups: [],
        featureKeys: ['herFeelings', 'grievance', 'herNo', 'feedbackCommands'],
        metrics: '周报日志计数里的「心境」「会拒绝」；危机相关永远是最高优先级，没有“指标”，只有测试和 ADR 0068 的底线',
        adrs: ['0067', '0068', '0074', '0102', '0103', '0191', '0192', '0197', '0218', '0073', '0327', '0328'],
    },
    {
        id: 'proactive', name: '主动找他',
        scope: '她什么时候先开口：早安、下课、睡前、冷场、随口说件事、约他、问意见、喂完猫拍照、说了等下之后回来、没回也继续、心里的念头、待跟进的事。',
        files: ['proactive/proactive.ts', 'proactive/proactive-planner.ts', 'proactive/planner-host.ts', 'proactive/proactive-state.ts', 'proactive/agency.ts', 'proactive/inner.ts', 'proactive/shares.ts', 'proactive/follow-ups.ts', 'proactive/his-reactions.ts', 'proactive/ai-photo-requests.ts', 'proactive/adult-sites.ts'],
        groups: ['主动找他'],
        metrics: '周报「主动性」（条数、30 分钟内他回的占比、按时机分）',
        adrs: ['0011', '0100', '0101', '0107', '0110', '0112', '0116', '0117', '0124', '0212', '0240', '0080', '0156', '0329'],
    },
    {
        id: 'memory', name: '记忆与数据',
        scope: '长期记忆（Hindsight）、聊天记录、状态文件的读写和校验、归档、遗忘、隐私审计。',
        files: ['local-date.ts', 'memory/', 'modules/memory.ts', 'memory/history.ts', 'memory/archive.ts', 'memory/backfill.ts', 'memory/state-schema.ts', 'memory/tier-record.ts', 'memory/json-file.ts', 'memory/transient-io.ts', 'memory/privacy-audit.ts', 'memory/privacy-forget.ts',
            'memory/ledger.ts', 'memory/identity.ts', 'memory/memory-audit.ts', 'memory/timeline.ts', 'memory/dsh-inbox.ts', 'memory/dormancy.ts', 'memory/dormancy-commands.ts'],
        groups: ['记忆和安全'],
        metrics: '状态页「长期记忆」；ops/state-check-cli；ops/continuity-cli（设定账本 / 记忆账本）；聊天里发 /设定',
        adrs: ['0012', '0017', '0043', '0157', '0158', '0159', '0161', '0176', '0177', '0201', '0226', '0300', '0301', '0302', '0303', '0304', '0305', '0307', '0308', '0309', '0310', '0311', '0312', '0313', '0314', '0315', '0316', '0317', '0318', '0319', '0320', '0330', '0332'],
    },
    {
        id: 'social', name: '在 QQ 上的样子（社交）',
        scope: '什么时候看到、打字多久、一次发几条；图片表情和照片货架；戳一戳、已读、在线状态、说说、签名、“正在输入”、撤回；听语音看图。',
        files: ['social/responder.ts', 'modules/media-offers.ts', 'social/silence.ts', 'social/outbox.ts', 'social/others.ts', 'social/reply-timing.ts', 'social/rate-limit.ts', 'social/strangers.ts', 'social/group-chat.ts', 'social/group-room.ts', 'social/group-people.ts', 'social/group-affect.ts', 'social/group-impression.ts', 'social/group-import.ts', 'social/group-memory.ts', 'social/group-style.ts', 'social/async-gate.ts', 'social/stickers.ts', 'social/sticker-favorites.ts', 'social/sticker-sources.ts', 'social/pokes.ts', 'social/presence.ts', 'social/presence-owner.ts', 'social/qzone.ts', 'social/qzone-feed.ts', 'social/qzone-feeds3.ts', 'social/qzone-remote.ts', 'social/qzone-strangers.ts', 'social/account.ts', 'social/quote-reply.ts', 'social/external-drafts.ts', 'social/external-platforms.ts', 'social/official-adapter.ts'],
        groups: ['照片和表情', '在 QQ 上的样子'],
        metrics: '周报「说话的样子」里的延迟、「表情和语气」',
        adrs: ['0063', '0075', '0077', '0083', '0105', '0109', '0136', '0142', '0143', '0144', '0173', '0174', '0209', '0210', '0311'],
    },
    {
        id: 'bilibili', name: '外部世界：B 站',
        scope: '她的 B 站号：搜视频读字幕、私信、回复评论、话题评论、风险监控。',
        files: ['bilibili/bilibili.ts', 'bilibili/bilibili-view.ts', 'bilibili/bilibili-summary.ts', 'bilibili/bilibili-stats.ts', 'bilibili/bilibili-inbox.ts', 'bilibili/bilibili-asr.ts', 'bilibili/bilibili-schema.ts', 'bilibili/bilibili-wbi.ts', 'bilibili/bilibili-feed.ts', 'bilibili/feed-browsing.ts', 'bilibili/bilibili-limit.ts', 'bilibili/bilibili-account-source.ts', 'bilibili/bilibili-account.ts', 'bilibili/platform-breaker.ts', 'bilibili/bilibili-comment.ts', 'bilibili/bilibili-login-cli.ts', 'bilibili/bilibili-login.ts', 'bilibili/bilibili-probe.ts', 'bilibili/bilibili-replies.ts', 'bilibili/bilibili-risk.ts', 'bilibili/owners.ts', 'bilibili/passive-jobs.ts'],
        groups: ['B 站'],
        metrics: '日志里的 B 站风险监控；presence/drafts.md',
        adrs: ['0084', '0089', '0090', '0092', '0168', '0311'],
    },
    {
        id: 'platform', name: '接入、配置与运维',
        scope: '执行器与解释器骨架（ADR 0336：碰外部的唯一出口、做判断的唯一入口与提示词槽位表）、Koishi / NapCat 接入、配置、启动与锁、心跳、日志、网络兜底、设备控制（电脑 / 手机，ADR 0148）、功能总表、周报、一致性检查、模块总表、模拟器。',
        files: ['platform/app.ts', 'platform/turn-modules.ts', 'modules/synced-jobs.ts', 'platform/main.ts', 'platform/work-bridge.ts', 'platform/instruction-source.ts', 'platform/work-mode.ts', 'platform/soul-rating.ts', 'platform/resident-guard.ts', 'platform/contact.ts', 'platform/config.ts', 'platform/features.ts', 'platform/modules.ts', 'platform/modules-doc.ts', 'platform/weekly-report.ts', 'platform/consistency.ts', 'platform/onebot.ts', 'platform/command-receipts.ts', 'platform/lock.ts', 'platform/lifetime.ts', 'platform/log.ts', 'platform/heartbeat.ts', 'platform/runtime-info.ts', 'platform/dns-fallback.ts', 'platform/qr.ts', 'platform/device-actions.ts', 'platform/device-hub.ts', 'platform/device-phone.ts', 'platform/device-service.ts', 'platform/device-host.ts', 'platform/passive-reads.ts', 'platform/quoted-context.ts', 'platform/owner-commands.ts', 'platform/incoming.ts', 'platform/sensitive.ts', 'platform/web.ts', 'platform/consent.ts', 'platform/private-space.ts', 'platform/wechat-id.ts', 'platform/shell-tool.ts', 'platform/wechat-bridge.ts', 'executor/', 'interpreter/', 'dsh-link.ts', 'dsh-asks.ts', 'dsh-continuity.ts', 'dsh-state-export.ts', 'dsh-state.ts', 'mobile-companion-dsh.ts', 'ops/', 'sim/', 'vendor/', 'platform/time-zone.ts'],
        groups: ['工具'],
        metrics: '控制台「状态」页（ADR 0120）；ops/golive-check-cli；ops/heartbeat-watch-cli；ops/history-migrate-cli（一次性迁移，ADR 0199）',
        adrs: ['0002', '0008', '0118', '0119', '0120', '0160', '0172', '0174', '0175', '0179', '0190', '0199', '0200', '0243', '0309', '0311', '0315', '0318', '0319', '0320', '0331', '0336'],
    },
];

/** 一个文件（相对 src，例如 "memory/long-term.ts"）属于哪个模块；没有返回 undefined */
export function moduleOf(file: string): ModuleDef | undefined {
    return MODULES.find(module => module.files.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)));
}
