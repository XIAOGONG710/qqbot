// 戳一戳（ADR 0079）：他在 QQ 里戳她一下，NapCat 推一个 notice/notify/poke。
// 她看到的是一条「[戳了戳你]」——和「[语音]」「[图片]」一样是占位符，之后走原来的回复流程（看到的时刻、打字多久、气泡数都照旧）。
// 这里只管三件事：戳算不算数（名单里的人、没睡觉没上课、不是旧的、不是连着狂戳）、把戳变成一条消息。
import type { MessageEvent, PokeEvent } from './onebot.ts';
import { pick } from './reply-timing.ts';

export const POKE_TEXT = '[戳了戳你]';
const POKE_ID_BASE = 2 ** 40;

/** 她主动戳他一下（ADR 0087）记进聊天记录的那条：他问「戳我干嘛」时她知道自己戳过。id 同样不会和真 id、和他的戳撞 */
export const POKE_OUT_TEXT = '[你戳了戳他]';
const POKE_OUT_ID_BASE = 2 ** 41;
export const pokeOutMessageId = (at: number): number => POKE_OUT_ID_BASE + at;

/** 聊天安静了多久，她才会主动戳他 */
export const POKE_OUT_QUIET_MS = 90 * 60_000;
const GOODNIGHT = /晚安|睡了|去睡|先睡|睡觉|睡啦/;

/**
 * 这会儿适不适合戳他：最后一条是她说的（他没回、没有他的消息等着她回）、已经安静了 POKE_OUT_QUIET_MS 以上、最近几条里没有道晚安 / 说去睡。
 * 没聊过的人不戳
 */
export function quietEnoughToPoke(messages: readonly { time: string; role: 'user' | 'assistant'; content: string }[], now: number): boolean {
    const last = messages.at(-1);
    if (!last || last.role !== 'assistant') return false;
    const at = Date.parse(last.time);
    if (!Number.isFinite(at) || now - at < POKE_OUT_QUIET_MS) return false;
    return !messages.slice(-4).some(message => GOODNIGHT.test(message.content));
}

/** 戳是当下的事：通知到得比这晚（断线重连后补推等），当没发生 */
export const POKE_MAX_AGE_MS = 60_000;
/** 连着狂戳：5 分钟里最多算 3 下，之后的不理（她回过一两句「戳上瘾了」就够了） */
export const POKE_WINDOW_MS = 5 * 60_000;
export const POKE_MAX_IN_WINDOW = 3;

/** 戳回去（配置 pokeBack）：算数的戳里这么大概率她也戳回去一下，隔一两秒（比文字回复早），同一个人 5 分钟最多一次 */
export const POKE_BACK_CHANCE = 0.4;
export const POKE_BACK_DELAY_MS: [number, number] = [1_200, 3_500];
export const POKE_BACK_COOLDOWN_MS = 5 * 60_000;

/** 这一下戳她回不回：按人和通知时间定（同一下每次一样，不存状态），回的话隔多久。不回返回 undefined */
export function pokeBackPlan(qq: number, time: number): { delayMs: number } | undefined {
    const seed = `${qq} ${time}`;
    if (pick(seed, 'poke-back', [0, 999]) >= POKE_BACK_CHANCE * 1000) return undefined;
    return { delayMs: pick(seed, 'poke-back-delay', POKE_BACK_DELAY_MS) };
}

export interface PokeLimiter {
    /** 这一下算数就记下并返回 true；5 分钟里已经有 3 下就返回 false（不记） */
    take(qq: number, at: number): boolean;
}

export function createPokeLimiter(): PokeLimiter {
    const taken = new Map<number, number[]>();
    return {
        take(qq, at) {
            const recent = (taken.get(qq) ?? []).filter(time => at - time < POKE_WINDOW_MS);
            if (recent.length >= POKE_MAX_IN_WINDOW) {
                taken.set(qq, recent);
                return false;
            }
            taken.set(qq, [...recent, at]);
            return true;
        },
    };
}

let sequence = 0;

/**
 * 戳变成的消息：没有真的 QQ 消息 id。聊天记录只收非负的安全整数，NapCat 的真 id 是 32 位的（小于 2^32），所以用 2^40 起头再加时间毫秒和序号，
 * 不会和真 id 撞，同一秒两下也不撞；去重、聊天记录、补回对账都只把它当一个不重复的 id
 */
export function pokeMessage(event: PokeEvent): MessageEvent {
    return {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        self_id: event.self_id, user_id: event.user_id, time: event.time,
        message_id: POKE_ID_BASE + event.time * 1000 + (sequence++ % 1000),
        message: [{ type: 'text', data: { text: POKE_TEXT } }], raw_message: POKE_TEXT,
        sender: { user_id: event.user_id },
    };
}
