// 说话的质感（ADR 0131，配置 texture，默认关；用户 10-23 追加：「表情包让她在 bilibili 自己找，不要用或者少用黄豆表情」——小黄脸只在语气很对得上时偶尔带一个，约 2% 的气泡，中性的不带；表情包走 bilibili 找，见 ADR 0132）：发出去之前，在已经定好的气泡上加真人聊天里常有、她从来没有的那些细节。
// 用户 10-23：「质感那几项也往真人靠，如果可以的话尽量超过我」。
// 量过（「像不像真人」的尺子，用他自己的聊天训练，只看写法；10-21 以后线上她的话 121 条，他的 652 条；每百条里有多少条带，括号里是尺子给的分量，越大越拖后腿）：
//   句末没有任何标点  她 95  他 79（最大）  |  「～」 她 0  他 10  |  句末「？」 她 3  他 10  |  整条只有一个小句 她 95  他 83
//   QQ 小黄脸 她 0  他 18  |  叠字 她 2  他 6  |  两个字以内的反应 她 5  他 14–24  |  夹英文字母 她 0  他 2  |  结尾「……」 她 2  他 0
//   尺子判成真人的比例：她 21–30%，他自己 64%。
// 这些是**写法**，模型不会自己写（ADR 0051 实测 9,039 条气泡里只有 1 处方括号；卡里写了“偶尔带小黄脸”也没用；问句她多半不带问号）。所以放在代码里、按概率、按语气来
// （和打错字 ADR 0024 一个位置：已经拆好条、出口检查过之后，发出去之前）：
//   - 问号：一条看得出是在问的（吗 / 什么 / 几点 / 有没有……）没带问号，补「？」；有感叹语气的（太……了、好……啊）补「！」；
//   - 「～」：轻松的短句（句尾是啦 / 呀 / 哦 / 嘛 / 哈……）把句号换成「～」；
//   - 小黄脸：只在语气对得上的气泡末尾加一个（哈哈 → 笑哭，晚安 → 睡，想你 → 爱心，无语 → 白眼，不好意思 → 害羞……），一次回复最多一个，她最近几次回复里已经带得多就不带；
//   - 叠字：整条只是一个语气词（哈哈、嗯、啊、呜）时拉长；
//   - 英文字母：整条只是「好的」「哈哈哈」时，偶尔写成 ok / hhh；
//   - 结尾的「……」去掉（整条只有“……”的无语反应不动）；
//   - 连着两条都很短的，偶尔并成一条（「没呢，这两天也没怎么聊」）。
// 不加的：危机、他难过 / 生病 / 小别扭的回合（serious）；表情包、照片、链接；已经带了小黄脸的气泡。纯函数，同一句话结果固定。

import { SENDABLE_FACES } from './qq-faces.ts';
import { unit } from './expression.ts';
import { endsHanging } from './unfinished.ts';

export interface TextureContext {
    /** 种子：同一句话每次结果固定（测试、重放） */
    seed: string;
    /** 他这一串说的话（看语气用：他在笑、在撒娇……）；没有就空 */
    said?: string;
    /** 危机 / 他难过、生病 / 小别扭 / 她在认真安慰他：一律不加 */
    serious: boolean;
    /** 她最近 6 次回复里已经有几次带了小黄脸（faceContext 的 recent 里数） */
    recentFaces: number;
    /** 她最近 TEXTURE_TILDE_WINDOW 次回复里有几次句尾带了「～」（不管是模型写的还是这里加的）；有就不再加（ADR 0134：选择题连着答「X吧～」，一场测试里 27–39% 的气泡以「～」结尾，他自己是 9%）；不写按 0 */
    recentTildes?: number;
    /** 这一轮最多几条气泡（加一条单独的反应要有空位）；不写按 3 */
    maxBubbles?: number;
}

/** 各项每回合（或每条气泡）的概率；调参看 ADR 0131 的重放数字 */
export const TEXTURE_SHARES = {
    question: 0.6,
    exclaim: 0.3,
    /** 有语气线索的回合里带小黄脸 */
    faceCue: 0.1,
    /** 没有线索的回合里带（只用中性的 doge） */
    faceNeutral: 0,
    tilde: 0.5,
    repeat: 0.4,
    ascii: 0.25,
    ellipsis: 0.7,
    merge: 0.5,
    reaction: 0.3,
    /** 他陈述了件事（不是问句、不难过）时，她先嗯一声再说 */
    ack: 0.1,
} as const;

/** 看最近几次回复有没有带「～」：这么多次回复里有一次，这次就不再加 */
export const TEXTURE_TILDE_WINDOW = 3;

