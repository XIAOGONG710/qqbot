// 群聊（ADR 0210，用户 2026-11-02「下一步做群聊和陌生人互动」）。
// 用户定的：只进他拉她进的群，而且要加进配置 groups 才说话；他来标哪些群的人都知道她是 AI（标了的群承不承认由她，没标的按不知道：认真问到就承认）。
// 她本人（scripts/ask-her.mjs）：「基本潜水」「有人点我名了，或者话题正好撞我枪口上——吃的、剧、猫」「有人在群里损你，那我得出来说两句」；
// 「群里肯定得收着点……但你也别装得跟不认识我似的……就正常说话，别喊得那么黏」。
// 这里是纯函数：群里的记录、谁说的、该不该开口、每个群的额度、给她的说明。调模型、发消息在 app.ts。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { catAlternative } from '../character-terms.ts';
import { detectCrisis } from '../emotion/crisis.ts';
import { join } from 'node:path';
import { pick } from './reply-timing.ts';
import type { Segment } from '../platform/onebot.ts';

/** 群里的一条（她自己说的 mine） */
export interface GroupEntry {
    time: string;
    from: number;
    /** 群名片，没有就 QQ 昵称 */
    name: string;
    content: string;
    messageId: number;
    mine?: true;
    /** 进群之前导进来的旧记录（2026-11-14）：只当上下文，不是刚到的消息、不触发回话 */
    history?: true;
}

/** 每个群的额度：一小时、一天最多几条；不是被叫到的话两句之间至少隔多久；顺着话题插嘴一天几次 */
export const GROUP_LIMITS = { perHour: 6, perDay: 30, minGapMs: 90_000, topicPerDay: 3, topicChance: 0.3, overheardPerDay: 2, overheardChance: 0.4 } as const;
/** 放进提示词的最近几条 */
export const GROUP_CONTEXT = 30;

/** 她的叫法：群里有人这样叫就算叫到她（真名）；QQ 昵称、群名片另从群成员资料读（2026-11-14） */
export const HER_NAMES = ['林梦瑶', '梦瑶', '瑶瑶', '瑶姐'] as const;
/** 她在这个群还可能被叫的名字：QQ 昵称 / 群名片 + 真名，去重、太短的不算（「瑶」这种一个字会被当成普通字） */
export function herNameList(extra: readonly string[] = []): string[] {
    return [...new Set([...extra.filter(name => typeof name === 'string' && name.trim().length >= 2).map(name => name.trim()), ...HER_NAMES])];
}
const escaped = (names: readonly string[]) => names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
/** 她熟的话题（她本人：吃的、剧、楼下的猫；猫的名字从卡上读，ADR 0335） */
const herTopics = () => new RegExp(`吃什么|吃啥|饭|外卖|奶茶|火锅|烧烤|零食|追剧|这剧|电视剧|番剧|新番|电影|猫|${catAlternative()}相机|拍照|摄影|修图|照片`);
/** 损人的话（有人这样说他） */
const TEASING = /菜|笨|傻|蠢|丑|怂|废物|拉胯|垃圾|太弱|弱鸡|不行啊|就这|笑死|好惨|活该|单身狗/;
/** 想伤害自己、绝望（群里有人这么说，她认真接，不当玩笑）：用私聊那套判定，夸张、否认、说别人的都不算 */
const despair = (text: string) => detectCrisis(text) !== undefined;

/** 提到她名字的时候，是不是在冲她说话（「梦瑶你说呢」「梦瑶在吗」算；「梦瑶昨天那个视频」不算） */
const namedAt = (text: string, names: readonly string[]) =>
    new RegExp(`(?:${escaped(names)})\\s*[，,、]?\\s*(?:你|您|在吗|在不在|在哪|呢|帮|看|听|来|说|唱|觉得|要不要|怎么|为什么|能不能)`).test(text);
/** 谈论她的口气：夸还是损（2026-11-14 没 @ 她、只在群里聊到她） */
const ABOUT_HER_GOOD = /好看|好听|厉害|牛|可爱|靠谱|温柔|聪明|厉害|真行|不错|挺好|好会|会说话|人好/;
const ABOUT_HER_BAD = /难看|难听|做作|装|绿茶|蠢|傻|烦人|恶心|刻薄|有病|不行|讨厌|自恋|整天/;

