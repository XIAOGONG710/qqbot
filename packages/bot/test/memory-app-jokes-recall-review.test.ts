import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { jokeLine } from '../src/language/jokes.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成等待超时'); await new Promise(done => setTimeout(done, 5)); } }

test('真实App小梗在途来源被同长度撤回后，不保存旧结果或带入下一轮提示词', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-jokes-recall-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, now = Date.parse('2026-11-05T12:00:00+08:00'), phrase = '星云土豆', origin = '合成被撤回的来历';
    let app: App | undefined, release!: (value: string) => void, extracts = 0;
    const held = new Promise<string>(done => { release = done; }), prompts: { content: string }[][] = [];
    try {
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], jokes: true, recalls: true, idioms: false,
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        const history = new ChatHistory(dataDir);
        // All messages remain unanswered and inside the joke window, but outside
        // catch-up's window. Only two distinct source messages establish the joke.
        for (let i = 0; i < 42; i++) history.append(10001, { role: 'user', content: i === 0 ? `${phrase} ${origin}` : i === 1 ? phrase : `合成其他对话${i}`, time: new Date(now - 3 * 86_400_000 + i * 1000).toISOString(), messageId: i + 1 });
        globalThis.fetch = async () => { throw new Error('unexpected synthetic network request'); };
        app = startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: () => {}, transport: { friendHistory: async () => [], sendPrivateText: async () => 900 },
            pipeline: { now: () => now, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
                if (messages[0]?.content.includes('最近两周的聊天')) { extracts++; return held; }
                prompts.push(messages); return '合成回应';
            } } });
        await app.connected(20000); await until(() => extracts === 1);
        for (const message_id of [1, 2]) app.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: 20000, user_id: 10001, message_id });
        const fresh = new ChatHistory(dataDir).load(10001);
        assert.equal(fresh.length, 42); assert.equal(fresh.filter(message => message.recalled).length, 2);
        assert.ok(fresh.every(message => !message.content.includes(phrase) && !message.content.includes(origin)));
        release(JSON.stringify([{ 梗: phrase, 来历: origin }])); for (let i = 0; i < 8; i++) await tick();
        assert.equal(existsSync(join(dataDir, 'jokes', '10001.json')), false, '未提交的陈旧派生结果不得落盘');
        // Pick a normal turn which would expose the stale joke if the read port
        // still returned it; do not let the probabilistic display hide a leak.
        let content: string | undefined;
        for (let n = 0; n < 200; n++) { const text = `合成现在问候${n}`; if (jokeLine([{ phrase, origin }], [...fresh, { role: 'user', content: text, time: new Date(now).toISOString() }], now)) { content = text; break; } }
        assert.ok(content);
        app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 800, real_seq: '8000001', time: now / 1000,
            raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: content } }] });
        await until(() => prompts.length > 0);
        assert.ok(prompts.every(prompt => prompt.every(message => !message.content.includes(origin) && !message.content.includes(phrase))));
    } finally {
        release('[]'); await app?.stop(); for (let i = 0; i < 8; i++) await tick(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-jokes-recall-')); rmSync(root, { recursive: true, force: true });
    }
});
