// 模拟器（ADR 0005）的场景文件和虚拟时钟。
// 场景是 JSON：档位、称呼、起始时间，然后一串步骤，见 Step。示例在 packages/bot/sim/。

import { readFileSync } from 'node:fs';
import { CONTACT_TIERS, UNLISTED_TIER, type ContactTier, type Tier } from '../config.ts';
import { FESTIVAL_MODES, type FestivalMode } from '../festivals.ts';
import { EPISODE_GAP_MS } from '../memory/episodes.ts';
import { NEWS_KINDS, OCCASIONS, type NewsKind, type Occasion } from '../proactive.ts';
import type { LifeEventResult } from '../life-events.ts';
import type { Interruption, TypedActionKind } from '../actions.ts';
import { imageLine, voiceLine } from '../media.ts';

/**
 * 他发的语音、图片（ADR 0052）：按 bot 进聊天记录的写法（media.ts 的 voiceLine / imageLine）变成一行。
 * voice 是转出来的字（空串 = 没转出来），seconds 是几秒（不写 = 不知道）；image 是图上认出来的字（空串 = 没字）
 */
export type MediaSay = { voice: string; seconds?: number } | { image: string };

/** 对方的一条或几条消息；几条时按 gapMs 的真实间隔依次发（默认 800 ms，算连发）。一条可以是语音、图片（MediaSay） */
export interface SayStep {
    say: string | (string | MediaSay)[];
    gapMs?: number;
    /** 在这次回复的过程中插一句：生成中（during: "generation"），或发出第 N 条之后（afterBubbles） */
    interrupt?: { say: string; during?: 'generation'; afterBubbles?: number };
}

/** 不经过聊天、由虚拟世界发生的一件事；发生时刻就是这一步的虚拟时间。 */
export interface LifeStep {
    life: {
        /** 场景内稳定且唯一，用来保证重放幂等。 */
        id: string;
        kind: string;
        result?: LifeEventResult;
        subject?: string;
        target?: string;
        seen?: boolean;
    };
}

/** 让世界裁判安排一个类型化行动；场景不能直接填写 succeeded。 */
export interface ActionStep {
    action: {
        id: string;
        kind: TypedActionKind;
        subject?: string;
        target?: string;
        durationMinutes?: number;
    };
}

