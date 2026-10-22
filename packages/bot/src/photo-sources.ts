// 照片货架的网络来源（ADR 0109 补）：她的照片不用作者给的相册，自己从网上找高清图。
// 来源：Wikimedia Commons（不用 key）。只收 CC0 / 公有领域——发给他不需要署名，也不碰版权；其他许可（CC BY / BY-SA 要署名）一律不收。
// 范围：猫（三花，同一组系列里取，免得每张是不同的猫）和天空 / 晚霞。她的作品（work）、风景以外的街景不走网络：街景里的招牌、人、地名对不上她在济南的生活。
// 高清：原图宽 ≥ 2400、高 ≥ 1600，下载 2560 宽的缩略图（Commons 自己生成，不放大，一般 1–3 MB）。
// 水印（用户 10-22：「记得去水印」）：不擦别人图上的水印——来源只取 CC0 / 公有领域的原图（本来基本没有），再逐张让看图模型检查叠加的文字、水印、徽标、日期戳、相框；
// 有任何一样就不收，模型没明确回答“没有”也不收（宁可少收）。
// 把关：下载后让看图模型回一个 JSON（有没有人脸、有没有水印 / 文字、是不是猫 / 三花 / 以天空为主、清不清晰、一句话描述），代码按规则定收不收；说明里不许带地名、品种名。

import type { AppConfig } from './config.ts';
import { imageDataUrl, fetchRemoteImage } from './safe-image.ts';
import { configuredImageDescriber, MAX_IMAGE_BYTES } from './vision.ts';
import { PHOTO_MAX_BYTES, type PhotoCandidate, type PhotoJudgement, type PhotoKind, type PhotoSource } from './photos.ts';

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
/** Wikimedia 要求带说明性的 User-Agent */
export const COMMONS_USER_AGENT = 'qqbot-photos/1.0 (private companion bot; one photo shelf; low volume)';
/** 网络来源支持的种类 */
export const WEB_PHOTO_KINDS = ['cat', 'view'] as const satisfies readonly PhotoKind[];

const MIN_WIDTH = 2400;
const MIN_HEIGHT = 1600;
/** 宽高比：太扁（全景）或太窄的不要 */
const MIN_ASPECT = 0.55;
const MAX_ASPECT = 1.9;
const PAGE_SIZE = 30;

/** 每一类的搜索词（CirrusSearch 语法）。许可靠代码再筛一遍，搜索词里的只是让结果里 CC0 / 公有领域多一点 */
const QUERIES: Record<(typeof WEB_PHOTO_KINDS)[number], string> = {
    cat: `calico cat filetype:bitmap filew:>${MIN_WIDTH} fileh:>${MIN_HEIGHT}`,
    view: `sunset sky clouds incategory:"CC-Zero" filetype:bitmap filew:>${MIN_WIDTH} fileh:>${MIN_HEIGHT}`,
};

/** 只认这些许可（LicenseShortName）：CC0、公有领域 */
const LICENSE_OK = /^(?:CC0(?:[ -]1\.0)?|CC[ -]Zero|Public domain|PD(?:[ -].*)?)$/i;

/** 标题去掉 “File:”、扩展名和结尾的编号：同一系列的照片有同一个 key（“Calico cat, Lebanon 3.jpg” → “Calico cat, Lebanon”） */
export function seriesKey(title: string): string {
    return title.replace(/^File:/i, '').replace(/\.[a-z0-9]{3,4}$/i, '').replace(/[\s_(-]*\d+\)?$/, '').trim();
}

const stripHtml = (value: unknown) => String(value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

interface CommonsPage {
    title?: string;
    imageinfo?: {
        width?: number; height?: number; mime?: string;
        thumburl?: string; thumbwidth?: number; thumbheight?: number; url?: string; descriptionurl?: string;
        extmetadata?: Record<string, { value?: unknown } | undefined>;
    }[];
}

/** Commons 的搜索结果 → 候选（只留 jpeg、够大、比例正常、CC0 / 公有领域的）。纯函数，测试用 */
export function parseCommons(kind: PhotoKind, body: unknown): PhotoCandidate[] {
    const pages = Object.values((body as { query?: { pages?: Record<string, CommonsPage> } } | undefined)?.query?.pages ?? {});
    const out: PhotoCandidate[] = [];
    for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!page.title || !info || info.mime !== 'image/jpeg') continue;
        const width = info.width ?? 0;
        const height = info.height ?? 0;
        if (width < MIN_WIDTH || height < MIN_HEIGHT) continue;
        const aspect = width / height;
        if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
        const license = stripHtml(info.extmetadata?.LicenseShortName?.value);
        if (!LICENSE_OK.test(license)) continue;
        const imageUrl = info.thumburl ?? info.url;
        if (!imageUrl || !/^https:\/\/upload\.wikimedia\.org\//.test(imageUrl)) continue;
        out.push({
            kind, title: page.title, pageUrl: info.descriptionurl ?? '', imageUrl, width, height, license,
            artist: stripHtml(info.extmetadata?.Artist?.value).slice(0, 60), series: seriesKey(page.title),
        });
    }
    return out;
}

export type CommonsFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CommonsOptions {
    fetch?: CommonsFetch;
    timeoutMs?: number;
}

