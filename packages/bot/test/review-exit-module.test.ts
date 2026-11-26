import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReviewCtx, ReviewVerdict, Turn, TurnFacts } from '../src/interpreter/interpreter.ts';
import { crisisFallback, reviewCrisisReply, reviewReply, type ReviewOptions } from '../src/language/exit-check.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { crisisModule } from '../src/modules/crisis.ts';
import { intentModule } from '../src/modules/intent.ts';
import { reviewExitModule } from '../src/modules/review-exit.ts';
import { reviewFinalizeModule } from '../src/modules/review-finalize.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { parseDeviceTokens, type DeviceProposal } from '../src/platform/device-actions.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 出口检查 / 危机检查（ADR 0336「生成之后那一段」第 6 步；ADR 0014 / 0068）：只用合成数据、假模型
const turnWith = (facts: TurnFacts = {}): Turn => ({ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts });
const CRISIS = (level: 'concern' | 'high' | 'imminent' = 'high'): TurnFacts => ({ crisis: { match: '不想活了', level } });
const exit = reviewExitModule().reviewAt!.exit!;

type Ctx = ReviewCtx;

/** events 按先后记：重写（哪一份的 regenerate）、采用、不登记设备 */
function setup(rewrite: (note: string) => Promise<string> = async () => '好呀') {
    const events: string[] = [];
    const notes: string[] = [];
    const ctxLogs: string[] = [];
    const exitLogs: string[] = [];
    const ctx: Ctx = {
        regenerate: async () => { events.push('ctx.regenerate'); return '不该用 ctx 的重写'; },
        accept: () => { events.push('ctx.accept'); },
        dropDevices: () => { events.push('dropDevices'); },
        scratch: {},
        log: line => { ctxLogs.push(line); },
    };
    const exitOptions: ReviewOptions = {
        banned: ['秘密'], userName: '阿明',
        regenerate: note => { events.push('regenerate'); notes.push(note); return rewrite(note); },
        onRewriteAccepted: () => { events.push('accept'); },
        log: line => { exitLogs.push(line); },
    };
    ctx.scratch.exitOptions = exitOptions;
    return { ctx, exitOptions, events, notes, ctxLogs, exitLogs };
}

const verdict = (out: unknown): ReviewVerdict => {
    assert.equal(typeof out, 'object');
    return out as ReviewVerdict;
};

