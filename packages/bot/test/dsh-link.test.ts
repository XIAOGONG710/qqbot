import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDshLink, dshOptionsFromLlm, sanitizeDshQuestion, type DshState } from '../src/dsh-link.ts';
import { createMobileCompanion, createMobileDshHandlers } from '../src/mobile-companion-dsh.ts';
import { helloEnvelope } from '@qqbot/mobile-companion/gateway';
import type { LlmOptions } from '../src/llm.ts';

const options: LlmOptions = {
    baseUrl: 'https://dsh.example', model: 'dsh-model', apiKey: 'secret', temperature: 1, maxTokens: 300, timeoutMs: 1000, extraBody: {},
};
const response = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));

describe('DSH 连接层', () => {
    test('独立 DSH 配置只覆盖地址、模型和超时，不复制或暴露密钥', () => {
        const overridden = dshOptionsFromLlm(options, { baseUrl: 'https://advisor.example/v1', model: 'advisor-model', timeoutMs: 2_500 });
        assert.deepEqual(overridden, { ...options, baseUrl: 'https://advisor.example/v1', model: 'advisor-model', timeoutMs: 2_500 });
        assert.equal(overridden.apiKey, 'secret');
        assert.deepEqual(dshOptionsFromLlm(options), options);
    });

    test('问题先脱敏、压缩并限制长度', () => {
        const text = sanitizeDshQuestion('QQ: 123456789，api_key=sk-abc123   看看她的状态');
        assert.equal(text, 'QQ=<redacted>，api_key=<redacted> 看看她的状态');
        assert.equal(sanitizeDshQuestion('请看 https://example.test/?api_key=sk-url&access_token=access-value&token=secret-value&ok=1'), '请看 https://example.test/?api_key=<redacted>&access_token=<redacted>&token=<redacted>&ok=1');
        assert.equal(sanitizeDshQuestion('   '), '');
        assert.ok(sanitizeDshQuestion('x'.repeat(3000)).length <= 2000);
    });

    test('探针使用独立的最小请求，只接受 OK', async () => {
        const bodies: Record<string, unknown>[] = [];
        const link = createDshLink(options, {
            now: (() => { let value = 1000; return () => value += 25; })(),
            fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return response('OK'); },
            sleep: async () => {},
        });
        const result = await link.probe();
        assert.equal(result.ok, true);
        assert.equal(result.model, 'dsh-model');
        assert.equal((bodies[0]!.messages as unknown[]).length, 2);
        assert.equal(bodies[0]!.max_tokens, 8);
    });

    test('咨询只发送脱敏状态摘要，不发送聊天原文或身份标识', async () => {
        let body: Record<string, unknown> | undefined;
        const state: DshState = { at: '2026-11-03T00:00:00.000Z', tier: 'boyfriend', values: { energy: 40, hunger: 70, stress: 20, mood: 60, health: 90, loneliness: 10, motivation: 55, boredom: 30, socialBattery: 50 }, recentEvents: ['meal', 'rest'] };
        const link = createDshLink(options, {
            fetch: async (_url, init) => { body = JSON.parse(init.body); return response('建议一'); },
            sleep: async () => {},
        });
        assert.equal(await link.advise({ question: '现在该如何安排下一步？QQ 123456', state }), '建议一');
        const prompt = String((body!.messages as { content: string }[])[1]!.content);
        assert.match(prompt, /hunger=70/);
        assert.match(prompt, /QQ=<redacted>/);
        assert.doesNotMatch(prompt, /123456/);
        assert.doesNotMatch(prompt, /聊天原文/);
    });

    test('显式 QQ 咨询会带有限连续上下文，并要求沿用她的语气', async () => {
        let body: Record<string, unknown> | undefined;
        const link = createDshLink(options, {
            fetch: async (_url, init) => { body = JSON.parse(init.body); return response('你先去吃点东西嘛'); },
            sleep: async () => {},
        });
        const reply = await link.advise({
            question: '那我现在该做什么？',
            recentTurns: [
                { role: 'user', content: '我今天一直没吃饭' },
                { role: 'assistant', content: '那你先别硬撑' },
                { role: 'user', content: 'QQ: 123456789' },
            ],
            voice: { name: '林梦瑶', personality: '说话自然，偶尔带一点撒娇，不写长报告' },
        });
        assert.equal(reply, '你先去吃点东西嘛');
        const prompt = String((body!.messages as { content: string }[])[1]!.content);
        assert.match(prompt, /最近 QQ 对话/);
        assert.match(prompt, /他：我今天一直没吃饭/);
        assert.match(prompt, /性格和说话方式/);
        assert.match(prompt, /自然，偶尔带一点撒娇/);
        assert.doesNotMatch(prompt, /123456789/);
        assert.doesNotMatch(prompt, /分析报告/);
    });

    test('手机伴侣复用 bot 的 DSH 状态和语气适配器', async () => {
        const calls: Array<{ question: string; state?: DshState; voice?: { name?: string }; recentTurns?: readonly { role: string; content: string }[] }> = [];
        const handlers = createMobileDshHandlers({
            dsh: { advise: async request => { calls.push(request); return '你先歇一会儿，我在呢'; } },
            state: () => ({ at: '2026-11-03T00:00:00.000Z', values: { energy: 40, hunger: 70, stress: 20, mood: 60, health: 90, loneliness: 10, motivation: 55, boredom: 30, socialBattery: 50 } }),
            voice: () => ({ name: '林梦瑶', personality: '自然一点' }),
        });
        const first = await handlers.onMessage({ kind: 'text', text: '我今天有点累' }, 'android-123456');
        const second = await handlers.onMessage({ kind: 'text', text: '还在吗' }, 'android-123456');
        assert.equal(first.text, '你先歇一会儿，我在呢');
        assert.equal(second.text, '你先歇一会儿，我在呢');
        assert.equal(calls[0]?.voice?.name, '林梦瑶');
        assert.equal(calls[1]?.recentTurns?.length, 2);
        assert.equal(calls[0]?.state?.values?.hunger, 70);
    });

    test('bot 工厂把配对、网关和 DSH 运行时连成一条链', async () => {
        let now = 1000;
        const integration = createMobileCompanion({
            dsh: { advise: async request => `回：${request.question}` },
            now: () => now,
        });
        const ticket = integration.issuePairing('android-bot', now);
        const hello = await integration.runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-bot-hello', 'nonce-bot-hello', new Date(now).toISOString()));
        assert.equal(hello.accepted, true);
        now += 1;
        const response = await integration.runtime.handle({ v: 1, requestId: 'req-bot-msg', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-bot-msg', body: { kind: 'text', text: '在吗' } });
        assert.equal(response.accepted, true);
        if (response.accepted) assert.equal((response.response?.body as { text?: string }).text, '回：在吗');
    });
});
