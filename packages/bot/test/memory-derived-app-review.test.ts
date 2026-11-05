import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory, RECALLED_TEXT } from '../src/memory/history.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { DerivedState } from '../src/memory/derived-state.ts';
import { fileOps } from '../src/memory/json-file.ts';
import type { HindsightApi } from '../src/memory/hindsight.ts';

const A = { qq: 10001, tier: 'boyfriend', name: '合成甲' }, B = { qq: 10002, tier: 'boyfriend', name: '合成乙' };
const POISON = 'SYNTHETIC_STALE_DERIVED';
const roots: string[] = [], apps: App[] = [], releases: (() => void)[] = [];
let originalFetch: typeof fetch;
let affectedPrivate = '';
let heldSubmissions = 0;
beforeEach(() => {
    originalFetch = globalThis.fetch; heldSubmissions = 0;
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input)); assert.equal(url.origin, 'http://synthetic.invalid');
        const bank = decodeURIComponent(url.pathname.split('/banks/')[1]?.split('/')[0] ?? '');
        const polluted = bank.endsWith('-common') || bank === affectedPrivate;
        if (url.pathname.includes('/mental-models/')) return Response.json({ id: url.pathname.split('/').at(-1), content: polluted ? POISON : '合成未污染关系' });
        if (url.pathname.endsWith('/entities')) return Response.json({ total: 1, items: [{ canonical_name: POISON }] });
        if (url.pathname.endsWith('/memories/recall')) return Response.json({ results: polluted ? [{ id: 'stale-observation', type: 'observation', text: POISON, mentioned_at: new Date().toISOString() }] : [] });
        if (url.pathname.endsWith('/operations')) return Response.json({ bank_id: decodeURIComponent(url.pathname.split('/banks/')[1]!.split('/')[0]!), total: 0, operations: [] });
        if (url.pathname.includes('/operations/')) return new Response('', { status: 404 });
        if (init?.method === 'POST' && url.pathname.endsWith('/memories')) { heldSubmissions++; return new Promise<Response>(release => releases.push(() => release(new Response('', { status: 503 })))); }
        return Response.json({});
    };
});
afterEach(async () => {
    const drains = apps.splice(0).map(app => app.stop()); for (const release of releases.splice(0)) release();
    await Promise.allSettled(drains); globalThis.fetch = originalFetch;
    for (const root of roots.splice(0)) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-derived-app-')); rmSync(root, { recursive: true, force: true }); }
});
const tick = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) assert.fail('synthetic timeout'); await new Promise(done => setTimeout(done, 5)); } }
async function fixture(content = `合成乙 ${POISON}`) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-derived-app-')); roots.push(root); const dataDir = join(root, 'bot'); mkdirSync(dataDir); const memoryDir = join(dataDir, 'memory');
    for (const tier of ['classmate', 'classmate-open', 'boyfriend', 'boyfriend-open']) writeFileSync(join(root, `${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, '{tier}.json'), dataDir, contacts: [A, B],
        memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic', timeoutMs: 1000, recallTimeoutMs: 100 }, recalls: true,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off',
    }, root, { QQBOT_LLM_API_KEY: 'synthetic' });
    const history = new ChatHistory(dataDir), time = new Date(Date.now() - 3600_000).toISOString();
    history.append(A.qq, { role: 'user', time, content, messageId: 1, messageSeq: '100001' });
    history.append(B.qq, { role: 'user', time, content: '合成普通消息', messageId: 2, messageSeq: '100002' });
    const fake: HindsightApi = { putBank: async () => {}, retain: async () => {}, recall: async () => [], getMentalModel: async () => undefined,
        createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => 'synthetic' };
    const seed = new LongTermMemory({ api: fake, dir: memoryDir, bankPrefix: 'synthetic', recallTimeoutMs: 100, common: true, log() {} });
    for (const person of [A, B]) await seed.sync(person, { char: '合成角色', user: person.name }, history.load(person.qq)); await seed.stop();
    affectedPrivate = seed.bankId(A);
    return { root, dataDir, memoryDir, config, history, bank: (person: typeof A) => seed.bankId(person), common: seed.commonBankId() };
}
function start(f: Awaited<ReturnType<typeof fixture>>) {
    const prompts: string[] = []; const app = startApp({ config: f.config, log() {}, sensitive: { on: () => false, describe: () => '' },
        transport: { friendHistory: async () => [], sendPrivateText: async () => 9 }, pipeline: { generate: async messages => {
            prompts.push(JSON.stringify(messages)); return '合成回复';
        }, settle: { quietMs: 0, maxMs: 0 } } }); apps.push(app); return { app, prompts };
}
function recall(app: App) { app.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: 20000, user_id: A.qq, message_id: 1 }); }
function ask(app: App, id: number) { app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: B.qq,
    message_id: id, real_seq: String(999000 + id), time: Math.floor(Date.now() / 1000), sender: { user_id: B.qq }, raw_message: '', message: [{ type: 'text', data: { text: '合成甲今天聊了什么' } }] }); }

test('真实App撤回先建立派生屏障，修订HTTP仍held时下一联系人提示不含旧观测', async () => {
    const f = await fixture(), run = start(f); ask(run.app, 70); await until(() => f.history.load(B.qq).some(message => message.role === 'assistant')); await tick();
    assert.ok(run.prompts.some(prompt => prompt.includes(POISON)), '修订前确实能召回合成旧观测');
    const before = run.prompts.length; recall(run.app); ask(run.app, 81); await until(() => run.prompts.length > before);
    assert.ok(run.prompts.slice(before).every(prompt => !prompt.includes(POISON)));
    await until(() => heldSubmissions > 0);
    assert.equal(new DerivedState(f.memoryDir).snapshot(f.common).dirty, true);
});

test('撤回发布EIO但RAM已接受时立即屏蔽公共派生，其他联系人仍可生成', async () => {
    const f = await fixture(), run = start(f); ask(run.app, 70); await until(() => f.history.load(B.qq).some(message => message.role === 'assistant')); await tick();
    assert.ok(run.prompts.some(prompt => prompt.includes(POISON)));
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs, before = run.prompts.length;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => { if (String(to) === join(f.dataDir, 'chats', `${A.qq}.recalled.json`)) throw Object.assign(new Error('synthetic'), { code: 'EIO' }); return rename(from, to); };
        recall(run.app); ask(run.app, 82); await until(() => run.prompts.length > before);
        assert.ok(run.prompts.slice(before).every(prompt => !prompt.includes(POISON)));
        assert.equal(new DerivedState(f.memoryDir).snapshot(f.common).owners.find(owner => owner.qq === A.qq)?.allDocuments, true);
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
});

test('重启迁移真实recalled元数据，旧digest已改占位也先挡供应商旧模型', async () => {
    const f = await fixture(); assert.equal(f.history.recall(A.qq, 1), true);
    // Simulate a prior version having retained the redacted document, with no derived barrier.
    const fake: HindsightApi = { putBank: async () => {}, retain: async () => {}, recall: async () => [], getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '' };
    const seed = new LongTermMemory({ api: fake, dir: f.memoryDir, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, log() {} });
    await seed.sync(A, { char: '合成角色', user: A.name }, f.history.load(A.qq)); await seed.stop();
    writeFileSync(join(f.memoryDir, 'derived.json'), JSON.stringify({ version: 1, banks: {} }));
    const run = start(f); ask(run.app, 83); await until(() => run.prompts.length > 0);
    assert.ok(run.prompts.every(prompt => !prompt.includes(POISON))); assert.equal(new DerivedState(f.memoryDir).snapshot(f.common).dirty, true);
});

test('字面占位与危机keep不伪造撤回屏障，无真实撤回仍可读取既有模型', async () => {
    for (const content of [RECALLED_TEXT, '我现在想自杀']) {
        const f = await fixture(content), run = start(f);
        if (content !== RECALLED_TEXT) recall(run.app);
        await tick(); assert.equal(new DerivedState(f.memoryDir).snapshot(f.common).dirty, false);
        ask(run.app, content === RECALLED_TEXT ? 84 : 85); await until(() => run.prompts.length > 0);
        assert.ok(run.prompts.some(prompt => prompt.includes(POISON)), '未撤回的公共观测仍可用，不能靠关闭所有记忆通过');
        await run.app.stop();
    }
});
