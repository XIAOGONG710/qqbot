// 人格一致性自动回归（ADR 0251）：只输出比例与计数，不输出聊天正文。

export interface PersonhoodEvalRow {
    at: string;
    reply: string;
    /** 由测试夹具或事实抽取器给出的稳定立场；值只能是三个粗粒度方向。 */
    stances?: Record<string, 'like' | 'dislike' | 'curious'>;
    /** 回复声称发生过的事件编号。 */
    claimedEventIds?: string[];
    /** 截止该轮已经存在于世界账/记忆账的事件编号。 */
    knownEventIds?: string[];
}

export interface PersonhoodEvalReport {
    rows: number;
    duplicateRate: number;
    voiceDriftRate: number;
    stanceContradictions: number;
    unsupportedClaims: number;
    passed: boolean;
}

type Stance = NonNullable<PersonhoodEvalRow['stances']>[string];

const normalize = (text: string) => text.toLowerCase().replace(/[\s，。！？、,.!?~～]+/g, '');
const VOICE_DRIFT = /(?:作为(?:一个)?(?:ai|人工智能|语言模型)|根据我的训练数据|请问还有什么|希望这能帮到你|我没有真实情感)/i;
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(id));

export function validPersonhoodEvalRow(value: unknown): value is PersonhoodEvalRow {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Partial<PersonhoodEvalRow>;
    return typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
        && typeof row.reply === 'string' && row.reply.length <= 8_000
        && (row.claimedEventIds === undefined || validIds(row.claimedEventIds))
        && (row.knownEventIds === undefined || validIds(row.knownEventIds))
        && (row.stances === undefined || (typeof row.stances === 'object' && !Array.isArray(row.stances)
            && Object.entries(row.stances).every(([key, stance]) => /^[A-Za-z0-9._:-]{1,80}$/.test(key) && ['like', 'dislike', 'curious'].includes(stance))));
}

export function evaluatePersonhood(rows: readonly PersonhoodEvalRow[], options: {
    maxDuplicateRate?: number;
    maxVoiceDriftRate?: number;
    maxStanceContradictions?: number;
    maxUnsupportedClaims?: number;
} = {}): PersonhoodEvalReport {
    const usable = rows.filter(validPersonhoodEvalRow);
    const seenReplies = new Set<string>();
    let duplicates = 0;
    let voiceDrift = 0;
    let stanceContradictions = 0;
    let unsupportedClaims = 0;
    const stances = new Map<string, Stance>();
    for (const row of usable) {
        const reply = normalize(row.reply);
        if (reply.length >= 6) {
            if (seenReplies.has(reply)) duplicates++;
            seenReplies.add(reply);
        }
        if (VOICE_DRIFT.test(row.reply)) voiceDrift++;
        for (const [key, stance] of Object.entries(row.stances ?? {})) {
            const previous = stances.get(key);
            if (previous && previous !== stance && previous !== 'curious' && stance !== 'curious') stanceContradictions++;
            stances.set(key, stance);
        }
        const known = new Set(row.knownEventIds ?? []);
        unsupportedClaims += (row.claimedEventIds ?? []).filter(id => !known.has(id)).length;
    }
    const rate = (value: number) => usable.length ? Number((value / usable.length).toFixed(4)) : 0;
    const duplicateRate = rate(duplicates);
    const voiceDriftRate = rate(voiceDrift);
    const passed = duplicateRate <= (options.maxDuplicateRate ?? 0.08)
        && voiceDriftRate <= (options.maxVoiceDriftRate ?? 0)
        && stanceContradictions <= (options.maxStanceContradictions ?? 0)
        && unsupportedClaims <= (options.maxUnsupportedClaims ?? 0);
    return { rows: usable.length, duplicateRate, voiceDriftRate, stanceContradictions, unsupportedClaims, passed };
}