export type SpeakReason = 'mentioned' | 'crisis' | 'defend' | 'topic' | 'overheard';

export interface SpeakContext {
    selfId: number;
    /** 男朋友（宝宝）：他在群里的 QQ 号、她怎么叫他 */
    boyfriend?: { qq: number; name: string };
    /** 群里他的名片 / 昵称（从记录里认出来的） */
    boyfriendNames?: readonly string[];
    /** 她在这个群发过的消息 id（别人引用她） */
    herMessageIds: ReadonlySet<number>;
    /** 这个群今天已经顺着话题插过几次 */
    topicToday: number;
    /** 这个群今天已经「听见别人聊她」接过几次 */
    overheardToday?: number;
    /** 她在群里被叫的名字（QQ 昵称 / 群名片）；不给就只认真名 */
    herNames?: readonly string[];
}

/** 这条是不是在说「她」：叫她的名字（或群里叫她那个名字），但不是在叫她 */
export function mentionsHer(text: string, extra: readonly string[] = []): boolean {
    return herNameList(extra).some(name => text.includes(name));
}

/** 提到她的时候是什么口气 */
export function gossipTone(text: string, extra: readonly string[] = []): 'good' | 'bad' | undefined {
    if (!mentionsHer(text, extra)) return undefined;
    if (ABOUT_HER_BAD.test(text)) return 'bad';
    if (ABOUT_HER_GOOD.test(text)) return 'good';
    return undefined;
}

/** 这条该不该让她开口、为什么；undefined = 潜水 */
export function speakReason(message: Segment[] | string, text: string, from: number, messageId: number, ctx: SpeakContext): SpeakReason | undefined {
    const segments = typeof message === 'string' ? [] : message;
    const atHer = segments.some(s => s.type === 'at' && Number(s.data?.qq) === ctx.selfId);
    const repliesHer = segments.some(s => s.type === 'reply' && ctx.herMessageIds.has(Number(s.data?.id)));
    if (despair(text)) return 'crisis';
    if (atHer || repliesHer) return 'mentioned';
    const names = ctx.herNames ?? [];
    if (mentionsHer(text, names)) {
        // 名字后面跟着「你 / 在吗 / 帮我看」这种，就是在跟她说话；只是被提起来，是「听见」
        if (namedAt(text, herNameList(names))) return 'mentioned';
        if ((ctx.overheardToday ?? 0) >= GROUP_LIMITS.overheardPerDay) return undefined;
        // 听见别人聊她：说坏话的更容易接一句给自己分辩；被夸、被随口提起来的大多看着不说话
        if (gossipTone(text, names) === 'bad') return 'overheard';
        if (pick(String(messageId), 'group-overheard', [0, 999]) < GROUP_LIMITS.overheardChance * 1000) return 'overheard';
        return undefined;
    }
    if (ctx.boyfriend && from !== ctx.boyfriend.qq) {
        const atHim = segments.some(s => s.type === 'at' && Number(s.data?.qq) === ctx.boyfriend!.qq);
        const namesHim = (ctx.boyfriendNames ?? []).some(name => name.length >= 2 && text.includes(name));
        if ((atHim || namesHim) && TEASING.test(text)) return 'defend';
    }
    if (herTopics().test(text) && ctx.topicToday < GROUP_LIMITS.topicPerDay
        && pick(String(messageId), 'group-topic', [0, 999]) < GROUP_LIMITS.topicChance * 1000) return 'topic';
    return undefined;
}

/** 额度：这一次能不能说（被叫到、有人说想不开的不看间隔，但照样看一小时 / 一天的上限） */
export function withinBudget(mine: readonly GroupEntry[], now: number, reason: SpeakReason): { ok: true } | { ok: false; why: string } {
    const times = mine.map(e => Date.parse(e.time));
    const lastHour = times.filter(t => now - t < 3_600_000).length;
    const day = new Date(now);
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const today = times.filter(t => t >= dayStart).length;
    if (reason !== 'crisis' && lastHour >= GROUP_LIMITS.perHour) return { ok: false, why: `这一小时已经在这个群说了 ${lastHour} 条` };
    if (reason !== 'crisis' && today >= GROUP_LIMITS.perDay) return { ok: false, why: `今天已经在这个群说了 ${today} 条` };
    const last = times.length ? Math.max(...times) : -Infinity;
    if ((reason === 'topic' || reason === 'defend' || reason === 'overheard') && now - last < GROUP_LIMITS.minGapMs) return { ok: false, why: '刚说过，隔一会儿' };
    return { ok: true };
}

