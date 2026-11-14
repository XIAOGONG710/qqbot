import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { contextSummarizer, SUMMARY_RETRY_MS } from '../src/language/context-window.ts';
import { crisisFallback, inspectReply, reviewCrisisReply } from '../src/language/exit-check.ts';
import { asksToExplain, lengthHint } from '../src/language/expression.ts';
import { auditMessages, dropClaimLines, parseClaims } from '../src/language/fact-check.ts';
import { refreshIdioms, type IdiomState } from '../src/language/idioms.ts';
import { refreshJokes, type JokeState } from '../src/language/jokes.ts';
import { chatCompletion, completionMaxTokens, ModelUnreachable, type LlmOptions } from '../src/language/llm.ts';
import { ModelGuard } from '../src/language/model-guard.ts';
import { buildPrompt, type OpenAIMessage } from '../src/language/prompt.ts';
import { planShape } from '../src/language/shape.ts';
import { applyTexture } from '../src/language/texture.ts';
import { togetherNow } from '../src/language/together.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { deliberateLlm } from '../src/platform/config.ts';
import { createContactResponder, type ContactPipelineOptions } from '../src/platform/contact.ts';
import { intentModule } from '../src/modules/intent.ts';
import { parseDeviceTokens, type DeviceProposal } from '../src/platform/device-actions.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// ADR 0321。全部使用合成聊天、假模型/网络/设备，不访问真实运行数据。
const NOW = Date.parse('2026-11-05T12:00:00+08:00');
const DAY = 86_400_000;
const quiet = () => {};
const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };
const character = () => parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { qqbot: { banned: ['秘密'] } } } });

function contact(overrides: Partial<ContactPipelineOptions> = {}) {
    const rows: StoredMessage[] = [];
    const sent: string[] = [];
    const committed: DeviceProposal[] = [];
    const prompts: OpenAIMessage[][] = [];
    const responder = createContactResponder({
        contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
        card: { character: character(), worldInfo: [] }, llm,
        prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
        history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
        now: () => NOW, log: quiet, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
        // 意图阶梯是解释器的模块（ADR 0336），App 总是挂着它；深思按意图判断
        turnModules: [intentModule()],
        send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
        generate: async () => '好呀',
        devices: {
            parse: text => parseDeviceTokens(text, { links: new Map(), apps: [], maxVolume: 50 }),
            commit: parsed => committed.push(...parsed.proposals),
        },
        onPrompt: prompt => { prompts.push(prompt.messages); },
        ...overrides,
    });
    return {
        sent, committed, prompts, rows,
        async run(text = '今天心情不错') {
            try { responder.receive(text, 1, new Date(NOW)); await responder.whenIdle(); }
            finally { responder.stop(); }
        },
    };
}

describe('最终草稿、硬规则与设备动作', () => {
    for (const stage of ['shape', 'unfinished'] as const) {
        test(`${stage} 重写加入禁用词仍被最终检查拦截`, async () => {
            let calls = 0;
            const fixture = contact({
                // ADR 0220 之后形状控制只在 shapeAll / 有提示 / 特定意图时生效：这里要它生效
                ...(stage === 'shape' ? { shape: true, shapeAll: true } : { speechCheck: true }),
                generate: async () => {
                    calls++;
                    if (calls === 1) return stage === 'shape' ? '今天我有好多好多好多事情想跟你说'.repeat(10) : '我知道了\n不过你别得意';
                    return calls === 2 ? '秘密\n好呀' : '好呀';
                },
            });
            await fixture.run();
            assert.ok(calls >= 2);
            assert.ok(fixture.sent.length > 0);
            assert.ok(fixture.sent.every(text => !text.includes('秘密')));
        });
    }

    test('空重写被弃用时，不提交其中的设备动作；选中非空重写时正常提交', async () => {
        for (const accepted of [false, true]) {
            let calls = 0;
            const fixture = contact({ speechCheck: true, generate: async () => ++calls === 1 ? '我知道了\n不过你别得意' : `${accepted ? '好呀\n' : ''}<device:ring>` });
            await fixture.run();
            assert.equal(calls, 2);
            assert.ok(fixture.sent.length > 0);
            assert.deepEqual(fixture.committed.map(p => p.action), accepted ? ['ring'] : []);
        }
    });

    test('出口检查自己接受的重写也绑定自己的设备动作', async () => {
        let calls = 0;
        const fixture = contact({ generate: async () => ++calls === 1 ? '秘密\n<device:ring>' : '好呀' });
        await fixture.run();
        assert.equal(calls, 2);
        assert.deepEqual(fixture.committed, []);
        assert.deepEqual(fixture.sent, ['好呀']);
    });

    test('末次事实检查只删行，不再次重写；新事实不会因后续重写漏查', async () => {
        let calls = 0;
        let audits = 0;
        const fixture = contact({
            speechCheck: true, factCheck: 'fix',
            generate: async () => ++calls === 1 ? '我知道你在说什么了\n不过你别得意' : '猫刚跑到楼下去了\n我知道你在说什么了',
            factAudit: async messages => {
                audits++;
                return messages[1]!.content.includes('猫刚跑到楼下去了') ? JSON.stringify([{ quote: '猫刚跑到楼下去了', kind: 'invented', why: '没有依据' }]) : '[]';
            },
        });
        await fixture.run();
        assert.equal(calls, 2);
        assert.equal(audits, 2);
        assert.ok(fixture.sent.length > 0 && fixture.sent.every(text => !text.includes('猫')));
    });
});

