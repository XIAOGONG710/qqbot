// 她的过去（ADR 0022）：source/biography.yml → 每档卡上的 extensions.qqbot.biography。
// 自传（characters/linmengyao/biography/autobiography-v1.md，作者定稿）是素材的出处；这里是切好的块：
// - timeline：年表，事实源；运行时想起某一块时附一行，不单独进提示词
// - chunks：一件事一块，第一人称的素材（不是台词），按档位可见，keys 是他说到哪些词时想起来；
//   gap 是留白：refuse 不想讲、vague 记不清、unsaid 心里的事不说出口
// 不整篇进提示词（运行时 packages/bot/src/biography.ts 有线索才放 1–2 块）。

import type { CardBiography } from './st-format.ts';

export const BIOGRAPHY_GAPS = ['refuse', 'vague', 'unsaid'] as const;
export type BiographyGap = (typeof BIOGRAPHY_GAPS)[number];

export interface BiographyVariant {
    tiers: string[];
    text: string;
    note?: string;
}

export interface TimelineSource {
    when: string;
    text: string;
    tiers: string[];
    note?: string;
}

export interface ChunkSource {
    id: string;
    title: string;
    /** 他说到这些词（出现在他这次的话里）就想起这一块；不进提示词 */
    keys: string[];
    gap?: BiographyGap;
    text: string;
    tiers: string[];
    /** 某几档用的改写版本，按顺序取第一条含这一档的（同 persona.yml） */
    variants?: BiographyVariant[];
    note?: string;
}

export interface BiographySource {
    /** 素材出处等说明 */
    note?: string;
    timeline: TimelineSource[];
    chunks: ChunkSource[];
}

/** 检查 biography.yml 的结构（档位名在 build.ts 的 checkReferences 里查） */
export function checkBiography(raw: unknown): BiographySource {
    const fail = (at: string, message: string): never => { throw new Error(`biography.yml${at} ${message}`); };
    const object = (v: unknown, at: string): Record<string, unknown> =>
        typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail(at, '应为对象');
    const keys = (o: Record<string, unknown>, at: string, allowed: string[]) => {
        const unknown = Object.keys(o).filter(key => !allowed.includes(key));
        if (unknown.length) fail(at, `有不认识的键：${unknown.join('、')}`);
    };
    const text = (v: unknown, at: string): string => typeof v === 'string' && v.trim() ? v.trim() : fail(at, '应为非空字符串');
    const optional = (v: unknown, at: string): string | undefined =>
        v === undefined || v === null || (typeof v === 'string' && !v.trim()) ? undefined : text(v, at);
    const strings = (v: unknown, at: string): string[] => {
        if (!Array.isArray(v) || v.length === 0) fail(at, '应为非空的字符串数组');
        return (v as unknown[]).map((item, i) => text(item, `${at}[${i}]`));
    };
    const array = (v: unknown, at: string): unknown[] => Array.isArray(v) ? v : fail(at, '应为数组');
    const withNote = <T extends object>(base: T, note: string | undefined): T & { note?: string } => (note ? { ...base, note } : base);

    const root = object(raw, '');
    keys(root, '', ['note', 'timeline', 'chunks']);
    const timeline = array(root.timeline, '.timeline').map((value, i): TimelineSource => {
        const at = `.timeline[${i}]`;
        const o = object(value, at);
        keys(o, at, ['when', 'text', 'tiers', 'note']);
        return withNote({ when: text(o.when, `${at}.when`), text: text(o.text, `${at}.text`), tiers: strings(o.tiers, `${at}.tiers`) }, optional(o.note, `${at}.note`));
    });
    const ids = new Set<string>();
    const chunks = array(root.chunks, '.chunks').map((value, i): ChunkSource => {
        const at = `.chunks[${i}]`;
        const o = object(value, at);
        keys(o, at, ['id', 'title', 'keys', 'gap', 'text', 'tiers', 'variants', 'note']);
        const id = text(o.id, `${at}.id`);
        if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`${at}.id`, '只能用小写字母、数字和连字符');
        if (ids.has(id)) fail(`${at}.id`, `重复：${id}`);
        ids.add(id);
        const gap = optional(o.gap, `${at}.gap`);
        if (gap !== undefined && !(BIOGRAPHY_GAPS as readonly string[]).includes(gap)) fail(`${at}.gap`, `应为 ${BIOGRAPHY_GAPS.join(' / ')}`);
        const variants = o.variants === undefined ? undefined : array(o.variants, `${at}.variants`).map((v, j): BiographyVariant => {
            const vat = `${at}.variants[${j}]`;
            const vo = object(v, vat);
            keys(vo, vat, ['tiers', 'text', 'note']);
            return withNote({ tiers: strings(vo.tiers, `${vat}.tiers`), text: text(vo.text, `${vat}.text`) }, optional(vo.note, `${vat}.note`));
        });
        return withNote({
            id,
            title: text(o.title, `${at}.title`),
            keys: strings(o.keys, `${at}.keys`),
            ...(gap ? { gap: gap as BiographyGap } : {}),
            text: text(o.text, `${at}.text`),
            tiers: strings(o.tiers, `${at}.tiers`),
            ...(variants?.length ? { variants } : {}),
        }, optional(o.note, `${at}.note`));
    });
    return withNote({ timeline, chunks }, optional(root.note, ''));
}

/** 这一档看得到的年表和块；一块都没有就是 undefined（卡上不写） */
export function biographyForTier(source: BiographySource | undefined, tier: string): CardBiography | undefined {
    if (!source) return undefined;
    const chunks = source.chunks.filter(chunk => chunk.tiers.includes(tier)).map(chunk => ({
        id: chunk.id,
        title: chunk.title,
        keys: [...chunk.keys],
        ...(chunk.gap ? { gap: chunk.gap } : {}),
        text: chunk.variants?.find(v => v.tiers.includes(tier))?.text ?? chunk.text,
    }));
    if (chunks.length === 0) return undefined;
    const timeline = source.timeline.filter(item => item.tiers.includes(tier)).map(item => `${item.when}：${item.text}`);
    return { timeline, chunks };
}

/** 档位名都在：给 build.ts 的 checkReferences 用 */
export function biographyTierRefs(source: BiographySource | undefined): { at: string; tiers: string[] }[] {
    if (!source) return [];
    return [
        ...source.timeline.map((item, i) => ({ at: `biography.yml timeline[${i}].tiers`, tiers: item.tiers })),
        ...source.chunks.flatMap((chunk, i) => [
            { at: `biography.yml chunks[${i}].tiers`, tiers: chunk.tiers },
            ...(chunk.variants ?? []).map((v, j) => ({ at: `biography.yml chunks[${i}].variants[${j}].tiers`, tiers: v.tiers })),
        ]),
    ];
}
