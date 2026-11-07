// 小梗（ADR 0114）作为解释器的模块（ADR 0263 第 5 步）：
// - 补完漏掉的消息之后（synced）抽一次，之后每 JOKES_CHECK_MS 检查一次（定时由解释器经执行器开）；抽取的模型调用经执行器。
// - 一轮回复时，男朋友档、不是主动找他 / 只想一想 / 危机 / 小别扭 / 他难过的轮次，按 jokeLine 的规则往「此刻」块的 joke 槽放一行。
// - 停下时关入口、等已派发的抽取收尾；状态页给出男朋友档现在有几个梗。
// 抽取和挑梗的规则都在 language/jokes.ts，这里只是接线；行为和迁移前 app.ts / contact.ts 里的逐字一样（行为基线 jokes 场景核对）。

import { join } from 'node:path';
import type { Executor } from '../executor/executor.ts';
import type { Module, Turn } from '../interpreter/interpreter.ts';
import { forExtraction, type LlmOptions } from '../language/llm.ts';
import { jokeLine, jokeRefresher, jokeStore, JOKES_CHECK_MS, verifiedJokes, type Joke } from '../language/jokes.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';

/** 他难过的轮次（意图行是「先接住他此刻的情绪」）小梗让路 */
const COMFORTING = /先接住他此刻的情绪/;

/** 这一轮能不能提小梗：只有男朋友档；主动找他、只想一想、危机、小别扭、他难过时都不提 */
export function jokesAllowed(turn: Turn): boolean {
    const { crisis, grievance, baseIntent } = turn.facts;
    return turn.contact.tier === 'boyfriend' && !turn.initiate && !turn.thinking && !crisis && !grievance && !(baseIntent && COMFORTING.test(baseIntent));
}

/** 只往提示词里放小梗的那一半（模拟器直接给梗，不抽）；log 同联系人流水线的日志，前面加 [QQ] */
export function jokesTurnModule(jokesOf: (contact: Contact) => readonly Joke[], log: Log): Module {
    return {
        id: 'jokes',
        contribute(turn) {
            if (!jokesAllowed(turn)) return [];
            const line = jokeLine(jokesOf(turn.contact), turn.history, turn.at.getTime());
            if (!line) return [];
            log(`[${turn.contact.qq}] 小梗：这一轮提示词里放了一个他们之间的梗（日志不记内容）`);
            return [{ slot: 'joke', text: line }];
        },
    };
}

export interface JokesModuleOptions {
    exec: Pick<Executor, 'llm' | 'now'>;
    dataDir: string;
    log: Log;
    contacts: readonly Contact[];
    /** 抽取时她叫什么（卡上的名字） */
    charName: (contact: Contact) => string;
    /** 这个人当前档位下的聊天记录 */
    history: (qq: number) => StoredMessage[];
    llm: LlmOptions;
}

export function jokesModule(options: JokesModuleOptions): Module {
    const { exec, log, contacts, history } = options;
    const store = jokeStore({ dir: join(options.dataDir, 'jokes'), log });
    const owner = jokeRefresher();
    let stopped = false;
    const boyfriends = () => contacts.filter(contact => contact.tier === 'boyfriend');
    const verified = (contact: Contact) => verifiedJokes(store.load(contact.qq), history(contact.qq));
    // 隔一阵从最近的聊天里抽；出错只记日志
    const refreshAll = () => {
        if (stopped) return;
        for (const contact of boyfriends()) {
            const scoped: Log = message => { if (!stopped) log(message); };
            void owner.refresh({
                qq: contact.qq, userName: contact.name, charName: options.charName(contact), history: history(contact.qq), store,
                freshHistory: () => history(contact.qq),
                extract: messages => exec.llm({ purpose: 'background', config: forExtraction(options.llm), messages }, scoped),
                now: exec.now(), log: message => scoped(`[${contact.qq}] ${message}`),
            }).catch(error => scoped(`[${contact.qq}] 小梗：抽取出错（${error instanceof Error ? error.message : String(error)}）`));
        }
    };
    const turn = jokesTurnModule(contact => (contact.tier === 'boyfriend' ? verified(contact) : []), log);
    return {
        ...turn,
        on: { synced: () => refreshAll() },
        schedules: [{ every: JOKES_CHECK_MS, run: refreshAll }],
        stop() {
            stopped = true;
            return owner.stop();
        },
        status: () => ({ jokes: boyfriends().reduce((n, contact) => n + verified(contact).length, 0) }),
    };
}