describe('危机空回复和媒体承诺', () => {
    const options = { banned: ['秘密'], userName: '小明', regenerate: async () => '秘密', log: quiet };
    test('空白、被删光的危机回复都立即返回对应级别兜底', async () => {
        for (const level of ['concern', 'high', 'imminent'] as const) {
            for (const reply of ['', '  ', '秘密']) assert.equal(await reviewCrisisReply(reply, options, level), crisisFallback(level));
        }
    });
    test('危机空正文只生成一次；兜底不提交原稿动作', async () => {
        let calls = 0;
        const fixture = contact({ generate: async () => { calls++; return '<device:ring>'; } });
        await fixture.run('我不想活了，真的撑不下去了');
        assert.equal(calls, 1);
        assert.ok(fixture.sent.length > 0);
        assert.deepEqual(fixture.committed, []);
    });
    test('照片和表情包只能豁免对应承诺，不能放过电话、语音、视频、红包', () => {
        for (const text of ['我给你发语音', '我给你发视频', '我打个电话', '我发个红包']) {
            assert.ok(inspectReply(`${text}\n<photo:0123456789ab>`, []).some(i => i.kind === 'promise'), text);
            assert.ok(inspectReply(`${text}还有表情包`, [], undefined, undefined, undefined, false, true).some(i => i.kind === 'promise'), text);
        }
        assert.ok(inspectReply('发你看看\n<photo:0123456789ab>', []).every(i => i.kind !== 'promise'));
        assert.ok(inspectReply('给你发表情包', [], undefined, undefined, undefined, false, true).every(i => i.kind !== 'promise'));
        assert.ok(inspectReply('发你看看，然后打个电话\n<photo:0123456789ab>', []).some(i => i.kind === 'promise'));
    });
});

describe('网络与熔断边界', () => {
    test('排队期间熔断后，后台任务一个也不启动；半开探路成功后恢复', async () => {
        let release!: () => void;
        let now = NOW;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const guard = new ModelGuard({ concurrent: 1, backgroundConcurrent: 1, breakerFailures: 1, breakerOpenMs: 1000, now: () => now });
        const first = guard.run('chat', async () => { await hold; throw new ModelUnreachable('down'); }, e => e instanceof ModelUnreachable);
        let starts = 0;
        const jobs = [first, ...[1, 2, 3].map(() => guard.run('background', async () => { starts++; }, e => e instanceof ModelUnreachable))];
        const done = Promise.allSettled(jobs);
        release();
        assert.ok((await done).every(result => result.status === 'rejected'));
        assert.equal(starts, 0);
        assert.equal(guard.status().active, 0);
        assert.equal(guard.status().callsToday, 4, '启动时复核没有重复扣额度');
        now += 1001;
        assert.equal(await guard.run('background', async () => 'up'), 'up');
        assert.equal(guard.status().breakerOpen, false);
    });
    test('读取正文时的超时、断线也归为不可达并参与熔断', async () => {
        for (const error of [new DOMException('body timeout', 'TimeoutError'), new TypeError('terminated', { cause: { code: 'ECONNRESET' } })]) {
            const guard = new ModelGuard({ breakerFailures: 1 });
            await assert.rejects(chatCompletion(llm, [], {
                guard, fetch: async () => ({ ok: true, status: 200, text: async () => { throw error; } }),
            }), e => e instanceof ModelUnreachable && e.cause === error);
            assert.equal(guard.status().breakerOpen, true);
        }
    });
});

