// 她认识的人（ADR 0016）：名单里的人互相认识。
// 他最后 3 条、或她最后 2 次回复里出现了名单里另一个人的称呼，而那个人写了「别人提起时」（intro），这一轮就放一段介绍；
// 开了长期记忆时，contact.ts 再从那个人自己的 bank 召回几条接在后面。陌生人档、名单外的人提起时不给。

import { UNLISTED_TIER, type Contact, type Tier } from './config.ts';
import type { StoredMessage } from './history.ts';

type Said = Pick<StoredMessage, 'role' | 'content'>;

/** 一次最多介绍几个人 */
export const MAX_MENTIONED = 2;

/** 称呼至少几个字才算：单字太容易出现在别的话里 */
const MIN_NAME_CHARS = 2;

/** 这两档提起别人时不给介绍和记忆，也不用公共记忆（ADR 0016 决策 2、3） */
export function knowsPeople(tier: Tier): boolean {
    return tier !== 'stranger' && tier !== UNLISTED_TIER;
}

/** 这几轮里提到的名单里的其他人（写了 intro 的），最近提到的在前，最多 MAX_MENTIONED 个 */
export function mentionedPeople(history: readonly Said[], self: Contact, contacts: readonly Contact[]): Contact[] {
    if (!knowsPeople(self.tier)) return [];
    const candidates = contacts.filter(c => c.qq !== self.qq && c.intro && [...c.name].length >= MIN_NAME_CHARS);
    if (candidates.length === 0) return [];

    // 窗口同 ADR 0015 判断「聊到书」：他最后 3 条、她最后 2 次回复（连着发的几条算一次）
    const his = history.map((message, index) => ({ message, index })).filter(item => item.message.role === 'user').slice(-3)
        .map(item => ({ index: item.index, text: item.message.content }));
    const replies: { index: number; text: string }[] = [];
    let inReply = false;
    for (const [index, message] of history.entries()) {
        if (message.role === 'assistant') {
            if (inReply) {
                const last = replies.at(-1)!;
                last.text += `\n${message.content}`;
                last.index = index;
            } else {
                replies.push({ index, text: message.content });
            }
            inReply = true;
        } else {
            inReply = false;
        }
    }
    const recent = [...his, ...replies.slice(-2)].sort((a, b) => b.index - a.index);

    const found: Contact[] = [];
    for (const item of recent) {
        const hits = candidates
            .filter(c => !found.includes(c) && item.text.includes(c.name))
            .sort((a, b) => item.text.lastIndexOf(b.name) - item.text.lastIndexOf(a.name));
        for (const person of hits) {
            found.push(person);
            if (found.length === MAX_MENTIONED) return found;
        }
    }
    return found;
}

/** 介绍一个人：称呼和 intro，召回到的记忆（已整理成一段）接在后面 */
export function describePerson(person: Contact, recalled?: string): string {
    return [`[你认识的人：${person.name}]`, `${person.name}：${person.intro}`, ...(recalled ? [recalled] : [])].join('\n');
}
