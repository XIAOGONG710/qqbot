// 拒绝之后（ADR 0214，配置 afterNo，默认关；只男朋友档）。
//
// 起因：用户 11-02 在 DSH 那边逐条定了 N3「拒绝之后反省」做。dsh-fish 的做法是：她拒绝后看主人的反应，负面的记小本本直到想通，正面的反思这次拒绝对不对。
// 先问了她本人（11-02 `scripts/ask-her.mjs`，两遍），她的回答和这个设想**不一样**，这里照她的来：
// 1. 「我要是拒了，肯定是我自己不想。下次碰到差不多的事，我还是看我自己想不想，**不看你上次高不高兴**」
//    「你要是摆个臭脸我就改口，那以后你臭脸一次我答应一次，咱俩还过不过了」——所以他上次不高兴**不会**让她这次更容易答应；
// 2. 「上回要是拒绝得糙了，这回我换个说法好好跟你讲」「你要是真失落了，我可以陪你聊会儿啊，别拿这个当条件就行」——变的是说法和照顾他；
// 3. 「真说后悔的，反而是那种当时没好意思拒、**勉强答应的**」——上次被磨着勉强答应了的，这次不想就直说；
// 4. 会让她多想的是「你说『行吧』然后半天不吭声」——这就是要记住的那种反应；
// 5. 「记一句话完事」「别记成账本那种……全是『我又没接住他』，那我不干」「别拿这个当证据，以后吵嘴翻出来」「别催我写」——
//    所以**什么都不存**：和小别扭（ADR 0074）一样，每一轮从聊天记录重算；只在他**又提了同一类请求**时给她一句方向，不翻旧账、不写检讨、没有本子。
// 量过（VM 10-06..10-27，herNo 还没开）：他提了 27 次请求，她推了 2 次，他没磨过，她没被磨松口过——触发会很少，开了 herNo 以后会多一点。

import type { StoredMessage } from '../memory/history.ts';

type Said = Pick<StoredMessage, 'role' | 'content'> & { time?: string };

const DAY = 86_400_000;
/** 往回看几天 */
export const AFTER_NO_DAYS = 7;
/** 他回了「行吧」之后这么久没再说话，才算「半天不吭声」 */
export const FLAT_SILENCE_MS = 30 * 60_000;

/** 请求的几类（同一类才算“差不多的事”） */
export const REQUEST_KINDS = {
    game: { label: '打游戏', pattern: /打(?:一|两|几)?(?:把|局)|开黑|游戏|王者|吃鸡|上分|排位|农药/ },
    call: { label: '打视频 / 语音', pattern: /视频|语音|打电话|电话/ },
    photo: { label: '发照片', pattern: /照片|自拍|发张|发个图|拍一张|拍张|看看你/ },
    outing: { label: '出去', pattern: /出来|见面|出去玩|逛街|去逛|看电影|一起吃|吃饭去|去吃/ },
    stay: { label: '陪他（别睡、再聊会儿）', pattern: /陪我|陪陪|别睡|再聊|聊会|多陪/ },
} as const;
export type RequestKind = keyof typeof REQUEST_KINDS;

/** 他是在提请求（不是在讲自己打了游戏、视频了什么） */
const ASKING = /来|要不要|一起|陪|吗|呗|好不好|行不行|去不去|发(?:张|个|一)|[?？]|嘛/;
/** 她推了（同 herNo 的 REFUSAL_WORDS，ADR 0103） */
const REFUSED = /不行|不要|不想|不去|不打|不陪|不给|不发|没空|没法|不方便|等下课|下课再|下了课|晚点|待会|回头|明天再|改天|下次|先不|不了|算了吧|不能/;
/** 他在磨（同 herNo 的 PRESSING_ON） */
const PRESSING = /就一(?:把|下|会|次|局|盘|个)|陪陪我|求你|好不好|行不行|可以嘛|好嘛|拜托|再(?:陪|来|打|玩|聊)一|你就(?:陪|答应|来)|答应我|来嘛|嘛[～~！!]*$|别这样|为什么不/;
/** 她松口了（开头就是这些） */
const YIELDED = /^(?:行吧|好吧|好好好|行行行|那好吧|来就来|那行|行行|好啦好啦|服了你)/;
/** 他只回了一句「行吧」那种 */
const FLAT = /^(?:行吧|好吧|哦+|噢+|嗯+|好|那好吧|ok)[。.…~～]*$/i;