describe('摘要异常不会丢原文或产生后台未处理拒绝', () => {
    const older = [{ role: 'user' as const, content: '周三下午两点面试', time: new Date(NOW).toISOString() }];
    test('空、无关文本、编号列表保持未就绪；到重试时间后有效摘要恢复', async () => {
        for (const invalid of ['', '请重新尝试生成摘要', '1. 周三面试']) {
            let now = NOW;
            let calls = 0;
            const summarize = contextSummarizer({ names: { user: '小明', char: '小红' }, now: () => now, log: quiet, generate: async () => ++calls === 1 ? invalid : '- 周三面试' });
            summarize(older); await summarize.idle();
            assert.deepEqual(summarize(older), { ready: false });
            assert.equal(calls, 1);
            now += SUMMARY_RETRY_MS;
            summarize(older); await summarize.idle();
            const result = summarize(older);
            assert.equal(result.ready, true);
            assert.ok(result.ready && result.text?.includes('周三面试'));
        }
    });
    test('明确无事实才允许缓存为空；同步生成异常和写盘异常都被捕获', async () => {
        const empty = contextSummarizer({ names: { user: '小明', char: '小红' }, log: quiet, generate: async () => '- 无' });
        empty(older); await empty.idle();
        assert.deepEqual(empty(older), { ready: true, text: undefined });
        const failures = [
            contextSummarizer({ names: { user: '小明', char: '小红' }, log: quiet, generate: () => { throw new Error('sync'); } }),
            contextSummarizer({ names: { user: '小明', char: '小红' }, log: quiet, file: join(import.meta.dirname, `missing-${process.pid}`, 'summary.json'), generate: async () => '- 周三面试' }),
        ];
        for (const summarize of failures) {
            summarize(older);
            await assert.doesNotReject(summarize.idle());
            assert.deepEqual(summarize(older), { ready: false });
        }
    });
});

describe('滑动窗口按新消息游标刷新，兼容旧状态', () => {
    const history = Array.from({ length: 90 }, (_, i): StoredMessage => ({ role: 'user', content: `今天开心第${i}句`, time: new Date(NOW - (90 - i) * DAY / 10).toISOString() }));
    test('窗口条数不变但有足够新消息，小梗和口头习惯仍刷新', async () => {
        let joke: JokeState = { version: 1, jokes: [] };
        let idiom: IdiomState = { version: 1, items: [] };
        let calls = 0;
        const extract = async () => { calls++; return '[]'; };
        const run = async (rows: StoredMessage[], now: number) => {
            const base = { qq: 1, userName: '小明', charName: '小红', now, history: rows, log: quiet, extract };
            return [
                await refreshJokes({ ...base, store: { load: () => joke, save: (_qq, value) => { joke = value; } } }),
                await refreshIdioms({ ...base, blocked: [], store: { load: () => idiom, save: (_qq, value) => { idiom = value; } } }),
            ];
        };
        assert.deepEqual(await run(history, NOW), [true, true]);
        assert.deepEqual(await run(history, NOW + DAY), [false, false]);
        const next = [...history.slice(25), ...Array.from({ length: 25 }, (_, i) => ({ ...history[i]!, content: `新消息${i}`, time: new Date(NOW + (i + 1) * 60_000).toISOString() }))];
        assert.equal(next.length, history.length);
        assert.deepEqual(await run(next, NOW + DAY), [true, true]);
        assert.equal(calls, 4);
        assert.match(joke.messageCursor!, /^[a-f0-9]{64}$/);
        assert.match(idiom.messageCursor!, /^[a-f0-9]{64}$/);
        delete joke.messageCursor; delete idiom.messageCursor;
        assert.deepEqual(await run(next, NOW + 2 * DAY), [false, false], '旧状态沿用更新时间作迁移边界');
    });
});