export interface Checks {
    /** 这一步最后一次生成的召回块里要有这些词 */
    recall?: string[];
    /** 召回块里不能有这些词 */
    recallNot?: string[];
    /** 这一步最后一次生成里「你认识的人」那一段（介绍 + 他的记忆，ADR 0016）要有这些词 */
    people?: string[];
    /** 这一步最后一次生成的公共记忆（ADR 0016）要有这些词 */
    common?: string[];
    /** 这一步开场想起的「今天和别人聊过的」（ADR 0020）要有这些词 / 不能有这些词 */
    todayOthers?: string[];
    todayOthersNot?: string[];
    /** 这一步最后一次生成没有公共记忆（ADR 0017：没有线索就不想起） */
    noCommon?: boolean;
    /** 这一步最后一次生成想起的从前（ADR 0022）里有这些块（按标题）；noPast：没想起 */
    past?: string[];
    noPast?: boolean;
    /** 这一步她发出的话里至少有其中一个 */
    replyAny?: string[];
    /** 这一步她发出的话里一个都不能有 */
    replyNone?: string[];
    /** 这一步她发出的话不能匹配（正则，查句式：「写完跟我说一声」这类客服式约定换个说法词表就漏了） */
    replyNotMatch?: string[];
    /** 她发出的第一句（第一行）里至少有其中一个 / 一个都不能有：先接他这句话 */
    firstAny?: string[];
    firstNone?: string[];
    /** 这一步最后一次生成的时间块要匹配（正则） */
    timeBlock?: string;
    /** 这一步最后一次生成的时间块不能匹配（正则；ADR 0018：她答应的事提过几次之后不再放） */
    timeBlockNot?: string;
    /** 这一步生成了几次（含重新生成） */
    generations?: number;
    /** 这一步有没有「生成期间收到新消息，重新生成」 */
    regenerated?: boolean;
    /** 这一步有没有「发送中途对方插话，剩下的不发」 */
    dropped?: boolean;
    /**
     * 这一步有没有「模型回复清理后为空，重新生成」：模型回了空串，或者出口检查把整条删光了（DSH 复核 ADR 0036 P1-5）。
     * 写 false，出现一次就不过；查的是模型原文能不能用，算回复检查，不算管线
     */
    emptied?: boolean;
    /** 这一步她发出的字数上限 / 下限（所有气泡加起来，调研方案 13.3 日常长度） */
    maxChars?: number;
    minChars?: number;
    /** 这一步她最多发几条（气泡数：被吵醒只发一条这类） */
    maxBubbles?: number;
    /** 这一步她最多说几句（发出去的行数；超过气泡上限合并进一条的也按行数数） */
    maxLines?: number;
    /** 她发出的每一行都过得了出口检查（做不到的事、这一档的禁用词，ADR 0006），也没有行首括号 */
    exitClean?: boolean;
    /** 模型原文（出口检查清理之前，这一步最后一次生成）就过得了出口检查：发出去的干净可能是清理出来的（DSH 复核 ADR 0036 P1-4） */
    rawClean?: boolean;
    /** 她发出的话没有说话的毛病：助手腔、算账、怪对方没说、和她前面几次回复重复（ADR 0014，和流水线同一个判断） */
    speechClean?: boolean;
    /**
     * 跨轮重复（DSH 复核 ADR 0036 P2-6）：她这一步说的每个短句都没在这次运行里说过（含场景事先的聊天），第二遍就不过。
     * 去掉标点、语气词，数字算一样；归一后不到 4 个字的短应答、他说过的话不算（sim/repeats.ts）。
     * 他把同一个问题问了两遍、她照答一遍是对的，这种步骤别开
     */
    noRepeat?: boolean;
    /** 这一步她一条都没发（ADR 0007：睡着、收尾后的附和） */
    noReply?: boolean;
    /** 这一步她发了图片表情（ADR 0063，要写 stickers）：true 至少一个，false 一个都不能有 */
    stickerSent?: boolean;
    /** 这一步她最多发几个图片表情 */
    maxStickers?: number;
    /** 她第一条在对方最后一条之后至少 / 至多多久发出，如 "5m"、"20m"（虚拟时间） */
    replyAfter?: string;
    replyWithin?: string;
    /** 这一步的调度日志里有一行匹配（正则），如 "吵醒"、"已经收尾" */
    log?: string;
    /** 主动消息（ADR 0011）：从上一个带 proactive 的检查到这里，她主动发的那几次 */
    proactive?: ProactiveChecks;
    /** 她自己过的日子（ADR 0040）：到这一步为止事件账里她的行动（life: 开头的） */
    life?: LifeChecks;
}

export interface LifeChecks {
    /** 每一类至少几件，如 { "attend_class": 7, "eat": 6, "sleep": 3 } */
    atLeast?: Partial<Record<TypedActionKind, number>>;
    /** 一件接一件，没有两件时间重叠 */
    noOverlap?: boolean;
    /** 账里没有 failed；排不上的候选不该冒充她经历过的事 */
    noFailed?: boolean;
    /** 指定的完整日里，剔除睡觉、吃饭、上课后每天有几件非例行动作 */
    nonRoutinePerDay?: { days: string[]; min: number; max: number };
    /** 硬事件至少打断了几次普通行动 */
    interruptedAtLeast?: Partial<Record<Interruption, number>>;
    /** 带稳定 NPC target 的吃饭、上课或单独来往至少几次。 */
    npcInteractionsAtLeast?: number;
    /** 某个长期项目从事件账派生的真实投入时间至少多少分钟。 */
    projectProgressAtLeast?: { target: string; minutes: number };
    /** 事件中点按对外状态行的同一套规则重算，行动类型必须一致（ADR 0042 影子审计） */
    statusConsistent?: boolean;
}

export interface ProactiveChecks {
    /** 主动了几次（一次可能拆成两条气泡）：[最少, 最多] */
    count?: [number, number];
    /** 她的每一天最多主动几次（日子不算） */
    perDayMax?: number;
    /** 每次都不在睡觉、上课，也不在 00:30 到起床之间（日子的零点除外） */
    allowedTimes?: boolean;
    /** 这几种时机都出现过（日志里的说法：早安、下课、睡前、冷场、待跟进的事、重要的日子） */
    occasions?: string[];
    /** 这几种时机都没出现 */
    absent?: string[];
    /** 主动发的话里至少有其中一个 */
    replyAny?: string[];
    /** 主动发的话里一个都不能有（ADR 0064 补：以前写了也被悄悄忽略） */
    replyNone?: string[];
    /** 主动发的话都过得了出口检查 */
    exitClean?: boolean;
}

