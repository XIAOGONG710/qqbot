// 桌面上的事也进心境（ADR 0347 第 5 层第五处断口）。
//
// 起因：QQ 是唯一算心境的地方（ADR 0197），可是他在电脑上（DSH）跟她说的话、她在那边的回应
// 什么都不进心境——桌面上过了一晚上，QQ 这边她心里还是空的。她 11-22 说「想起来还带着当时的感觉」
// 要的是两边是同一个人的生活；桌面上的事不产生感受，这条就断在那儿。
//
// 只算冲她来的（和 group-affect 一个规矩）：别人说话、她在桌面上自言自语不算。
// 规则只管一眼能看出来的四种，宁可少记，不硬猜——算心思的是她，不是这几个正则。

import type { Appraisal } from '../emotion/feelings.ts';
import type { StoredMessage } from '../memory/history.ts';

/** 他说想她 / 要抱抱：心情好起来 */
const WARM = /想你|想抱|抱抱|亲一下|喜欢你|爱你|mua/i;
/** 他关心她（问吃没吃、让早点睡）：也是心里暖的那一种 */
const CARE = /吃了没|吃了吗|吃饭没|吃饭了没|吃饭了吗|吃点|早点睡|睡觉吧|别熬|别太累|喝水|累不累|注意身体/;
/** 他自己难受（累、被骂、不舒服）：她跟着担心 */
const HIS_TROUBLE = /累死|好累|太累|被骂|难受|不舒服|头疼|发烧|睡不着|烦死了/;
/** 他冲她发火 */
const RUDE = /别烦|烦不烦|闭嘴|滚(?:吧|开)|你烦不烦|有病/;

/**
 * 桌面上的这些话说过的、在她心里算事的：一条消息最多算一件事（先凶后暖按最重的算）。
 * 不算就返回 undefined。
 */
export function desktopAffectOf(message: Pick<StoredMessage, 'role' | 'content' | 'time'>, now = Date.now()): Appraisal | undefined {
    if (message.role !== 'user') return undefined;
    const at = Date.parse(message.time);
    if (!Number.isFinite(at)) return undefined;
    // 太久以前的旧账不再重复算（缓存里会有一整天的回合）
    if (now - at > 6 * 3_600_000) return undefined;
    const said = String(message.content || '');
    if (!said.trim()) return undefined;
    const stamp = `${at}`;
    if (RUDE.test(said)) return { id: `desktop:rude:${stamp}`, at, kind: 'annoyed', strength: 2, cause: '他在电脑上冲你发火', source: 'desktop', aboutHim: true };
    if (HIS_TROUBLE.test(said)) return { id: `desktop:trouble:${stamp}`, at, kind: 'worry', strength: 2, cause: '他在电脑上说难受', source: 'desktop', aboutHim: true };
    if (WARM.test(said)) return { id: `desktop:warm:${stamp}`, at, kind: 'joy', strength: 2, cause: '他在电脑上说想你', source: 'desktop', aboutHim: true };
    if (CARE.test(said)) return { id: `desktop:care:${stamp}`, at, kind: 'joy', strength: 1, cause: '他在电脑上关心你', source: 'desktop', aboutHim: true };
    return undefined;
}

/** 一批桌面对话里算得上的评估（喂给心境现算；缓存里是一整天的回合，按时间过滤过） */
export function desktopAffects(messages: readonly Pick<StoredMessage, 'role' | 'content' | 'time'>[], now = Date.now()): Appraisal[] {
    const out: Appraisal[] = [];
    for (const message of messages) {
        const appraisal = desktopAffectOf(message, now);
        if (appraisal) out.push(appraisal);
    }
    return out;
}
