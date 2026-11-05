import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory, RECALLED_TEXT } from '../src/memory/history.ts';
import { OPEN_EPISODE_STEP } from '../src/memory/long-term.ts';
import { fileOps } from '../src/memory/json-file.ts';

const PEER = 10001, SELF = 20000, MARKER = 'SYNTHETIC_RETAINED_RECALL';
type Retained = { bank: string; document: string; content: string };
const roots: string[] = [], apps: App[] = [], releases: (() => void)[] = [];
let originalFetch: typeof fetch; let calls: Retained[]; let requests: string[];
beforeEach(() => {
    originalFetch = globalThis.fetch; calls = []; requests = [];
    const operations = new Set<string>();
    globalThis.fetch = async (url, init) => {
        const path = String(url); assert.ok(path.startsWith('http://synthetic.invalid/'), '只允许全合成假API'); requests.push(path);
        const parsed = new URL(path), bank = decodeURIComponent(parsed.pathname.split('/banks/')[1]?.split('/')[0] ?? '');
        if (init?.method === 'POST' && path.endsWith('/memories')) {
            const body = JSON.parse(String(init.body));
            for (const item of body.items) calls.push({ bank: path.split('/banks/')[1]!.split('/')[0]!, document: item.document_id, content: item.content });
            if (body.operation_id) { operations.add(`${bank}:${body.operation_id}`); return Response.json({ success: true, async: true, bank_id: bank, items_count: 1, operation_id: body.operation_id }); }
            return Response.json({});
        }
        if (init?.method === 'GET' && path.includes('/mental-models/')) return new Response('', { status: 404 });
        if (parsed.pathname.endsWith('/operations')) return Response.json({ bank_id: bank, total: 0, operations: [] });
        if (parsed.pathname.includes('/operations/')) {
            const id = decodeURIComponent(parsed.pathname.split('/operations/')[1]!);
            return operations.has(`${bank}:${id}`) ? Response.json({ operation_id: id, operation_type: 'batch_retain', status: 'completed', child_operations: [{ status: 'completed' }] }) : new Response('', { status: 404 });
        }
        return Response.json({});
    };
});
afterEach(async () => {
    const drains = apps.splice(0).map(app => app.stop()).filter((value): value is Promise<void> => value !== undefined);
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(drains); globalThis.fetch = originalFetch;
    for (const root of roots.splice(0)) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-recall-sync-')); rmSync(root, { recursive: true, force: true }); }
});
async function until(check: () => boolean) { const end = Date.now() + 3500; while (!check()) { if (Date.now() > end) assert.fail('合成等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
function fixture(options: { memory?: boolean; dormant?: boolean; previousTier?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-recall-sync-')); roots.push(root); const dataDir = join(root, 'bot'); mkdirSync(dataDir);
    for (const tier of ['classmate', 'classmate-open', 'boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const tier = options.dormant ? 'boyfriend' : 'classmate';
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: PEER, name: '合成联系人', tier }], ...(options.memory === false ? {} : { memory: { baseUrl: 'http://synthetic.invalid', timeoutMs: 1000, recallTimeoutMs: 100, bankPrefix: 'synthetic' } }),
        recalls: true, media: true, dormancy: options.dormant === true, schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off',
    }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const at = Math.floor(Date.now() / 1000) - 120; const history = new ChatHistory(dataDir);
    for (let i = 1; i <= OPEN_EPISODE_STEP; i++) history.append(PEER, { role: 'user', time: new Date((at + i) * 1000).toISOString(), messageId: i, messageSeq: String(81000 + i), content: i === OPEN_EPISODE_STEP ? MARKER : `合成消息${i}` });
    if (options.dormant) writeFileSync(join(dataDir, 'dormancy.json'), JSON.stringify({ state: 'dormant', since: new Date((at - 1) * 1000).toISOString(), archive: join(root, 'synthetic-archive') }));
    if (options.previousTier) writeFileSync(join(dataDir, 'tiers.json'), JSON.stringify({ [PEER]: 'boyfriend' }));
    return { root, dataDir, config, at };
}
function start(f: ReturnType<typeof fixture>, media?: { voiceToText(): Promise<string> }) {
    let release!: (value: string) => void; const held = new Promise<string>(resolve => { release = resolve; }); releases.push(() => release('合成迟到模型结果'));
    let generated = 0;
    const app = startApp({ config: f.config, transport: { friendHistory: async () => [], sendPrivateText: async () => 999 }, log() {},
        ...(media ? { media } : {}), sensitive: { on: () => false, describe: () => '' },
        pipeline: { generate: async () => { generated++; return held; }, settle: { quietMs: 0, maxMs: 0 } } });
    apps.push(app); return { app, generated: () => generated };
}
const recall = (app: App, id = OPEN_EPISODE_STEP) => app.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: SELF, user_id: PEER, message_id: id });
const own = () => calls.filter(call => !call.bank.endsWith('-common'));
async function initiallyRetained(run: ReturnType<typeof start>) { await run.app.connected(SELF); await until(() => calls.some(call => call.bank.endsWith('-common') && call.content.includes(MARKER))); await new Promise(resolve => setImmediate(resolve)); }

test('已retain的开放片段撤回后立即提交相同文档ID的占位快照，不等五分钟', async () => {
    const f = fixture(), run = start(f); await initiallyRetained(run); const old = own()[0]!, shared = calls.find(call => call.bank.endsWith('-common'))!;
    recall(run.app);
    await until(() => own().some(call => call.document === old.document && call.content.includes(RECALLED_TEXT) && !call.content.includes(MARKER)));
    await until(() => calls.some(call => call.bank === shared.bank && call.document === shared.document && call.content.includes(RECALLED_TEXT) && !call.content.includes(MARKER)));
    assert.equal(new ChatHistory(f.dataDir).load(PEER).at(-1)!.content, RECALLED_TEXT);
});

test('撤回观察写入EIO时不提交未发布正文，恢复IO后自动提交遮盖快照', async () => {
    const f = fixture(), run = start(f); await initiallyRetained(run); const before = calls.length;
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        const recalled = join(f.dataDir, 'chats', `${PEER}.recalled.json`); fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from, to) => { if (String(to) === recalled) throw Object.assign(new Error('SYNTHETIC_IO'), { code: 'EIO' }); return rename(from, to); }) as typeof rename;
        recall(run.app); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(calls.length, before);
        fileOps.renameSync = rename; fileOps.writeDelaysMs = delays;
        await until(() => own().some(call => call.content.includes(RECALLED_TEXT) && !call.content.includes(MARKER)));
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
});