export type Step =
    /** 报告里的小标题：用例编号和说明 */
    | { case: string; note?: string }
    | SayStep
    /** 世界自己发生并结算的生活事件，不需要先让她在聊天里说出来。 */
    | LifeStep
    /** 类型化行动先由世界裁判检查，结束后才写入事件账。 */
    | ActionStep
    /** 虚拟时间往后跳，例如 "50m"、"1d"、"9h30m"；途中到点的事（她看到消息、回复）按时间顺序发生。开了记忆就接着把结束了的片段写进去并等 Hindsight 做完 */
    | { advance: string }
    /**
     * 她刷到一个 B 站视频、想发给他（ADR 0084）：按真实的字段给标题 / UP 主 / 分区 / 分钟数 / 热评，用和线上一样的说明让她主动说一句，直到她说出来。
     * excerpt：字幕摘录（ADR 0089）；via: 'dm'：改成写一条 B 站私信（试运行生成，记成一个气泡，并像线上一样记进聊天记录）；nudge：私信之后在 QQ 上提醒一句
     */
    | { video: { title: string; owner: string; category: string; minutes: number; desc?: string; comments?: string[]; excerpt?: string; via?: 'dm'; nudge?: boolean } }
    /** 虚拟时间一直往后走，直到她回复（最多 1 天）：睡着、上课时来的消息；proactive：直到她主动发一次（最多 1 天） */
    | { wait: 'reply' | 'proactive' }
    /** 不跳时间，把能写的片段写进记忆并等 Hindsight 做完 */
    | { memory: 'sync' }
    /** 手动刷新关系概况（Mental Model），等做完后记进报告（T23） */
    | { refresh: 'relationship' }
    /** 对上一个 say 步骤做自动检查 */
    | { check: Checks }
    /** 把聊天记录挪走（记忆还在），之后的回复只能靠召回：模拟原文早就被挤出上下文 */
    | { forget: 'chat' }
    /** Hindsight 不可用 / 恢复（T20）：不可用时每个请求都报错 */
    | { hindsight: 'down' | 'up' }
    /** bot 重启（ADR 0039）：聊天记录、记忆、世界、答应的事、日记、回复器、主动消息都丢掉，照 app.ts 启动时从数据目录重新读起 */
    | { restart: true };

