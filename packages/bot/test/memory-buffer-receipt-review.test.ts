import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';

test('补回缓冲的已持久receipt遇一次入口读EIO后保留，自动恢复历史和模型响应', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-buffer-receipt-'));
    const dataDir = join(root, 'bot'); mkdirSync(dataDir);
    for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `card-${tier}.json`), JSON.stringify({
        spec: 'chara_card_v2', data: { name: '合成角色', description: '纯合成测试角色' },
    }));
    const config = parseAppConfig({
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic', timeoutMs: 1000 },
        characterCard: join(root, 'card-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], recalls: true, media: false,
        schedule: false, herDays: false, moody: false, speechCheck: false, realWeather: false, proactive: 'off', feedbackCommands: false,
    }, root, { QQBOT_LLM_API_KEY: 'synthetic' });
    const marker = 'SYNTHETIC_BUFFERED_USER_FACT';
    const prompts: string[] = [], sent: string[] = [], logs: string[] = [];
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered = false, failNext = false, injected = false, networkCalls = 0;
    const previousFetch = globalThis.fetch, stat = fs.statSync;
    const descriptor = Object.getOwnPropertyDescriptor(fs, 'statSync')!;
    const chatPath = join(dataDir, 'chats', '10001.jsonl');
    let app: App | undefined;
    try {
        globalThis.fetch = async () => { networkCalls++; throw new Error('合成回归禁止访问网络'); };
        Object.defineProperty(fs, 'statSync', { ...descriptor, value: (path: fs.PathLike, ...options: unknown[]) => {
            // 历史请求返回后才注入，恰好命中缓冲消息的hasMessage检查。
            if (failNext && String(path) === chatPath) {
                failNext = false; injected = true;
                throw Object.assign(new Error('合成入口读错误'), { code: 'EIO' });
            }
            return Reflect.apply(stat, fs, [path, ...options]);
        } }); syncBuiltinESMExports();
        app = startApp({ config, transport: {
            friendHistory: async () => { entered = true; await held; failNext = true; return []; },
            sendPrivateText: async (_peer, text) => { sent.push(text); return 900; },
        }, log: text => logs.push(text), pipeline: {
            generate: async messages => { prompts.push(messages.map(message => message.content).join('\n')); return '合成回复'; },
            settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
        } });
        const connected = app.connected(20000);
        const until = async (check: () => boolean) => {
            const deadline = Date.now() + 6000;
            while (!check()) { assert.ok(Date.now() < deadline, '等待合成自动恢复超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
        };
        await until(() => entered);
        app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001,
            message_id: 741, real_seq: '730001', time: Math.floor(Date.now() / 1000), sender: { user_id: 10001 }, raw_message: '',
            message: [{ type: 'text', data: { text: marker } }],
        });
        assert.equal(new ChatHistory(dataDir).pendingIncoming(10001).length, 1, '缓冲期间已经持久预约');
        release(); await connected;
        await until(() => sent.length > 0);
        assert.equal(injected, true); assert.ok(logs.some(text => text.includes('EIO')));
        assert.ok(prompts.some(prompt => prompt.includes(marker)), '不依赖用户重投，模型仍能看到恢复的事实');
        const history = new ChatHistory(dataDir);
        assert.equal(history.load(10001).filter(message => message.role === 'user' && message.content === marker).length, 1);
        assert.deepEqual(history.pendingIncoming(10001), []);
        assert.equal(sent.length, 1); assert.equal(networkCalls, 0);
    } finally {
        release?.(); Object.defineProperty(fs, 'statSync', descriptor); syncBuiltinESMExports();
        app?.stop(); globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true });
    }
});
