// QQ 小黄脸（ADR 0051）：OneBot 的 face 段 ↔ 聊天记录里的「[捂脸]」。
// - 他发的：face 段按 id 换成名字（faceText），查不到的照旧「[表情]」。表来自 NapCat 的
//   vendor/NapCatQQ/packages/napcat-core/external/face_config.json（sysface 的 QSid → QDes 去掉「/」，线上 v4.18.28 的打包里是同一份）：
//   只收面板上看得见的（没有 QHide）、名字是中文的（加上 doge、OK、666、emm），不收节日、红包那几个和骰子、猜拳、龙年这类大动图。
// - 她发的：只认白名单 SENDABLE_FACES 里的十几个；发送时「[捂脸]」拆成 face 段，和前后的文字拼成一条消息（textToSegments），
//   聊天记录里存的还是原文，下一轮她看得到自己发过什么。NapCat 发 face 时，表里带 AniStickerType 的（流泪、比心、贴贴、生气……）
//   一律发成超级表情（大的动图，faceType 3，napcat-onebot/api/msg.ts），不像随手带的小黄脸，不进白名单。
// - 白名单外的方括号、一次回复里堆太多、最近几次带得太密、他认真说事她只回表情：出口检查管（exit-check.ts）。

/** face 段的 id → 名字（NapCat face_config.json，见文件头） */
export const FACE_NAMES: Readonly<Record<number, string>> = {
    0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
    8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过',
    16: '酷', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱', 22: '白眼', 23: '傲慢', 24: '饥饿',
    25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑', 29: '悠闲', 30: '奋斗', 31: '咒骂', 32: '疑问',
    33: '嘘', 34: '晕', 35: '折磨', 36: '衰', 37: '骷髅', 38: '敲打', 39: '再见', 41: '发抖',
    42: '爱情', 43: '跳跳', 46: '猪头', 49: '拥抱', 53: '蛋糕', 56: '刀', 59: '便便', 60: '咖啡',
    63: '玫瑰', 64: '凋谢', 66: '爱心', 67: '心碎', 74: '太阳', 75: '月亮', 76: '赞', 77: '踩',
    78: '握手', 79: '胜利', 85: '飞吻', 86: '怄火', 89: '西瓜', 96: '冷汗', 97: '擦汗', 98: '抠鼻',
    99: '鼓掌', 100: '糗大了', 101: '坏笑', 102: '左哼哼', 103: '右哼哼', 104: '哈欠', 105: '鄙视', 106: '委屈',
    107: '快哭了', 108: '阴险', 109: '左亲亲', 110: '吓', 111: '可怜', 112: '菜刀', 116: '示爱', 118: '抱拳',
    119: '勾引', 120: '拳头', 121: '差劲', 124: 'OK', 125: '转圈', 129: '挥手', 144: '喝彩', 146: '爆筋',
    147: '棒棒糖', 169: '手枪', 171: '茶', 172: '眨眼睛', 173: '泪奔', 174: '无奈', 175: '卖萌', 176: '小纠结',
    177: '喷血', 178: '斜眼笑', 179: 'doge', 182: '笑哭', 183: '我最美', 185: '羊驼', 187: '幽灵', 201: '点赞',
    212: '托腮', 262: '脑阔疼', 263: '沧桑', 264: '捂脸', 265: '辣眼睛', 266: '哦哟', 267: '头秃', 268: '问号脸',
    269: '暗中观察', 270: 'emm', 271: '吃瓜', 272: '呵呵哒', 273: '我酸了', 277: '汪汪', 281: '无眼笑', 282: '敬礼',
    283: '狂笑', 284: '面无表情', 285: '摸鱼', 286: '魔鬼笑', 287: '哦', 289: '睁眼', 294: '期待', 297: '拜谢',
    299: '牛啊', 300: '胖三斤', 305: '右亲亲', 307: '喵喵', 311: '打call', 312: '变形', 314: '仔细分析', 317: '菜汪',
    318: '崇拜', 319: '比心', 320: '庆祝', 323: '嫌弃', 324: '吃糖', 325: '惊吓', 326: '生气', 332: '举牌牌',
    337: '花朵脸', 338: '我想开了', 339: '舔屏', 341: '打招呼', 342: '酸Q', 343: '我方了', 344: '大怨种', 346: '你真棒棒',
    349: '坚强', 350: '贴贴', 351: '敲敲', 352: '咦', 353: '拜托', 354: '尊嘟假嘟', 355: '耶', 356: '666',
    357: '裂开', 395: '略略略', 450: '撇嘴', 451: '色', 452: '微笑', 453: '发呆', 454: '得意', 455: '害羞',
    456: '闭嘴', 457: '睡', 458: '我吗', 459: '优雅', 460: '硬撑', 461: '宕机', 462: '无语', 464: '马上到',
    466: '羞羞哒', 467: '摇花手', 468: '失眠', 469: '坚毅', 472: '心动', 474: '给你一拳', 475: '干饭', 476: '不是吧',
    477: '你懂的', 478: '对的对的', 479: '不对不对', 480: '散味儿', 481: '学习', 482: '热化了', 483: '略', 484: '比爱心',
};

