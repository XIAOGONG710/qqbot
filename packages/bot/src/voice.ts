// 开口说话、唱歌（ADR 0140，配置 voice，默认关）：真人女朋友偶尔会发条语音——懒得打字、撒个娇、想他了、他刚发了语音，
// 或者他说「想听你声音」「唱首歌给我听」。她以前只会打字（卡上写着发不了语音，出口检查也拦「发语音」）。
// 这一份只管“能不能发、怎么念、发什么”的纯逻辑；合成声音在 tts.ts，发出去在 onebot.ts / 插件的 transport，接线在 contact.ts / responder.ts。
// 做法：满足条件的轮次（只对男朋友档、她方便出声、今天没发够）才给她看“这一轮你也可以发语音”这一行，要发就把 <voice> 单独写在第一行；
// 模型写没写、写在哪都不信：标签只在这一轮提供过的前提下才认，认了也要过一遍“念得出来”的检查，过不了照旧发文字。
// 次数上限直接从聊天记录里数（她发的语音在记录里是「[语音 6秒：……]」，和他发来的写法一样），不另存状态。

import { voiceLine } from './media.ts';
import { pick } from './reply-timing.ts';
import type { State } from './schedule.ts';

export type SpeechKind = 'voice' | 'sing';

/** 聊天记录里的一条（回复器的 StoredMessage 和提示词里的 ChatMessage 都满足） */
export interface Said { role: 'user' | 'assistant'; content: string; time?: string }

/** 一条语音最多念多少字（约 20 秒；QQ 语音上限 60 秒，真人随手发的多半 3–15 秒） */
export const VOICE_MAX_CHARS = 90;
/** 短于这个不值得发语音（「嗯」「好」）*/
export const VOICE_MIN_CHARS = 3;
/** 她的一天（按日历日）最多发几条语音；他明着要的也不超过 VOICE_MAX_PER_DAY_ASKED */
export const VOICE_MAX_PER_DAY = 2;
export const VOICE_MAX_PER_DAY_ASKED = 4;
/** 没人要她发时，两条语音之间至少隔多久；他明着要的隔 VOICE_ASKED_GAP_MS */
export const VOICE_GAP_MS = 3 * 3_600_000;
export const VOICE_ASKED_GAP_MS = 5 * 60_000;
/** 唱歌：一天最多、两次之间至少隔多久（他明着要的才唱，她自己不会突然唱） */
export const SING_MAX_PER_DAY = 2;
export const SING_GAP_MS = 20 * 60_000;
/** 没人要她发的轮次里，给她看“可以发语音”这一选项的概率；他刚发了语音、说了亲近的话时高一些 */
export const VOICE_OFFER_SHARE = 0.05;
export const VOICE_OFFER_AFTER_VOICE_SHARE = 0.4;
export const VOICE_OFFER_WARM_SHARE = 0.14;
/** 宿舍夜里室友在睡：这段时间不出声（小时，含小数；23:00–07:30） */
export const QUIET_FROM_HOUR = 23;
export const QUIET_TO_HOUR = 7.5;
/** 唱的词：最多几行、每行最多几个字 */
export const SING_MAX_LINES = 4;
export const SING_MAX_LINE_CHARS = 18;

/** 聊天记录里她发的语音的开头（和他发来的语音同一种写法，media.ts 的 voiceLine） */
export const VOICE_HISTORY_PREFIX = '[语音';
/** 唱歌在记录里的标记：念的是词，不是话 */
export const SING_MARK = '（唱歌）';

// ---- 他想听什么 ----

