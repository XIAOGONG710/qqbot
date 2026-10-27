// 照片货架的网络来源（ADR 0109 补）：她的照片不用作者给的相册，自己从网上找高清图。
// 来源：Wikimedia Commons（不用 key）。只收 CC0 / 公有领域——发给他不需要署名，也不碰版权；其他许可（CC BY / BY-SA 要署名）一律不收。
// 范围：猫（三花，同一组系列里取，免得每张是不同的猫）和天空 / 晚霞。她的作品（work）、风景以外的街景不走网络：街景里的招牌、人、地名对不上她在济南的生活。
// 高清：原图宽 ≥ 2400、高 ≥ 1600，下载 2560 宽的缩略图（Commons 自己生成，不放大，一般 1–3 MB）。
// 水印（用户 10-22：「记得去水印」）：不擦别人图上的水印——来源只取 CC0 / 公有领域的原图（本来基本没有），再逐张让看图模型检查叠加的文字、水印、徽标、日期戳、相框；
// 有任何一样就不收，模型没明确回答“没有”也不收（宁可少收）。
// 把关：下载后让看图模型回一个 JSON（有没有人脸、有没有水印 / 文字、是不是猫 / 三花 / 以天空为主、清不清晰、一句话描述），代码按规则定收不收；说明里不许带地名、品种名。

import type { AppConfig } from '.././config.ts';
import { imageDataUrl, fetchRemoteImage } from './safe-image.ts';
import { configuredImageDescriber, MAX_IMAGE_BYTES } from './vision.ts';
import { PHOTO_MAX_BYTES, type FoodSource, type PhotoCandidate, type PhotoJudgement, type PhotoKind, type PhotoSource } from './photos.ts';

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
    const caption = String(o['说明'] ?? '').replace(/\s+/g, '').trim();
    // 水印和人物必须明确回答“没有”才收：没回答、答得含糊都不收
    if (!isNo(o['水印'])) return { keep: false, caption, reason: bool(o['水印']) ? '有水印 / 文字 / 相框' : '没明确说没有水印' };
    if (!isNo(o['人物'])) return { keep: false, caption, reason: bool(o['人物']) ? '画面里有人' : '没明确说没有人' };
    if (!bool(o['清晰'])) return { keep: false, caption, reason: '不够清晰' };
    if (kind === 'cat' && !(bool(o['猫']) && bool(o['三花']))) return { keep: false, caption, reason: '不是三花猫' };
    if (kind === 'view' && !bool(o['天空'])) return { keep: false, caption, reason: '不是以天空为主' };
    // 济南没有的东西（10-25：货架里有两张澳大利亚 Palm Beach 的棕榈树晚霞，用户看了说假）：模型明说有，或说明里写了，都不收；字段没回答不算（只在明确说「有」时拦）
    // 场景里的招牌 / 外文（10-25：一张澳大利亚的晚霞左下角是英文啤酒招牌，叠加水印的检查拦不住场景里的字）：模型明说有就不收；字段没回答不算
    if (bool(o['招牌']) || /招牌|标牌|广告牌|路牌|字母|文字/.test(caption)) return { keep: false, caption, reason: '画面里有招牌 / 文字' };
    if (bool(o['热带']) || /棕榈|椰子|椰树|热带|沙滩|海滩|仙人掌|海面|海边|海浪|大海|岛|水面|湖面|摩天轮/.test(caption)) return { keep: false, caption, reason: '画面里有济南没有的东西（棕榈 / 热带植物 / 沙滩 / 海面 / 岛屿 / 大片水面）' };
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