describe('语境、形状与事实边界', () => {
    test('普通邀约不产生游戏状态，明确游戏邀约仍正常', () => {
        const history = (text: string): StoredMessage[] => [
            { role: 'assistant', content: text, time: new Date(NOW - 120000).toISOString() },
            { role: 'user', content: '好呀', time: new Date(NOW - 60000).toISOString() },
        ];
        for (const text of ['要不要喝杯奶茶', '有空不，一起吃饭', '来不来吃饭']) assert.equal(togetherNow(history(text), NOW), undefined);
        assert.equal(togetherNow(history('王者开黑吗'), NOW)?.activity, 'wzry');
    });
    test('连发中的详细请求保留，后续明确撤销则取消', () => {
        const history = [{ role: 'user' as const, content: '帮我详细解释一下梯度下降' }, { role: 'user' as const, content: '谢谢你' }];
        assert.equal(planShape({ history }), undefined);
        assert.equal(lengthHint({ history }), 'long');
        assert.equal(asksToExplain('详细解释一下\n不用解释了'), false);
        assert.equal(asksToExplain('不用解释了\n还是详细讲讲吧'), true);
    });
    test('陈述和否定句不会被质感层改成问句，真正问句仍可补问号', () => {
        let questions = 0;
        for (let i = 0; i < 100; i++) {
            const context = { seed: String(i), serious: false, recentFaces: 0, maxBubbles: 1 };
            for (const text of ['我没什么想说的', '不知道为什么', '你怎么都行', '谁也没来']) assert.ok(!applyTexture([text], context).parts[0]!.endsWith('？'), text);
            if (applyTexture(['你今晚吃什么'], context).parts[0]!.endsWith('？')) questions++;
        }
        assert.ok(questions > 0);
    });
    test('示例对话不进事实证据，真实历史仍保留；跨行证据删除覆盖行', () => {
        const example = '上周我和你去海边看了日出，然后一起吃早饭，还拍了许多照片';
        const audit = auditMessages([{ role: 'system', name: 'example_assistant', content: example }, { role: 'user', content: '我在家' }], '猫跑来了', { user: '小明', char: '小红' });
        assert.ok(!audit[1]!.content.includes(example));
        assert.ok(audit[1]!.content.includes('小明：我在家'));
        const reply = '猫跑过来了\n又跑到楼下了\n我在听';
        const claims = parseClaims(JSON.stringify([{ quote: '猫跑过来了\n又跑到楼下了', kind: 'invented' }]), reply);
        assert.equal(dropClaimLines(reply, claims), '我在听');
    });
});

describe('当前消息与实际模型预算', () => {
    test('放不下最新消息或固定内容时明确返回兜底，不生成无问题提示词', () => {
        const build = (afterHistory: string[] = []) => buildPrompt({ character: character(), worldInfo: [], history: [{ role: 'user', content: '问题'.repeat(1000) }], userName: '小明', afterHistory, settings: { maxContext: 1024, maxTokens: 300, worldInfo: DEFAULT_WORLD_INFO_SETTINGS }, countTokens: text => [...text].length });
        for (const result of [build(), build(['事实'.repeat(1000)])]) {
            assert.ok(result.fallbackReply);
            assert.deepEqual(result.messages, []);
        }
    });
    test('置顶示例也必须给最新用户问题留位置', () => {
        const card = { ...character(), mesExample: '<START>\n{{user}}: 你好\n{{char}}: ' + '示例'.repeat(50) };
        const question = '问题'.repeat(75);
        const result = buildPrompt({ character: card, worldInfo: [], history: [{ role: 'user', content: question }], userName: '小明', settings: { maxContext: 300, maxTokens: 10, pinExamples: true, worldInfo: DEFAULT_WORLD_INFO_SETTINGS }, countTokens: text => [...text].length });
        assert.equal(result.fallbackReply, undefined);
        assert.ok(result.messages.some(message => message.role === 'user' && message.content === question));
    });
    test('超长输入直接回复分段提示，实际模型调用为零', async () => {
        let calls = 0;
        const fixture = contact({ generate: async () => { calls++; return '不会调用'; } });
        await fixture.run('长消息'.repeat(10000));
        assert.equal(calls, 0);
        assert.ok(fixture.sent.some(text => text.includes('分几段')));
        assert.deepEqual(fixture.committed, []);
    });
    test('深思和 extraBody 覆盖使用实际输出上限预留', async () => {
        const pro = deliberateLlm(llm, 'fake-pro');
        assert.equal(completionMaxTokens(pro), 4000);
        assert.equal(completionMaxTokens({ ...pro, extraBody: { max_tokens: 5000 } }), 5000);
        for (const extraBody of [{}, { max_tokens: 7000 }]) {
            let used: LlmOptions | undefined;
            const fixture = contact({
                deliberate: { llm: { ...pro, extraBody } },
                generate: async (_messages, _log, actual) => { used = actual; return '好呀'; },
            });
            fixture.rows.push(...Array.from({ length: 100 }, (_, i): StoredMessage => ({
                role: i % 2 ? 'assistant' : 'user', content: '普通聊天内容'.repeat(20),
                time: new Date(NOW - (100 - i) * 60_000).toISOString(), messageId: 1000 + i,
            })));
            await fixture.run('你觉得我该不该去北京实习？');
            assert.equal(used?.model, 'fake-pro');
            const input = fixture.prompts[0]!.reduce((sum, message) => sum + Math.ceil(Buffer.byteLength(message.content) / 3.35) + Math.ceil(Buffer.byteLength(message.role) / 3.35), 0);
            assert.ok(input > 500, '带足够多的历史，确实触达输入截断边界');
            assert.ok(input + completionMaxTokens(used!) <= 8192);
        }
    });
});