/** 他明着要语音：发个语音、说句话我听听、想听你声音、语音一下 */
const ASKS_VOICE = /(?:发|来|录|给我)[个条段句]?(?:语音|录音)|录个?音|语音(?:一下|吧|呗|嘛|给我|听听)|(?:想|要|让我)听(?:听)?你(?:的)?(?:声音|声儿|嗓音)|听听你的?(?:声音|声儿)|想听你(?:说话|说句)|说句话(?:给我)?(?:听|吧|呗)|开口说|你说话我听|出个声/;
/** 他明着要她唱：唱首歌、唱两句、想听你唱、哼个歌；“我唱”“他唱”不算，“你会唱歌吗”只是问会不会，也不算 */
const ASKS_SING = /(?:想听你|要听你|让我听听你|听你)(?:唱|哼)|(?<![我他她咱会])(?:唱|哼)(?:一?首|个|一?段|一?句|两句|几句|一下|给我|歌|小曲)|(?:来|给我来|整)(?:一?首|个|段)歌|(?:给我|为我|替我)(?:唱|哼)/;
const HE_SINGS = /(?<![给为替让叫帮])我(?:来|想|要|去|也)?(?:唱|哼)|(?:他|她|咱们?)(?:唱|哼)|(?:去|在|刚)(?:KTV|ktv|唱k|唱K)/;
const ASKS_CAN_SING = /(?:会|能|可以).{0,3}唱歌?.{0,3}(?:吗|么|嘛|不)|唱歌.{0,3}(?:好听|难听|怎么样)/;

/** 他这一串话里明着要什么：唱 > 语音；没要就是 undefined。text 是她上次回复之后他说的话合在一起 */
export function voiceAsked(text: string): SpeechKind | undefined {
    // 他自己唱 / 说别人唱 / 说去过 KTV、听过演唱会 / 过去时（「唱了首歌」）都不是在要她唱
    // 「你发语音干嘛」「你唱歌干啥」是在问她为什么，不是在要
    const said = text.replace(/[^，。！？!?\n]*(?:干嘛|干啥|干什么|为什么|为啥|咋)[^，。！？!?\n]*/g, '').replace(/(?:KTV|ktv|唱k|唱K|K歌|演唱会)[^，。！？!?\n]*/g, '').replace(HE_SINGS, '').replace(/(?:唱|哼)(?:歌|首歌|了首歌)?了/g, '');
    if (ASKS_SING.test(said) && !ASKS_CAN_SING.test(said)) return 'sing';
    if (ASKS_VOICE.test(said)) return 'voice';
    return undefined;
}

/** 聊天记录里这一条是不是她发的语音 */
export function isHerVoice(message: Pick<Said, 'role' | 'content'>): boolean {
    return message.role === 'assistant' && message.content.startsWith(VOICE_HISTORY_PREFIX);
}

/** 她最后一条回复之后，他有没有发过语音（最后一条他的消息是语音） */
export function heSentVoice(history: readonly Pick<Said, 'role' | 'content'>[]): boolean {
    const last = history.findLast(message => message.role === 'user');
    return last !== undefined && last.content.startsWith(VOICE_HISTORY_PREFIX);
}

const WARM = /想你|想我|晚安|抱抱|亲亲|宝贝|宝宝|乖|哄我|陪我|撒娇|睡不着|难过|开心死|好开心/;

// ---- 方不方便出声 ----

export interface VoiceSituation {
    /** 毫秒时间戳 */
    now: number;
    /** 聊天记录（带时间）：数她今天发了几条、上一条是什么时候 */
    history: readonly Said[];
    /** 她此刻的状态（作息）；没有作息就不按状态限制 */
    state?: State;
    /** 被消息吵醒的这一轮 */
    woken?: boolean;
    /** 在家（放假回家）：夜里不用顾及室友 */
    home?: boolean;
}

/** 空闲活动里这些地方不方便出声 */
const QUIET_PLACES = /图书馆|自习|教室|占座/;

function hourOf(ms: number): number {
    const d = new Date(ms);
    return d.getHours() + d.getMinutes() / 60;
}

