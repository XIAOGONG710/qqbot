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
        files: ['prompt.ts', 'intent.ts', 'shape.ts', 'expression.ts', 'exit-check.ts', 'speech-check.ts', 'candidates.ts', 'humanness.ts', 'reply.ts', 'qq-faces.ts', 'context-window.ts', 'tokens.ts',
            'status-line.ts', 'time-context.ts', 'relationship.ts', 'jokes.ts', 'interruption.ts', 'together.ts', 'jealousy.ts', 'llm.ts', 'model-guard.ts', 'st/'],
        groups: ['说话'],
        metrics: '周报「说话的样子」「表情和语气」「她的口头禅」；consistency-cli；humanness-cli；blind-judge-cli',
        adrs: ['0091', '0095', '0096', '0099', '0113', '0114', '0115', '0111', '0121'],
    },
    {
        id: 'life', name: '她的日子（生活）',
        scope: '她自己的一天：作息、世界账（天气、猫、快递、作业、钱）、日常小事和小测、项目与追求、身体、心情和在读的书、闺蜜、节日、承诺和日记。',
        files: ['schedule.ts', 'world.ts', 'life-selector.ts', 'life-events.ts', 'action-queue.ts', 'actions.ts', 'projects.ts', 'pursuits.ts', 'money.ts', 'body.ts', 'needs.ts', 'her-days.ts', 'day-plan.ts',
            'everyday.ts', 'menu.ts', 'weather.ts', 'festivals.ts', 'npc.ts', 'npc-asks.ts', 'obstacles.ts', 'diary.ts', 'biography.ts', 'bedtime.ts', 'people.ts', 'promises.ts', 'promise-state.ts', 'open-loops.ts'],
        groups: ['她的日子'],
        metrics: '周报「她的日子」；consistency-cli（说的和账对不对）；sim/life-audit',
        adrs: ['0015', '0040', '0045', '0104', '0106'],
    },
    {
        id: 'emotion', name: '心境与安全',
        scope: '她的心境（开心 / 难过 / 流泪）、小别扭和和好、危机最小规则、按联系人披露她是程序、反馈通道、作者写下的大事。',
        files: ['affect.ts', 'feelings.ts', 'moments.ts', 'grievance.ts', 'crisis.ts', 'crisis-state.ts', 'disclosure.ts', 'feedback.ts', 'feedback-digest.ts', 'feedback-digest-cli.ts'],
        groups: [],
        metrics: '周报日志计数里的「心境」「会拒绝」；危机相关永远是最高优先级，没有“指标”，只有测试和 ADR 0068 的底线',
        adrs: ['0067', '0068', '0074', '0102', '0103'],
    },
    {
        id: 'proactive', name: '主动找他',
        scope: '她什么时候先开口：早安、下课、睡前、冷场、随口说件事、约他、问意见、喂完土豆拍照、说了等下之后回来、没回也继续、心里的念头、待跟进的事。',
        files: ['proactive.ts', 'proactive-planner.ts', 'proactive-state.ts', 'inner.ts', 'shares.ts', 'follow-ups.ts'],
        groups: ['主动找他'],
        metrics: '周报「主动性」（条数、30 分钟内他回的占比、按时机分）',
        adrs: ['0011', '0100', '0101', '0107', '0110', '0112', '0116', '0117', '0124'],
    },
    {
        id: 'memory', name: '记忆与数据',
        scope: '长期记忆（Hindsight）、聊天记录、状态文件的读写和校验、归档、遗忘、隐私审计。',
        files: ['memory/', 'history.ts', 'archive.ts', 'backfill.ts', 'state-schema.ts', 'tier-record.ts', 'json-file.ts', 'transient-io.ts', 'privacy-audit.ts', 'privacy-forget.ts'],
        groups: ['记忆和安全'],
        metrics: '状态页「长期记忆」；ops/state-check-cli',
        adrs: ['0012', '0017', '0043'],
    },
    {
        id: 'rhythm', name: '节奏、图片和在 QQ 上的样子',
        scope: '什么时候看到、打字多久、一次发几条；图片表情和照片货架；戳一戳、已读、在线状态、说说、签名、“正在输入”、撤回；听语音看图。',
        files: ['responder.ts', 'reply-timing.ts', 'rate-limit.ts', 'async-gate.ts', 'stickers.ts', 'sticker-favorites.ts', 'sticker-sources.ts', 'photos.ts', 'photo-sources.ts', 'pokes.ts', 'presence.ts', 'qzone.ts', 'media.ts', 'safe-image.ts', 'vision.ts'],
        groups: ['照片和表情', '在 QQ 上的样子'],
        metrics: '周报「说话的样子」里的延迟、「表情和语气」',
        adrs: ['0063', '0075', '0077', '0083', '0105', '0109'],
    },
    {
        id: 'bilibili', name: '外部世界：B 站',
        scope: '她的 B 站号：搜视频读字幕、私信、回复评论、话题评论、风险监控。',
        files: ['bilibili.ts', 'bilibili-account-source.ts', 'bilibili-account.ts', 'bilibili-comment.ts', 'bilibili-login-cli.ts', 'bilibili-login.ts', 'bilibili-probe.ts', 'bilibili-replies.ts', 'bilibili-risk.ts'],
        groups: ['B 站'],
        metrics: '日志里的 B 站风险监控；presence/drafts.md',
        adrs: ['0084', '0089', '0090', '0092'],
    },
    {
        id: 'platform', name: '接入、配置与运维',
        scope: 'Koishi / NapCat 接入、配置、启动与锁、心跳、日志、网络兜底、功能总表、周报、一致性检查、模块总表、模拟器。',
        files: ['app.ts', 'main.ts', 'contact.ts', 'config.ts', 'features.ts', 'modules.ts', 'modules-doc.ts', 'weekly-report.ts', 'consistency.ts', 'onebot.ts', 'lock.ts', 'log.ts', 'heartbeat.ts', 'runtime-info.ts', 'dns-fallback.ts', 'qr.ts',
            'sensitive.ts', 'ops/', 'sim/', 'vendor/'],
        groups: ['工具'],
        metrics: '控制台「状态」页（ADR 0120）；ops/golive-check-cli；ops/heartbeat-watch-cli',
        adrs: ['0002', '0008', '0118', '0119', '0120'],
    },
];

/** 一个文件（相对 src，例如 "memory/long-term.ts"）属于哪个模块；没有返回 undefined */
export function moduleOf(file: string): ModuleDef | undefined {
    return MODULES.find(module => module.files.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)));
}
