// 群里的遭遇也进她的心境（用户 2026-11-14：「群里的对话会反过来改她的心境」）。
//
// 和私聊那边同一套：只认说出口的事实（有人谢她、有人骂她、有人想不开），变成带时刻的评估，
// 由 feelings.ts 按半衰期衰减——不存「她现在开心 N 分」这种会漂的东西。
// 落盘：<数据目录>/groups/<群号>.affect.json，一个群一份；只留近几天的、最多 60 条。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { herNameList, type GroupEntry } from './group-chat.ts';
import type { Appraisal, Felt } from '../emotion/feelings.ts';

/** 最多留几条（小事，每人每天也遇不上几件） */
export const GROUP_AFFECT_MAX = 60;
/** 只留这么久以内的（和半衰期的 4 倍对齐，再老也已经散干净） */
export const GROUP_AFFECT_KEEP_MS = 32 * 3_600_000;

/** 有人夸她 / 谢她 */
const PRAISE = /谢谢|多谢|辛苦了|辛苦啦|厉害|牛啊|牛哇|好听|好看|说得对|真会|好会|靠谱|nice|Nice/i;
/** 有人冲她发火 / 骂她 */
const RUDE = /闭嘴|滚(?:\s|$|吧|开)|傻[逼比]|你谁啊|别烦|烦死了|机器人|有病|神经病|恶心/;
/** 想不开（和 group-chat 一样用私聊那套判定，这里只要「有人说了」） */
const DESPAIR_ISH = /不想活|想死|自杀|轻生|活着没意思|活着没意义|跳楼|割腕|结束自己/;

/** 点名她了没有：@她（记录里写成「@你」）、或者叫她的名字（真名 / 群里那个昵称） */
function addressedToHer(content: string, extra: readonly string[] = []): boolean {
    return content.includes('@你') || herNameList(extra).some(name => content.includes(name));
}

/**
 * 一条群消息在她心里算不算事；不算返回 undefined。
 * 只有「冲着她来的」才进心境：别人互夸、别人互骂不关她的事。
 */
export function groupAffectOf(input: {
    entry: Pick<GroupEntry, 'content' | 'messageId'>;
    /** 这条是不是在跟她说话（speakReason 判出来的 mentioned / defend / crisis） */
    addressed: boolean;
    at: number;
    /** 她在这个群被叫的名字（QQ 昵称 / 群名片） */
    herNames?: readonly string[];
}): Appraisal | undefined {
    const { entry, addressed, at } = input;
    const cause = entry.content;
    if (!Number.isFinite(at)) return undefined;
    if (DESPAIR_ISH.test(cause)) {
        return { id: `group:crisis:${entry.messageId}`, at, kind: 'worry', strength: 2, cause: '群里有人说想不开', source: 'group' };
    }
    // 夸 / 谢：得是冲她来的（点名、@、或者正在接她的话）；一条就该让她心情好起来（clear 档）
    if ((addressed || addressedToHer(cause, input.herNames)) && PRAISE.test(cause)) {
        return { id: `group:praise:${entry.messageId}`, at, kind: 'joy', strength: 2, cause: '群里有人夸你、谢你', source: 'group' };
    }
    // 骂她：冲她来的算，没 @ 她但在群里说她坏话也算（听见了）
    if ((addressed || addressedToHer(cause, input.herNames)) && RUDE.test(cause)) {
        return { id: `group:rude:${entry.messageId}`, at, kind: 'annoyed', strength: 2, cause: '有人在群里冲你发火', source: 'group' };
    }
    return undefined;
}

export interface GroupAffect {
    /** 这个群（或所有群）留下的评估：喂给 feelingsAt 现算 */
    appraisals(groupId?: number): Appraisal[];
    /** 记一条；不关她的事就不记 */
    note(groupId: number, appraisal: Appraisal | undefined): void;
}

/** now：清旧记录按哪个时钟算（线上不传，用墙上时间；测试的日子是写死的，传测试自己的时钟，免得日子一过记下的那条当场被清掉） */
export function groupAffect(dataDir: string, clock: () => number = Date.now): GroupAffect {
    const dir = join(dataDir, 'groups');
    const file = (groupId: number) => join(dir, `${groupId}.affect.json`);
    const cache = new Map<number, Appraisal[]>();

    const load = (groupId: number): Appraisal[] => {
        const hit = cache.get(groupId);
        if (hit) return hit;
        let list: Appraisal[] = [];
        const path = file(groupId);
        if (existsSync(path)) {
            try {
                const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
                if (Array.isArray(parsed)) {
                    const now = clock();
                    list = parsed.filter((item): item is Appraisal => Boolean(item) && typeof item === 'object'
                        && typeof (item as Appraisal).id === 'string' && Number.isFinite((item as Appraisal).at)
                        && now - (item as Appraisal).at <= GROUP_AFFECT_KEEP_MS);
                }
            } catch { /* 坏了就从空的开始 */ }
        }
        cache.set(groupId, list);
        return list;
    };

    return {
        appraisals(groupId) {
            const ids = groupId === undefined ? [...cache.keys()] : [groupId];
            return ids.flatMap(id => load(id));
        },
        note(groupId, appraisal) {
            if (!appraisal) return;
            const list = load(groupId);
            if (list.some(item => item.id === appraisal.id)) return;
            list.push(appraisal);
            const cutoff = clock() - GROUP_AFFECT_KEEP_MS;
            while (list.length > GROUP_AFFECT_MAX || (list[0] && list[0].at < cutoff)) list.shift();
            try {
                mkdirSync(dirname(file(groupId)), { recursive: true });
                const temp = `${file(groupId)}.tmp`;
                writeFileSync(temp, JSON.stringify(list));
                renameSync(temp, file(groupId));
            } catch { /* 写不进去只是这次的心情下次没了 */ }
        },
    };
}

/** 两组已经算好的感受合并：同一种取更重的，按分量排 */
export function mergeFelt(a: readonly Felt[], b: readonly Felt[]): Felt[] {
    const byKind = new Map<string, Felt>();
    for (const felt of [...a, ...b]) {
        const known = byKind.get(felt.kind);
        if (!known || felt.weight > known.weight) byKind.set(felt.kind, felt);
    }
    return [...byKind.values()].sort((x, y) => y.weight - x.weight);
}
