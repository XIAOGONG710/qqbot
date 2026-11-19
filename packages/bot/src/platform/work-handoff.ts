import type { Executor } from '../executor/executor.ts';
import type { currentTierHistory } from '../memory/tier-record.ts';
import type { Log } from './log.ts';
import { rememberWorkTask, type runWorkTask } from './work-bridge.ts';

/** 动电脑没干成时她回的那句（也记进聊天记录） */
export const WORK_FAILED_LINE = '这个没弄成，等下我再看。';

// 把一件活交给 headless 的她（dsh）干，干完把结果单独发回去（工具桥）。
// 两个地方用：工作模式里他打的字（deliver），和她在聊天里自己判断要动电脑（<<用电脑>>，work-mode 模块）。
// 原来这两处在 app.ts 里各写了一遍，只有没干成时那行日志不一样；ADR 0336 第 6 步合成这一份，先后、说法、记录都同原来。
export interface WorkHandoffDeps {
    runWork: typeof runWorkTask;
    transport: Pick<Executor['qq'], 'sendPrivateText'>;
    history: ReturnType<typeof currentTierHistory>;
    clockNow: () => Date;
    log: Log;
}

export function workHandoff({ runWork, transport, history, clockNow, log }: WorkHandoffDeps) {
    /** 最近十条（他 / 我），交给 dsh 当上下文 */
    const recentFor = (qq: number): string => history.load(qq).slice(-10)
        .map(message => `${message.role === 'user' ? '他' : '我'}：${message.content}`)
        .join('\n');

    /**
     * 交给 dsh 干：干完的结果发回去、进聊天记录（ADR 0176），活记在他自己的 bank 里（干完时才取）；
     * 没干成：日志记「failure：原因」，回他一句 WORK_FAILED_LINE，这句也记进聊天记录（他问「怎么没弄成」她知道，11-02）
     */
    const handOff = (qq: number, task: string, recent: string, bank: () => string | undefined, failure: string): void => {
        void runWork(task, { context: recent })
            .then(async reply => {
                const messageId = await transport.sendPrivateText(qq, reply);
                history.append(qq, { time: clockNow().toISOString(), role: 'assistant', content: reply, messageId });
                void rememberWorkTask(task, reply, bank());
            })
            .catch(error => {
                log(`[${qq}] ${failure}：${error instanceof Error ? error.message : String(error)}`);
                void transport.sendPrivateText(qq, WORK_FAILED_LINE)
                    .then(messageId => history.append(qq, { time: clockNow().toISOString(), role: 'assistant', content: WORK_FAILED_LINE, messageId }))
                    .catch(() => {});
            });
    };

    return { recentFor, handOff };
}
