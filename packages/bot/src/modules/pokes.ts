import type { Module } from '../interpreter/interpreter.ts';
import type { MessageEvent } from '../platform/onebot.ts';
import type { AppConfig, Tier } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { asleepSince } from '../life/bedtime.ts';
import { stateAt, type Schedule } from '../life/schedule.ts';
import { POKE_BACK_COOLDOWN_MS, POKE_MAX_AGE_MS, POKE_MAX_IN_WINDOW, pokeBackPlan, pokeMessage, type PokeLimiter } from '../social/pokes.ts';

// 他戳她一下：名单里的人、她没睡着没在上课、5 分钟里没戳太多，就当成他发来的一条消息交给私聊那边回，顺便戳回去。
// 原来是 app.ts 里 App 的 receivePoke，ADR 0336 第 6 步原样搬成解释器的模块（接 poke 事件）。
export interface PokeDeps {
    config: Pick<AppConfig, 'pokes' | 'contacts' | 'schedule'>;
    stopped: () => boolean;
    /** 正在补回漏掉的消息：这时的戳不理（同原来） */
    syncing: () => boolean;
    now: () => number;
    /** 这一档的人设里她的作息 */
    scheduleOf: (tier: Tier) => Schedule | undefined;
    /** 他们说过的「睡了」（App 从聊天记录里读） */
    bedtimes: (schedule: Schedule, now: number) => readonly number[];
    limiter: PokeLimiter;
    /** 戳回去的冷却：每个人上次戳回去的时间 */
    lastPokeBack: Map<number, number>;
    /** 交给私聊那边，当成他发来的一条消息 */
    onMessage: (event: MessageEvent) => void;
    /** 她戳回去；入口不支持时没有 */
    pokeFriend: ((qq: number) => Promise<unknown>) | undefined;
    /** 过一会儿再做（App 经执行器开计时器，停止时取消） */
    later: (run: () => void, delayMs: number) => void;
    /** 已派发的回执算 App 的收尾（停止时等它） */
    sendOwnedNotice: (send: () => Promise<unknown>, success: () => void, failure: (error: unknown) => void) => Promise<void>;
    log: Log;
}

// App 里解释器建得比戳的那几样（限流、冷却、补回状态）早，所以给的是取它们的函数，事件来了才取（事件都在 App 搭好之后才来）。
export function pokesModule(depsNow: () => PokeDeps): Module {
    return {
        id: 'pokes',
        on: {
            poke: ({ event }) => {
                const deps = depsNow();
                const { config, limiter, lastPokeBack, pokeFriend, log } = deps;
                if (deps.stopped() || deps.syncing() || !config.pokes) return;
                const contact = config.contacts.find(c => c.qq === event.user_id);
                if (!contact) return;
                const now = deps.now();
                if (now - event.time * 1000 > POKE_MAX_AGE_MS) return;
                // 睡着、在上课时的戳不算：她看不到手机，起床、下课后回一句「戳我干嘛」是怪的（消息才会等到起床后看到）
                const schedule = config.schedule ? deps.scheduleOf(contact.tier) : undefined;
                if (schedule) {
                    const kind = stateAt(schedule, new Date(now)).activity.kind;
                    if (kind === 'sleep' || kind === 'class' || asleepSince(schedule, deps.bedtimes(schedule, now), new Date(now))) {
                        log(`[${contact.qq}] 戳了她一下，她在${kind === 'class' ? '上课' : '睡觉'}，不理`);
                        return;
                    }
                }
                if (!limiter.take(contact.qq, now)) {
                    log(`[${contact.qq}] 戳了她一下，5 分钟里已经戳过 ${POKE_MAX_IN_WINDOW} 下，不理`);
                    return;
                }
                log(`[${contact.qq}] 戳了她一下`);
                deps.onMessage(pokeMessage(event));
                // 她也戳回去一下（比文字回复早一点）；失败只记一行，不影响回复
                const back = pokeFriend ? pokeBackPlan(contact.qq, event.time) : undefined;
                const lastBack = lastPokeBack.get(contact.qq);
                if (back && pokeFriend && (lastBack === undefined || now - lastBack >= POKE_BACK_COOLDOWN_MS)) {
                    lastPokeBack.set(contact.qq, now);
                    deps.later(() => {
                        if (deps.stopped()) return;
                        void deps.sendOwnedNotice(() => pokeFriend(contact.qq),
                            () => log(`[${contact.qq}] 戳回去了`),
                            error => log(`[${contact.qq}] 戳回去失败：${error instanceof Error ? error.message : String(error)}`));
                    }, back.delayMs);
                }
            },
        },
    };
}