/** 搜一类的候选；offset 是翻页的起点（0、30、60……） */
export function commonsSearch(options: CommonsOptions = {}): (kind: PhotoKind, offset?: number) => Promise<PhotoCandidate[]> {
    const doFetch: CommonsFetch = options.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<CommonsFetch>);
    return async (kind, offset = 0) => {
        const query = (QUERIES as Record<string, string | undefined>)[kind];
        if (!query) return [];
        const params = new URLSearchParams({
            action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: String(PAGE_SIZE), gsroffset: String(offset),
            gsrsearch: query, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '2560',
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Commons 搜索超时')), options.timeoutMs ?? 12_000);
        try {
            const response = await doFetch(`${COMMONS_API}?${params}`, { headers: { 'user-agent': COMMONS_USER_AGENT, accept: 'application/json' }, signal: controller.signal });
            if (!response.ok) throw new Error(`Commons 搜索返回 ${response.status}`);
            return parseCommons(kind, await response.json());
        } finally {
            clearTimeout(timer);
        }
    };
}

// ───────── 看图把关 ─────────

export const PHOTO_VISION_PROMPT = '这是一张要放进某人手机相册的照片。请只输出一个 JSON 对象，不要别的字：'
    + '{"人物":画面里有没有清晰可辨的人脸或人物(true/false),"水印":图上任何位置（尤其四个角和边缘）有没有叠加的文字、水印、徽标、署名、日期戳、版权标记或相框边框(true/false),"猫":主体是不是一只猫(true/false),'
    + '"三花":是不是三花猫，白底带黑色和橘色斑块(true/false),"天空":画面是不是以天空、云、日落日出为主(true/false),"清晰":对焦清晰不糊(true/false),'
    + '"说明":"一句话客观描述画面，不超过 30 个字，只写看得见的东西和光线，不写地名、品种名、拍摄者、年代"}。不要猜看不清的东西。';

const bool = (value: unknown) => value === true || value === 'true' || value === '是';
const isNo = (value: unknown) => value === false || value === 'false' || value === '否' || value === '无';

/** 看图模型的回复 → 收不收 + 一句说明。规则在代码里，不让模型自己定 */
export function judgePhoto(kind: PhotoKind, reply: string): PhotoJudgement {
    const match = /\{[\s\S]*\}/.exec(reply);
    if (!match) return { keep: false, caption: '', reason: '看图没给出 JSON' };
    let o: Record<string, unknown>;
    try { o = JSON.parse(match[0]) as Record<string, unknown>; } catch { return { keep: false, caption: '', reason: 'JSON 解析不了' }; }
    const caption = String(o['说明'] ?? '').replace(/\s+/g, '').trim();
    // 水印和人物必须明确回答“没有”才收：没回答、答得含糊都不收
    if (!isNo(o['水印'])) return { keep: false, caption, reason: bool(o['水印']) ? '有水印 / 文字 / 相框' : '没明确说没有水印' };
    if (!isNo(o['人物'])) return { keep: false, caption, reason: bool(o['人物']) ? '画面里有人' : '没明确说没有人' };
    if (!bool(o['清晰'])) return { keep: false, caption, reason: '不够清晰' };
    if (kind === 'cat' && !(bool(o['猫']) && bool(o['三花']))) return { keep: false, caption, reason: '不是三花猫' };
    if (kind === 'view' && !bool(o['天空'])) return { keep: false, caption, reason: '不是以天空为主' };
    const chars = [...caption].length;
    if (chars < 6 || chars > 40) return { keep: false, caption, reason: '说明太短或太长' };
    // 说明里不许带地名 / 品种 / 外文：会和她在济南的生活、“土豆”对不上
    if (/[A-Za-z]{3,}/.test(caption) || /黎巴嫩|意大利|日本|美国|法国|德国|英国|澳大利亚|欧洲|非洲|短毛猫|布偶|暹罗|波斯/.test(caption)) return { keep: false, caption, reason: '说明里带了地名或品种' };
    return { keep: true, caption };
}

/**
 * 运行入口用的网络来源：Commons 搜索 + 安全下载（safe-image：只认公网、限字节、每跳校验）+ 看图把关（和聊天同一个看图模型）。
 * 看图没配置就返回 undefined——货架只剩作者手动加的，不去网上找没把关的图。
 */
export function webPhotoSource(config: Pick<AppConfig, 'llm' | 'vision'>, log: (message: string) => void): PhotoSource | undefined {
    const describer = configuredImageDescriber(config, PHOTO_VISION_PROMPT);
    if (!describer) return undefined;
    const search = commonsSearch();
    return {
        search,
        download: async url => {
            const image = await fetchRemoteImage(url, { timeoutMs: 25_000, maxBytes: PHOTO_MAX_BYTES, headers: { 'user-agent': COMMONS_USER_AGENT } });
            return { bytes: image.bytes, type: image.type };
        },
        judge: async (image, kind) => {
            if (image.bytes.length > MAX_IMAGE_BYTES) return { keep: false, caption: '', reason: '太大，看图模型看不了' };
            const reply = await describer.describe({ url: 'photo-candidate', dataUrl: imageDataUrl({ bytes: image.bytes, type: image.type as 'image/jpeg' }) });
            const judged = judgePhoto(kind, reply);
            if (!judged.keep) log(`照片货架：看图把关没通过（${judged.reason}）`);
            return judged;
        },
    };
}