describe('出口检查模块（ADR 0336）', () => {
    test('只挂在 exit 这一个位置', () => {
        assert.deepEqual(Object.keys(reviewExitModule().reviewAt!), ['exit']);
    });

    test('平常回合、没问题：返回 promise（原来总是 await），原样，不重写、不停', async () => {
        const s = setup();
        const out = exit('好呀\n周末见', turnWith(), s.ctx);
        assert.ok(out instanceof Promise);
        assert.equal(await out, '好呀\n周末见');
        assert.deepEqual(s.events, []);
    });

    test('平常回合、有禁用词：用出口检查那一刻的上下文（scratch.exitOptions）重写一次、采用，不用 ctx 自己的', async () => {
        const s = setup(async () => '好呀');
        assert.equal(await exit('秘密\n好呀', turnWith(), s.ctx), '好呀');
        assert.deepEqual(s.events, ['regenerate', 'accept']);
        assert.match(s.notes[0]!, /提到了「秘密」/);
        assert.ok(s.exitLogs.includes('出口检查：重写后通过'), s.exitLogs.join('|'));
        assert.deepEqual(s.ctxLogs, []);
    });

    test('平常回合、重写后还有：删行（不停下，后面的审稿接着跑）', async () => {
        const s = setup(async () => '秘密\n嗯嗯');
        assert.equal(await exit('秘密\n好呀', turnWith(), s.ctx), '嗯嗯');
    });

    test('平常回合：照抄的「[B 站私信]」标记不重写，直接去掉', async () => {
        const s = setup();
        assert.equal(await exit('[B 站私信] 好呀', turnWith(), s.ctx), '好呀');
        assert.deepEqual(s.events, []);
    });

    test('平常回合：和直接调 reviewReply 逐字一样', async () => {
        for (const [draft, rewrite] of [['秘密\n好呀', '好呀'], ['秘密', '秘密'], ['好呀', '']] as const) {
            const a = setup(async () => rewrite);
            const b = setup(async () => rewrite);
            assert.equal(await exit(draft, turnWith(), a.ctx), await reviewReply(draft, b.exitOptions));
            assert.deepEqual(a.events, b.events);
            assert.deepEqual(a.exitLogs, b.exitLogs);
        }
    });

    test('危机回合：走危机检查（收尾的话重写一次），这一轮到此为止，草稿和重写里的设备指令都不登记', async () => {
        const s = setup(async () => '我在，你现在安全吗');
        const out = verdict(await exit('那你早点睡', turnWith(CRISIS()), s.ctx));
        assert.deepEqual(out, { text: '我在，你现在安全吗', stop: true });
        assert.match(s.notes[0]!, /「早点睡」是在收尾/);
        // 采用了重写（设备指令先换成重写稿的），然后整轮都不登记
        assert.deepEqual(s.events, ['regenerate', 'accept', 'dropDevices']);
    });

    test('危机回合、重写还不过：按这一轮的危机级别发固定兜底，停下、不登记设备', async () => {
        for (const level of ['concern', 'high', 'imminent'] as const) {
            const s = setup(async () => '别想太多，去睡吧');
            const out = verdict(await exit('别想太多', turnWith(CRISIS(level)), s.ctx));
            assert.deepEqual(out, { text: crisisFallback(level), stop: true });
            assert.equal(s.events.at(-1), 'dropDevices');
        }
    });

    test('危机回合、本来就没问题：原样，也停下、也不登记设备（原来危机回合总是清掉设备指令）', async () => {
        const s = setup();
        const out = verdict(await exit('我在听\n你现在安全吗', turnWith(CRISIS()), s.ctx));
        assert.deepEqual(out, { text: '我在听\n你现在安全吗', stop: true });
        assert.deepEqual(s.events, ['dropDevices']);
    });

    test('危机回合、草稿是空的（只写了设备指令）：发兜底', async () => {
        const s = setup();
        assert.deepEqual(verdict(await exit('', turnWith(CRISIS('imminent')), s.ctx)), { text: crisisFallback('imminent'), stop: true });
        assert.deepEqual(s.events, ['dropDevices']);
    });

    test('危机回合：和直接调 reviewCrisisReply 逐字一样', async () => {
        for (const [draft, rewrite] of [['那你早点睡', '我在'], ['别想太多', '晚安'], ['我在听', '']] as const) {
            const a = setup(async () => rewrite);
            const b = setup(async () => rewrite);
            const out = verdict(await exit(draft, turnWith(CRISIS('concern')), a.ctx));
            assert.equal(out.text, await reviewCrisisReply(draft, b.exitOptions, 'concern'));
            assert.deepEqual(a.events.filter(e => e !== 'dropDevices'), b.events);
            assert.deepEqual(a.exitLogs, b.exitLogs);
        }
    });

    test('scratch 里没有出口检查的上下文（接线漏了）：平常回合原样放过、记一句；危机回合发兜底、停下、不登记设备', async () => {
        const normal = setup();
        delete normal.ctx.scratch.exitOptions;
        assert.equal(exit('秘密\n好呀', turnWith(), normal.ctx), '秘密\n好呀');
        assert.equal(normal.ctxLogs.length, 1);
        assert.match(normal.ctxLogs[0]!, /出口检查/);
        const crisis = setup();
        delete crisis.ctx.scratch.exitOptions;
        assert.deepEqual(exit('那你早点睡', turnWith(CRISIS()), crisis.ctx), { text: crisisFallback('high'), stop: true });
        assert.deepEqual(crisis.events, ['dropDevices']);
    });
});

describe('联系人流水线里的出口检查', () => {
    const NOW = Date.parse('2026-11-05T12:00:00+08:00');
    const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };

    function contact(generate: (call: number) => string) {
        const rows: StoredMessage[] = [];
        const sent: string[] = [];
        const committed: DeviceProposal[] = [];
        let calls = 0;
        const responder = createContactResponder({
            contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
            card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { qqbot: { banned: ['秘密'] } } } }), worldInfo: [] }, llm,
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            turnModules: [crisisModule({ log: () => {} }), intentModule(), reviewExitModule(), reviewFinalizeModule()],
            send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
            generate: async () => generate(++calls),
            devices: {
                parse: text => parseDeviceTokens(text, { links: new Map(), apps: [], maxVolume: 50 }),
                commit: parsed => committed.push(...parsed.proposals),
            },
        });
        return {
            sent, committed, calls: () => calls,
            async run(text: string) {
                try { responder.receive(text, 1, new Date(NOW)); await responder.whenIdle(); } finally { responder.stop(); }
            },
        };
    }

    // 接线前（旧逻辑 + 模块）也通过：旧逻辑已经重写过，模块再查一遍是干净的
    // 不挂这个模块时删行收尾只删掉「秘密」那一行、发「嗯嗯」并登记原稿的设备指令（只调一次模型）：这条测试分得清
    test('禁用词：重写一次，发重写稿；采用的重写不带设备指令，原稿的也不登记', async () => {
        const fixture = contact(call => (call === 1 ? '秘密\n嗯嗯\n<device:ring>' : '好呀'));
        await fixture.run('今天心情不错');
        assert.equal(fixture.calls(), 2);
        assert.deepEqual(fixture.sent, ['好呀']);
        assert.deepEqual(fixture.committed, []);
    });

    // 接线前跑不了：旧逻辑的 ReviewCtx 还没有 dropDevices（模块调它会抛错）
    test('危机回合：收尾的话重写一次；重写稿里的设备指令也不登记；后面的审稿不跑', async () => {
        const fixture = contact(call => (call === 1 ? '那你早点睡' : '我在，你现在安全吗\n<device:ring>'));
        await fixture.run('我不想活了，真的撑不下去了');
        assert.equal(fixture.calls(), 2);
        assert.deepEqual(fixture.sent, ['我在，你现在安全吗']);
        assert.deepEqual(fixture.committed, []);
    });
});