/** 群消息里的 @QQ号 换成人话：@她 → @你，@他 → @宝宝，别人用记录里认出来的名字 */
export function nameAts(text: string, selfId: number, names: ReadonlyMap<number, string>, boyfriend?: { qq: number; name: string }): string {
    return text.replace(/@(\d{5,12}) ?/g, (_all, qq: string) => {
        const id = Number(qq);
        if (id === selfId) return '@你 ';
        if (boyfriend && id === boyfriend.qq) return `@${boyfriend.name} `;
        const name = names.get(id);
        return name ? `@${name} ` : '@某人 ';
    });
}

/** 一条记录写成给她看的一行：她自己 =「你」，男朋友 =「宝宝（你男朋友）」，别人用群名片 */
export function groupLine(entry: GroupEntry, boyfriend?: { qq: number; name: string }): string {
    const who = entry.mine ? '你' : boyfriend && entry.from === boyfriend.qq ? `${boyfriend.name}（你男朋友）` : entry.name || '群友';
    return `${who}：${entry.content}`;
}

const REASON_NOTE: Record<SpeakReason, string> = {
    mentioned: '刚才有人叫你、@你或者回了你的话，接一句。',
    crisis: '刚才有人说了想不开、不想活这类的话：认真接住他，不开玩笑，别讲大道理；劝他找身边信得过的人，或者打心理援助热线（12356，或 400-161-9995）。',
    defend: '刚才有人在损他（你男朋友），你可以出来替他说两句，嘴上别太凶，像平时斗嘴那样。',
    topic: '刚才聊到的正好是你熟的，想插一句就插一句；没什么想说的就只写「不说」。',
    overheard: '刚才没人在跟你说话，是他们在聊到你（提到你的名字）。你可以装作恰好看见、接一句；被说得不好听就给自己分辩一下，但别大气凛然，也别追着问是谁说的；不想理就只写「不说」。',
};

/**
 * 给她的说明（放在聊天记录后面）：这是哪个群、群里怎么说话、他在不在、这次为什么开口。
 * 不写「你是 AI」的立场：认不认按卡（ADR 0067 / 0208），这里不重复
 */
export function groupNote(input: {
    groupName: string; boyfriendHere: boolean; boyfriendName?: string; reason: SpeakReason;
    callers?: readonly string[]; pending?: number;
    /** 这个群里她认识谁（group-people.ts 渲染好的一整段） */
    memory?: string;
    /** 她这会儿的心情（只说怎么样，不说来由） */
    mood?: string;
    /** 她在这个群的 QQ 昵称 / 群名片：别人不一定叫她的真名 */
    myNames?: readonly string[];
    /** 群里导进过以前的记录：她不是刚进群，别人提旧事别露怯（也别硬编不知道的） */
    veteran?: boolean;
}): string {
    const others = input.pending && input.callers ? input.pending - input.callers.length : 0;
    // 群里叫她别的名字（QQ 昵称、群名片）：那也是她，别人叫那些也算叫她
    const aliases = (input.myNames ?? []).filter(name => name.trim().length >= 2 && !HER_NAMES.includes(name.trim() as typeof HER_NAMES[number]));
    return [
        `[这是 QQ 群「${input.groupName}」里的聊天，群里有好几个人，上面每行冒号前是谁说的，「你」是你自己说的。`,
        aliases.length ? `群里他们也可能叫你「${aliases.join('」「')}」（你在这个群的昵称 / 群名片）；那都是你，别当成别人。` : '',
        input.veteran ? '你在这个群待了一阵子了，上面的旧聊天你都经历过：提到以前的事就照你知道的说，不知道的别硬编，也别问「什么情况」。' : '',
        '群里说话像在群里：短，一两句，不刷屏，不用每句都接；不在群里说你和他之间的私事，也不说别人私下跟你说的事。',
        input.boyfriendHere && input.boyfriendName ? `${input.boyfriendName}（你男朋友）也在这个群：群里收着点，正常说话，别喊得黏，也别装不认识。` : '',
        input.memory ?? '',
        input.mood ?? '',
        input.callers?.length
            ? `刚才${input.callers.join('、')}在跟你说话${others > 0 ? `，这一段里还有 ${others} 条是别人在说别的` : ''}：先把上面的记录看完，挑你最想接的那一两句回，不用挨个都应，也不要一个人回一条。`
            : '',
        REASON_NOTE[input.reason],
        '只输出你要发到群里的话，不写名字前缀、不写动作；想让谁看见就写「@群名片」（只认这个群里叫得出来的名字）；不想说就只写「不说」。]',
    ].filter(Boolean).join('');
}

