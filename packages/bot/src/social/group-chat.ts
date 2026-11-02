// 群聊（ADR 0210，用户 2026-11-02「下一步做群聊和陌生人互动」）。
// 用户定的：只进他拉她进的群，而且要加进配置 groups 才说话；他来标哪些群的人都知道她是 AI（标了的群承不承认由她，没标的按不知道：认真问到就承认）。
// 她本人（scripts/ask-her.mjs）：「基本潜水」「有人点我名了，或者话题正好撞我枪口上——吃的、剧、土豆」「有人在群里损你，那我得出来说两句」；
// 「群里肯定得收着点……但你也别装得跟不认识我似的……就正常说话，别喊得那么黏」。
// 这里是纯函数：群里的记录、谁说的、该不该开口、每个群的额度、给她的说明。调模型、发消息在 app.ts。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
}

/** 每个群的额度：一小时、一天最多几条；不是被叫到的话两句之间至少隔多久；顺着话题插嘴一天几次 */
export const GROUP_LIMITS = { perHour: 6, perDay: 30, minGapMs: 90_000, topicPerDay: 3, topicChance: 0.3 } as const;
/** 放进提示词的最近几条 */
export const GROUP_CONTEXT = 30;

/** 她的叫法：群里有人这样叫就算叫到她 */
export const HER_NAMES = ['林梦瑶', '梦瑶', '瑶瑶', '瑶姐'] as const;
/** 她熟的话题（她本人：吃的、剧、土豆） */
const HER_TOPICS = /吃什么|吃啥|饭|外卖|奶茶|火锅|烧烤|零食|追剧|这剧|电视剧|番剧|新番|电影|猫|土豆|相机|拍照|摄影|修图|照片/;
/** 损人的话（有人这样说他） */
const TEASING = /菜|笨|傻|蠢|丑|怂|废物|拉胯|垃圾|太弱|弱鸡|不行啊|就这|笑死|好惨|活该|单身狗/;
/** 想伤害自己、绝望（群里有人这么说，她认真接，不当玩笑） */
const DESPAIR = /不想活|想死|自杀|轻生|活着没意思|活着没意义|跳楼|割腕|结束自己|撑不下去了/;

export type SpeakReason = 'mentioned' | 'crisis' | 'defend' | 'topic';

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
}

/** 这条该不该让她开口、为什么；undefined = 潜水 */
export function speakReason(message: Segment[] | string, text: string, from: number, messageId: number, ctx: SpeakContext): SpeakReason | undefined {
    const segments = typeof message === 'string' ? [] : message;
    const atHer = segments.some(s => s.type === 'at' && Number(s.data?.qq) === ctx.selfId);
    const repliesHer = segments.some(s => s.type === 'reply' && ctx.herMessageIds.has(Number(s.data?.id)));
    if (DESPAIR.test(text)) return 'crisis';
    if (atHer || repliesHer || HER_NAMES.some(name => text.includes(name))) return 'mentioned';
    if (ctx.boyfriend && from !== ctx.boyfriend.qq) {
        const atHim = segments.some(s => s.type === 'at' && Number(s.data?.qq) === ctx.boyfriend!.qq);
        const namesHim = (ctx.boyfriendNames ?? []).some(name => name.length >= 2 && text.includes(name));
        if ((atHim || namesHim) && TEASING.test(text)) return 'defend';
    }
    if (HER_TOPICS.test(text) && ctx.topicToday < GROUP_LIMITS.topicPerDay
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
    if ((reason === 'topic' || reason === 'defend') && now - last < GROUP_LIMITS.minGapMs) return { ok: false, why: '刚说过，隔一会儿' };
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
};

/**
 * 给她的说明（放在聊天记录后面）：这是哪个群、群里怎么说话、他在不在、这次为什么开口。
 * 不写「你是 AI」的立场：认不认按卡（ADR 0067 / 0208），这里不重复
 */
export function groupNote(input: { groupName: string; boyfriendHere: boolean; boyfriendName?: string; reason: SpeakReason }): string {
    return [
        `[这是 QQ 群「${input.groupName}」里的聊天，群里有好几个人，上面每行冒号前是谁说的，「你」是你自己说的。`,
        '群里说话像在群里：短，一两句，不刷屏，不用每句都接；不在群里说你和他之间的私事，也不说别人私下跟你说的事。',
        input.boyfriendHere && input.boyfriendName ? `${input.boyfriendName}（你男朋友）也在这个群：群里收着点，正常说话，别喊得黏，也别装不认识。` : '',
        REASON_NOTE[input.reason],
        '只输出你要发到群里的话，不写名字前缀、不写动作；不想说就只写「不说」。]',
    ].filter(Boolean).join('');
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
