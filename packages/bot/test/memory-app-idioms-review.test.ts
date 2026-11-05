import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { idiomLine } from '../src/language/idioms.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成等待超时'); await new Promise(done => setTimeout(done, 5)); } }
const phrase = '咕噜呀', now = Date.parse('2026-11-05T12:00:00+08:00'), ids = [2, 22, 42, 43];
const result = JSON.stringify([{ 说法: phrase, 类型: '口头禅' }]);

async function fixture(held = false, kind: 'plain' | 'answered' | 'crisis' = 'plain') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-idioms-review-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const previousFetch = globalThis.fetch, logs: string[] = [], prompts: { content: string }[][] = [];
    let app: App | undefined, extracts = 0, sends = 0, release!: (value: string) => void, reject!: (error: Error) => void, generateLog: ((line: string) => void) | undefined;
    const pending = new Promise<string>((done, fail) => { release = done; reject = fail; });
    const file = join(dataDir, 'idioms', '10001.json'), history = () => new ChatHistory(dataDir).load(10001);
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], jokes: false, recalls: true, idioms: true,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const h = new ChatHistory(dataDir);
    for (let i = 0; i < 66; i++) h.append(10001, { role: 'user', content: ids.includes(i + 1) ? phrase : i === 0 && kind === 'crisis' ? '我现在想自杀' : `合成其他对话${i}`,
        time: new Date(now - (5 - Math.floor(i / 20)) * 86_400_000 + i * 1000).toISOString(), messageId: i + 1 });
    if (kind === 'answered') h.append(10001, { role: 'assistant', content: '合成已回复确认', time: new Date(now - 86_400_000).toISOString(), messageId: 100 });
    const original = history();
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network request'); };
    const make = () => startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: line => logs.push(line), transport: { friendHistory: async () => [], sendPrivateText: async () => ++sends + 900 },
        pipeline: { now: () => now, settle: { quietMs: 0, maxMs: 0 }, generate: async (messages, log) => {
            if (messages[0]?.content.includes('口头习惯')) { extracts++; generateLog = log; return held ? pending : result; }
            prompts.push(messages); return '合成回应';
        } } });
    const cleanup = async () => {
        release(result); await app?.stop(); await settle(); globalThis.fetch = previousFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-idioms-review-')); rmSync(root, { recursive: true, force: true });
    };
    try { app = make(); await app.connected(20000); await until(() => extracts === 1); if (!held) await until(() => existsSync(file)); }
    catch (error) { await cleanup(); throw error; }
    return {
        root, dataDir, file, history, logs, prompts, release, reject, extracts: () => extracts, generateLog: () => generateLog,
        stop: () => app!.stop(),
        recall(targets = ids) { for (const message_id of targets) app!.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: 20000, user_id: 10001, message_id }); },
        async restart() { await app!.stop(); app = make(); await app.connected(20000); await settle(); },
        async turn() {
            let content: string | undefined;
            // Use the real default display probability, but choose its nonce on
            // the pre-recall history so a missing source cannot hide the check.
            for (let n = 0; n < 200; n++) { const text = `合成现在问候${n}`; if (idiomLine([{ phrase, kind: '口头禅', count: 4, days: 3 }], [...original, { role: 'user', content: text, time: new Date(now).toISOString() }], now)) { content = text; break; } }
            assert.ok(content); const before = prompts.length, sent = sends;
            app!.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 800, real_seq: '8000001', time: now / 1000,
                raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: content } }] });
            await until(() => prompts.length > before && sends > sent); return prompts.at(-1)!;
        },
        cleanup,
    };
}

for (const fail of [false, true]) test(`真实App停止后口头习惯模型晚${fail ? '失败' : '成功'}不写文件或日志`, async () => {
    const f = await fixture(true);
    try {
        await f.stop(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); const before = [...f.logs];
        f.generateLog()!('SYNTHETIC_LATE_IDIOM_CALLBACK');
        if (fail) f.reject(new Error('SYNTHETIC_LATE_IDIOM_FAILURE')); else f.release(result);
        await settle(); assert.equal(existsSync(f.file), false); assert.deepEqual(f.logs, before);
    } finally { await f.cleanup(); }
});

test('真实App口头习惯在途提取来源同长度撤回后不保存陈旧结果', async () => {
    const f = await fixture(true);
    try {
        f.recall(); const fresh = f.history(); assert.equal(fresh.length, 66); assert.equal(fresh.filter(message => message.recalled).length, 4);
        assert.ok(fresh.every(message => !message.content.includes(phrase)));
        f.release(result); await settle(); assert.equal(existsSync(f.file), false);
        const prompt = await f.turn(); assert.ok(prompt.every(message => !message.content.includes('他平时爱说')));
    } finally { await f.cleanup(); }
});

test('口头习惯全部phrase来源撤回重启后，既有fresh读取策略也不会向实际prompt供给', async () => {
    const f = await fixture();
    try {
        const before = readFileSync(f.file, 'utf8'); f.recall(); assert.ok(f.history().every(message => !message.content.includes(phrase)));
        await f.restart(); const prompt = await f.turn(); assert.ok(prompt.every(message => !message.content.includes('他平时爱说')));
        assert.equal(f.extracts(), 1); assert.equal(readFileSync(f.file, 'utf8'), before);
    } finally { await f.cleanup(); }
});

test('仅剩一次phrase不能洗白已撤回的频次/跨日证据，重启后暂停旧习惯供给', async () => {
    const f = await fixture();
    try {
        const before = readFileSync(f.file, 'utf8'); f.recall(ids.slice(0, 3));
        assert.equal(f.history().filter(message => message.content.includes(phrase)).length, 1);
        await f.restart(); const prompt = await f.turn();
        assert.ok(prompt.every(message => !message.content.includes('他平时爱说')), '旧4次3日分类不能凭剩余1次重放');
        assert.equal(f.extracts(), 1); assert.equal(readFileSync(f.file, 'utf8'), before);
    } finally { await f.cleanup(); }
});

test('正常追加保留口头习惯缓存及默认概率的实际prompt供给', async () => {
    const f = await fixture();
    try {
        const before = readFileSync(f.file, 'utf8'); const prompt = await f.turn();
        assert.ok(prompt.some(message => message.content.includes('他平时爱说') && message.content.includes(phrase)));
        await f.restart(); assert.equal(f.extracts(), 1); assert.equal(readFileSync(f.file, 'utf8'), before);
    } finally { await f.cleanup(); }
});

test('已回复来源撤回仍忽略，不抹掉已确认口头习惯', async () => {
    const f = await fixture(false, 'answered');
    try {
        const before = readFileSync(f.file, 'utf8'); f.recall(); assert.equal(f.history().filter(message => message.recalled).length, 0);
        await f.restart(); const prompt = await f.turn(); assert.ok(prompt.some(message => message.content.includes('他平时爱说')));
        assert.equal(f.extracts(), 1); assert.equal(readFileSync(f.file, 'utf8'), before);
    } finally { await f.cleanup(); }
});

test('危机keep撤回保留真实历史且不改变已完成口头习惯资料', async () => {
    const f = await fixture(false, 'crisis');
    try {
        const before = readFileSync(f.file, 'utf8'); f.recall([1]); assert.equal(f.history().filter(message => message.recalled).length, 0);
        assert.ok(f.history().some(message => message.content.includes('我现在想自杀')));
        await f.restart(); assert.equal(f.extracts(), 1); assert.equal(readFileSync(f.file, 'utf8'), before);
    } finally { await f.cleanup(); }
});