/** 她最近 6 次回复里带了这么多次小黄脸，这次就不带（和 exit-check 的 FACE_WINDOW_MAX 一致） */
export const TEXTURE_FACE_WINDOW_MAX = 2;

type FaceName = keyof typeof SENDABLE_FACES;

/** 语气线索 → 小黄脸（按顺序，先中先用；只用她能发的 16 个）。看她这一条气泡自己的话 */
const FACE_RULES: readonly { re: RegExp; faces: readonly FaceName[] }[] = [
    { re: /晚安|睡了|去睡|睡觉|困死|困了/, faces: ['睡'] },
    { re: /哈哈|笑死|笑哭|太好笑|好笑|绷不住|乐死|笑得/, faces: ['笑哭', '笑哭', '偷笑'] },
    { re: /嘿嘿|嘻嘻|偷偷|你猜|才不告诉|略略/, faces: ['偷笑', 'doge'] },
    { re: /想你|爱你|喜欢你|mua|么么|亲亲|飞吻|贴贴/i, faces: ['爱心', '飞吻'] },
    { re: /抱抱|抱一下|抱你|抱住/, faces: ['拥抱'] },
    { re: /害羞|不好意思|才没有|讨厌啦|脸红|你坏|羞/, faces: ['害羞'] },
    { re: /尴尬|丢人|社死|完蛋|糟了|忘了|没脸|醉了|离谱/, faces: ['捂脸'] },
    { re: /无语|懒得理|服了你|烦死|你烦|切一声|少来/, faces: ['白眼'] },
    { re: /委屈|呜呜|不理你|不陪我|可怜|好惨|没人疼/, faces: ['委屈', '可怜'] },
    { re: /累哭|想哭|哭了|崩溃|难受死/, faces: ['快哭了', '大哭'] },
    { re: /你再说|信不信我|打你|揍你|你完了/, faces: ['敲打'] },
    { re: /^(?:好的?|行|可以|没问题|收到)[。！!～~]?$/, faces: ['OK'] },
    { re: /算了|行吧|随你|无所谓|懒得|随便吧|拿你没办法/, faces: ['捂脸', '白眼'] },
    { re: /好累|累死|累了|好困|没睡醒/, faces: ['捂脸', '睡'] },
    { re: /太好了|终于|好耶|开心|高兴|耶$/, faces: ['偷笑', '笑哭'] },
    { re: /好饿|馋|想吃|饿死/, faces: ['委屈', '可怜'] },
    { re: /抱歉|对不起|我错了|是我不好/, faces: ['捂脸'] },
    { re: /吓|害怕|怕死|好怕/, faces: ['快哭了'] },
    { re: /谢谢|谢啦|多谢|麻烦你了/, faces: ['害羞', '爱心'] },
];
/** 他这一串里的语气：她接话时带点同样的（他在笑、在撒娇） */
const SAID_CUES: readonly { re: RegExp; faces: readonly FaceName[] }[] = [
    { re: /哈哈|笑死|太好笑|绷不住|乐死/, faces: ['笑哭', '偷笑'] },
    { re: /想你|爱你|mua|么么|亲亲|抱抱|贴贴/i, faces: ['爱心', '飞吻'] },
];

