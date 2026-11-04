import { join } from 'node:path';
import { helloEnvelope } from '@qqbot/mobile-companion/gateway';
import type { CompanionEnvelope, CompanionMessage } from '@qqbot/mobile-companion/protocol';
import { DshConversationContext } from '../dsh-continuity.ts';
import type { StoredMessage } from '../memory/history.ts';
import { createMobileCompanion } from '../mobile-companion-dsh.ts';

export interface CrossEndDrillReport {
    passed: boolean;
    checks: { name: string; passed: boolean }[];
    calls: number;
}

const envelope = (requestId: string, nonce: string, body: CompanionMessage, now: number): CompanionEnvelope<CompanionMessage> => ({
    v: 1, requestId, nonce, kind: 'message.send', sentAt: new Date(now).toISOString(), body,
});

/** 离线总演练：真实走配对、DSH 适配、跨端上下文持久化、请求幂等和进程重载。 */
export async function runCrossEndDrill(dir: string): Promise<CrossEndDrillReport> {
    let now = Date.parse('2026-11-04T06:00:00Z');
    const file = join(dir, 'dsh-continuity.json');
    const qq: StoredMessage[] = [
        { time: '2026-11-04T05:58:00Z', role: 'user', content: 'QQ：晚点提醒我带伞' },
        { time: '2026-11-04T05:58:10Z', role: 'assistant', content: 'QQ：好，我记着' },
    ];
    const context = new DshConversationContext({ file, maxTurns: 20 });
    context.commit('DSH：我刚把包放门口了', 'DSH：那出门时顺手拿上', now - 60_000, now - 59_000);
    let calls = 0;
    const mobile = createMobileCompanion({
        dsh: {
            advise: async request => {
                calls++;
                const joined = request.recentTurns?.map(turn => turn.content).join('|') ?? '';
                return joined.includes('带伞') && joined.includes('放门口') ? `手机：上下文连上了；${request.question}` : '手机：上下文断了';
            },
        },
        now: () => now,
        sharedConversation: {
            recent: () => context.recent(qq, 10),
            commit: (_clientId, question, reply, askedAt, repliedAt) => context.commit(question, reply, askedAt, repliedAt),
        },
    });
    const ticket = mobile.issuePairing('android-drill', now);
    const session = 'session-drill-001';
    const hello = await mobile.runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'request-hello-001', 'nonce-hello-001', new Date(now).toISOString()), session);
    now += 1_000;
    const first = await mobile.runtime.handle(envelope('request-message-001', 'nonce-message-001', { kind: 'text', text: '手机：我现在该拿什么？' }, now), session);
    now += 1_000;
    const replay = await mobile.runtime.handle(envelope('request-message-001', 'nonce-message-002', { kind: 'text', text: '手机：我现在该拿什么？' }, now), session);
    const reply = first.accepted ? (first.response?.body as CompanionMessage | undefined)?.text : undefined;
    const replayReply = replay.accepted ? (replay.response?.body as CompanionMessage | undefined)?.text : undefined;
    const reloaded = new DshConversationContext({ file, maxTurns: 20 });
    const afterRestart = reloaded.recent(qq, 12)?.map(turn => turn.content) ?? [];
    const checks = [
        { name: '手机完成一次性配对', passed: hello.accepted },
        { name: '手机收到 QQ 与 DSH 共享上下文', passed: reply?.includes('上下文连上了') === true },
        { name: '同 requestId 重试不重复调用 DSH', passed: replayReply === reply && calls === 1 },
        { name: '完整问答在进程重载后仍可读取', passed: afterRestart.includes('手机：我现在该拿什么？') && afterRestart.some(text => text.includes('上下文连上了')) },
    ];
    return { passed: checks.every(check => check.passed), checks, calls };
}
