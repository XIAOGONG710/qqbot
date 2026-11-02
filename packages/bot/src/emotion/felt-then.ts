// 回忆带着当时的感觉（ADR 0218，配置 memoryFeelings，默认关；只男朋友档）。
//
// 起因：11-02 问她「有没有哪些时候，你自己都觉得自己不太像真人」，她说：
// 「有些事我记得特别清楚，清楚到像在看别人的日记，连当时谁说了什么都在，但就是没有那个『我当时什么感觉』。」
// 召回的记忆是「林梦瑶……」这种第三人称的事实；她当时的心情另有来处（心境，ADR 0102 / 0197）：那天世界里带感受的事、作者写下的事、
// 她聊完回想时指出了依据记下的感受。这里把两头接起来：想起某一天的事时，附上一句她那天有依据的感觉。不编。
//
// 用户 11-02 晚「做，让她有当时的感觉」。10-06（ADR 0018）「带情绪的记忆」是列出来、用户没选的一项，顾虑是容易「算账」（ADR 0014）。护栏：
// 1. **不附因为他而难过 / 烦 / 担心的**：那几条评估先拿掉再算（因为他开心、松口气的留着）；
// 2. **只在想起来的时候附**：召回到了（他说到了那件事），或他问到那一天；不自己翻出来；
// 3. **对得上才附**：记忆那一条和那天感觉的来由要说的是同一件事（共有 2 个以上有意义的二字词），对不上不硬贴；他问到那一天时整天的感觉都算；
// 4. 写明「是你当时的感觉，现在不一定还这样；不用说出来」。

import { gramSet } from '../language/speech-notes.ts';
import { topicalGrams } from '../life/diary-insights.ts';
import { FEELING_NAME, feelingsAt, type Appraisal, type Felt, type FeelingKind } from './feelings.ts';

/** 因为他而有的这几种不附（护栏 1） */
const NEGATIVE: ReadonlySet<FeelingKind> = new Set(['sad', 'annoyed', 'worry']);
/** 记忆和感觉的来由至少共有几个有意义的二字词才算同一件事（护栏 3） */
export const FELT_MIN_SHARED = 2;
/** 那天的感觉按那天晚上这个时刻算（一天的事都发生了，还没散） */
export const FELT_AT_HOUR = 21;

/** 拿掉因为他而难过 / 烦 / 担心的那几条 */
export function withoutGrudges(list: readonly Appraisal[]): Appraisal[] {
    return list.filter(item => !(item.aboutHim && NEGATIVE.has(item.kind)));
}

/** 那一刻她心里明显的感觉（到「明显」以上的），最多两种 */
export function feltThen(list: readonly Appraisal[], at: number): Felt[] {
    return feelingsAt(withoutGrudges(list), at).filter(felt => felt.level !== 'faint').slice(0, 2);
}

/** 记忆这一条和这个感觉说的是不是同一件事 */
export function sameThing(felt: Pick<Felt, 'cause'>, text: string): boolean {
    const target = gramSet(text);
    return topicalGrams(felt.cause).filter(gram => target.has(gram)).length >= FELT_MIN_SHARED;
}

const describe = (felt: Felt) => `${felt.level === 'strong' ? '很' : '有点'}${FEELING_NAME[felt.kind]}——${felt.cause}`;

/** 召回的一条记忆后面附的一句（对得上的那种感觉；对不上返回 undefined） */
export function feltNoteFor(felt: readonly Felt[], text: string): string | undefined {
    const match = felt.find(item => sameThing(item, text));
    // 只写感觉，不重复经过：记忆那一条已经说了是什么事；把经过再写一遍，她会顺着讲成故事、补出没发生的结局（探针 3/4 编了「最后在床垫底下找到」）
    return match ? `那时你心里${match.level === 'strong' ? '很' : '有点'}${FEELING_NAME[match.kind]}` : undefined;
}

/** 他问到那一天时附的一句（整天的，最多两种） */
export function feltDayNote(felt: readonly Felt[]): string | undefined {
    return felt.length ? `那天你心里：${felt.map(describe).join('；')}（是你当时的感觉，现在不一定还这样；不用说出来，说也别夸大）` : undefined;
}

/** 事情发生后多久算「当时」 */
const RIGHT_AFTER_MS = 30 * 60_000;

/**
 * 那一段时间里（那一天）她心里明显过的感觉：在每件事发生后半小时、和 to 那一刻各看一眼，每种感觉取最强的那次。
 * 不按一天结束时算：下午丢了水卡的那点难过，到晚上已经淡得「刚能察觉」，但那是她当时的感觉（ADR 0218 调整）
 */
export function feltDuring(list: readonly Appraisal[], from: number, to: number): Felt[] {
    const kept = withoutGrudges(list);
    const moments = [...new Set([...kept.filter(item => item.at >= from && item.at <= to).map(item => Math.min(to, item.at + RIGHT_AFTER_MS)), to])];
    const best = new Map<FeelingKind, Felt>();
    for (const moment of moments) {
        for (const felt of feelingsAt(kept, moment)) {
            const seen = best.get(felt.kind);
            if (!seen || felt.weight > seen.weight) best.set(felt.kind, felt);
        }
    }
    return [...best.values()].filter(felt => felt.level !== 'faint').sort((a, b) => b.weight - a.weight).slice(0, 2);
}