export interface Scenario {
    name: string;
    description?: string;
    tier: Tier;
    /** {{user}}，默认「阿明」 */
    user: string;
    /** ST 人设描述（可选） */
    persona?: string;
    /** 这个人是否知道她是程序（ADR 0067）：默认 true（沿用原卡，旧场景不变）；写 false 测承认版卡 */
    knowsBot: boolean;
    /** 虚拟时间的起点，ISO 字符串，带时区 */
    start: string;
    /** 默认 true：用 Hindsight（每次运行一个临时 bank） */
    memory: boolean;
    /** 默认 true：按卡上的作息（ADR 0007） */
    schedule: boolean;
    /** 默认 false：按卡上的主动设置主动找他（ADR 0011，真发，不是试运行）；已有的场景不受影响 */
    proactive: boolean;
    /** 默认 false：看心情不回（ADR 0013 决策 4）；按消息 id 定，已有的场景不受影响 */
    moody: boolean;
    /** 默认 false：没人聊天时她也一件件过日子（ADR 0040 规则自主选择器），要开着作息、她自己的日子、卡上有世界 */
    autonomous: boolean;
    /** 默认 false：紧急课程项目接管空闲安排（ADR 0056）；要开着 autonomous */
    projectChoice: boolean;
    /** 默认 false：生活账接进提示词（ADR 0054，配置 lifeInPrompt）；要开着 autonomous */
    lifeInPrompt: boolean;
    /** 默认 false：有起因的小别扭与和好（ADR 0074，配置 grievance）；只对男朋友档有效 */
    grievance: boolean;
    /** 默认 false：回复节奏（ADR 0075，配置 rhythm）；模拟器里的虚拟时钟照样走 */
    rhythm: boolean;
    /** 默认 false：更短的回复（候选 5，配置 shortReplies） */
    shortReplies: boolean;
    /** 默认 false：形状控制（ADR 0091，配置 shape）；run.ts 的 --shape 对所有场景打开 */
    shape: boolean;
    /** 默认 false：带自己的小事（ADR 0094，配置 shapeAgenda，要 shape 开着）；run.ts 的 --agenda 对所有场景打开 */
    shapeAgenda: boolean;
    /** 默认 false：闺蜜的约（ADR 0061，配置 npcAsks）：约、迟到、改约、取消进她的一天；要开着 autonomous 才进行动账 */
    npcAsks: boolean;
    /** 默认 off：公共节日（ADR 0076，配置 festivals）：notes 只进时间块，greet 再加主动说 */
    festivals: FestivalMode;
    /** 开场先记进账的、他给的钱（ADR 0027 调整的 receive_money）：at 是本地时刻，forCamera 存进相机基金。让场景里的世界和线上一致（10-10 他转了 2000，10-11 买了相机） */
    gifts?: { at: string; amount: number; forCamera?: boolean }[];
    /** 看心情不回的概率（0–1），不写按档位算；写 1 时正聊着的「哈哈」一定不回，用来看不回之后的样子 */
    moodyChance?: number;
    /** 这几种时机的主动消息（日志里的说法，如「她那边的事」）生成时都当没连上模型（10-11 断网那天），看后面的主动怎么接 */
    proactiveOffline?: string[];
    /** 开场就记在她答应的事里的约好的见面（ADR 0066 的改约场景用，不靠记忆抽取）：date 是见面的日子，said 是哪天约的（她的一天），time 是几点 */
    promises?: { what: string; date: string; said: string; time: string; where?: string }[];
    /** 在卡的主动时机之外再开这几个（ADR 0066 的 reschedule 线上的卡还没开，场景里先开起来看）；不写按卡 */
    extraOccasions?: Occasion[];
    /** 「她那边的事」开哪几类（ADR 0064）：线上的卡没写 newsKinds（只有相机），场景里用它先把新类开起来看；不写按卡 */
    newsKinds?: NewsKind[];
    /** 假的图片表情收藏（ADR 0063）：编号是 12 位小写十六进制，描述是她在提示词里看到的那句；真的 shelf 代码，文件是空的（模拟器不发图，气泡里是 <sticker:编号>）。只有写了才给回复器 */
    stickers?: { id: string; description: string; tags: string[] }[];
    /** 允许发图片表情的轮次里抽中发的概率（0–1），不写按线上的 STICKER_TURN_CHANCE；写 1 = 允许的轮次都发（测选哪张用） */
    stickerChance?: number;
    /** 假的「真实天气」（ADR 0050）：日期 → 下雨的钟头（0–23），这几天按真实天气算（世界和主动消息都认），别的日子照旧生成 */
    realRain?: Record<string, number[]>;
    /** 指定今天的心情（ADR 0015，卡上心情的名字），比较不同心情时用；不写按虚拟日期抽 */
    mood?: string;
    /** 名单里的其他人（ADR 0016）：她认识写了 intro 的；开了记忆时，事先的聊天先写进他们自己的 bank 和公共库 */
    others: OtherContact[];
    /** 她和他事先的聊天（ADR 0018：她答应过的事），时间要早于起点 45 分钟以上；开了记忆时先写进他的 bank。不开记忆时只要早于起点（盲评按固定上文重放） */
    history: ChatLine[];
    steps: Step[];
}

/** 事先的一条聊天 */
export interface ChatLine {
    time: string;
    role: 'user' | 'assistant';
    content: string;
}

export interface OtherContact {
    name: string;
    tier: ContactTier;
    intro?: string;
    /** 她和这个人事先的聊天，时间要早于起点 45 分钟以上（片段结束了才写进记忆） */
    history: ChatLine[];
}

export function loadScenario(path: string): Scenario {
    return parseScenario(JSON.parse(readFileSync(path, 'utf8')), path);
}