/** 不动的气泡：表情包 / 照片 / 链接 / 已经带了小黄脸或方括号的 */
const UNTOUCHED = /^<(?:sticker|photo):|^\[(?:图片|表情|动画)|https?:|\[[\p{Script=Han}A-Za-z0-9]{1,6}\]/u;
/** 句末是语气词的轻松短句：把句号换成「～」（啦 / 呀 / 哦 / 嘛……任何长度；呢 / 吧 / 啊 / 好 / 行 只在很短的时候，免得「宿舍有人睡了～」） */
const TILDE_END = /[啦呀哦嘛哈嘿哒咯喔耶哇]$/;
const TILDE_END_SHORT = /[呢吧啊好行]$/;
/** 看得出是在问的（没带问号时补「？」） */
const ASKING = /吗|么|啥|什么|怎么|为啥|为什么|哪[里儿个天]?|几[点个天号分]?|多少|谁|是不是|有没有|要不要|能不能|行不行|对不对|好不好|了没|干嘛|咋|多久|多大|多远/;
const DECLARATIVE_QUESTION_WORD = /没什么|没啥|(?:不|没)(?:知道|明白|清楚|懂).*(?:什么|怎么|为什么|谁|哪)|(?:怎么|什么|谁|哪).{0,8}(?:都|也)|(?:不知道|不懂|不明白|没想好)|不是(?:什么|谁)|(?:想|要|会|能)怎么.*就怎么/;
const QUESTION_FORM = /(?:吗|么|啥|什么|谁|哪[里儿个天]|几点|多少|了没|干嘛|咋|多久|多大|多远|是不是|有没有|要不要|能不能|行不行|对不对|好不好)$|^(?:怎么|为什么|为啥|啥|什么|哪|谁|几|多少|是不是|有没有|要不要|能不能|行不行|好不好)/;
const isQuestion = (text: string) => ASKING.test(text) && QUESTION_FORM.test(text) && !DECLARATIVE_QUESTION_WORD.test(text);
/** 感叹的短句：太……了、好……啊、真…… */
const EXCLAIM = /^(?:太|好|真|这也太|也太)[^，。？?！!]{2,9}$/;
/** 他这一串里的反应线索 → 她可以先单独回一个字的反应（哈哈 / 啊？ / ？） */
const LAUGH_SAID = /哈哈|笑死|太好笑|绷不住|乐死|搞笑|逗死/;
const SURPRISE_SAID = /真的假的|不会吧|居然|竟然|没想到|什么鬼|离谱|我天|卧槽|！！/;
/** 整条只是一个语气词：拉长 */
const REPEAT: Readonly<Record<string, string>> = {
    哈: '哈哈', 哈哈: '哈哈哈哈', 哈哈哈: '哈哈哈哈哈', 嗯: '嗯嗯', 哦: '哦哦', 啊: '啊啊啊', 呜: '呜呜呜', 哎: '哎哎', 唉: '唉唉', 嘿嘿: '嘿嘿嘿', 哼: '哼哼哼', 呵呵: '呵呵呵', 好: '好好好', 对: '对对对',
};
/** 整条是这几个词时，偶尔写成英文字母 */
const ASCII_WORDS: Readonly<Record<string, string>> = { 好的: 'ok', 收到: 'ok', 哈哈哈: 'hhh', 哈哈: 'hh', 哈哈哈哈: 'hhhh' };

const chars = (text: string) => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;
const bare = (text: string) => text.replace(/[。！!？?～~…，,\s]+$/g, '');
const hasEnding = (text: string) => /[。！!？?～~…]$/.test(text.trim());

/** 这一条气泡的语气线索对应的小黄脸；没有线索返回 undefined */
export function faceFor(bubble: string, seed: string, said = ''): FaceName | undefined {
    const rule = FACE_RULES.find(r => r.re.test(bubble)) ?? (chars(bubble) <= 10 ? SAID_CUES.find(r => r.re.test(said)) : undefined);
    return rule ? rule.faces[Math.floor(unit(`${seed} which`) * rule.faces.length)] : undefined;
}

export interface TextureResult { parts: string[]; notes: string[] }

/** 在已经定好的气泡上加质感。parts 是这一轮要发的气泡（旧到新）；返回新的气泡和日志里的说法 */
export function applyTexture(parts: readonly string[], ctx: TextureContext): TextureResult {
    let out = [...parts];
    const notes: string[] = [];
    if (ctx.serious || !out.length) return { parts: out, notes };
    const said = ctx.said ?? '';
    let decorated = out.some(p => /\[[\p{Script=Han}A-Za-z0-9]{1,6}\]|[～~]$/u.test(p));

    // ① 整条气泡的改写：叠字、英文字母、去掉结尾的省略号、补问号 / 感叹号（互不重叠，一条最多一种）
    for (const [i, part] of out.entries()) {
        const text = part.trim();
        if (!text || UNTOUCHED.test(text)) continue;
        const core = bare(text);
        const tail = text.slice(core.length);
        const seed = `${ctx.seed} ${i}`;
        const ascii = ASCII_WORDS[core];
        if (ascii && !/[？?]/.test(tail) && unit(`${seed} ascii`) < TEXTURE_SHARES.ascii) { out[i] = `${ascii}${tail.replace(/[。]/g, '')}`; notes.push(`英文字母：${core} → ${ascii}`); continue; }
        const longer = REPEAT[core];
        if (longer && !/[？?]/.test(tail) && unit(`${seed} repeat`) < TEXTURE_SHARES.repeat) { out[i] = `${longer}${tail}`; notes.push(`叠字：${core} → ${longer}`); continue; }
        if (/[…]+$/.test(text) && chars(core) >= 3) {
            // 停在连词 / 假设词上的「……」是故意拖着的，去掉就成了话说到一半（ADR 0141）
            if (!endsHanging(core) && unit(`${seed} ellipsis`) < TEXTURE_SHARES.ellipsis) { out[i] = isQuestion(core) && unit(`${seed} q2`) < TEXTURE_SHARES.question ? `${core}？` : core; notes.push('去掉结尾的省略号'); }
            continue;
        }
        if (!hasEnding(text) && chars(text) >= 2 && chars(text) <= 24) {
            if (isQuestion(core) && !/^[a-z]+$/i.test(core) && unit(`${seed} question`) < TEXTURE_SHARES.question) { out[i] = `${core}？`; notes.push('补问号'); continue; }
            if (EXCLAIM.test(core) && unit(`${seed} exclaim`) < TEXTURE_SHARES.exclaim) { out[i] = `${core}！`; notes.push('补感叹号'); }
        }
    }

    // ② 「～」：轻松的短句，一次回复最多一条；最近几次回复里带过就不加
    if (!decorated && (ctx.recentTildes ?? 0) === 0) {
        for (const [i, part] of out.entries()) {
            const text = part.trim();
            if (!text || UNTOUCHED.test(text) || /[？?！!～~…]$/.test(text) || /^[a-z]+$/i.test(text) || chars(text) > 14 || chars(text) < 2) continue;
            const core = bare(text);
            if (ASKING.test(core) || !(TILDE_END.test(core) || (TILDE_END_SHORT.test(core) && chars(core) <= 6)) || unit(`${ctx.seed} ${i} tilde`) >= TEXTURE_SHARES.tilde) continue;
            out[i] = `${core}～`;
            notes.push('句尾加「～」');
            decorated = true;
            break;
        }
    }

    // ③ 小黄脸：一次回复最多一个，加在语气对得上的那条气泡末尾；最近带得多就不带
    if (!decorated && ctx.recentFaces < TEXTURE_FACE_WINDOW_MAX) {
        for (const [i, part] of out.entries()) {
            const text = part.trim();
            if (!text || UNTOUCHED.test(text) || /～$|~$/.test(text) || /^[a-z]+$/i.test(text)) continue;
            const face = faceFor(text, `${ctx.seed} ${i}`, said);
            if (!face) continue;
            if (unit(`${ctx.seed} ${i} face`) >= TEXTURE_SHARES.faceCue) continue;
            out[i] = `${text}[${face}]`;
            notes.push(`小黄脸：[${face}]`);
            decorated = true;
            break;
        }
        if (!decorated && unit(`${ctx.seed} neutral`) < TEXTURE_SHARES.faceNeutral) {
            const last = out.length - 1;
            const text = out[last]!.trim();
            if (text && !UNTOUCHED.test(text) && /\p{Script=Han}/u.test(text) && !/[？?]$/.test(text) && !ASKING.test(text) && chars(text) <= 12) {
                out[last] = `${text}[doge]`;
                notes.push('小黄脸：[doge]（没有线索）');
            }
        }
    }

    // ④ 连着两条都很短的，偶尔并成一条（真人一个小句往往不拆）；问句、带小黄脸 / 表情的不并
    if (out.length >= 2 && unit(`${ctx.seed} merge`) < TEXTURE_SHARES.merge) {
        const [a, b] = [out[0]!.trim(), out[1]!.trim()];
        const plain = (t: string) => t && !UNTOUCHED.test(t) && !/[？?！!～~…]$/.test(t) && chars(t) <= 9 && chars(t) >= 2 && !/^[a-z]+$/i.test(t);
        if (plain(a) && plain(b) && !ASKING.test(a)) {
            out = [`${bare(a)}，${b}`, ...out.slice(2)];
            notes.push('并了两条短的');
        }
    }
    // ⑤ 先单独回一个字的反应：他在笑 / 觉得离谱，她的第一条不是在笑 / 惊讶，偶尔先回一条「哈哈」「啊？」「？」（真人两个字以内的反应占 14–24%，她 5%）；要有空位
    if (out.length < (ctx.maxBubbles ?? 3) && !/^(?:哈|啊|？|\?|嗯|哦|真的假的)/.test(out[0]!.trim()) && !UNTOUCHED.test(out[0]!.trim())) {
        const cued = LAUGH_SAID.test(said) ? ['哈哈', '哈哈哈', '笑死'] : SURPRISE_SAID.test(said) ? ['啊？', '？', '真的假的'] : undefined;
        // 没有明显线索：他陈述了件事（不是问句），她第一条又比较长，偶尔先“嗯嗯”一声
        const acked = !cued && said.trim() && !/[？?吗呢吧么]|什么|怎么|为什么/.test(said) && chars(out[0]!) >= 6 && unit(`${ctx.seed} ack`) < TEXTURE_SHARES.ack ? ['嗯嗯', '嗯', '好', '对'] : undefined;
        const kinds = cued ?? acked;
        if (kinds && (acked || unit(`${ctx.seed} reaction`) < TEXTURE_SHARES.reaction)) {
            const pick = kinds[Math.floor(unit(`${ctx.seed} reaction which`) * kinds.length)]!;
            out = [pick, ...out];
            notes.push(`先回一个反应：${pick}`);
        }
    }
    return { parts: out, notes };
}
