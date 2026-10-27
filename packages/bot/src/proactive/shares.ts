// 他发来的分享卡片、转发的聊天记录、文件在聊天记录里怎么写（ADR 0080）。
// NapCat 的分享（B 站、小红书、网页、音乐、位置……）是 json 段，data.data 是一段 JSON 文字；
// 以前 segmentsToText 一律写成「[json]」，她看不懂，要么装没看见（接着问上一句），要么说「这是啥」。
// 这里只取人看得懂的几个字：来源、标题。不放链接（她点不开，也不该把网址写进聊天记录和记忆）。

const MAX_TITLE = 40;
const MAX_NAME = 40;

/** 去掉换行、方括号（会和占位符的括号搞混）、两头空白，截短 */
function clean(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const text = value.replace(/[\r\n\t]+/g, ' ').replace(/[[\]【】]/g, '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * json 段 → 「[分享：哔哩哔哩《标题》]」「[分享：知乎《标题》]」「[分享音乐：歌名 - 歌手]」；
 * 认不出结构就用卡片自带的 prompt（QQ 给通知栏用的那一行，例如「[位置]某某路」→「[位置：某某路]」），再不行写「[分享]」
 */
export function shareText(raw: unknown): string {
    let card: Record<string, unknown> | undefined;
    try {
        card = record(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {
        card = undefined;
    }
    if (!card) return '[分享]';
    const meta = record(card.meta);
    // meta 下面只有一个子对象：小程序是 detail_1，网页是 news，音乐是 music
    const [kind, body] = Object.entries(meta ?? {}).map(([key, value]) => [key, record(value)] as const).find(([, value]) => value) ?? [];
    if (kind && body) {
        if (kind === 'music') {
            const title = clean(body.title, MAX_TITLE);
            const singer = clean(body.desc, MAX_TITLE);
            if (title) return `[分享音乐：${title}${singer ? ` - ${singer}` : ''}]`;
        } else {
            // 小程序：title 是小程序名（哔哩哔哩），desc 是内容标题；网页：title 是文章标题，tag 是站点名
            const miniapp = typeof card.app === 'string' && card.app.includes('miniapp');
            const source = clean(miniapp ? body.title : body.tag, MAX_TITLE);
            const title = clean(miniapp ? body.desc : body.title, MAX_TITLE);
            if (source && title) return `[分享：${source}《${title}》]`;
            if (title || source) return `[分享：${title || source}]`;
        }
    }
    const labelled = /^\s*\[([^\]]{1,10})\](.*)$/.exec(typeof card.prompt === 'string' ? card.prompt : '');
    if (labelled) {
        const label = clean(labelled[1], 10);
        const rest = clean(labelled[2], MAX_TITLE * 2);
        return label && rest ? `[${label}：${rest}]` : '[分享]';
    }
    const prompt = clean(card.prompt, MAX_TITLE * 2);
    return prompt ? `[分享：${prompt}]` : '[分享]';
}

/** file 段 → 「[文件：简历.pdf]」；没有文件名就「[文件]」 */
export function fileText(name: unknown): string {
    const text = clean(name, MAX_NAME);
    return text ? `[文件：${text}]` : '[文件]';
}

/** forward 段（合并转发的聊天记录）：内容没取，只说是一份聊天记录 */
export const FORWARD_TEXT = '[转发的聊天记录]';