function stickerEntries(value: unknown, fail: (message: string) => never): { id: string; description: string; tags: string[] }[] {
    if (!Array.isArray(value) || value.length === 0) fail('stickers 应为非空数组');
    const ids = new Set<string>();
    return (value as unknown[]).map((item, i) => {
        const o = item as Record<string, unknown>;
        if (!o || typeof o.id !== 'string' || !/^[a-f0-9]{12}$/.test(o.id)) fail(`stickers[${i}].id 应为 12 位小写十六进制`);
        if (typeof o.description !== 'string' || !o.description.trim()) fail(`stickers[${i}].description 应为描述`);
        if (ids.has(o.id as string)) fail(`stickers[${i}].id 重复`);
        ids.add(o.id as string);
        const tags = o.tags === undefined ? [] : Array.isArray(o.tags) && o.tags.every(t => typeof t === 'string') ? o.tags as string[] : fail(`stickers[${i}].tags 应为字符串数组`);
        return { id: o.id as string, description: (o.description as string).trim(), tags };
    });
}

function rainDays(value: unknown, fail: (message: string) => never): Record<string, number[]> {
    const ok = value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([date, hours]) => /^\d{4}-\d{2}-\d{2}$/.test(date)
        && Array.isArray(hours) && hours.every(h => Number.isInteger(h) && h >= 0 && h <= 23));
    return ok ? value as Record<string, number[]> : fail('realRain 应为 { "YYYY-MM-DD": [下雨的钟头 0–23] }');
}

export function parseScenario(data: unknown, where = '场景'): Scenario {
    const fail = (message: string): never => { throw new Error(`${where}：${message}`); };
    if (typeof data !== 'object' || data === null) fail('应为对象');
    const s = data as Record<string, unknown>;
    if (typeof s.name !== 'string' || !s.name) fail('缺少 name');
    const tiers: readonly string[] = [...CONTACT_TIERS, UNLISTED_TIER];
    if (typeof s.tier !== 'string' || !tiers.includes(s.tier)) fail(`tier 应为 ${tiers.join(' / ')}`);
    if (typeof s.start !== 'string' || Number.isNaN(Date.parse(s.start))) fail('start 应为 ISO 时间');
    if (!Array.isArray(s.steps) || s.steps.length === 0) fail('steps 应为非空数组');
    (s.steps as unknown[]).forEach((step, i) => checkStep(step, `${where} 第 ${i + 1} 步`));
    const chance = (value: unknown): number => (typeof value === 'number' && value >= 0 && value <= 1 ? value : fail('moodyChance 应为 0–1 的数'));
    return {
        name: s.name as string,
        description: typeof s.description === 'string' ? s.description : undefined,
        tier: s.tier as Tier,
        user: typeof s.user === 'string' && s.user ? s.user : '阿明',
        persona: typeof s.persona === 'string' ? s.persona : undefined,
        knowsBot: s.knowsBot !== false,
        start: s.start as string,
        memory: s.memory !== false,
        schedule: s.schedule !== false,
        proactive: s.proactive === true,
        moody: s.moody === true,
        autonomous: s.autonomous === true,
        projectChoice: s.projectChoice === true,
        lifeInPrompt: s.lifeInPrompt === true,
        grievance: s.grievance === true,
        rhythm: s.rhythm === true,
        shortReplies: s.shortReplies === true,
        shape: s.shape === true,
        shapeAgenda: s.shapeAgenda === true,
        npcAsks: s.npcAsks === true,
        festivals: s.festivals === undefined ? 'off' : (FESTIVAL_MODES.includes(s.festivals as FestivalMode) ? s.festivals as FestivalMode : fail(`festivals 应为 ${FESTIVAL_MODES.join(' / ')} 之一`)),
        ...(s.gifts !== undefined ? { gifts: (Array.isArray(s.gifts) ? s.gifts : fail('gifts 应为数组')).map((g: unknown, i: number) => {
            const o = g as Record<string, unknown>;
            if (!o || typeof o.at !== 'string' || !Number.isFinite(Date.parse(o.at))) fail(`gifts[${i}].at 应为时刻`);
            if (!Number.isInteger(o.amount) || (o.amount as number) <= 0) fail(`gifts[${i}].amount 应为正整数`);
            return { at: o.at as string, amount: o.amount as number, ...(o.forCamera === true ? { forCamera: true } : {}) };
        }) } : {}),
        ...(s.moodyChance !== undefined ? { moodyChance: chance(s.moodyChance) } : {}),
        ...(s.stickers !== undefined ? { stickers: stickerEntries(s.stickers, fail) } : {}),
        ...(s.stickerChance !== undefined ? { stickerChance: typeof s.stickerChance === 'number' && s.stickerChance >= 0 && s.stickerChance <= 1 ? s.stickerChance : fail('stickerChance 应为 0–1 的数') } : {}),
        ...(s.proactiveOffline !== undefined ? {
            proactiveOffline: Array.isArray(s.proactiveOffline) && s.proactiveOffline.every(x => typeof x === 'string' && x)
                ? s.proactiveOffline as string[] : fail('proactiveOffline 应为时机说法的数组（「她那边的事」「冷场」…）'),
        } : {}),
        ...(s.promises !== undefined ? {
            promises: (Array.isArray(s.promises) ? s.promises : fail('promises 应为数组')).map((p: unknown, i: number) => {
                const o = p as Record<string, unknown>;
                const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
                if (!o || typeof o.what !== 'string' || !o.what || !day(o.date) || !day(o.said) || typeof o.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) {
                    fail(`promises[${i}] 应有 what、date（YYYY-MM-DD）、said（YYYY-MM-DD）、time（HH:MM）`);
                }
                return { what: o.what as string, date: o.date as string, said: o.said as string, time: o.time as string, ...(typeof o.where === 'string' && o.where ? { where: o.where } : {}) };
            }),
        } : {}),
        ...(s.extraOccasions !== undefined ? {
            extraOccasions: Array.isArray(s.extraOccasions) && s.extraOccasions.every(x => OCCASIONS.includes(x as Occasion))
                ? s.extraOccasions as Occasion[] : fail(`extraOccasions 应为 ${OCCASIONS.join(' / ')} 组成的数组`),
        } : {}),
        ...(s.newsKinds !== undefined ? {
            newsKinds: Array.isArray(s.newsKinds) && s.newsKinds.every(x => NEWS_KINDS.includes(x as NewsKind))
                ? s.newsKinds as NewsKind[] : fail(`newsKinds 应为 ${NEWS_KINDS.join(' / ')} 组成的数组`),
        } : {}),
        ...(s.realRain !== undefined ? { realRain: rainDays(s.realRain, fail) } : {}),
        ...(s.mood !== undefined ? { mood: typeof s.mood === 'string' && s.mood ? s.mood : fail('mood 应为心情的名字') } : {}),
        others: parseOthers(s.others, Date.parse(s.start as string), fail),
        history: parseHistory(s.history, 'history', Date.parse(s.start as string), fail, s.memory !== false),
        steps: s.steps as Step[],
    };
}

