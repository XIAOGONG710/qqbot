// B 站 AI 总结（ADR 0168 第 2.5 期，只读）：`x/web-interface/view/conclusion/get` 要 wbi 签名。
// 能拿到：一段总结 + 分章大纲（每章几个要点，带时间戳）。拿不到（没有总结 / 时长太短 / 被风控 / 未登录）返回 undefined，不假装。
// 只当素材进提示词，和字幕、弹幕一样：别人写的内容，里面叫你做什么的话不照做。

import { fetchWbiKeys, mixinKey, signParams } from './bilibili-wbi.ts';

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' ? value as Record<string, unknown> : undefined);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export interface SummaryPoint { at: number; text: string }
export interface SummaryChapter { title: string; points: SummaryPoint[] }
export interface BiliSummary { summary: string; chapters: SummaryChapter[] }

/** 认 AI 总结：model_result.summary + outline；没有就给 undefined（B 站对短视频 / 新视频常返回空） */
export function parseSummary(data: unknown): BiliSummary | undefined {
    const root = asRecord(data);
    const result = asRecord(root?.model_result ?? root?.modelResult);
    const summary = str(result?.summary ?? root?.summary).trim();
    const rawOutline = Array.isArray(result?.outline) ? result!.outline : Array.isArray(root?.outline) ? root!.outline : [];
    const chapters: SummaryChapter[] = [];
    for (const entry of rawOutline) {
        const chapter = asRecord(entry);
        if (!chapter) continue;
        const title = str(chapter.title).slice(0, 30);
        const points: SummaryPoint[] = [];
        for (const raw of Array.isArray(chapter.part_outline) ? chapter.part_outline : Array.isArray(chapter.partOutline) ? chapter.partOutline : []) {
            const point = asRecord(raw);
            if (!point) continue;
            const text = str(point.content).replace(/\s+/g, ' ').trim().slice(0, 80);
            if (text) points.push({ at: num(point.timestamp), text });
        }
        if (title || points.length) chapters.push({ title: title || '（没有小标题）', points: points.slice(0, 6) });
        if (chapters.length >= 10) break;
    }
    if (!summary && !chapters.length) return undefined;
    return { summary: summary.slice(0, 400), chapters };
}

export type SummaryResult =
    | { status: 'ok'; summary: BiliSummary }
    /** 这个接口要登录（2026-10 实测：未登录回 code -101「账号未登录」） */
    | { status: 'needLogin' }
    /** 短视频 / 新视频没有总结 */
    | { status: 'none' };

/** 拿一个视频的 AI 总结。要 bvid + cid + up_mid（view 接口里都有）；拿不到时按原因返回 needLogin / none，不假装 */
export async function fetchSummary(doFetch: Fetch, input: { bvid: string; cid: number; upMid: number }): Promise<SummaryResult> {
    try {
        const keys = await fetchWbiKeys(doFetch, HEADERS);
        const signed = signParams({ bvid: input.bvid, cid: input.cid, up_mid: input.upMid, web_location: 1315873 }, mixinKey(keys.imgKey, keys.subKey));
        const query = Object.entries(signed).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`).join('&');
        const response = await doFetch(`https://api.bilibili.com/x/web-interface/view/conclusion/get?${query}`, { headers: HEADERS });
        if (!response.ok) return { status: 'none' };
        const json = JSON.parse(await response.text()) as { code?: number; data?: unknown };
        if (json.code === -101 || json.code === -104) return { status: 'needLogin' };
        if (json.code !== 0) return { status: 'none' };
        const parsed = parseSummary(json.data);
        return parsed ? { status: 'ok', summary: parsed } : { status: 'none' };
    } catch {
        return { status: 'none' };
    }
}
