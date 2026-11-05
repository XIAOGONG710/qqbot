import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { ChatHistory } from '../src/memory/history.ts';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }
async function until(check: () => boolean, label: string) {
    const deadline = Date.now() + 3000;
    while (!check()) { assert.ok(Date.now() < deadline, `合成${label}检查点超时`); await tick(); }
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

const schedule = {
    sleep: '23:30', wake: { early: '07:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:00' } },
    semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['合成上午'], afternoon: ['合成下午'], evening: ['合成晚上'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点',
};

function writeCards(root: string): void {
    const card = { spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule } } } };
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify(card));
}

async function typingFixture(mode: 'success' | 'failure' | 'reentrant' | 'throw') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-typing-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir); writeCards(root);
    const oldFetch = globalThis.fetch, held = deferred(), logs: string[] = [];
    let app: App | undefined, calls = 0, settledAction = false, leaseInside: boolean | undefined, stopInside: Promise<void> | undefined;
    let now = Date.parse('2026-11-05T12:00:00+08:00');
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], typingStatus: true, jokes: false, idioms: false,
        schedule: true, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { held.resolve(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-typing-owner-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => 900, setInputStatus: () => {
                calls++;
                if (mode === 'reentrant' || mode === 'throw') { stopInside = Promise.resolve(app!.stop()); leaseInside = existsSync(join(dataDir, 'bot.lock')); }
                if (mode === 'throw') throw new Error('SYNTHETIC_TYPING_SYNC_THROW');
                return held.promise.then(() => { settledAction = true; if (mode === 'failure') throw new Error('SYNTHETIC_TYPING_FAILURE'); });
            } },
            pipeline: { now: () => now, waitUntil: async at => { now = at; }, settle: { quietMs: 0, maxMs: 0 }, generate: async () => '这是一条足够长的合成回应，用来稳定触发正在输入状态。' },
        });
        await app.connected(20000);
    } catch (error) { await cleanup(); throw error; }
    const owner = app;
    return { app: owner, dataDir, logs, held, calls: () => calls, settled: () => settledAction, leaseInside: () => leaseInside, stopInside: () => stopInside,
        receive() { owner.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1, real_seq: '100001', time: now / 1000, raw_message: '合成消息', sender: { user_id: 10001 }, message: '合成消息' }); }, cleanup };
}

for (const mode of ['success', 'failure'] as const) test(`已派正在输入${mode === 'success' ? '成功' : '失败'}确认前App不释放租约`, async () => {
    const f = await typingFixture(mode);
    try {
        f.receive(); await until(() => f.calls() === 1, '正在输入'); let stopped = false; const drain = Promise.resolve(f.app.stop()).then(() => { stopped = true; }); await settle();
        assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); f.held.resolve(); await drain;
        assert.equal(f.settled(), true); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        assert.equal(f.logs.some(line => line.includes('显示「正在输入」失败')), mode === 'failure');
    } finally { await f.cleanup(); }
});

for (const mode of ['reentrant', 'throw'] as const) test(`正在输入transport同步stop${mode === 'throw' ? '并throw' : ''}仍预登记本次收尾`, async () => {
    const f = await typingFixture(mode);
    try {
        f.receive(); await until(() => f.calls() === 1, '正在输入'); assert.equal(f.leaseInside(), true); f.held.resolve(); await f.stopInside();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.logs.some(line => line.includes('SYNTHETIC_TYPING_SYNC_THROW')), mode === 'throw');
    } finally { await f.cleanup(); }
});

async function reactionFixture(mode: 'success' | 'failure' | 'reentrant' | 'throw') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-reaction-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir); writeCards(root);
    const oldFetch = globalThis.fetch, held = deferred(), logs: string[] = [], calls: Array<{ messageId: number; emojiId: number }> = [];
    const now = Date.parse('2026-11-05T15:00:00+08:00');
    let app: App | undefined, settledAction = false, leaseInside: boolean | undefined, stopInside: Promise<void> | undefined;
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], schedule: true, reactions: true, jokes: false, idioms: false,
        moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const history = new ChatHistory(dataDir);
    history.append(10001, { time: new Date(now - 300_000).toISOString(), role: 'user', content: '我要睡了', messageId: 11 });
    history.append(10001, { time: new Date(now - 240_000).toISOString(), role: 'assistant', content: '晚安啦', messageId: 12 });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { held.resolve(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-reaction-owner-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => { throw new Error('no text reply expected'); }, reactMessage: (messageId, emojiId) => {
                calls.push({ messageId, emojiId });
                if (mode === 'reentrant' || mode === 'throw') { stopInside = Promise.resolve(app!.stop()); leaseInside = existsSync(join(dataDir, 'bot.lock')); }
                if (mode === 'throw') throw new Error('SYNTHETIC_REACTION_SYNC_THROW');
                return held.promise.then(() => { settledAction = true; if (mode === 'failure') throw new Error('SYNTHETIC_REACTION_FAILURE'); });
            } },
            pipeline: { now: () => now, settle: { quietMs: 0, maxMs: 0 }, waitUntil: async () => {}, generate: async () => { throw new Error('no synthetic generation expected'); } },
        });
    } catch (error) { await cleanup(); throw error; }
    const owner = app;
    return { app: owner, dataDir, logs, held, calls, settled: () => settledAction, leaseInside: () => leaseInside, stopInside: () => stopInside,
        receive() { owner.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 13, real_seq: '100013', time: now / 1000, raw_message: '嗯嗯', sender: { user_id: 10001 }, message: '嗯嗯' }); }, cleanup };
}

for (const mode of ['success', 'failure'] as const) test(`已派表情回应${mode === 'success' ? '成功' : '失败'}确认前App不释放租约`, async () => {
    const f = await reactionFixture(mode);
    try {
        f.receive(); await until(() => f.calls.length === 1, '表情回应'); let stopped = false; const drain = Promise.resolve(f.app.stop()).then(() => { stopped = true; }); await settle();
        assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); f.held.resolve(); await drain;
        assert.equal(f.settled(), true); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.calls[0]?.messageId, 13);
        assert.equal(f.logs.some(line => line.includes('表情回应失败')), mode === 'failure');
    } finally { await f.cleanup(); }
});

for (const mode of ['reentrant', 'throw'] as const) test(`表情回应transport同步stop${mode === 'throw' ? '并throw' : ''}仍预登记本次收尾`, async () => {
    const f = await reactionFixture(mode);
    try {
        f.receive(); await until(() => f.calls.length === 1, '表情回应'); assert.equal(f.leaseInside(), true); f.held.resolve(); await f.stopInside();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.logs.some(line => line.includes('SYNTHETIC_REACTION_SYNC_THROW')), mode === 'throw');
    } finally { await f.cleanup(); }
});
