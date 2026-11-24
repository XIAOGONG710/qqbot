// 照片货架的网络来源（ADR 0109 补）：她的照片不用作者给的相册，自己从网上找高清图。
// 来源：Wikimedia Commons（不用 key）。只收 CC0 / 公有领域——发给他不需要署名，也不碰版权；其他许可（CC BY / BY-SA 要署名）一律不收。
// 范围：猫（三花，同一组系列里取，免得每张是不同的猫）和天空 / 晚霞。她的作品（work）、风景以外的街景不走网络：街景里的招牌、人、地名对不上她在学校那边的生活。
// 高清：原图宽 ≥ 2400、高 ≥ 1600，下载 2560 宽的缩略图（Commons 自己生成，不放大，一般 1–3 MB）。
// 水印（用户 10-22：「记得去水印」）：不擦别人图上的水印——来源只取 CC0 / 公有领域的原图（本来基本没有），再逐张让看图模型检查叠加的文字、水印、徽标、日期戳、相框；
// 有任何一样就不收，模型没明确回答“没有”也不收（宁可少收）。
// 把关：下载后让看图模型回一个 JSON（有没有人脸、有没有水印 / 文字、是不是猫 / 三花 / 以天空为主、清不清晰、一句话描述），代码按规则定收不收；说明里不许带地名、品种名。

import type { AppConfig } from '../platform/config.ts';
import { stateObject } from '../memory/state-schema.ts';
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

function stripHtml(value: unknown): string {
    if (typeof value !== 'string') return '';
    const parts: string[] = [];
    let from = 0;
    let scan = 0;
    for (;;) {
        const open = value.indexOf('<', scan);
        if (open < 0) break;
        const close = value.indexOf('>', open + 1);
        if (close < 0) break; // 未闭合的剩余部分保留，不在每个 '<' 上重新扫描。
        if (close > open + 1) { parts.push(value.slice(from, open)); from = close + 1; }
        scan = close + 1; // '<>' 不匹配旧正则，原样保留；嵌套 '<' 属于标签内容。
    }
    parts.push(value.slice(from));
    return parts.join('').replace(/\s+/g, ' ').trim();
}

interface CommonsPage {
    title?: string;
    imageinfo?: {
        width?: number; height?: number; mime?: string;
        thumburl?: string; thumbwidth?: number; thumbheight?: number; url?: string; descriptionurl?: string;
        extmetadata?: Record<string, { value?: unknown } | undefined>;
    }[];
}

function commonsPages(body: unknown): CommonsPage[] {
    if (!stateObject(body) || !stateObject(body.query) || !stateObject(body.query.pages)) return [];
    return Object.values(body.query.pages).filter(stateObject).slice(0, PAGE_SIZE) as CommonsPage[];
}

function sourcePage(title: string, value: unknown): string | undefined {
    try {
        if (value === undefined) return `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`;
        if (typeof value !== 'string') return undefined;
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'commons.wikimedia.org' && !url.port && !url.username && !url.password ? value : undefined;
    } catch { return undefined; }
}

/** Commons 的搜索结果 → 候选（只留 jpeg、够大、比例正常、CC0 / 公有领域的）。纯函数，测试用 */
export function parseCommons(kind: PhotoKind, body: unknown): PhotoCandidate[] {
    if (kind !== 'cat' && kind !== 'view') return [];
    const pages = commonsPages(body);
    const out: PhotoCandidate[] = [];
    for (const page of pages) {
        const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined;
        if (typeof page.title !== 'string' || !page.title.trim() || !info || info.mime !== 'image/jpeg') continue;
        const width = info.width ?? 0;
        const height = info.height ?? 0;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < MIN_WIDTH || height < MIN_HEIGHT) continue;
        const aspect = width / height;
        if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
        const license = stripHtml(info.extmetadata?.LicenseShortName?.value);
        if (!LICENSE_OK.test(license)) continue;
        const imageUrl = info.thumburl ?? info.url;
        if (typeof imageUrl !== 'string' || !/^https:\/\/upload\.wikimedia\.org\//.test(imageUrl)) continue;
        const pageUrl = sourcePage(page.title, info.descriptionurl);
        if (!pageUrl) continue;
        out.push({
            kind, title: page.title, pageUrl, imageUrl, width, height, license,
            artist: stripHtml(info.extmetadata?.Artist?.value), series: seriesKey(page.title),
        });
    }
    return out;
}