function sameDay(a: number, b: number): boolean {
    const x = new Date(a); const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** 此刻为什么不方便出声；方便就是 undefined（给“他要听、她不方便”的那一行当原因，也写进日志） */
export function whyNotNow(situation: VoiceSituation): string | undefined {
    if (situation.woken) return '刚被消息吵醒';
    const activity = situation.state?.activity;
    if (activity?.kind === 'sleep') return '在睡觉';
    if (activity?.kind === 'class') return '在上课';
    if (activity?.kind === 'free' && QUIET_PLACES.test(activity.text)) return '在图书馆或自习的地方，周围很安静';
    const hour = hourOf(situation.now);
    const home = situation.home ?? situation.state?.holiday?.home === true;
    if (!home && (hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR)) return '夜里宿舍室友在睡，不好出声';
    return undefined;
}

export interface VoiceCount { today: number; lastAt: number | undefined }

/** 她今天发了几条语音（唱歌的单算）、最近一条是什么时候 */
export function countVoices(history: VoiceSituation['history'], now: number, kind: SpeechKind): VoiceCount {
    const mine = history.filter(message => isHerVoice(message) && message.time !== undefined && (message.content.includes(SING_MARK) === (kind === 'sing')));
    const times = mine.map(message => Date.parse(message.time!)).filter(Number.isFinite);
    return { today: times.filter(t => sameDay(t, now)).length, lastAt: times.length ? Math.max(...times) : undefined };
}

export interface VoiceChoice {
    /** 这一轮提供给她的选项（她可以在回复第一行写 <voice> / <sing>）；没有就是不提供 */
    offer?: SpeechKind;
    /** 他明着要的 */
    asked?: SpeechKind;
    /** 他要了、但此刻不行的原因（给提示词那一行用） */
    blocked?: string;
    /** 没人要、抽中提供时的由头：他刚发了语音 / 他在撒娇想她（提示词的说法跟着变） */
    cue?: 'afterVoice' | 'warm';
    /** 日志里的一句话 */
    note: string;
}

export interface VoiceTurn extends VoiceSituation {
    /** 他这一串话（她上次回复之后他说的，合在一起） */
    said: string;
    /** 随机抽签的种子（同一串消息结果固定） */
    seed: string;
    /** 没人要时提供选项的概率（模拟器场景用来调；线上不传，按 VOICE_OFFER_* 常量） */
    share?: number;
    /** 唱歌的引擎在不在 */
    canSing: boolean;
    /** 这一轮不适合发语音（危机、他难过、小别扭、主动找他、只发表情 / 照片的回合……）：由调用方判断 */
    skip?: string;
}

/** 这一轮给不给她“发语音 / 唱歌”的选项 */
export function chooseVoice(turn: VoiceTurn): VoiceChoice {
    if (turn.skip) return { note: `这一轮不提供（${turn.skip}）` };
    const asked = voiceAsked(turn.said);
    const why = whyNotNow(turn);
    if (asked === 'sing' && !turn.canSing) return { asked, blocked: '有点害羞，不想唱', note: '他要她唱歌，但没有唱歌引擎（提示词里按“害羞不想唱”说）' };
    if (asked) {
        const kind = asked;
        if (why) return { asked, blocked: why, note: `他要${kind === 'sing' ? '她唱歌' : '听她声音'}，但${why}` };
        const count = countVoices(turn.history, turn.now, kind);
        const limit = kind === 'sing' ? SING_MAX_PER_DAY : VOICE_MAX_PER_DAY_ASKED;
        const gap = kind === 'sing' ? SING_GAP_MS : VOICE_ASKED_GAP_MS;
        if (count.today >= limit) return { asked, blocked: kind === 'sing' ? '今天已经唱过了，嗓子累了' : '今天已经发了不少语音', note: `他要${kind === 'sing' ? '她唱歌' : '听她声音'}，但今天已经${count.today}次` };
        if (count.lastAt !== undefined && turn.now - count.lastAt < gap) return { asked, blocked: '刚发过', note: `他要${kind === 'sing' ? '她唱歌' : '听她声音'}，但刚发过` };
        return { asked, offer: kind, note: `他要${kind === 'sing' ? '她唱歌' : '听她声音'}，提供` };
    }
    if (why) return { note: `不提供（${why}）` };
    const count = countVoices(turn.history, turn.now, 'voice');
    if (count.today >= VOICE_MAX_PER_DAY) return { note: '不提供（今天发够了）' };
    if (count.lastAt !== undefined && turn.now - count.lastAt < VOICE_GAP_MS) return { note: '不提供（刚发过一条）' };
    const share = turn.share ?? (heSentVoice(turn.history) ? VOICE_OFFER_AFTER_VOICE_SHARE : WARM.test(turn.said) ? VOICE_OFFER_WARM_SHARE : VOICE_OFFER_SHARE);
    if (pick(turn.seed, 'voice offer', [0, 9999]) >= share * 10_000) return { note: '不提供（没抽中）' };
    const cue = heSentVoice(turn.history) ? 'afterVoice' as const : WARM.test(turn.said) ? 'warm' as const : undefined;
    return { offer: 'voice', ...(cue ? { cue } : {}), note: cue === 'afterVoice' ? '他刚发了语音，提供' : cue === 'warm' ? '他在说亲近的话，提供' : '抽中，提供' };
}

// ---- 提示词里的一行 ----

const HOW_TO_WRITE = '要像对着手机说出来的，口语，一两句，别带括号动作、表情符号、颜文字、网址';

/** 提供“发语音”选项的那一行（没人要的轮次）*/
export const VOICE_OFFER_LINE = `[这一轮你也可以发语音：想发，就把 <voice> 单独写在第一行，后面写你要说的话——${HOW_TO_WRITE}；不想发就照常打字，不写 <voice>。有由头才发（想撒个娇、懒得打字、想他了、他刚发了语音），平常聊事情还是打字；发语音就别再说“发你一条语音”“给你听听”，直接说]`;

export function describeVoice(choice: VoiceChoice, userName: string): string | undefined {
    if (choice.offer === 'sing') {
        return `[${userName}想听你唱歌。你现在方便：想唱，就把 <sing> 单独写在第一行，后面每行写一句你要唱的词（两到四行，每行十来个字，自己随口编的小词，别抄真的歌词，别写括号动作和表情）；害羞不想唱也行，用你自己的话回他，别编没写在这里的理由]`;
    }
    if (choice.offer === 'voice' && choice.asked) {
        return `[${userName}想听你的声音。你现在方便说话：想答应，就把 <voice> 单独写在第一行，后面写你要说的话——${HOW_TO_WRITE}；不想发也行，用你自己的话回他，别编没写在这里的理由。发语音就别再说“发你一条语音”“给你听听”，直接说]`;
    }
    if (choice.offer === 'voice' && choice.cue === 'afterVoice') return `[${userName}刚给你发了条语音。真人收到语音多半也回条语音，比打字亲：想回，就把 <voice> 单独写在第一行，后面写你要说的话——${HOW_TO_WRITE}；不方便或者不想就照常打字，不写 <voice>。发语音就别再说“发你一条语音”“给你听听”，直接说]`;
    if (choice.offer === 'voice' && choice.cue === 'warm') return `[这一轮你也可以发语音：${userName}在跟你撒娇、说想你，这种话说出来比打出来更有味道。想发，就把 <voice> 单独写在第一行，后面写你要说的话——${HOW_TO_WRITE}；不想发就照常打字，不写 <voice>。发语音就别再说“发你一条语音”“给你听听”，直接说]`;
    if (choice.offer === 'voice') return VOICE_OFFER_LINE;
    if (choice.asked && choice.blocked) {
        const sing = choice.asked === 'sing';
        return `[${userName}想听你${sing ? '唱歌' : '的声音'}，可你现在不方便（${choice.blocked}）：像真人那样自然地告诉他现在不方便，可以说晚点或下次；理由只用括号里写的，别编嗓子哑、感冒、不舒服这类身体上的理由；别说“发不了”“我只能打字”，也别答应具体的时间]`;
    }
    return undefined;
}

/** 她最近一天内发过语音：提示词里补一句，免得她看着聊天记录里的「[语音 …]」又按卡上写的说“我发不了语音” */
export function describeHerVoices(history: readonly Said[], now: number): string | undefined {
    const recent = history.slice(-30).some(message => isHerVoice(message) && message.time !== undefined && now - Date.parse(message.time) < 24 * 3_600_000);
    return recent ? '[聊天记录里写成「[语音 N秒：……]」的是你前面真发给他的语音，他听得到；你打字的时候不写这种方括号]' : undefined;
}

// ---- 模型写的标签 ----

const TAG = /^\s*<\s*(voice|sing)\s*>[ \t]*/i;
const STRAY_TAG = /<\/?\s*(?:voice|sing)\s*>/gi;

/** 回复开头的 <voice> / <sing>：拿掉标签，返回它要的是哪种；别处出现的标签一律去掉（不会当文字发出去） */
export function readVoiceTag(reply: string): { kind?: SpeechKind; text: string } {
    const match = TAG.exec(reply);
    const text = reply.replace(TAG, '').replace(STRAY_TAG, '').replace(/^\s*\n/, '');
    return match ? { kind: match[1]!.toLowerCase() as SpeechKind, text } : { text };
}

// ---- 念出来的字 ----

/** 把要发的几条气泡改成念得出来的话；念不出来（太长、太短、里面全是符号）返回 undefined，照旧发文字 */
export function speakable(parts: readonly string[], max = VOICE_MAX_CHARS): string | undefined {
    const pieces = parts.map(part => part
        .replace(/<(?:sticker|photo):[^>]*>/gi, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\[[^\]\n]{1,8}\]/g, '')
        .replace(/[（(][^）)\n]{0,12}[）)]/g, '')
        .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
        .replace(/[～~]+/g, '')
        .replace(/哈{4,}/g, '哈哈哈').replace(/呜{3,}/g, '呜呜').replace(/啊{4,}/g, '啊啊啊').replace(/哼{3,}/g, '哼哼')
        .replace(/[…]+|\.{2,}|。{2,}/g, '，')
        .replace(/[!！]{2,}/g, '！').replace(/[?？]{2,}/g, '？')
        .replace(/\s+/g, ' ')
        .trim())
        .filter(piece => piece !== '');
    if (!pieces.length) return undefined;
    const joined = pieces.map((piece, i) => (i === pieces.length - 1 || /[，。！？、,.!?]$/.test(piece) ? piece : `${piece}，`)).join('');
    const letters = [...joined].filter(ch => /[\p{Script=Han}A-Za-z0-9]/u.test(ch)).length;
    if (letters < VOICE_MIN_CHARS || letters > max) return undefined;
    return joined;
}

