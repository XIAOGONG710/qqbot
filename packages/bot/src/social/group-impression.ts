// 她对群里某个人的印象（用户 2026-11-14：「有性格印象，且能保留」）。
//
// 只从那个人自己说过的原话里总结，一句话、最多 30 字，写在 group-people.ts 的底账里，重启还在。
// 说得最多的那种人才值得写（至少说过几句、而且隔了一阵没更新）；模型只负责把它写成一句人话，
// 写不出来就继续没有印象——不编。
//
// 不写的事：不写群里别人的八卦、不写她和他之间的事（那些在私聊里，不进群）。

import { GROUP_PEOPLE_LINES, type GroupPerson } from './group-people.ts';

/** 至少说过这么多句才值得总结 */
export const IMPRESSION_MIN_MSGS = 5;
/** 印象最多几个字 */
export const IMPRESSION_MAX_CHARS = 30;
/** 隔这么久才重新总结一次（人名下的话不多，别天天重写） */
export const IMPRESSION_STALE_MS = 14 * 24 * 3_600_000;

/** 这个人现在该不该让模型重新总结一句印象 */
export function impressionDue(person: GroupPerson, now: number): boolean {
    if (person.msgs < IMPRESSION_MIN_MSGS) return false;
    if (!person.said.length) return false;
    const at = person.impressionAt ? Date.parse(person.impressionAt) : NaN;
    if (!Number.isFinite(at)) return true;
    return now - at >= IMPRESSION_STALE_MS;
}

export function impressionPrompt(person: Pick<GroupPerson, 'names' | 'said' | 'impression'>): string {
    const name = person.names[0] ?? '群友';
    return [
        '下面是一个 QQ 群里的人最近说过的话（都是他在群里说的原话，可能有错别字、有表情包描述）。',
        `他叫「${name}」。`,
        person.said.map(line => `- ${line}`).join('\n'),
        person.impression ? `你原来对他的印象是「${person.impression}」，可以改也可以留着。` : '',
        '用一句话写出他是个什么样的人、爱聊什么（可以有依据地推测性格，但别编他说过的话）。',
        `不超过 ${IMPRESSION_MAX_CHARS} 个字，只输出这一句，不要引号、不要解释、不要写名字。`,
    ].filter(Boolean).join('\n');
}

/** 模型写回来的那一句：去掉引号、换行、名字前缀，超长截断；空的就是没写出来 */
export function parseImpression(raw: string): string | undefined {
    const text = String(raw ?? '')
        .replace(/\r/g, '')
        .split('\n').map(line => line.trim()).filter(Boolean)[0]
        ?.replace(/^(?:印象|他对你|他)[：:]\s*/, '')
        .replace(/^[「“"'《]+|[」”"'》]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return undefined;
    const chars = [...text];
    return chars.length > IMPRESSION_MAX_CHARS ? `${chars.slice(0, IMPRESSION_MAX_CHARS).join('')}…` : text;
}

/**
 * 从这一批说话的人里挑一个该更新的（优先没印象的、说得多的），后台让模型写一句。
 * 一批最多写一个人：群的印象是慢慢长出来的，不是一次性批量生成。
 */
export function impressionCandidate(people: readonly GroupPerson[], spoke: ReadonlySet<number>, now: number): GroupPerson | undefined {
    return people
        .filter(person => spoke.has(person.qq) && impressionDue(person, now))
        .sort((a, b) => Number(Boolean(a.impression)) - Number(Boolean(b.impression)) || b.msgs - a.msgs)[0];
}

/** 印象里要带上几句原话才能写；没有原话就不写 */
export function impressionInput(person: GroupPerson): GroupPerson['said'] {
    return person.said.slice(-GROUP_PEOPLE_LINES);
}
