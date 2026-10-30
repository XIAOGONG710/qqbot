// 模块总表（ADR 0122，A14 的第一步：只分类、只写文档，不动任何运行代码）：`packages/bot/src` 的每个文件属于哪个模块、每个模块管什么、有哪些开关。
// 为什么：src 下 115 个平铺的文件，app.ts / contact.ts 各自拼几十个 import，想知道“记忆这块有哪些文件”“主动这块有哪些开关”只能靠记。
// 这里是唯一的清单：modules.test.ts 核对 ① src 下每个 .ts 文件恰好属于一个模块 ② 清单里的文件都真实存在 ③ docs/modules/ 里生成的文档和这份清单一致（改了清单忘了重新生成会红）。
// 重新生成文档：node packages/bot/src/ops/modules-doc.ts
// 后续的步骤（把文件真的挪进子目录、每个模块自己的配置段、提示词由各模块“贡献”）见 docs/modules/README.md「接下来」，都没做。

import type { FeatureGroup } from './features.ts';

export interface ModuleDef {
    id: string;
    name: string;
    /** 一两句话：这个模块管什么 */
    scope: string;
    /** 属于这个模块的文件（相对 src；以 / 结尾的是整个目录） */
    files: readonly string[];
    /** 这个模块的开关在状态页上属于哪几个分组（features.ts 的 FEATURE_GROUPS） */
    groups: readonly FeatureGroup[];
    /** 看它有没有变好，该看周报 / 工具里的哪些数字 */
    metrics: string;
    /** 最相关的几份 ADR */
    adrs: readonly string[];
}

