// 他的口头习惯（ADR 0138）作为解释器的模块（ADR 0263 第 5 步），做法同小梗（modules/jokes.ts）：
// - 补完漏掉的消息之后（synced）学一次，之后每 IDIOMS_CHECK_MS 检查一次（定时由解释器经执行器开）；学的模型调用经执行器。
//   不收进去的词：这个人和角色的名字、名单里所有人的名字、卡上的禁用词。
// - 一轮回复时，让路规则同小梗（男朋友档、不是主动找他 / 只想一想 / 危机 / 小别扭 / 他难过），按 idiomLine 的规则往「此刻」块的 idiom 槽放一行。
// - 停下时关入口、等已派发的学习收尾。没有状态页补充。
// 学和挑词的规则都在 language/idioms.ts，这里只是接线；行为和迁移前 app.ts / contact.ts 里的逐字一样（行为基线 idioms 场景核对）。

import { join } from 'node:path';
import type { Executor } from '../executor/executor.ts';
import type { Module } from '../interpreter/interpreter.ts';
import { forExtraction, type LlmOptions } from '../language/llm.ts';
import { idiomLine, idiomRefresher, idiomStore, IDIOMS_CHECK_MS, verifiedIdioms, type Idiom } from '../language/idioms.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { playfulAllowed } from './playful.ts';

/**
 * 只往提示词里放口头习惯的那一半（模拟器直接给词，不学）；log 同联系人流水线的日志，前面加 [QQ]。
 * share：给她看的概率（默认 IDIOM_TURN_SHARE；模拟器场景可以调来测）
 */
export function idiomsTurnModule(idiomsOf: (contact: Contact) => readonly Idiom[], log: Log, share?: number): Module {
    return {
        id: 'idioms',
        contribute(turn) {
            if (!playfulAllowed(turn)) return [];
            const line = idiomLine(idiomsOf(turn.contact), turn.history, turn.at.getTime(), share);
            if (!line) return [];
            log(`[${turn.contact.qq}] 口头习惯：这一轮提示词里放了他爱说的词（日志不记内容）`);
            return [{ slot: 'idiom', text: line }];
        },
    };
}

export interface IdiomsModuleOptions {
    exec: Pick<Executor, 'llm' | 'now'>;
    dataDir: string;
    log: Log;
    contacts: readonly Contact[];
    /** 学的时候她叫什么（卡上的名字） */
    charName: (contact: Contact) => string;
    /** 不收进去的词：联系人和角色的名字、卡上的禁用词 */
    blocked: (contact: Contact) => readonly string[];
    /** 这个人当前档位下的聊天记录 */
    history: (qq: number) => StoredMessage[];
    llm: LlmOptions;
}

export function idiomsModule(options: IdiomsModuleOptions): Module {
    const { exec, log, contacts, history, blocked } = options;
    // 派生数据，存 <数据目录>/idioms/<QQ>.json
    const store = idiomStore({ dir: join(options.dataDir, 'idioms'), log });
    const owner = idiomRefresher();
    let stopped = false;
    // 隔一阵从他最近的话里学；出错只记日志
    const refreshAll = () => {
        if (stopped) return;
        for (const contact of contacts.filter(c => c.tier === 'boyfriend')) {
            const scoped: Log = message => { if (!stopped) log(message); };
            void owner.refresh({
                qq: contact.qq, userName: contact.name, charName: options.charName(contact), history: history(contact.qq), store,
                freshHistory: () => history(contact.qq), blocked: blocked(contact),
                extract: messages => exec.llm({ purpose: 'background', config: forExtraction(options.llm), messages }, scoped),
                now: exec.now(), log: message => scoped(`[${contact.qq}] ${message}`),
            }).catch(error => scoped(`[${contact.qq}] 口头习惯：学习出错（${error instanceof Error ? error.message : String(error)}）`));
        }
    };
    const turn = idiomsTurnModule(contact => (contact.tier === 'boyfriend' ? verifiedIdioms(store.load(contact.qq), history(contact.qq), blocked(contact)) : []), log);
    return {
        ...turn,
        on: { synced: () => refreshAll() },
        schedules: [{ every: IDIOMS_CHECK_MS, run: refreshAll }],
        stop() {
            stopped = true;
            return owner.stop();
        },
    };
}