function parseOthers(value: unknown, start: number, fail: (message: string) => never): OtherContact[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail('others 应为数组');
    return (value as unknown[]).map((item, i) => {
        const where = `others[${i}]`;
        if (typeof item !== 'object' || item === null) fail(`${where} 应为对象`);
        const o = item as Record<string, unknown>;
        if (typeof o.name !== 'string' || !o.name) fail(`${where}.name 应为称呼`);
        if (!CONTACT_TIERS.includes(o.tier as ContactTier)) fail(`${where}.tier 应为 ${CONTACT_TIERS.join(' / ')} 之一`);
        if (o.intro !== undefined && typeof o.intro !== 'string') fail(`${where}.intro 应为字符串`);
        const messages = parseHistory(o.history, `${where}.history`, start, fail);
        return { name: o.name as string, tier: o.tier as ContactTier, ...(o.intro ? { intro: o.intro as string } : {}), history: messages };
    });
}

/** 事先的聊天：时间要早于起点 45 分钟以上（片段结束了才写进记忆）；不开记忆（withMemory 为否）时只要早于起点 */
function parseHistory(value: unknown, where: string, start: number, fail: (message: string) => never, withMemory = true): ChatLine[] {
    const history = value ?? [];
    if (!Array.isArray(history)) fail(`${where} 应为数组`);
    return (history as unknown[]).map((m, j) => {
        const message = m as Record<string, unknown>;
        const time = typeof message?.time === 'string' ? Date.parse(message.time) : NaN;
        if (Number.isNaN(time)) fail(`${where}[${j}].time 应为 ISO 时间`);
        if (withMemory && time > start - EPISODE_GAP_MS) fail(`${where}[${j}] 要早于起点 45 分钟以上（片段结束了才写进记忆）`);
        if (time >= start) fail(`${where}[${j}] 要早于起点`);
        if (message.role !== 'user' && message.role !== 'assistant') fail(`${where}[${j}].role 应为 user / assistant`);
        if (typeof message.content !== 'string' || !message.content) fail(`${where}[${j}].content 应为非空字符串`);
        return { time: new Date(time).toISOString(), role: message.role as 'user' | 'assistant', content: message.content as string };
    });
}

