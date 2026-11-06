import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { jokeLine, jokeStore, verifiedJokes } from '../src/language/jokes.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成等待超时'); await new Promise(done => setTimeout(done, 5)); } }
const phrase = '星云团子饼', origin = '合成被撤回的来历', now = Date.parse('2026-11-05T12:00:00+08:00');

async function fixture(kind: 'plain' | 'answered' | 'crisis' = 'plain') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-jokes-provenance-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const previousFetch = globalThis.fetch, prompts: { content: string }[][] = [];
    let app: App | undefined, extracts = 0, sends = 0;
    const file = join(dataDir, 'jokes', '10001.json');
    const history = () => new ChatHistory(dataDir).load(10001);
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], jokes: true, recalls: true, idioms: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const h = new ChatHistory(dataDir);
    for (let i = 0; i < 42; i++) h.append(10001, { role: 'user', content: i === 0 ? `${phrase} ${origin}${kind === 'crisis' ? ' 我现在想自杀' : ''}` : i < 3 ? phrase : `合成其他对话${i}`, time: new Date(now - 3 * 86_400_000 + i * 1000).toISOString(), messageId: i + 1 });
    if (kind === 'answered') h.append(10001, { role: 'assistant', content: '合成已回复确认', time: new Date(now - 3 * 86_400_000 + 42_000).toISOString(), messageId: 100 });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network request'); };
    const make = () => startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: () => {}, transport: { friendHistory: async () => [], sendPrivateText: async () => ++sends + 900 },
        pipeline: { now: () => now, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
            if (messages[0]?.content.includes('最近两周的聊天')) { extracts++; return JSON.stringify([{ 梗: phrase, 来历: origin }]); }
            prompts.push(messages); return '合成回应';
        } } });
    const cleanup = async () => {
        await app?.stop(); for (let i = 0; i < 8; i++) await tick(); globalThis.fetch = previousFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-jokes-provenance-')); rmSync(root, { recursive: true, force: true });
    };
    try { app = make(); await app.connected(20000); await until(() => existsSync(file)); }
    catch (error) { await cleanup(); throw error; }
    return {
        root, dataDir, file, history, prompts, extracts: () => extracts,
        recall() { app!.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: 20000, user_id: 10001, message_id: 1 }); },
        async restart() { await app!.stop(); app = make(); await app.connected(20000); for (let i = 0; i < 8; i++) await tick(); },
        async turn() {
            const fresh = history(); let content: string | undefined;
            for (let n = 0; n < 200; n++) { const text = `合成现在问候${n}`; if (jokeLine([{ phrase, origin }], [...fresh, { role: 'user', content: text, time: new Date(now).toISOString() }], now)) { content = text; break; } }
            assert.ok(content); const before = prompts.length, sent = sends;
            app!.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 800, real_seq: '8000001', time: now / 1000,
                raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: content } }] });
            await until(() => prompts.length > before && sends > sent); return prompts.at(-1)!;
        },
        cleanup,
    };
}

test('已保存小梗的唯一origin来源撤回后，重启仍遮盖旧来历且不猜删原文件', async () => {
    const f = await fixture();
    try {
        const before = readFileSync(f.file, 'utf8'); f.recall();
        const fresh = f.history(); assert.equal(fresh.length, 42); assert.ok(fresh.every(message => !message.content.includes(origin)));
        assert.equal(fresh.filter(message => message.content.includes(phrase)).length, 2, 'phrase仍成立不证明其生成的origin来源安全');
        await f.restart(); const prompt = await f.turn();
        assert.ok(prompt.every(message => !message.content.includes(origin)), '已撤回来历不能经持久小梗旁路进入实际prompt');
        assert.equal(f.extracts(), 1, '冷却期内不靠重新编一份origin掩盖旧来源');
        assert.equal(readFileSync(f.file, 'utf8'), before, '读取保护不销毁原派生资料或猜测迁移');
    } finally { await f.cleanup(); }
});

test('已回复来源的撤回按既定政策忽略，重启后保留已确认小梗缓存', async () => {
    const f = await fixture('answered');
    try {
        const before = readFileSync(f.file, 'utf8'); f.recall(); assert.ok(f.history().some(message => message.content.includes(origin)));
        assert.equal(f.history().filter(message => message.recalled).length, 0);
        await f.restart(); const prompt = await f.turn();
        assert.ok(prompt.some(message => message.content.includes('你们之间有个小梗') && message.content.includes(origin)));
        assert.equal(f.extracts(), 1); assert.equal(readFileSync(f.file, 'utf8'), before);
    } finally { await f.cleanup(); }
});

test('危机keep来源撤回不改写事实或小梗来源版本', async () => {
    const f = await fixture('crisis');
    try {
        const before = readFileSync(f.file, 'utf8'); f.recall(); const fresh = f.history();
        assert.ok(fresh.some(message => message.content.includes('我现在想自杀') && message.content.includes(origin)));
        assert.equal(fresh.filter(message => message.recalled).length, 0);
        await f.restart(); assert.equal(f.extracts(), 1); assert.equal(readFileSync(f.file, 'utf8'), before);
        assert.equal(verifiedJokes(jokeStore({ dir: join(f.dataDir, 'jokes'), log: () => {} }).load(10001), f.history()).length, 1, 'keep保留的真实来源仍通过同一App读口守卫');
        // Crisis turns intentionally suppress joke prompts. This checks the
        // keep policy and persistent source identity without overriding it.
    } finally { await f.cleanup(); }
});

test('正常追加新轮次后旧来源仍完整，小梗缓存可用且不重抽或重写', async () => {
    const f = await fixture();
    try {
        const before = readFileSync(f.file, 'utf8');
        const { jokes: _jokes, ...metadata } = JSON.parse(before) as Record<string, unknown>;
        const encoded = JSON.stringify(metadata);
        assert.ok(!encoded.includes(origin) && !encoded.includes(phrase) && !encoded.includes(f.root), '来源副状态不复制聊天正文或机器绝对路径');
        const prompt = await f.turn();
        assert.ok(prompt.some(message => message.content.includes('你们之间有个小梗') && message.content.includes(origin)));
        assert.equal(f.extracts(), 1); assert.equal(readFileSync(f.file, 'utf8'), before);
        await f.restart(); assert.equal(f.extracts(), 1);
    } finally { await f.cleanup(); }
});