/**
 * 她写的话里带「@老王」就真的 @ 出去（2026-11-14）：只认这个群里认得出的名字，
 * 认不出的照旧当文字留着（不瞎 @ 人）。返回 undefined = 没有能换成段的 @，发纯文字就行。
 */
export function mentionSegments(text: string, names: ReadonlyMap<string, number>): Segment[] | undefined {
    if (!text.includes('@')) return undefined;
    const segments: Segment[] = [];
    let mentioned = false;
    const pattern = /@([^\s@，。！？!?、:：]{1,16})/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        const name = match[1]!;
        const qq = names.get(name);
        if (qq === undefined) continue;
        const at = match.index!;
        const before = text.slice(last, at).replace(/[ \t]+$/, '');
        if (before) segments.push({ type: 'text', data: { text: before } });
        segments.push({ type: 'at', data: { qq: String(qq) } });
        last = at + match[0].length;
        mentioned = true;
    }
    if (!mentioned) return undefined;
    const tail = text.slice(last).trimStart();
    if (tail) segments.push({ type: 'text', data: { text: ` ${tail}` } });
    return segments.length ? segments : undefined;
}

/** 接完话顺手戳一下：约 15%，同一个人 10 分钟最多一次（2026-11-14） */
export const GROUP_POKE = { chance: 0.15, gapMs: 10 * 60_000 } as const;
export function groupPokePlan(seed: string, lastAt: number | undefined, now: number): { delayMs: number } | undefined {
    if (lastAt !== undefined && now - lastAt < GROUP_POKE.gapMs) return undefined;
    if (pick(seed, 'group-poke', [0, 999]) >= GROUP_POKE.chance * 1000) return undefined;
    return { delayMs: pick(seed, 'group-poke-delay', [800, 2400]) };
}


/** 她写的群消息整理成要发的一两条；「不说」或者空的就不发 */
export function groupReply(raw: string, maxBubbles = 2): string[] {
    const lines = raw.replace(/\r/g, '').split('\n')
        .map(line => line.replace(/<<[^<>\n]{0,80}>>/g, '').replace(/^(?:你|林梦瑶|梦瑶)[：:]\s*/, '').trim())
        .filter(Boolean);
    if (!lines.length || lines.every(line => /^[（(]?不说[）)]?[。.]?$/.test(line))) return [];
    return lines.filter(line => !/^[（(]?不说[）)]?[。.]?$/.test(line)).slice(0, maxBubbles).map(line => (line.length > 80 ? `${line.slice(0, 80)}…` : line));
}

/** 群记录：<数据目录>/groups/<群号>.jsonl，一行一条 */
export function groupLog(dataDir: string): { load(groupId: number): GroupEntry[]; append(groupId: number, entry: GroupEntry): void; has(groupId: number, messageId: number): boolean } {
    const dir = join(dataDir, 'groups');
    const file = (groupId: number) => join(dir, `${groupId}.jsonl`);
    const cache = new Map<number, GroupEntry[]>();
    const load = (groupId: number): GroupEntry[] => {
        const hit = cache.get(groupId);
        if (hit) return hit;
        const path = file(groupId);
        const list = existsSync(path)
            ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as GroupEntry]; } catch { return []; } })
            : [];
        cache.set(groupId, list);
        return list;
    };
    return {
        load,
        append(groupId, entry) {
            mkdirSync(dir, { recursive: true });
            appendFileSync(file(groupId), `${JSON.stringify(entry)}\n`);
            load(groupId).push(entry);
        },
        has: (groupId, messageId) => load(groupId).some(e => e.messageId === messageId),
    };
}
