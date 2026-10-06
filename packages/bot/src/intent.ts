// 当天这一层的「这一轮你想」（ADR 0019 决策 2）。
// 只按眼前已有线索给一个方向，不抽签、不额外调模型，也不把它写成能照抄的台词。

import type { StoredMessage } from './history.ts';
import type { Schedule, State } from './schedule.ts';

type Said = Pick<StoredMessage, 'role' | 'content'>;

export interface IntentContext {
    history: readonly Said[];
    state?: State;
    schedule?: Schedule;
    now: Date;
    /** 时间块里已经有「她答应的事」 */
    promised?: boolean;
    /** 这一轮放了在读的书，说明他问到了书或她正在看 */
    books?: boolean;
    /** 主动找他时 initiate.note 已经是这一轮的意图 */
    initiating?: boolean;
}

/** 她上一次回复以后，他这次说的内容。 */
function latestUserText(history: readonly Said[]): string {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
}

/** 他在说自己的经历、近况或心情；普通提问不算。 */
export function saysOwnThing(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    const self = /我|俺|咱|刚刚|刚才|刚|今天|昨天|昨晚/;
    const experience = /去(?:了|过|到|看|吃|玩|见|面试|上班|上课)|到(?:了|家|公司|学校)|回(?:了|到|家)|做了|干了|忙(?:了|着|完)|下课|上课|上班|下班|吃了|看了|玩了|见了|考了|买了|遇到|碰到|发生|累|困|烦|难受|开心|高兴|紧张|生气|emo/i;
    return self.test(text) && experience.test(text);
}

function nearSleep(now: Date, sleep: string): boolean {
    const [hour, minute] = sleep.split(':').map(Number);
    const current = now.getHours() * 60 + now.getMinutes();
    const target = hour! * 60 + minute!;
    const until = (target - current + 24 * 60) % (24 * 60);
    return until <= 90;
}

function busy(state: State | undefined, schedule: Schedule | undefined, now: Date): boolean {
    if (!state) return false;
    if (state.activity.kind === 'sleep') return true;
    if (state.activity.kind === 'class' && (state.activity.lesson.kind === 'hard' || state.activity.lesson.kind === 'machine')) return true;
    if (state.activity.kind === 'free' && /赶|作业|复习|报告|论文|考试/.test(state.activity.text)) return true;
    return Boolean(schedule && nearSleep(now, schedule.sleep));
}

/** 时间块里的一行；没有当下线索就不返回。顺序与 ADR 0019 的决策表一致。 */
export function describeIntent(context: IntentContext): string | undefined {
    if (context.initiating) return undefined;
    if (saysOwnThing(context.history)) return '[这一轮你想：问他刚说的那件事里的一个具体细节，不问“在干嘛”]';
    if (context.promised) return '[这一轮你想：先把上面你答应的那件事说了，不另起话题]';
    if (context.books) return '[这一轮你想：只说一件你手上这本书的新进度；没有新进度就不硬编]';
    if (!busy(context.state, context.schedule, context.now) && context.state?.activity.kind === 'free' && context.state.activity.text) {
        return `[这一轮你想：只说一件你手上正在做的事的新进度（${context.state.activity.text}）；没有新进度就不硬编]`;
    }
    if (busy(context.state, context.schedule, context.now)) return '[这一轮你想：回两句就去忙，不铺开新话题]';
    return undefined;
}