test('撤回发布后立刻stop不再派发写入，重启从已存遮盖历史更新远端文档', async () => {
    const f = fixture(), first = start(f); await initiallyRetained(first); const before = calls.length;
    recall(first.app); await first.app.stop(); const stoppedAt = calls.length; await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls.length, stoppedAt);
    const restarted = start(f); await restarted.app.connected(SELF);
    await until(() => calls.slice(before).some(call => call.content.includes(RECALLED_TEXT) && !call.content.includes(MARKER)));
});

test('无memory配置及休眠时撤回只改私有占位，不开始远端记忆或额外生成', async () => {
    for (const options of [{ memory: false }, { dormant: true }]) {
        const f = fixture(options), run = start(f); const before = requests.length; await run.app.connected(SELF); await new Promise(resolve => setTimeout(resolve, 30)); const generated = run.generated();
        recall(run.app); await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(requests.length, before); assert.equal(run.generated(), generated);
        assert.equal(new ChatHistory(f.dataDir).load(PEER).at(-1)!.content, RECALLED_TEXT);
        await run.app.stop();
    }
});

test('降档since排除旧高档原文，即使收到旧撤回通知也不提交旧私密正文', async () => {
    const f = fixture({ previousTier: true }), run = start(f); await run.app.connected(SELF); recall(run.app); await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(calls.every(call => !call.content.includes(MARKER))); assert.equal(run.generated(), 0);
});

test('休眠期间保留撤回同步意图，唤醒后不等周期就提交最新遮盖历史', async () => {
    const f = fixture({ dormant: true }); writeFileSync(join(f.dataDir, 'dormancy.json'), JSON.stringify({ state: 'awake' }));
    const run = start(f); await initiallyRetained(run);
    writeFileSync(join(f.dataDir, 'dormancy.json'), JSON.stringify({ state: 'dormant', since: new Date().toISOString(), archive: join(f.root, 'synthetic-archive') }));
    const before = calls.length; recall(run.app); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(calls.length, before);
    run.app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: PEER, message_id: 501, time: Math.floor(Date.now() / 1000), raw_message: '/唤醒', sender: { user_id: PEER }, message: [{ type: 'text', data: { text: '/唤醒' } }] });
    await until(() => calls.slice(before).some(call => call.content.includes(RECALLED_TEXT) && !call.content.includes(MARKER)));
});

test('媒体排队撤回期间同步只看已发布视图，完成后占位且不会提交新媒体原文', async () => {
    const f = fixture(); let entered = false; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); releases.push(() => release());
    const mediaMarker = 'SYNTHETIC_PENDING_MEDIA'; const run = start(f, { voiceToText: async () => { entered = true; await held; return mediaMarker; } }); await initiallyRetained(run);
    run.app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: PEER, message_id: 99, real_seq: '81999', time: Math.floor(Date.now() / 1000), raw_message: '', sender: { user_id: PEER }, message: [{ type: 'record', data: { file: 'synthetic.amr' } }] });
    await until(() => entered); recall(run.app, 99); recall(run.app); release();
    await until(() => new ChatHistory(f.dataDir).load(PEER).some(message => message.messageId === 99 && message.content === RECALLED_TEXT));
    await until(() => own().some(call => call.content.includes(RECALLED_TEXT) && !call.content.includes(MARKER)));
    assert.ok(calls.every(call => !call.content.includes(mediaMarker)));
});