export type CommonsFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CommonsOptions {
    fetch?: CommonsFetch;
    timeoutMs?: number;
}

/** 搜索页最多30项；原始JSON也限流读取，不能先把任意大正文放进内存。 */
export const COMMONS_MAX_BYTES = 2 * 1024 * 1024;
const defaultCommonsFetch: CommonsFetch = async (url, init) => {
    const response = await fetch(url, init);
    if (init.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        init.signal.throwIfAborted();
    }
    if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, status: response.status, json: async () => undefined };
    }
    return { ok: true, status: response.status, json: async () => {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Commons 回复没有正文');
        const chunks: Uint8Array[] = [];
        let total = 0;
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        init.signal.addEventListener('abort', cancel, { once: true });
        try {
            init.signal.throwIfAborted();
            for (;;) {
                const { done, value } = await reader.read();
                init.signal.throwIfAborted();
                if (done) break;
                total += value.byteLength;
                if (total > COMMONS_MAX_BYTES) throw new Error('Commons 回复过大');
                chunks.push(value);
            }
            return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
        } finally {
            // 不等待不合作流的cancel，超时竞速仍须能释放调用方。
            void reader.cancel().catch(() => undefined);
            init.signal.removeEventListener('abort', cancel);
            reader.releaseLock();
        }
    } };
};

async function searchBody(params: URLSearchParams, options: CommonsOptions): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError('Commons 超时配置无效');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Commons 搜索超时 (timeout)'));
        }, timeoutMs);
    });
    try {
        return await Promise.race([timeout, (async () => {
            let response: Awaited<ReturnType<CommonsFetch>>;
            try { response = await (options.fetch ?? defaultCommonsFetch)(`${COMMONS_API}?${params}`, { headers: { 'user-agent': COMMONS_USER_AGENT, accept: 'application/json' }, signal: controller.signal }); }
            catch { throw new Error('Commons 搜索请求失败 (fetch failed)'); }
            if (!response.ok) throw new Error(`Commons 搜索返回 ${Number.isInteger(response.status) ? response.status : '未知状态'}${response.status >= 500 ? ' (fetch failed)' : ''}`);
            let body: unknown;
            try { body = await response.json(); } catch { throw new Error('Commons 回复读取或解析失败'); }
            if (stateObject(body) && body.error !== undefined) {
                const code = stateObject(body.error) ? body.error.code : undefined;
                const transient = typeof code === 'string' && ['maxlag', 'ratelimited', 'readonly'].includes(code);
                throw new Error(`Commons 搜索接口返回错误${transient ? ' (fetch failed)' : ''}`);
            }
            return body;
        })()]);
    } finally { clearTimeout(timer); }
}

function checkOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Commons 翻页起点无效');
}

/** 搜一类的候选；offset 是翻页的起点（0、30、60……） */
export function commonsSearch(options: CommonsOptions = {}): (kind: PhotoKind, offset?: number) => Promise<PhotoCandidate[]> {
    return async (kind, offset = 0) => {
        const query = Object.hasOwn(QUERIES, kind) ? (QUERIES as Record<string, string | undefined>)[kind] : undefined;
        if (!query) return [];
        checkOffset(offset);
        const params = new URLSearchParams({
            action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: String(PAGE_SIZE), gsroffset: String(offset),
            gsrsearch: query, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '2560',
        });
        return parseCommons(kind, await searchBody(params, options));
    };
}

// ───────── 看图把关 ─────────

