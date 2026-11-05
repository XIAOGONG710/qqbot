import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const NOW = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise<void>(done => setImmediate(done));
async function settle(rounds = 16): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!check()) { assert.ok(Date.now() < deadline, `synthetic timeout: ${label}`); await new Promise(done => setTimeout(done, 5)); }
}

function wiki(): Response {
    return Response.json({ query: { pages: { 1: {
        pageid: 1, title: '合成资料', extract: '合成资料明确写着星云土豆是一项离线测试事实。', index: 1,
    } } } });
}

function event(id: number, text: string) {
    return { post_type: 'message' as const, message_type: 'private' as const, sub_type: 'friend', self_id: 20000, user_id: 10001,
        message_id: id, real_seq: String(900000 + id), time: NOW / 1000, raw_message: text,
        sender: { user_id: 10001 }, message: text };
}

function config(root: string, dataDir: string) {
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({
        spec: 'chara_card_v2', data: { name: '合成角色' },
    }));
    return parseAppConfig({
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], timeline: true, webLookup: 'explicit',
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false,
        jokes: false, idioms: false,
    }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
}

function cleanup(root: string): void {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('qqbot-web-owner-'));
    rmSync(root, { recursive: true, force: true });
}

test('真实App停机取消已派Web gather，迟到结果不再摘录、写时间线或日志', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-web-owner-stop-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = [], sent: string[] = [];
    let app: App | undefined, releaseFetch!: () => void, fetchCalls = 0, extractCalls = 0;
    const held = new Promise<void>(done => { releaseFetch = done; });
    try {
        globalThis.fetch = async input => { fetchCalls++; assert.match(String(input), /wikipedia/); await held; return wiki(); };
        app = startApp({ config: config(root, dataDir), log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sent.push(text); return 1; } },
            pipeline: { now: () => NOW, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
                const text = messages.map(line => line.content).join('\n');
                if (text.includes('资料摘录员')) { extractCalls++; return '星云土豆是一项离线测试事实'; }
                return '合成主回复';
            } },
        });
        await app.connected(20000); app.receive(event(1, '帮我查一下星云土豆是什么'));
        await until(() => fetchCalls === 1, 'web gather entered');
        await app.stop(); const logCount = logs.length;
        assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        releaseFetch(); await settle(32);
        assert.equal(extractCalls, 0, 'stop 后的 gather 结果不能再派发摘录模型');
        assert.deepEqual(sent, []);
        assert.deepEqual(logs.slice(logCount), [], 'stop 后不能再产生 Web 或联系人流水线日志');
        assert.equal(existsSync(join(dataDir, 'timeline.jsonl')), false, 'stop 后不能再提交 Web 时间线');
    } finally {
        releaseFetch(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; cleanup(root);
    }
});

test('Web deadline产生的孤儿结果不污染已经接管目录的替代实例', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-web-owner-restart-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, oldSetTimeout = globalThis.setTimeout;
    const logs1: string[] = [], sent1: string[] = [], sent2: string[] = [], prompts2: string[] = [];
    let app1: App | undefined, app2: App | undefined, releaseFetch!: () => void, fetchCalls = 0, extractCalls = 0;
    const held = new Promise<void>(done => { releaseFetch = done; });
    try {
        globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => oldSetTimeout(callback, ms === 25_000 ? 5 : ms, ...args)) as typeof setTimeout;
        globalThis.fetch = async input => { fetchCalls++; assert.match(String(input), /wikipedia/); await held; return wiki(); };
        const parsed = config(root, dataDir);
        app1 = startApp({ config: parsed, log: line => logs1.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sent1.push(text); return 11; } },
            pipeline: { now: () => NOW, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
                const text = messages.map(line => line.content).join('\n');
                if (text.includes('资料摘录员')) { extractCalls++; return '星云土豆是一项离线测试事实'; }
                return '第一实例合成主回复';
            } },
        });
        await app1.connected(20000); app1.receive(event(10, '帮我查一下星云土豆是什么'));
        await until(() => fetchCalls === 1, 'old web gather entered');
        await until(() => sent1.length === 1, 'old reply after deadline');
        await app1.stop(); const oldLogCount = logs1.length;
        assert.equal(existsSync(join(dataDir, 'bot.lock')), false);

        app2 = startApp({ config: parsed, log: () => {}, sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sent2.push(text); return 22; } },
            pipeline: { now: () => NOW, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
                prompts2.push(messages.map(line => line.content).join('\n')); return '第二实例合成主回复';
            } },
        });
        await app2.connected(20000);
        releaseFetch(); await settle(32);
        assert.equal(extractCalls, 0, 'deadline 后的旧 gather 不能再派发摘录模型');
        assert.deepEqual(logs1.slice(oldLogCount), []);
        assert.equal(existsSync(join(dataDir, 'timeline.jsonl')), false, '旧实例不得向替代实例的数据目录迟到提交时间线');
        app2.receive(event(11, '晚上好'));
        await until(() => sent2.length === 1, 'replacement reply');
        assert.ok(prompts2.length > 0);
        assert.ok(prompts2.every(prompt => !prompt.includes('上网查了「星云土豆是什么」')));
    } finally {
        releaseFetch(); await app2?.stop(); await app1?.stop(); await settle();
        globalThis.fetch = oldFetch; globalThis.setTimeout = oldSetTimeout; cleanup(root);
    }
});

test('Web正常完成仍会摘录、写时间线并在同实例复用缓存', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-web-owner-complete-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = [], sent: string[] = [], prompts: string[] = [];
    let app: App | undefined, fetchCalls = 0, extractCalls = 0;
    try {
        globalThis.fetch = async input => { fetchCalls++; assert.match(String(input), /wikipedia/); return wiki(); };
        app = startApp({ config: config(root, dataDir), log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sent.push(text); return sent.length; } },
            pipeline: { now: () => NOW, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
                const text = messages.map(line => line.content).join('\n');
                if (text.includes('资料摘录员')) { extractCalls++; return '星云土豆是一项离线测试事实'; }
                prompts.push(text); return '正常完成的合成回复';
            } },
        });
        await app.connected(20000); app.receive(event(20, '帮我查一下星云土豆是什么'));
        await until(() => sent.length === 1, 'first completed reply');
        app.receive(event(21, '帮我查一下星云土豆是什么'));
        await until(() => sent.length === 2, 'cached completed reply');
        assert.equal(fetchCalls, 1); assert.equal(extractCalls, 1);
        assert.ok(prompts.every(prompt => prompt.includes('你刚上网查了一下（中文维基百科）：星云土豆是一项离线测试事实')));
        assert.match(readFileSync(join(dataDir, 'timeline.jsonl'), 'utf8'), /上网查了「星云土豆是什么」/);
        assert.ok(logs.some(line => line.includes('摘出 1 条')));
    } finally {
        await app?.stop(); await settle(); globalThis.fetch = oldFetch; cleanup(root);
    }
});