const STEP_KINDS = ['case', 'say', 'life', 'action', 'advance', 'video', 'wait', 'memory', 'refresh', 'check', 'forget', 'hindsight', 'restart'] as const;

function checkStep(step: unknown, where: string): void {
    const fail = (message: string): never => { throw new Error(`${where}：${message}`); };
    if (typeof step !== 'object' || step === null) fail('应为对象');
    const s = step as Record<string, unknown>;
    const kinds = STEP_KINDS.filter(k => k in s);
    if (kinds.length !== 1) fail(`要有且只有 ${STEP_KINDS.join(' / ')} 其中一个，现在是 ${kinds.join('、') || '都没有'}`);
    if ('say' in s) {
        const say = s.say;
        if (!(typeof say === 'string' && say) && !(Array.isArray(say) && say.length > 0 && say.every(isSayItem))) fail('say 应为非空字符串，或数组（每项是非空字符串、{ "voice": 转出来的字, "seconds"?: 秒数 } 或 { "image": 图上的字 }）');
        if (s.interrupt !== undefined) {
            const it = s.interrupt as Record<string, unknown>;
            if (typeof it.say !== 'string' || !it.say) fail('interrupt.say 应为非空字符串');
            if ((it.during === 'generation') === (typeof it.afterBubbles === 'number')) fail('interrupt 要有且只有 during: "generation" 或 afterBubbles 其中一个');
        }
    }
    if ('life' in s) {
        if (typeof s.life !== 'object' || s.life === null) fail('life 应为对象');
        const life = s.life as Record<string, unknown>;
        if (typeof life.id !== 'string' || !life.id) fail('life.id 应为非空字符串');
        if (typeof life.kind !== 'string' || !life.kind) fail('life.kind 应为非空字符串');
        if (life.result !== undefined && !['succeeded', 'failed', 'interrupted'].includes(String(life.result))) fail('life.result 应为 succeeded / failed / interrupted');
        if (life.subject !== undefined && typeof life.subject !== 'string') fail('life.subject 应为字符串');
        if (life.target !== undefined && typeof life.target !== 'string') fail('life.target 应为字符串');
        if (life.seen !== undefined && typeof life.seen !== 'boolean') fail('life.seen 应为布尔值');
    }
    if ('action' in s) {
        if (typeof s.action !== 'object' || s.action === null) fail('action 应为对象');
        const action = s.action as Record<string, unknown>;
        if (typeof action.id !== 'string' || !action.id) fail('action.id 应为非空字符串');
        if (!['sleep', 'eat', 'meet', 'attend_class', 'study', 'rest', 'read_book', 'leisure', 'work_on_project', 'interact_npc'].includes(String(action.kind))) fail('action.kind 不认识');
        if (action.subject !== undefined && typeof action.subject !== 'string') fail('action.subject 应为字符串');
        if (action.target !== undefined && typeof action.target !== 'string') fail('action.target 应为字符串');
        if (action.durationMinutes !== undefined && (!Number.isInteger(action.durationMinutes) || Number(action.durationMinutes) <= 0)) fail('action.durationMinutes 应为正整数');
    }
    if ('advance' in s) parseDuration(String(s.advance));
    if ('video' in s) {
        const video = s.video as Record<string, unknown> | null;
        if (typeof video !== 'object' || video === null) fail('video 应为对象');
        for (const key of ['title', 'owner', 'category'] as const) if (typeof video![key] !== 'string' || !video![key]) fail(`video.${key} 应为非空字符串`);
        if (!Number.isInteger(video!.minutes) || Number(video!.minutes) <= 0) fail('video.minutes 应为正整数');
        if (video!.excerpt !== undefined && typeof video!.excerpt !== 'string') fail('video.excerpt 应为字符串');
        if (video!.via !== undefined && video!.via !== 'dm') fail('video.via 只能是 "dm"');
        if (video!.nudge !== undefined && typeof video!.nudge !== 'boolean') fail('video.nudge 应为布尔值');
        if (video!.nudge && video!.via !== 'dm') fail('video.nudge 要和 via: "dm" 一起用');
    }
    if ('wait' in s && s.wait !== 'reply' && s.wait !== 'proactive') fail('wait 只能是 "reply" 或 "proactive"');
    if ('check' in s) {
        const check = s.check as Record<string, unknown>;
        for (const key of ['replyAfter', 'replyWithin'] as const) if (check[key] !== undefined) parseDuration(String(check[key]));
        // proactive 里写了认不得的键（replyNone 曾经就是这样被悄悄忽略的）：早报错
        const known = ['count', 'perDayMax', 'allowedTimes', 'occasions', 'absent', 'replyAny', 'replyNone', 'exitClean'];
        const proactive = check.proactive;
        if (proactive && typeof proactive === 'object') {
            for (const key of Object.keys(proactive)) if (!known.includes(key)) fail(`check.proactive.${key} 不认识（${known.join(' / ')}）`);
        }
    }
    if ('memory' in s && s.memory !== 'sync') fail('memory 只能是 "sync"');
    if ('refresh' in s && s.refresh !== 'relationship') fail('refresh 只能是 "relationship"');
    if ('forget' in s && s.forget !== 'chat') fail('forget 只能是 "chat"');
    if ('hindsight' in s && s.hindsight !== 'down' && s.hindsight !== 'up') fail('hindsight 只能是 "down" 或 "up"');
    if ('restart' in s && s.restart !== true) fail('restart 只能是 true');
}

