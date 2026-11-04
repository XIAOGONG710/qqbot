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
    nearDuplicateRate: number;
    openingRepeatRate: number;
    voiceDriftRate: number;
    stanceContradictions: number;
    unsupportedClaims: number;
    chronologyErrors: number;
    passed: boolean;
}

type Stance = NonNullable<PersonhoodEvalRow['stances']>[string];

const normalize = (text: string) => text.toLowerCase().replace(/[\s，。！？、,.!?~～]+/g, '');
const VOICE_DRIFT = /(?:作为(?:一个)?(?:ai|人工智能|语言模型)|根据我的训练数据|请问还有什么|希望这能帮到你|我没有真实情感)/i;
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(id));

function nearDuplicate(left: string, right: string): boolean {
    if (left === right || left.length < 10 || right.length < 10) return false;
    const grams = (value: string) => new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
    const a = grams(left);
    const b = grams(right);
    let common = 0;
    for (const gram of a) if (b.has(gram)) common++;
    return common / Math.min(a.size, b.size) >= 0.65 && Math.min(left.length, right.length) / Math.max(left.length, right.length) >= 0.72;
}

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
    maxNearDuplicateRate?: number;
    maxOpeningRepeatRate?: number;
    maxVoiceDriftRate?: number;
    maxStanceContradictions?: number;
    maxUnsupportedClaims?: number;
    maxChronologyErrors?: number;
} = {}): PersonhoodEvalReport {
    const usable = rows.filter(validPersonhoodEvalRow);
    const seenReplies = new Set<string>();
    const recentReplies: string[] = [];
    const seenOpenings = new Set<string>();
    let duplicates = 0;
    let nearDuplicates = 0;
    let openingRepeats = 0;
    let voiceDrift = 0;
    let stanceContradictions = 0;
    let unsupportedClaims = 0;
    let chronologyErrors = 0;
    let previousAt = Number.NEGATIVE_INFINITY;
    const stances = new Map<string, Stance>();
    for (const row of usable) {
        const reply = normalize(row.reply);
        const rowAt = Date.parse(row.at);
        if (rowAt < previousAt) chronologyErrors++;
        previousAt = Math.max(previousAt, rowAt);
        if (reply.length >= 6) {
            if (seenReplies.has(reply)) duplicates++;
            else if (recentReplies.some(previous => nearDuplicate(previous, reply))) nearDuplicates++;
            seenReplies.add(reply);
            recentReplies.push(reply);
            if (recentReplies.length > 50) recentReplies.shift();
        }
        if (reply.length >= 12) {
            const opening = reply.slice(0, 6);
            if (seenOpenings.has(opening)) openingRepeats++;
            seenOpenings.add(opening);
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
    const nearDuplicateRate = rate(nearDuplicates);
    const openingRepeatRate = rate(openingRepeats);
    const voiceDriftRate = rate(voiceDrift);
    const passed = duplicateRate <= (options.maxDuplicateRate ?? 0.08)
        && nearDuplicateRate <= (options.maxNearDuplicateRate ?? 0.12)
        && openingRepeatRate <= (options.maxOpeningRepeatRate ?? 0.35)
        && voiceDriftRate <= (options.maxVoiceDriftRate ?? 0)
        && stanceContradictions <= (options.maxStanceContradictions ?? 0)
        && unsupportedClaims <= (options.maxUnsupportedClaims ?? 0)
        && chronologyErrors <= (options.maxChronologyErrors ?? 0);
    return { rows: usable.length, duplicateRate, nearDuplicateRate, openingRepeatRate, voiceDriftRate, stanceContradictions, unsupportedClaims, chronologyErrors, passed };
}