// ───────── 吃的照片（ADR 0128）─────────
// 来源：同样是 Wikimedia Commons，按菜名搜。用户 10-23 要“博主随手拍的第一视角”：B 站图文（专栏）试过，搜到的多是笔记卡片，23 张里 1 张能用；
// 必应 / 搜狗 / 小红书 / 微博要登录、签名或直接拦；Commons 上有很多普通人拍的饭，看图把关 24 张里收 16 张。
// 和猫、风景比放宽了两处：许可除了 CC0 / 公有领域，也收 CC BY / CC BY-SA（私下聊天里用，出处和许可存在货架索引里，作者要署名时查得到）；高清放宽到宽 ≥ 1500。
// 把关更严一层：画面主体必须是装在碗 / 盘 / 锅里的一份做好的饭，对得上这道菜，不是店面、摊位、排队的人，不是菜谱步骤图、宣传图。

/** 每道菜的搜索词（Commons 上用英文）；没写的菜就是没有照片，她那顿“没拍”。第一个搜不到新的再用下一个 */
export const FOOD_QUERIES: Readonly<Record<string, readonly string[]>> = {
    黄焖鸡米饭: ['Huangmenji', 'braised chicken with rice'], 黄焖鸡: ['Huangmenji', 'braised chicken with rice'], 把子肉饭: ['braised pork rice Shandong', 'braised pork belly rice'],
    番茄鸡蛋盖饭: ['tomato scrambled eggs rice', 'tomato and egg stir fry'], 红烧肉盖饭: ['braised pork belly rice', 'hongshaorou rice'], 兰州拉面: ['Lanzhou lamian noodles', 'Lanzhou beef noodle soup'],
    酸辣粉: ['hot and sour rice noodle soup', 'suan la fen'], 鸡腿饭: ['chicken leg rice', 'fried chicken leg rice'], 炒面: ['chow mein', 'stir fried noodles'], 麻辣香锅: ['mala xiang guo', 'dry pot spicy Sichuan'],
    土豆牛腩饭: ['beef brisket potato rice', 'beef stew rice'], 宫保鸡丁盖饭: ['kung pao chicken rice', 'kung pao chicken'], 酸菜鱼饭: ['suan cai yu', 'pickled cabbage fish soup'],
    青椒肉丝盖饭: ['shredded pork green pepper rice', 'green pepper pork stir fry rice'], 炸酱面: ['zhajiangmian', 'noodles with fried sauce'], 煲仔饭: ['claypot rice', 'clay pot rice Cantonese'],
    鱼香肉丝饭: ['yuxiang shredded pork rice', 'yu xiang rou si'], 水饺: ['jiaozi dumplings', 'boiled dumplings plate'], 小炒肉盖饭: ['stir fried pork rice', 'xiaochao rou'], 麻辣烫: ['malatang', 'malatang bowl'],
    炒饭: ['fried rice bowl', 'egg fried rice'], 砂锅米线: ['rice noodles clay pot', 'crossing the bridge noodles'], 小馄饨: ['wonton soup bowl', 'wontons in soup'], 炒河粉: ['stir fried rice noodles', 'beef chow fun'],
    包子配小米粥: ['baozi steamed buns', 'millet porridge'], 牛肉面: ['beef noodle soup', 'Lanzhou beef noodle soup'], 肉夹馍配凉皮: ['roujiamo', 'liangpi cold noodles'],
    番茄鸡蛋面: ['tomato egg noodle soup', 'tomato scrambled egg noodles'], 烧茄子盖饭: ['braised eggplant rice', 'eggplant in garlic sauce rice'], 小笼包: ['xiaolongbao', 'soup dumplings'],
    酸汤水饺: ['dumplings in soup', 'dumpling soup bowl'], 炒米粉: ['fried rice vermicelli', 'stir fried rice noodles'], 干锅花菜饭: ['dry pot cauliflower', 'stir fried cauliflower rice'],
    刀削面: ['knife-cut noodles', 'daoxiaomian'], 菜包配豆浆: ['vegetable baozi', 'soy milk breakfast'], 煎饼卷大葱: ['jianbing', 'jianbing guozi'],
};

