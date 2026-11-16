// 虚拟生理调节的派生快照（ADR 0338）。
// 复用既有 needs/body 事实，不模拟医学意义上的激素浓度；结果只描述可供动机层读取的调节倾向。

import type { NeedsSnapshot } from './needs.ts';
import type { BodyNow } from './body.ts';

export interface RegulationSnapshot {
    at: string;
    /** 0–1，身体不适、困累和饥饿的综合程度。 */
    discomfort: number;
    /** 0–1，当前警觉 / 紧绷程度，不等同于情绪。 */
    arousal: number;
    /** 0–1，休息和降低负荷的倾向。 */
    recoveryNeed: number;
    /** 0–1，承受社交互动的剩余容量。 */
    socialCapacity: number;
    /** 0–1，进行复杂思考或活动的剩余容量。 */
    cognitiveCapacity: number;
}

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

function bodyDiscomfort(body: BodyNow | undefined): number {
    if (!body) return 0;
    let result = 0;
    if (body.period?.cramps === 'bad') result = Math.max(result, 0.85);
    else if (body.period?.cramps === 'mild') result = Math.max(result, 0.5);
    else if (body.period) result = Math.max(result, 0.15);
    if (body.cold) result = Math.max(result, body.cold.day === 1 ? 0.65 : 0.45);
    if (body.sleepy) result = Math.max(result, body.sleepy.when === 'late' ? 0.55 : 0.4);
    if (body.tired) result = Math.max(result, 0.5);
    if (body.hungry) result = Math.max(result, body.hungry === 'night' ? 0.45 : 0.3);
    return result;
}

/**
 * 将已有连续需要与身体事实投影为慢速调节状态。
 * 这些量是角色运行时的功能参数，不是对真实人的医学判断；同一输入总会得到同一输出。
 */
export function regulationAt(needs: NeedsSnapshot, body?: BodyNow): RegulationSnapshot {
    const energy = clamp(needs.energy / 100);
    const hunger = clamp(needs.hunger / 100);
    const stress = clamp(needs.stress / 100);
    const discomfort = bodyDiscomfort(body);
    const recoveryNeed = clamp(Math.max(1 - energy, stress * 0.72, discomfort, hunger * 0.45));
    const arousal = clamp(stress * 0.7 + (1 - energy) * 0.2 + discomfort * 0.1);
    const socialCapacity = clamp(energy * 0.55 + (1 - stress) * 0.3 + (1 - discomfort) * 0.15 - hunger * 0.15);
    const cognitiveCapacity = clamp(energy * 0.55 + (1 - stress) * 0.3 + (1 - discomfort) * 0.15 - hunger * 0.1);
    return {
        at: needs.at,
        discomfort: rounded(discomfort),
        arousal: rounded(arousal),
        recoveryNeed: rounded(recoveryNeed),
        socialCapacity: rounded(socialCapacity),
        cognitiveCapacity: rounded(cognitiveCapacity),
    };
}

function rounded(value: number): number { return Math.round(value * 1000) / 1000; }

