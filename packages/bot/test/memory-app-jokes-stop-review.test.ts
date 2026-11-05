import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
for (const failure of [false, true]) test(`真实App.stop取消小梗提取，旧${failure ? '失败' : '成功'}结果和授予log不晚写`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-jokes-stop-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = []; let app: App | undefined, entered = 0, modelLog: ((line: string) => void) | undefined;
    let release!: (text: string) => void, reject!: (error: Error) => void; const held = new Promise<string>((done, fail) => { release = done; reject = fail; });
    const now = Date.parse('2026-11-05T12:00:00+08:00');
    try {
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], jokes: true, idioms: false, schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        const history = new ChatHistory(dataDir);
        for (let i = 0; i < 42; i++) history.append(10001, { role: i % 2 ? 'assistant' : 'user', content: `星云土豆 合成对话${i}`, time: new Date(now - (42 - i) * 1000).toISOString(), messageId: i + 1 });
        globalThis.fetch = async () => { assert.fail('Network prohibited in synthetic jokes-stop fixture'); };
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => 1 }, pipeline: { now: () => now, generate: async (messages, log) => {
                assert.ok(messages[0]?.content.includes('小梗')); entered++; modelLog = log; return held;
            } } });
        await app.connected(20000); await tick(); assert.equal(entered, 1); const file = join(dataDir, 'jokes', '10001.json'); assert.equal(existsSync(file), false);
        await app.stop(); const before = [...logs]; assert.equal(existsSync(join(dataDir, 'bot.lock')), false); assert.ok(modelLog);
        modelLog('SYNTHETIC_LATE_JOKES_PROVIDER_LOG');
        if (failure) reject(new Error('SYNTHETIC_LATE_JOKES_FAILURE')); else release('[{"梗":"星云土豆","来历":"合成聊天玩笑"}]');
        await tick(); await tick();
        assert.equal(existsSync(file), false, '目录租约释放后不能保存旧小梗'); assert.deepEqual(logs, before, '晚模型及提取本体不能写结束日志'); assert.equal(entered, 1);
    } finally {
        release?.('[]'); await app?.stop(); await tick(); await tick(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-jokes-stop-')); rmSync(root, { recursive: true, force: true });
    }
});