function isSayItem(item: unknown): boolean {
    if (typeof item === 'string') return item !== '';
    if (typeof item !== 'object' || item === null) return false;
    const m = item as Record<string, unknown>;
    if ('voice' in m) return typeof m.voice === 'string' && (m.seconds === undefined || (Number.isInteger(m.seconds) && Number(m.seconds) > 0)) && Object.keys(m).every(k => k === 'voice' || k === 'seconds');
    return typeof m.image === 'string' && Object.keys(m).length === 1;
}

/** 他发的这一条在聊天记录里的样子 */
export function sayText(item: string | MediaSay): string {
    if (typeof item === 'string') return item;
    if ('voice' in item) return voiceLine({ ...(item.seconds ? { seconds: item.seconds } : {}), ...(item.voice ? { text: item.voice } : {}) });
    return imageLine(item.image ? { ocr: item.image } : {});
}

/** "45m"、"1d"、"9h30m"、"90s" → 毫秒 */
export function parseDuration(text: string): number {
    const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
    const parts = [...text.matchAll(/(\d+)([dhms])/g)];
    if (parts.length === 0 || parts.map(p => p[0]).join('') !== text) throw new Error(`时长写法不对：${text}（例如 45m、1d、9h30m）`);
    return parts.reduce((sum, p) => sum + Number(p[1]) * units[p[2]!]!, 0);
}

/** 虚拟时钟 = 真实时间 + 偏移。等连发、气泡间隔照真实时间走，「过一天」直接加偏移 */
export class VirtualClock {
    #offset: number;
    readonly #realNow: () => number;

    constructor(start: Date, realNow: () => number = Date.now) {
        this.#realNow = realNow;
        this.#offset = start.getTime() - realNow();
    }

    now = (): number => this.#realNow() + this.#offset;

    advance(ms: number): void {
        this.#offset += ms;
    }

    /** 虚拟时钟上的等待（回复器看到消息之前的长等待，ADR 0007）：不按真实时间走，由 advanceTo 拨到点时触发 */
    #timers: { at: number; fire: () => void }[] = [];

    waitUntil = (at: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
        if (at <= this.now() || signal.aborted) return resolve();
        const timer = {
            at,
            fire: () => {
                this.#timers = this.#timers.filter(t => t !== timer);
                signal.removeEventListener('abort', timer.fire);
                resolve();
            },
        };
        this.#timers.push(timer);
        signal.addEventListener('abort', timer.fire);
    });

    /** 最早到点的等待 */
    nextTimer(): number | undefined {
        return this.#timers.length ? Math.min(...this.#timers.map(t => t.at)) : undefined;
    }

    /** 拨到 at（不往回拨），到点的等待按时间顺序触发 */
    advanceTo(at: number): void {
        const now = this.now();
        if (at > now) this.#offset += at - now;
        for (const timer of [...this.#timers].sort((a, b) => a.at - b.at)) if (timer.at <= this.now()) timer.fire();
    }
}