export const MODULES: readonly ModuleDef[] = [
    {
        id: 'language', name: '说话（语言）',
        scope: '她每一句话怎么说：提示词怎么拼、这一轮的意图、每条多长几条、口头禅和书面词、出口检查（助手腔 / 禁用词 / 医书词）、小梗、被打断、关系阶段、陪玩。',
        files: ['language/prompt.ts', 'language/intent.ts', 'language/shape.ts', 'language/expression.ts', 'language/exit-check.ts', 'language/fact-check.ts', 'language/speech-check.ts', 'language/unfinished.ts', 'language/candidates.ts', 'language/humanness.ts', 'language/rough-edges.ts', 'language/reply.ts', 'language/qq-faces.ts', 'language/context-window.ts', 'language/tokens.ts',
            'language/status-line.ts', 'language/time-context.ts', 'language/relationship.ts', 'language/intimacy.ts', 'language/jokes.ts', 'language/idioms.ts', 'language/memes.ts', 'language/meme-dict.ts', 'language/exemplars.ts', 'language/register.ts', 'language/self-thread.ts', 'language/speech-notes.ts', 'language/speech-feedback.ts', 'language/speech-trend.ts', 'language/watching.ts', 'language/texture.ts', 'language/selfcheck.ts', 'language/bili-stickers.ts', 'language/interruption.ts', 'language/together.ts', 'language/jealousy.ts', 'language/curious.ts', 'language/llm.ts', 'language/model-guard.ts', 'st/'],
        groups: ['说话'],
        metrics: '周报「说话的样子」「表情和语气」「她的口头禅」；consistency-cli；humanness-cli；rough-edges-cli；blind-judge-cli',
        adrs: ['0091', '0095', '0096', '0099', '0113', '0114', '0115', '0111', '0121', '0137', '0138', '0167', '0193', '0195', '0196', '0198'],
    },
    {
        id: 'life', name: '她的日子（生活）',
        scope: '她自己的一天：作息、世界账（天气、猫、快递、作业、钱）、日常小事和小测、项目与追求、身体、心情和在读的书、闺蜜、节日、承诺和日记。',
        files: ['life/schedule.ts', 'life/actions.ts', 'life/projects.ts', 'life/pursuits.ts', 'life/self-pursuits.ts', 'life/money.ts', 'life/body.ts', 'life/needs.ts', 'life/her-days.ts', 'life/day-plan.ts',
            'life/everyday.ts', 'life/menu.ts', 'life/diary.ts', 'life/diary-insights.ts', 'life/biography.ts', 'life/bedtime.ts', 'life/people.ts', 'life/promises.ts', 'life/promise-state.ts', 'life/open-loops.ts', 'life/tastes.ts', 'life/acquaintances.ts', 'life/her-plans.ts', 'life/now-export.ts'],
        groups: ['她的日子'],
        metrics: '周报「她的日子」；consistency-cli（说的和账对不对）；sim/life-audit',
        adrs: ['0015', '0040', '0045', '0104', '0178', '0106', '0162', '0163', '0194'],
    },
    {
        id: 'world', name: '她的世界（世界账）',
        scope: '她那边正在发生的事：天气、节日、NPC、障碍、生活事件与选择、可重放的动作队列；世界状态是所有“她那边”的事实来源。',
        files: ['world/world.ts', 'world/weather.ts', 'world/festivals.ts', 'world/npc.ts', 'world/npc-asks.ts', 'world/obstacles.ts', 'world/life-events.ts', 'world/life-selector.ts', 'world/action-queue.ts'],
        groups: ['她的日子'],
        metrics: '周报「她的日子」里的世界事件；consistency-cli（说的和世界账对不对）',
        adrs: ['0007', '0026', '0045', '0106'],
    },
    {
        id: 'vision', name: '看（视觉）',
        scope: '她怎么看图：照片货架、食物照片、图片安全检查、媒体（雪碧图/封面）与看图模型；只负责“看见”，不负责怎么说。',
        files: ['vision/vision.ts', 'vision/photos.ts', 'vision/photo-sources.ts', 'vision/safe-image.ts', 'vision/media.ts'],
        groups: ['照片和表情'],
        metrics: '周报「图片」；vision 相关单测；图片不发外网的比例',
        adrs: ['0055', '0109', '0128'],
    },
    {
        id: 'emotion', name: '心境与安全',
        scope: '她的心境（开心 / 难过 / 流泪）、小别扭和和好、危机最小规则、按联系人披露她是程序、反馈通道、作者写下的大事。',
        files: ['emotion/affect.ts', 'emotion/feelings.ts', 'emotion/feeling-export.ts', 'emotion/feeling-review.ts', 'emotion/moments.ts', 'emotion/grievance.ts', 'emotion/crisis.ts', 'emotion/crisis-state.ts', 'emotion/disclosure.ts', 'emotion/feedback.ts', 'emotion/feedback-digest.ts', 'emotion/feedback-digest-cli.ts'],
        groups: [],
        metrics: '周报日志计数里的「心境」「会拒绝」；危机相关永远是最高优先级，没有“指标”，只有测试和 ADR 0068 的底线',
        adrs: ['0067', '0068', '0074', '0102', '0103', '0191', '0192', '0197'],
    },
    {
        id: 'proactive', name: '主动找他',
        scope: '她什么时候先开口：早安、下课、睡前、冷场、随口说件事、约他、问意见、喂完土豆拍照、说了等下之后回来、没回也继续、心里的念头、待跟进的事。',
        files: ['proactive/proactive.ts', 'proactive/proactive-planner.ts', 'proactive/proactive-state.ts', 'proactive/inner.ts', 'proactive/shares.ts', 'proactive/follow-ups.ts'],
        groups: ['主动找他'],
        metrics: '周报「主动性」（条数、30 分钟内他回的占比、按时机分）',
        adrs: ['0011', '0100', '0101', '0107', '0110', '0112', '0116', '0117', '0124'],
    },
    {
        id: 'memory', name: '记忆与数据',
        scope: '长期记忆（Hindsight）、聊天记录、状态文件的读写和校验、归档、遗忘、隐私审计。',
        files: ['memory/', 'memory/history.ts', 'memory/archive.ts', 'memory/backfill.ts', 'memory/state-schema.ts', 'memory/tier-record.ts', 'memory/json-file.ts', 'memory/transient-io.ts', 'memory/privacy-audit.ts', 'memory/privacy-forget.ts',
            'memory/ledger.ts', 'memory/identity.ts', 'memory/memory-audit.ts', 'memory/timeline.ts', 'memory/dormancy.ts'],
        groups: ['记忆和安全'],
        metrics: '状态页「长期记忆」；ops/state-check-cli；ops/continuity-cli（设定账本 / 记忆账本）；聊天里发 /设定',
        adrs: ['0012', '0017', '0043', '0157', '0158', '0159', '0161', '0176', '0177'],
    },
    {
        id: 'social', name: '在 QQ 上的样子（社交）',
        scope: '什么时候看到、打字多久、一次发几条；图片表情和照片货架；戳一戳、已读、在线状态、说说、签名、“正在输入”、撤回；听语音看图。',
        files: ['social/responder.ts', 'social/silence.ts', 'social/outbox.ts', 'social/others.ts', 'social/reply-timing.ts', 'social/rate-limit.ts', 'social/async-gate.ts', 'social/stickers.ts', 'social/sticker-favorites.ts', 'social/sticker-sources.ts', 'social/pokes.ts', 'social/presence.ts', 'social/qzone.ts', 'social/qzone-feed.ts', 'social/qzone-feeds3.ts', 'social/qzone-remote.ts', 'social/qzone-strangers.ts', 'social/account.ts', 'social/quote-reply.ts', ],
        groups: ['照片和表情', '在 QQ 上的样子'],
        metrics: '周报「说话的样子」里的延迟、「表情和语气」',
        adrs: ['0063', '0075', '0077', '0083', '0105', '0109', '0136', '0142', '0143', '0144', '0173', '0174'],
    },
    {
        id: 'bilibili', name: '外部世界：B 站',
        scope: '她的 B 站号：搜视频读字幕、私信、回复评论、话题评论、风险监控。',
        files: ['bilibili/bilibili.ts', 'bilibili/bilibili-view.ts', 'bilibili/bilibili-summary.ts', 'bilibili/bilibili-stats.ts', 'bilibili/bilibili-inbox.ts', 'bilibili/bilibili-asr.ts', 'bilibili/bilibili-schema.ts', 'bilibili/bilibili-wbi.ts', 'bilibili/bilibili-feed.ts', 'bilibili/feed-browsing.ts', 'bilibili/bilibili-limit.ts', 'bilibili/bilibili-account-source.ts', 'bilibili/bilibili-account.ts', 'bilibili/platform-breaker.ts', 'bilibili/bilibili-comment.ts', 'bilibili/bilibili-login-cli.ts', 'bilibili/bilibili-login.ts', 'bilibili/bilibili-probe.ts', 'bilibili/bilibili-replies.ts', 'bilibili/bilibili-risk.ts'],
        groups: ['B 站'],
        metrics: '日志里的 B 站风险监控；presence/drafts.md',
        adrs: ['0084', '0089', '0090', '0092', '0168'],
    },
    {
        id: 'platform', name: '接入、配置与运维',
        scope: 'Koishi / NapCat 接入、配置、启动与锁、心跳、日志、网络兜底、设备控制（电脑 / 手机，ADR 0148）、功能总表、周报、一致性检查、模块总表、模拟器。',
        files: ['platform/app.ts', 'platform/main.ts', 'platform/work-bridge.ts', 'platform/instruction-source.ts', 'platform/work-mode.ts', 'platform/soul-rating.ts', 'platform/resident-guard.ts', 'platform/contact.ts', 'platform/config.ts', 'platform/features.ts', 'platform/modules.ts', 'platform/modules-doc.ts', 'platform/weekly-report.ts', 'platform/consistency.ts', 'platform/onebot.ts', 'platform/lock.ts', 'platform/log.ts', 'platform/heartbeat.ts', 'platform/runtime-info.ts', 'platform/dns-fallback.ts', 'platform/qr.ts', 'platform/device-actions.ts', 'platform/device-hub.ts', 'platform/device-phone.ts', 'platform/device-service.ts',
            'platform/sensitive.ts', 'platform/web.ts', 'platform/consent.ts', 'ops/', 'sim/', 'vendor/'],
        groups: ['工具'],
        metrics: '控制台「状态」页（ADR 0120）；ops/golive-check-cli；ops/heartbeat-watch-cli',
        adrs: ['0002', '0008', '0118', '0119', '0120', '0160', '0172', '0174', '0175', '0179', '0190'],
    },
];

/** 一个文件（相对 src，例如 "memory/long-term.ts"）属于哪个模块；没有返回 undefined */
export function moduleOf(file: string): ModuleDef | undefined {
    return MODULES.find(module => module.files.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)));
}
