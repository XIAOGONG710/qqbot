import type { WorldNow } from './world.ts';

export interface WorldHighlight {
    at: string;
    text: string;
}

interface Candidate {
    at: Date;
    text: string;
}

const MEAL_LABEL = { lunch: '午饭', dinner: '晚饭' } as const;

/**
 * 把世界账里已经发生的事实压成控制台可读的「今天发生」。
 * 这里只做确定性投影：未来计划、模型猜测和没有时间依据的状态都不展示。
 */
export function worldHighlights(world: WorldNow | undefined, now: Date, limit = 3): WorldHighlight[] {
    if (!world || !Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit <= 0) return [];
    const candidates: Candidate[] = [];
    const add = (at: Date, text: string) => {
        if (!Number.isFinite(at.getTime()) || at > now || !text.trim()) return;
        candidates.push({ at, text: text.trim() });
    };

    for (const event of world.events ?? []) add(event.at, event.text);

    const cat = world.cat;
    if (cat && 'fed' in cat.today) {
        const ending = cat.today.seen === true ? '，也见到它了' : cat.today.seen === false ? '，但没见到它' : '';
        add(cat.today.fed, `喂过${cat.name}${ending}`);
    }

    for (const meal of world.routine?.meals ?? []) {
        if (meal.dish) add(meal.end, `${MEAL_LABEL[meal.kind]}吃了${meal.dish}`);
    }
    for (const parcel of world.parcels ?? []) {
        if (parcel.status === 'picked_today') add(parcel.when, `取了${parcel.item}`);
    }
    for (const homework of world.homework ?? []) {
        if (homework.done) add(homework.doneAt, `${homework.course}作业写完了`);
    }

    const seen = new Set<string>();
    return candidates
        .sort((a, b) => b.at.getTime() - a.at.getTime() || a.text.localeCompare(b.text, 'zh-CN'))
        .filter(candidate => {
            if (seen.has(candidate.text)) return false;
            seen.add(candidate.text);
            return true;
        })
        .slice(0, limit)
        .map(candidate => ({ at: candidate.at.toISOString(), text: candidate.text }));
}