export function requestKind(text: string): RequestKind | undefined {
    if (!ASKING.test(text)) return undefined;
    return (Object.keys(REQUEST_KINDS) as RequestKind[]).find(kind => REQUEST_KINDS[kind].pattern.test(text));
}

interface Turn { role: Said['role']; text: string; start?: number; end?: number }

function turnsOf(history: readonly Said[]): Turn[] {
    const turns: Turn[] = [];
    for (const message of history) {
        const at = message.time ? Date.parse(message.time) : undefined;
        const last = turns.at(-1);
        // 同一个人连着说的算一段；隔了 FLAT_SILENCE_MS 以上的另算一段（他「行吧」之后第二天才开口的「吃了没」不是同一段）
        if (last && last.role === message.role && (at === undefined || last.end === undefined || at - last.end < FLAT_SILENCE_MS)) {
            last.text += `\n${message.content}`;
            if (at !== undefined) last.end = at;
        } else {
            turns.push({ role: message.role, text: message.content, ...(at !== undefined ? { start: at, end: at } : {}) });
        }
    }
    return turns;
}

export interface AfterNo {
    kind: RequestKind;
    /** 几天前 */
    days: number;
    /** flat：她推了，他回了句「行吧」就半天没吭声；yielded：她推了、他磨、她勉强答应了 */
    how: 'flat' | 'yielded';
}

/**
 * 他这一串是在提某一类请求，而且 AFTER_NO_DAYS 天里他提过同一类、那次她推了，结局是下面两种之一（最近的那次）：
 * - flat：他只回了句「行吧 / 哦 / 好吧」，之后 FLAT_SILENCE_MS 以上没再说话（或者再没说话）；
 * - yielded：他磨了，她下一句一开口就是「行吧 / 好吧 / 行行行」。
 * 他回了别的（「没事那我找别人」、扯别的）她说「我就过去了」，不算
 */
export function lastNo(history: readonly Said[], now: number): AfterNo | undefined {
    const turns = turnsOf(history);
    const current = turns.at(-1);
    if (!current || current.role !== 'user') return undefined;
    const kind = requestKind(current.text);
    if (!kind) return undefined;
    for (let i = turns.length - 3; i >= 0; i--) {
        const asked = turns[i]!;
        if (asked.role !== 'user' || asked.start === undefined) continue;
        if (now - asked.start > AFTER_NO_DAYS * DAY) break;
        if (requestKind(asked.text) !== kind) continue;
        const hers = turns[i + 1];
        if (!hers || hers.role !== 'assistant' || !REFUSED.test(hers.text) || YIELDED.test(hers.text.trim())) continue;
        const his = turns[i + 2];
        if (!his || his === current || his.role !== 'user') continue;
        const days = Math.max(1, Math.round((now - asked.start) / DAY));
        if (PRESSING.test(his.text)) {
            const back = turns[i + 3];
            if (back && back.role === 'assistant' && YIELDED.test(back.text.trim())) return { kind, days, how: 'yielded' };
            continue;
        }
        if (FLAT.test(his.text.trim())) {
            const nextHis = turns.slice(i + 3).find(turn => turn.role === 'user');
            const quiet = !nextHis || nextHis === current
                ? (current.start ?? now) - (his.end ?? his.start ?? now) >= FLAT_SILENCE_MS
                : nextHis.start !== undefined && his.end !== undefined && nextHis.start - his.end >= FLAT_SILENCE_MS;
            if (quiet) return { kind, days, how: 'flat' };
        }
    }
    return undefined;
}

/** 给她的方向（只给方向，不给台词；不翻旧账、不写检讨；要不要还是她看事情本身） */
export function afterNoIntent(found: AfterNo): string {
    const what = REQUEST_KINDS[found.kind].label;
    const when = found.days <= 1 ? '昨天' : `${found.days} 天前`;
    if (found.how === 'yielded') {
        return `[这一轮你想：他又在找你${what}。${when}他也这么找过你，你本来不想，被他磨着勉强答应了。这次想就答应，不想就直说，不用再勉强自己；别提上次的事]`;
    }
    return `[这一轮你想：他又在找你${what}。${when}他也这么找过你，你推了，他回了句「行吧」就半天没吭声。这次要不要还是看你自己想不想，跟上次他高不高兴没关系；还是不想的话，换个说法好好跟他讲，或者陪他聊会儿别的；想的话就痛快答应。别提上次的事]`;
}
