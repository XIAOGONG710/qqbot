import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, type App, type Transport } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { PART_GAP_MS } from '../src/social/responder.ts';

async function until(check: () => boolean) {
    const end = Date.now() + 4000;
    while (!check()) { if (Date.now() > end) assert.fail('合成等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('真实App停止等待QQ ACK及历史收尾，同进程不能抢旧锁，完成后可重启且idle同步放锁', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-send-drain-')), dataDir = join(root, 'bot'); mkdirSync(dataDir);
    const originalFetch = globalThis.fetch; let networkCalls = 0;
    // DSH 线每次互动后会向常驻的她（127.0.0.1:7777）fire-and-forget 一条 /note，失败静默；它不是被测提供方，不计入
    globalThis.fetch = async input => { if (String(input).startsWith('http://127.0.0.1:7777/')) throw new Error('resident off in synthetic fixture'); networkCalls++; throw new Error('Network prohibited in synthetic App send fixture'); };
    const apps: App[] = []; let release!: (id: number) => void;
    const held = new Promise<number>(resolve => { release = resolve; });
    const sent: string[] = [];
    for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' },
        characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, name: '合成联系人', tier: 'classmate' }],
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false,
    }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const start = (waiting: boolean) => {
        const transport: Transport = { friendHistory: async () => [], sendPrivateText: async (_peer, text) => { sent.push(text); return waiting ? held : 9902; } };
        const app = startApp({ config, transport, log() {}, sensitive: { on: () => false, describe: () => '' },
            pipeline: { generate: async () => '合成第一句\n合成第二句', settle: { quietMs: 0, maxMs: 0 } } });
        apps.push(app); return app;
    };
    try {
        const first = start(true); await first.connected(20000);
        first.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001,
            message_id: 81, real_seq: '810001', time: Math.floor(Date.now() / 1000), raw_message: '',
            sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: '合成请求' } }] });
        await until(() => sent.length === 1);
        const drain = first.stop(); assert.ok(drain instanceof Promise); assert.equal(first.stop(), drain);
        assert.equal(new ChatHistory(dataDir).load(10001).filter(message => message.role === 'assistant').length, 0);
        assert.throws(() => start(false), error => error instanceof Error && error.message.startsWith('已有一个 bot 在运行（PID '));
        release(9901); await drain;
        const rows = new ChatHistory(dataDir).load(10001).filter(message => message.role === 'assistant');
        assert.deepEqual(rows.map(message => [message.messageId, message.content]), [[9901, sent[0]]]);
        assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        const restarted = start(false); assert.equal(restarted.stop(), undefined, '没有写者的idle停止同步完成');
        assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        // 跨过正常第二气泡的等待，避免在ACK刚返回时检查而漏过晚派发。
        await new Promise(resolve => setTimeout(resolve, PART_GAP_MS + 50));
        assert.equal(sent.length, 1); assert.equal(networkCalls, 0);
    } finally {
        release(9901);
        await Promise.allSettled(apps.map(app => app.stop()).filter((value): value is Promise<void> => value !== undefined));
        await new Promise(resolve => setImmediate(resolve)); globalThis.fetch = originalFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-send-drain-'));
        rmSync(root, { recursive: true, force: true });
    }
});
