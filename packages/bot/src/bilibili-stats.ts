// 单稿的公开数据（ADR 0168 第 3 期只读层）：播放 / 点赞 / 投币 / 收藏 / 转发 / 评论 / 弹幕。
// 2026-10-27 实测：老的 `x/web-interface/archive/stat` 已经 404，改从 `x/web-interface/view` 的 `stat` 里取（匿名可读）；**完播率、平均观看时长、3 秒退出率**在创作中心后台，要登录，不在这一层。
// 只出数字，不排名、不下结论；比率按「每百次播放」算（和 bili-cli 的口径一致）。

export interface VideoStats {
    view: number;
    danmaku: number;
    reply: number;
    favorite: number;
    coin: number;
    share: number;
    like: number;
}

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
};

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const rec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

/** 认 stat 接口（或 view 里的 stat）：字段少一个不影响，缺的按 0 */
export function parseVideoStats(data: unknown): VideoStats | undefined {
    const stat = rec(rec(data).stat) && Object.keys(rec(rec(data).stat)).length ? rec(rec(data).stat) : rec(data);
    if (!Object.keys(stat).length) return undefined;
    const stats: VideoStats = {
        view: num(stat.view), danmaku: num(stat.danmaku), reply: num(stat.reply), favorite: num(stat.favorite),
        coin: num(stat.coin), share: num(stat.share), like: num(stat.like),
    };
    // 全都 0 多半是错的形状（真视频至少有一个非零）
    if (!stats.view && !stats.like && !stats.favorite && !stats.coin) return undefined;
    return stats;
}

/** 每百次播放的互动（播放为 0 时返回 0，不除零） */
export function perHundred(stats: VideoStats): { like: number; coin: number; favorite: number; reply: number } {
    const base = stats.view || 0;
    const rate = (value: number): number => base ? Math.round((value / base) * 1000) / 10 : 0;
    return { like: rate(stats.like), coin: rate(stats.coin), favorite: rate(stats.favorite), reply: rate(stats.reply) };
}

/** 读一个视频的公开数据；失败抛错（调用方记一行） */
export async function fetchVideoStats(doFetch: Fetch, bvid: string): Promise<VideoStats | undefined> {
    const response = await doFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { headers: HEADERS });
    if (!response.ok) throw new Error(`数据接口 HTTP ${response.status}`);
    const json = JSON.parse(await response.text()) as { code?: number; message?: string; data?: unknown };
    if (json.code !== 0) throw new Error(`数据接口 code ${String(json.code)}（${String(json.message ?? '')}）`);
    return parseVideoStats(json.data);
}

/** 一行摘要（给人看 / 给日志）：「播放 12.3 万；每百播 赞 4.2 / 币 1.1 / 藏 2.0 / 评 0.3」 */
export function statsLine(stats: VideoStats): string {
    const rates = perHundred(stats);
    const wan = (value: number): string => value >= 10000 ? `${Math.round(value / 1000) / 10} 万` : String(value);
    return `播放 ${wan(stats.view)}、赞 ${wan(stats.like)}、币 ${wan(stats.coin)}、藏 ${wan(stats.favorite)}；每百播 赞 ${rates.like} / 币 ${rates.coin} / 藏 ${rates.favorite} / 评 ${rates.reply}`;
}