/** 吃的照片接受的许可：CC0、公有领域、CC BY、CC BY-SA（不收带 NC / ND 的——Commons 本来也没有） */
const FOOD_LICENSE_OK = /^(?:CC0(?:[ -]1\.0)?|CC[ -]Zero|Public domain|PD(?:[ -].*)?|CC[ -]BY(?:[ -]SA)?(?:[ -]\d\.\d)?(?:[ -][A-Za-z]{2,3})?)$/i;
const FOOD_MIN_WIDTH = 1500;
const FOOD_MIN_HEIGHT = 1000;

/** Commons 的搜索结果 → 吃的候选（jpeg、够大、比例正常、许可可用）。纯函数，测试用 */
export function parseCommonsFood(dish: string, body: unknown): PhotoCandidate[] {
    const pages = Object.values((body as { query?: { pages?: Record<string, CommonsPage> } } | undefined)?.query?.pages ?? {});
    const out: PhotoCandidate[] = [];
    for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!page.title || !info || info.mime !== 'image/jpeg') continue;
        const width = info.width ?? 0;
        const height = info.height ?? 0;
        if (width < FOOD_MIN_WIDTH || height < FOOD_MIN_HEIGHT) continue;
        const aspect = width / height;
        if (aspect < 0.6 || aspect > 1.8) continue;
        const license = stripHtml(info.extmetadata?.LicenseShortName?.value);
        if (!FOOD_LICENSE_OK.test(license)) continue;
        const imageUrl = info.thumburl ?? info.url;
        if (!imageUrl || !/^https:\/\/upload\.wikimedia\.org\//.test(imageUrl)) continue;
        out.push({
            kind: 'food', title: page.title, pageUrl: info.descriptionurl ?? '', imageUrl, width, height, license,
            artist: stripHtml(info.extmetadata?.Artist?.value).slice(0, 60), series: dish,
        });
    }
    return out;
}

/** 搜一道菜的候选；offset 是翻页的起点。这道菜没有搜索词 = 没有 */
export function commonsFoodSearch(options: CommonsOptions = {}): (dish: string, offset?: number) => Promise<PhotoCandidate[]> {
    const doFetch: CommonsFetch = options.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<CommonsFetch>);
    return async (dish, offset = 0) => {
        const queries = FOOD_QUERIES[dish];
        if (!queries?.length) return [];
        const merged: PhotoCandidate[] = [];
        for (const query of queries) {
            const params = new URLSearchParams({
                action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: String(PAGE_SIZE), gsroffset: String(offset),
                gsrsearch: `${query} filetype:bitmap filew:>${FOOD_MIN_WIDTH} fileh:>${FOOD_MIN_HEIGHT}`, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600',
            });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error('Commons 搜索超时')), options.timeoutMs ?? 12_000);
            try {
                const response = await doFetch(`${COMMONS_API}?${params}`, { headers: { 'user-agent': COMMONS_USER_AGENT, accept: 'application/json' }, signal: controller.signal });
                if (!response.ok) throw new Error(`Commons 搜索返回 ${response.status}`);
                for (const candidate of parseCommonsFood(dish, await response.json())) if (!merged.some(c => c.title === candidate.title)) merged.push(candidate);
            } finally {
                clearTimeout(timer);
            }
            // 第一个搜索词有够多的就不用下一个（少打 Commons）
            if (merged.length >= 6) break;
        }
        return merged;
    };
}

export const foodVisionPrompt = (dish: string): string => '这是一张要发给别人的饭的照片。请只输出一个 JSON 对象，不要别的字：'
    + '{"人脸":画面里有没有清晰可辨的人脸(true/false；只拍到手、手臂、餐具不算),"水印":图上有没有叠加的文字、水印、署名、logo、日期戳、相框、拼图(true/false；食物包装、桌上菜单印的字不算),'
    + '"招牌":有没有清晰可读的店名 / 地名 / 品牌招牌(true/false),'
    + `"是这道菜":画面主体是不是一份"${dish}"或者很像它的同类饭(true/false),`
    + '"一份饭":主体是不是装在碗 / 盘 / 锅 / 餐盒里的一份做好的饭(true/false；只是食材、摊位、店面、很多人排队的场面都算 false),'
    + '"实拍":是不是普通人随手拍的生活照(true/false；商业宣传图、海报、插画、示意图、菜谱步骤图、拼图都算 false),"清晰":对焦清晰不糊(true/false),'
    + '"说明":"一句话客观描述画面，不超过 30 个字，只写看得见的东西，不写店名、地名、品牌"}。不要猜看不清的东西。';