/**
 * 她能发的小黄脸：名字 → id，顺序就是卡上写的顺序。都是面板上的小表情（不是超级表情）；
 * 「抱抱」「哼」「晚安」「亲亲」在 QQ 里是隐藏的老表情或超级表情，用「拥抱」「白眼」「睡」「飞吻」。
 */
export const SENDABLE_FACES: Readonly<Record<string, number>> = {
    捂脸: 264, 笑哭: 182, doge: 179, 偷笑: 20, 委屈: 106, 可怜: 111, 拥抱: 49, 飞吻: 85,
    爱心: 66, 大哭: 9, 快哭了: 107, 白眼: 22, 害羞: 6, 敲打: 38, OK: 124, 睡: 8,
};

/** 白名单的名字不分大小写（模型写「[ok]」「[Doge]」）→ 正式的写法 */
const SENDABLE_BY_LOWER = new Map(Object.keys(SENDABLE_FACES).map(name => [name.toLowerCase(), name]));

/** 像小黄脸的方括号：里面是 1–6 个汉字、字母、数字（「[1 2; 3 4]」「[Start a new Chat]」不算） */
const BRACKET = /\[([\p{Script=Han}A-Za-z0-9]{1,6})\]/gu;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 聊天记录里认得的表情：表里的名字，和查不到 id 时的「[表情]」、表情包的「[动画表情]」 */
export const KNOWN_FACE = new RegExp(`\\[(?:${[...new Set([...Object.values(FACE_NAMES), '表情', '动画表情'])].map(escape).join('|')})\\]`, 'g');

/** face 段 → 「[捂脸]」；查不到的 id 照旧「[表情]」 */
export function faceText(id: unknown): string {
    const key = typeof id === 'number' ? id : typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : NaN;
    const name = FACE_NAMES[key];
    return name ? `[${name}]` : '[表情]';
}

/** 白名单里的名字（不分大小写）→ 正式的写法；不在白名单里是 undefined */
export function sendableFace(name: string): string | undefined {
    return SENDABLE_BY_LOWER.get(name.toLowerCase());
}

/** 回复里的方括号：白名单里的（正式写法）、不认识的（原样） */
export function facesIn(text: string): { sendable: string[]; unknown: string[] } {
    const sendable: string[] = [];
    const unknown: string[] = [];
    for (const match of text.matchAll(BRACKET)) {
        const name = sendableFace(match[1]!);
        if (name) sendable.push(`[${name}]`);
        else unknown.push(match[0]);
    }
    return { sendable, unknown };
}

/**
 * 去掉方括号（drop 说去不去：face 是白名单里的正式写法，不认识的是 undefined；默认全去），收拾去掉后多出来的空格和空行。
 * 一个都没去就原样返回
 */
export function removeFaces(text: string, drop: (face: string | undefined, token: string) => boolean = () => true): string {
    let removed = 0;
    const out = text.replace(BRACKET, (token, name: string) => {
        if (!drop(sendableFace(name), token)) return token;
        removed++;
        return '';
    });
    if (!removed) return text;
    return out.split('\n').map(line => line.replace(/[ \t]{2,}/g, ' ').trim()).filter(Boolean).join('\n');
}

/** 白名单里的名字统一成正式写法：「[ok]」→「[OK]」，全角的「【捂脸】」→「[捂脸]」 */
export function normalizeFaces(text: string): string {
    return text
        .replace(/【([\p{Script=Han}A-Za-z0-9]{1,6})】/gu, (token, name: string) => { const face = sendableFace(name); return face ? `[${face}]` : token; })
        .replace(BRACKET, (token, name: string) => { const face = sendableFace(name); return face ? `[${face}]` : token; });
}

/** 去掉小黄脸和标点之后什么都不剩（整条只有表情） */
export function onlyFaces(text: string): boolean {
    return text.trim() !== '' && removeFaces(text).replace(/[\p{P}\p{S}\s～~]/gu, '') === '';
}

/** 发出去的一段：文字 { text }，小黄脸 { id } */
export interface OutgoingSegment {
    type: 'text' | 'face';
    data: Record<string, string>;
}

/** 她要发的一条（一个气泡）：白名单里的「[捂脸]」变成 face 段，其余是文字；别的方括号原样当文字 */
export function textToSegments(text: string): OutgoingSegment[] {
    const segments: OutgoingSegment[] = [];
    let last = 0;
    for (const match of text.matchAll(BRACKET)) {
        const name = sendableFace(match[1]!);
        if (!name) continue;
        if (match.index > last) segments.push({ type: 'text', data: { text: text.slice(last, match.index) } });
        segments.push({ type: 'face', data: { id: String(SENDABLE_FACES[name]) } });
        last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } });
    return segments.length ? segments : [{ type: 'text', data: { text } }];
}