/** 唱的词：每行一句，去掉符号和括号，最多 SING_MAX_LINES 行、每行 SING_MAX_LINE_CHARS 字；一行都没有返回 undefined */
export function singable(parts: readonly string[]): string[] | undefined {
    const lines = parts.flatMap(part => part.split('\n'))
        .map(line => line
            .replace(/<(?:sticker|photo):[^>]*>/gi, '')
            .replace(/\[[^\]\n]{1,8}\]/g, '')
            .replace(/[（(][^）)\n]{0,12}[）)]/g, '')
            .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
            .replace(/^[♪♫♬\s]+|[♪♫♬]+/g, '')
            .replace(/[～~]+/g, '')
            .trim())
        .filter(line => [...line].filter(ch => /[\p{Script=Han}A-Za-z0-9]/u.test(ch)).length >= 2);
    if (!lines.length || lines.length > SING_MAX_LINES) return undefined;
    if (lines.some(line => [...line].length > SING_MAX_LINE_CHARS)) return undefined;
    return lines;
}

/** 聊天记录里这条语音怎么写：说话是「[语音 6秒：……]」，唱歌是「[语音 14秒：（唱歌）词一／词二]」 */
export function historyOfVoice(kind: SpeechKind, seconds: number, spoken: string | readonly string[]): string {
    const text = kind === 'sing' ? `${SING_MARK}${(spoken as readonly string[]).join('／')}` : (spoken as string);
    return voiceLine({ seconds: Math.max(1, Math.round(seconds)), text });
}

/** 她“录”这条语音要多久：和念出来一样长再加一点点开头结尾，至少 2 秒、最多 25 秒 */
export function recordMs(seconds: number): number {
    return Math.min(25_000, Math.max(2000, Math.round(seconds * 1000) + 1200));
}

/** 唱歌失败时退回的文字：词按行发，前面带个 ♪ */
export function singAsText(lines: readonly string[]): string[] {
    return lines.map(line => `♪ ${line}`);
}
