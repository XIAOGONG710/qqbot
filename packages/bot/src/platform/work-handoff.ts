import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { focusCheckpoint, FOCUS_CHECKPOINT_FILE } from '../../../../dsh-plugins/dsh-linmengyao-memory/focus-checkpoints.mjs';
import type { Executor } from '../executor/executor.ts';
import type { currentTierHistory } from '../memory/tier-record.ts';
import type { Log } from './log.ts';
import type { runWorkTask } from './work-bridge.ts';
import { soulDir } from './soul-rating.ts';

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
    focusFile?: string;
}

export function workHandoff({ runWork, transport, history, clockNow, log,
    focusFile = process.env.QQBOT_FOCUS_WORK === '1' ? join(soulDir(), FOCUS_CHECKPOINT_FILE) : undefined,
}: WorkHandoffDeps) {
    /**
     * 交给 dsh 干：干完的结果发回去、进聊天记录（ADR 0176）；
     * 没干成：日志记「failure：原因」，回他一句 WORK_FAILED_LINE，这句也记进聊天记录（他问「怎么没弄成」她知道，11-02）
     */
    const handOff = async (qq: number, task: string, failure: string, incomingId?: number): Promise<void> => {
        const send = async (reply: string) => {
            const messageId = await transport.sendPrivateText(qq, reply);
            history.append(qq, { time: clockNow().toISOString(), role: 'assistant', content: reply, messageId });
        };
        const noteError = (error: unknown) => log(`[${qq}] ${failure}：${error instanceof Error ? error.message : String(error)}`);
        let reply: string;
        try {
            if (focusFile && incomingId !== undefined) {
                const operationId = createHash('sha256').update(`${qq}:${incomingId}`).digest('hex').slice(0, 24);
                const reference = task.match(/\bqq-[a-f0-9]{24}\b/)?.[0];
                const taskId = reference ?? `qq-${operationId}`;
                const start = reference ? 'resume' : 'start';
                const claimId = `${start}-${operationId}`;
                const record = (action: string, next?: string) => focusCheckpoint(focusFile,
                    { action, taskId, operationId: `${action}-${operationId}`, ...(next ? { next } : {}),
                        ...(action === start ? {} : { claimId }) }, +clockNow());
                const claim = record(start, '在原对话核对工作请求及所需材料');
                if (!claim.acquired) return;
                try {
                    reply = await runWork(task, { checkpoint: { taskId, operationId, claimId },
                        ...(reference && claim.next ? { context: claim.next } : {}) });
                    if (record('finish').status !== 'finished') return;
                } catch {
                    const result = record('interrupt');
                    if (['cancelled', 'waiting', 'stale'].includes(result.status)) return;
                    reply = result.status === 'finished' ? `任务 ${taskId} 的执行回执已保存，回复内容待核对。`
                        : `任务 ${taskId} 的结果待核对。`;
                }
            } else reply = await runWork(task);
        } catch (error) {
            noteError(error);
            reply = focusFile && incomingId !== undefined ? '工作状态待核对。' : WORK_FAILED_LINE;
        }
        // Sending can fail after the transport accepted the reply. Avoid a second outbound message.
        try { await send(reply); } catch (error) { noteError(error); }
    };

    return { handOff };
}