export const PHOTO_VISION_PROMPT = '这是一张要放进某人手机相册的照片。请只输出一个 JSON 对象，不要别的字：'
    + '{"人物":画面里有没有清晰可辨的人脸或人物(true/false),"水印":图上任何位置（尤其四个角和边缘）有没有叠加的文字、水印、徽标、署名、日期戳、版权标记或相框边框(true/false),"猫":主体是不是一只猫(true/false),'
    + '"三花":是不是三花猫，白底带黑色和橘色斑块(true/false),"天空":画面是不是以天空、云、日落日出为主(true/false),"热带":画面里有没有棕榈树、椰子树、热带植物、沙滩、大海、岛屿、大片水面、摩天轮（内陆北方城市看不到的东西）(true/false),"招牌":画面里有没有任何能读出来的文字、招牌、广告牌、路牌、标牌（包括外文，场景里的也算）(true/false),"清晰":对焦清晰不糊(true/false),'
    + '"说明":"一句话客观描述画面，不超过 30 个字，只写看得见的东西和光线，不写地名、品种名、拍摄者、年代"}。不要猜看不清的东西。';

const bool = (value: unknown) => value === true || value === 'true' || value === '是';
const isNo = (value: unknown) => value === false || value === 'false' || value === '否' || value === '无';

/** 看图模型的回复 → 收不收 + 一句说明。规则在代码里，不让模型自己定 */
export function judgePhoto(kind: PhotoKind, reply: string): PhotoJudgement {
    const match = /\{[\s\S]*\}/.exec(reply);
    if (!match) return { keep: false, caption: '', reason: '看图没给出 JSON' };
    let o: Record<string, unknown>;
    try { o = JSON.parse(match[0]) as Record<string, unknown>; } catch { return { keep: false, caption: '', reason: 'JSON 解析不了' }; }
    const caption = typeof o['说明'] === 'string' ? o['说明'].replace(/\s+/g, '').trim() : '';
    // 水印和人物必须明确回答“没有”才收：没回答、答得含糊都不收
    if (!isNo(o['水印'])) return { keep: false, caption, reason: bool(o['水印']) ? '有水印 / 文字 / 相框' : '没明确说没有水印' };
    if (!isNo(o['人物'])) return { keep: false, caption, reason: bool(o['人物']) ? '画面里有人' : '没明确说没有人' };
    if (!bool(o['清晰'])) return { keep: false, caption, reason: '不够清晰' };
    if (kind === 'cat' && !(bool(o['猫']) && bool(o['三花']))) return { keep: false, caption, reason: '不是三花猫' };
    if (kind === 'view' && !bool(o['天空'])) return { keep: false, caption, reason: '不是以天空为主' };
    // 学校那边没有的东西（10-25：货架里有两张澳大利亚 Palm Beach 的棕榈树晚霞，用户看了说假）：模型明说有，或说明里写了，都不收；字段没回答不算（只在明确说「有」时拦）
    // 场景里的招牌 / 外文（10-25：一张澳大利亚的晚霞左下角是英文啤酒招牌，叠加水印的检查拦不住场景里的字）：模型明说有就不收；字段没回答不算
    if (bool(o['招牌']) || /招牌|标牌|广告牌|路牌|字母|文字/.test(caption)) return { keep: false, caption, reason: '画面里有招牌 / 文字' };
    if (bool(o['热带']) || /棕榈|椰子|椰树|热带|沙滩|海滩|仙人掌|海面|海边|海浪|大海|岛|水面|湖面|摩天轮/.test(caption)) return { keep: false, caption, reason: '画面里有她学校那边没有的东西（棕榈 / 热带植物 / 沙滩 / 海面 / 岛屿 / 大片水面）' };
    const chars = [...caption].length;
    if (chars < 6 || chars > 40) return { keep: false, caption, reason: '说明太短或太长' };
    // 说明里不许带地名 / 品种 / 外文：会和她在学校那边的生活、“猫”对不上
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