describe('出口检查的上下文自己算（exitOptionsOf，2026-11-16）', async () => {
    const { exitOptionsOf } = await import('../src/modules/review-exit.ts');
    const { ODD_BODY_WORDS, STILTED_WORDS } = await import('../src/language/expression.ts');
    const card = parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { qqbot: { banned: ['秘密'] } } } });
    const ctxOf = (extra: Partial<ReviewCtx> = {}) => {
        const reads: number[] = [];
        const ctx: ReviewCtx = {
            regenerate: async () => '重写', accept: () => {}, dropDevices: () => {}, scratch: {}, log: () => {},
            exit: { speechCheck: false, imageStickers: false },
            history: () => { reads.push(1); return [] as StoredMessage[]; },
            ...extra,
        };
        return { ctx, reads };
    };
    const turnOf = (facts: TurnFacts = {}): Turn => ({ ...turnWith(facts), card });

    test('不经联系人流水线（没有 ctx.exit）：不算', () => {
        const { ctx } = ctxOf();
        delete ctx.exit;
        assert.equal(exitOptionsOf(turnOf(), ctx), undefined);
    });

    test('禁用词是卡上的加医书里的词、书面腔；他的名字；重写 / 采用 / 日志就是 ctx 的', () => {
        const { ctx, reads } = ctxOf();
        const options = exitOptionsOf(turnOf(), ctx)!;
        assert.deepEqual(options.banned, ['秘密', ...ODD_BODY_WORDS, ...STILTED_WORDS]);
        assert.equal(options.userName, '阿明');
        assert.equal(options.regenerate, ctx.regenerate);
        assert.equal(options.onRewriteAccepted, ctx.accept);
        assert.equal(options.log, ctx.log);
        assert.equal(options.speech, undefined, '没开 speechCheck 不查说话的毛病');
        assert.ok(options.faces, '小黄脸总是查');
        assert.equal(reads.length, 1, '没开 speechCheck 时聊天记录只为小黄脸读一次');
        assert.equal(options.textIntimacy, undefined);
        assert.equal(options.imageStickers, undefined);
        assert.equal(options.books, undefined);
    });

    test('开了 speechCheck：聊天记录读两次（说话的毛病、小黄脸）；小别扭生效放过带点抱怨的话，固定说法放过重复', () => {
        const plain = ctxOf({ exit: { speechCheck: true, imageStickers: false } });
        const options = exitOptionsOf(turnOf(), plain.ctx)!;
        assert.ok(options.speech);
        assert.equal(plain.reads.length, 2);
        assert.equal(options.speech.allowGrievance, undefined);
        assert.equal(options.speech.allowRepeat, undefined);
        const sulk = exitOptionsOf(turnOf({ sulk: true }), ctxOf({ exit: { speechCheck: true, imageStickers: false }, allowRepeat: true }).ctx)!;
        assert.equal(sulk.speech!.allowGrievance, true);
        assert.equal(sulk.speech!.allowRepeat, true);
    });

    test('文字抱抱看最终的意图；图片表情看这个联系人有没有收藏库；在读的书的进度来自这一轮放的书', () => {
        const books = { context: { marker: '进度' } } as unknown as NonNullable<TurnFacts['books']>;
        const options = exitOptionsOf(turnOf({ intent: '[这一轮你想：他要 QQ 文字里的抱抱，给他]', books }), ctxOf({ exit: { speechCheck: false, imageStickers: true } }).ctx)!;
        assert.equal(options.textIntimacy, true);
        assert.equal(options.imageStickers, true);
        assert.equal(options.books, books.context);
    });

    test('模块在 exit 位置算好写进 scratch（删行收尾用同一份）；已经有人放好的不重算', async () => {
        const { ctx } = ctxOf();
        await exit('好呀', turnOf(), ctx);
        assert.ok(ctx.scratch.exitOptions, '算好了');
        const seeded = ctxOf();
        const mine = { ...exitOptionsOf(turnOf(), seeded.ctx)!, banned: ['只有这个'] };
        seeded.ctx.scratch.exitOptions = mine;
        await exit('好呀', turnOf(), seeded.ctx);
        assert.equal(seeded.ctx.scratch.exitOptions, mine);
    });
});
