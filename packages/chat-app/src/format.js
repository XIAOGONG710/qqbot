// @ts-check
// 给人看的文字：时间、时长、QQ 表情、消息摘要。纯函数，时间都按设备本地时区。

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {number} n */
const two = n => String(n).padStart(2, '0');

/** 本地日历上的「第几天」，跨夏令时也稳。 @param {number} at */
export function dayIndex(at) {
    const d = new Date(at);
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** @param {number} at */
export function formatClock(at) {
    const d = new Date(at);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 日期部分：今天为空，昨天 / 前天 / 星期几 / 几月几日 / 带年份。 @param {number} at @param {number} now */
export function formatDay(at, now) {
    const diff = dayIndex(now) - dayIndex(at);
    const d = new Date(at);
    if (diff === 0) return '';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    if (diff > 2 && diff < 7) return /** @type {string} */ (WEEKDAYS[d.getDay()]);
    if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 对话里的时间条：`21:03`、`昨天 21:03`、`11月3日 21:03`。 @param {number} at @param {number} now */
export function formatStamp(at, now) {
    const day = formatDay(at, now);
    return day ? `${day} ${formatClock(at)}` : formatClock(at);
}

/** `0:07`、`1:05`。 @param {number | undefined} ms */
export function formatDuration(ms) {
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
    const total = Math.max(1, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${two(total % 60)}`;
}

/** 常见 QQ 小黄脸 → 相近的 emoji；没有的显示 `[名字]`。 */
const FACES = /** @type {Record<number, [string, string]>} */ ({
    0: ['😲', '惊讶'], 1: ['😖', '撇嘴'], 2: ['😍', '色'], 3: ['😶', '发呆'], 4: ['😎', '得意'], 5: ['😭', '流泪'], 6: ['☺️', '害羞'],
    7: ['🤐', '闭嘴'], 8: ['😴', '睡'], 9: ['😭', '大哭'], 10: ['😅', '尴尬'], 11: ['😡', '发怒'], 12: ['😜', '调皮'], 13: ['😁', '呲牙'],
    14: ['🙂', '微笑'], 15: ['🙁', '难过'], 16: ['😎', '酷'], 18: ['😫', '抓狂'], 19: ['🤮', '吐'], 20: ['🤭', '偷笑'], 21: ['😊', '可爱'],
    22: ['🙄', '白眼'], 23: ['😏', '傲慢'], 24: ['😋', '饥饿'], 25: ['😪', '困'], 26: ['😱', '惊恐'], 27: ['😓', '流汗'], 28: ['😄', '憨笑'],
    29: ['😌', '悠闲'], 30: ['💪', '奋斗'], 31: ['🤬', '咒骂'], 32: ['🤔', '疑问'], 33: ['🤫', '嘘'], 34: ['😵', '晕'], 36: ['😞', '衰'],
    37: ['💀', '骷髅'], 39: ['👋', '再见'], 49: ['🤗', '拥抱'], 53: ['🎂', '蛋糕'], 60: ['☕', '咖啡'], 63: ['🌹', '玫瑰'], 64: ['🥀', '凋谢'],
    66: ['❤️', '爱心'], 67: ['💔', '心碎'], 74: ['☀️', '太阳'], 75: ['🌙', '月亮'], 76: ['👍', '赞'], 77: ['👎', '踩'], 78: ['🤝', '握手'],
    79: ['✌️', '胜利'], 85: ['😘', '飞吻'], 96: ['😰', '冷汗'], 97: ['😥', '擦汗'], 99: ['👏', '鼓掌'], 101: ['😏', '坏笑'], 104: ['🥱', '哈欠'],
    106: ['🥺', '委屈'], 107: ['😢', '快哭了'], 109: ['😚', '亲亲'], 111: ['🥺', '可怜'], 116: ['💋', '示爱'], 118: ['🙏', '抱拳'],
    120: ['✊', '拳头'], 122: ['🤟', '爱你'], 123: ['🙅', 'NO'], 124: ['👌', 'OK'], 171: ['🍵', '茶'], 173: ['😭', '泪奔'], 174: ['😑', '无奈'],
    175: ['😙', '卖萌'], 178: ['😏', '斜眼笑'], 179: ['🐶', 'doge'], 180: ['🤩', '惊喜'], 182: ['😂', '笑哭'], 201: ['👍', '点赞'],
    212: ['🤔', '托腮'], 264: ['🤦', '捂脸'], 271: ['🍉', '吃瓜'], 277: ['🐶', '汪汪'],
});

/**
 * @param {number} id @param {string} [name]
 * @returns {{ text: string, label: string, emoji: boolean }}
 */
export function faceDisplay(id, name) {
    const known = FACES[id];
    if (known) return { text: known[0], label: name || known[1], emoji: true };
    return { text: `[${name || '表情'}]`, label: name || '表情', emoji: false };
}

/** 表情回应的 emojiId：小黄脸编号，或者 Unicode 码位（比如 128077 = 👍）。 @param {number} id */
export function reactionDisplay(id) {
    if (!FACES[id] && id >= 0x2600 && id <= 0x10ffff) return { text: String.fromCodePoint(id), label: '表情', emoji: true };
    return faceDisplay(id);
}

/** @param {import('./types.d.ts').Part} part */
function partText(part) {
    switch (part.kind) {
        case 'text': return part.text;
        case 'face': return faceDisplay(part.id, part.name).text;
        case 'image': return '[图片]';
        case 'voice': return '[语音]';
        case 'card': return `[卡片] ${part.title}`.trim();
        case 'poke': return '[戳一戳]';
        default: return '';
    }
}

/** 一行摘要：引用条、通知、读屏用。 @param {{ parts: import('./types.d.ts').Part[] }} message @param {number} [max] */
export function previewText(message, max = 60) {
    const text = message.parts.map(partText).join('').replace(/\s+/g, ' ').trim();
    const chars = [...text];
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** 「复制」拿到的文字：只要文字、表情和卡片链接。 @param {{ parts: import('./types.d.ts').Part[] }} message */
export function copyText(message) {
    return message.parts.map(part => {
        if (part.kind === 'text') return part.text;
        if (part.kind === 'face') return faceDisplay(part.id, part.name).text;
        if (part.kind === 'card') return part.url ? `${part.title} ${part.url}` : part.title;
        return '';
    }).join('').trim();
}

/** @param {number} bytes */
export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
