import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';

async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) assert.fail('合成等待超时'); await new Promise(done => setTimeout(done, 5)); } }
const tick = () => new Promise<void>(done => setImmediate(done));

for (const failure of [false, true]) test(`真实App.stop收尾后不合作摘要${failure ? '失败' : '成功'}不得写文件或日志`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-context-stop-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = []; let app: App | undefined, release!: (text: string) => void, reject!: (error: Error) => void;
    let entered = false, oldLog: ((message: string) => void) | undefined;
    const held = new Promise<string>((done, fail) => { release = done; reject = fail; });
    const now = Date.parse('2026-11-09T12:00:00+08:00');
    try {
        for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic-context-stop', timeoutMs: 1000, recallTimeoutMs: 100 },
            contextTurns: 1, schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        const history = new ChatHistory(dataDir);
        for (let i = 0; i < 12; i++) history.append(10001, { role: i % 2 ? 'assistant' : 'user', content: `合成过去事实${i}`, time: new Date(now - (12 - i) * 1000).toISOString(), messageId: i + 1 });
        globalThis.fetch = async input => {
            const url = new URL(String(input)); assert.equal(url.origin, 'http://synthetic.invalid');
            if (url.pathname.includes('/mental-models/')) return new Response('', { status: 404 });
            if (url.pathname.endsWith('/entities')) return Response.json({ items: [] });
            return Response.json({ results: [] });
        };
        app = startApp({ config, log: line => logs.push(line), transport: { friendHistory: async () => [], sendPrivateText: async () => 99 },
            sensitive: { on: () => false, describe: () => '' }, pipeline: { now: () => now, settle: { quietMs: 0, maxMs: 0 }, generate: async (messages, log) => {
                if (messages[0]?.content.includes('较早的聊天记录')) { entered = true; oldLog = log; return held; }
                return '合成回应';
            } } });
        await app.connected(20000);
        app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 81, real_seq: '810001', time: now / 1000,
            raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: '合成现在问候' } }] });
        await until(() => entered); const drain = app.stop(); assert.ok(drain instanceof Promise); assert.equal(app.stop(), drain); await drain;
        assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        const before = [...logs]; assert.equal(existsSync(join(dataDir, 'context', '10001.json')), false); assert.ok(oldLog);
        oldLog('SYNTHETIC_LATE_CONTEXT_CALLBACK');
        if (failure) reject(new Error('SYNTHETIC_LATE_CONTEXT_FAILURE')); else release('- 合成摘要');
        await tick(); await tick();
        assert.equal(existsSync(join(dataDir, 'context', '10001.json')), false, '释放目录锁之后不能落旧摘要');
        assert.deepEqual(logs, before, '包括授予模型的回调和summarizer本体日志均须停止');
    } finally {
        release?.('- 合成清理'); await app?.stop(); await tick(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-context-stop-')); rmSync(root, { recursive: true, force: true });
    }
});