/** 看图模型的回复 → 收不收 + 一句说明。规则在代码里：人脸、水印 / 文字、招牌必须明确回答“没有”，其余必须明确回答“是” */
export function judgeFood(dish: string, reply: string): PhotoJudgement {
    const match = /\{[\s\S]*\}/.exec(reply);
    if (!match) return { keep: false, caption: '', reason: '看图没给出 JSON' };
    let o: Record<string, unknown>;
    try { o = JSON.parse(match[0]) as Record<string, unknown>; } catch { return { keep: false, caption: '', reason: 'JSON 解析不了' }; }
    const caption = String(o['说明'] ?? '').replace(/\s+/g, '').trim();
    if (!isNo(o['人脸'])) return { keep: false, caption, reason: bool(o['人脸']) ? '有人脸' : '没明确说没有人脸' };
    if (!isNo(o['水印'])) return { keep: false, caption, reason: bool(o['水印']) ? '有水印 / 文字 / 相框' : '没明确说没有水印' };
    if (!isNo(o['招牌'])) return { keep: false, caption, reason: bool(o['招牌']) ? '有清晰的招牌 / 店名' : '没明确说没有招牌' };
    if (!bool(o['是这道菜'])) return { keep: false, caption, reason: `不是${dish}` };
    if (!bool(o['一份饭'])) return { keep: false, caption, reason: '主体不是一份做好的饭' };
    if (!bool(o['实拍'])) return { keep: false, caption, reason: '不是随手拍的实拍' };
    if (!bool(o['清晰'])) return { keep: false, caption, reason: '不够清晰' };
    const chars = [...caption].length;
    if (chars < 6 || chars > 40) return { keep: false, caption, reason: '说明太短或太长' };
    if (/[A-Za-z]{3,}/.test(caption) || /北京|上海|广州|香港|台湾|日本|韩国|美国|泰国|越南|兰州|西安|成都|重庆|济南|青岛/.test(caption)) return { keep: false, caption, reason: '说明里带了地名' };
    return { keep: true, caption };
}

/**
 * 运行入口用的吃的照片来源：Commons 按菜名搜 + 安全下载 + 看图把关（和聊天同一个看图模型，每次带上这道菜的名字）。
 * 看图没配置就返回 undefined——没有把关的图不收
 */
export function webFoodSource(config: Pick<AppConfig, 'llm' | 'vision'>, log: (message: string) => void): FoodSource | undefined {
    if (!configuredImageDescriber(config, foodVisionPrompt('饭'))) return undefined;
    const search = commonsFoodSearch();
    return {
        search,
        download: async url => {
            const image = await fetchRemoteImage(url, { timeoutMs: 25_000, maxBytes: PHOTO_MAX_BYTES, headers: { 'user-agent': COMMONS_USER_AGENT } });
            return { bytes: image.bytes, type: image.type };
        },
        judge: async (image, dish) => {
            if (image.bytes.length > MAX_IMAGE_BYTES) return { keep: false, caption: '', reason: '太大，看图模型看不了' };
            const describer = configuredImageDescriber(config, foodVisionPrompt(dish));
            if (!describer) return { keep: false, caption: '', reason: '没配看图模型' };
            const reply = await describer.describe({ url: 'photo-candidate', dataUrl: imageDataUrl({ bytes: image.bytes, type: image.type as 'image/jpeg' }) });
            const judged = judgeFood(dish, reply);
            if (!judged.keep) log(`照片货架：看图把关没通过（${dish}：${judged.reason}）`);
            return judged;
        },
    };
}
