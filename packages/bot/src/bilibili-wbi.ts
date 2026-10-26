// B 站 wbi 签名（ADR 0168 第 2 期）：推荐流、AI 总结这些接口 2023 年起要 w_rid + wts，
// 算法固定但官方没文档：nav 接口拿 img_key / sub_key → 64 位混音表重排成 mixinKey → 参数排序后拼 query，md5(query + mixinKey)。
// 只读、无依赖（node:crypto），失败抛错由调用方记一行。

import { createHash } from 'node:crypto';

/** 官方混音表（64 项，顺序固定；B 站改过就整体换） */
export const MIXIN_KEY_TABLE: readonly number[] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** img_key + sub_key（各 32 位）→ 混音后的 32 位 key */
export function mixinKey(imgKey: string, subKey: string): string {
    const raw = `${imgKey}${subKey}`;
    return MIXIN_KEY_TABLE.map(index => raw[index] ?? '').join('').slice(0, 32);
}

/** 参数值只留字母数字和 -_.~（官方实现：去掉 !'()* 这些） */
const clean = (value: string): string => value.replace(/[!'()*]/g, '');

/** 排序、拼 query、加 wts，再 md5(query + key) 得到 w_rid。返回最终要带上的参数（含 wts / w_rid） */
export function signParams(params: Record<string, string | number>, key: string, wts = Math.floor(Date.now() / 1000)): Record<string, string | number> {
    const all: Record<string, string | number> = { ...params, wts };
    const query = Object.keys(all).sort().map(name => `${encodeURIComponent(name)}=${encodeURIComponent(clean(String(all[name]!)))}`).join('&');
    const wRid = createHash('md5').update(query + key).digest('hex');
    return { ...all, w_rid: wRid };
}

export interface WbiKeys { imgKey: string; subKey: string }

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** 从 nav 接口拿两条 key：data.wbi_img.img_url / sub_url，取文件名（去掉扩展名） */
export async function fetchWbiKeys(doFetch: Fetch, headers: Record<string, string>): Promise<WbiKeys> {
    const response = await doFetch('https://api.bilibili.com/x/web-interface/nav', { headers });
    if (!response.ok) throw new Error(`nav 接口 HTTP ${response.status}`);
    const json = JSON.parse(await response.text()) as { code?: number; data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
    const imgUrl = json.data?.wbi_img?.img_url ?? '';
    const subUrl = json.data?.wbi_img?.sub_url ?? '';
    const name = (url: string): string => url.slice(url.lastIndexOf('/') + 1).split('.')[0] ?? '';
    const imgKey = name(imgUrl);
    const subKey = name(subUrl);
    if (imgKey.length < 16 || subKey.length < 16) throw new Error('nav 接口没给 wbi key（可能被风控）');
    return { imgKey, subKey };
}
