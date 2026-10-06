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
export function knowsPeople(tier: Tier | string): boolean {
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

// 问她过去的事（ADR 0017）：同一句里有时间和经历
const PAST_TIME = /今天|昨天|前天|昨晚|今早|今晚|早上|上午|中午|下午|晚上|周末|上周|上星期|上个月|上次|那天|那次|最近|这几天|前几天|刚才|之前|以前/;
const PAST_DOING = /干嘛|干啥|干了|干什么|做什么|做啥|做了|去哪|去了|在忙|忙啥|忙什么|忙了|过得|怎么过|玩了|吃了|吃的|看了|上了|上的|学了|买了|见了|聊了|遇到|碰到|发生|怎么样/;

/**
 * 公共记忆的线索（ADR 0017，有线索才想起）：他这次的话（她上次回复之后的）里出现了公共库里的实体名，或者问她过去的事。
 * 返回线索（写日志用），没有就是 undefined。实体名至少 2 个字，不算她自己和他自己的名字；
 * 问过去的事要是问她的：有「你」、是问句，或者没说「我」（「我今天去爬山了」不算）
 */
export function commonCue(history: readonly Said[], self: Contact, entities: readonly string[], charName: string): string | undefined {
    if (!knowsPeople(self.tier)) return undefined;
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const said = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content);
    if (said.length === 0) return undefined;
    const text = said.join('\n');
    const entity = entities
        .filter(name => [...name].length >= MIN_NAME_CHARS && name !== charName && name !== self.name && text.includes(name))
        .sort((a, b) => b.length - a.length)[0];
    if (entity) return entity;
    const asksHer = said.some(line => PAST_TIME.test(line) && PAST_DOING.test(line) && (/你/.test(line) || /[?？吗呢]\s*$/.test(line) || !/我/.test(line)));
    return asksHer ? '问她过去的事' : undefined;
}

/** 介绍一个人：称呼和 intro，后面接她对他的印象（ADR 0017）、召回到的记忆（都已整理成一段，没有的不写） */
export function describePerson(person: Contact, ...more: (string | undefined)[]): string {
    return [`[你认识的人：${person.name}]`, `${person.name}：${person.intro}`, ...more.filter(text => text)].join('\n');
}
