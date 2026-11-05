import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { diaryWriter } from '../src/life/diary.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import type { HindsightApi, MemoryItem } from '../src/memory/hindsight.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { WrittenSourceIntent } from '../src/memory/written-retain.ts';

const now = new Date('2026-11-09T12:00:00+08:00'), date = '2026-11-06', marker = 'SYNTHETIC_DISABLED_WRITER_SOURCE';
const A = { qq: 10001, tier: 'classmate' as const, name: '合成甲' };
const schedule: Schedule = { sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } },
    semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成学校' };
async function fixture(pending: boolean | 'summary' = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-disabled-writer-')), dataDir = join(root, 'data'), dir = join(dataDir, 'memory'); mkdirSync(dir, { recursive: true });
    const documents = new Map<string, MemoryItem>(), operations = new Set<string>(), pendingOperations = new Set<string>(), history = new ChatHistory(dataDir);
    history.append(A.qq, { role: 'user', content: marker, time: '2026-11-06T12:00:00+08:00', messageId: 1 });
    const api: HindsightApi = { putBank: async () => {}, retain: async () => { assert.fail('advanced writer cannot use legacy retain'); },
        submitRetain: async (_bank, item, id) => {
            operations.add(id); documents.set(item.document_id!, structuredClone(item));
            if (pending === true || pending === 'summary' && !item.document_id!.startsWith('diary:')) pendingOperations.add(id);
        }, retentionStatus: async (_bank, id) => operations.has(id) ? pendingOperations.has(id) ? 'pending' : 'completed' : 'not_found',
        recall: async () => [], getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '',
        getDocument: async (_bank, id) => documents.has(id) ? { original_text: documents.get(id)!.content } : undefined };
    const create = () => new LongTermMemory({ dir, api, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, now: () => now.getTime(), log() {} });
    const memory = create();
    const writerOptions = { dir, memory, sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [A], history,
        sourceSince: () => undefined, generate: async () => marker, log() {} };
    const writer = diaryWriter(writerOptions); await writer.catchUp(now); await writer.stop(); await memory.stop();
    const state = JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8'));
    if (pending === true) assert.equal(state.prepared[`diary:${date}`].phase, 'dispatched');
    else if (pending === 'summary') assert.equal(state.prepared['week:2026-11-02'].phase, 'dispatched');
    else assert.equal(state.confirmed[`diary:${date}`].sourceVerified, true);
    assert.ok(documents.has(`diary:${date}`));
    assert.ok(Object.values(JSON.parse(readFileSync(join(dir, 'written-retain.json'), 'utf8')).operations).length > 0);
    return { root, dataDir, dir, api, create, documents, history, writerOptions };
}
function clean(root: string) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-disabled-writer-')); rmSync(root, { recursive: true, force: true }); }
function intents(dir: string): WrittenSourceIntent[] {
    const saved = JSON.parse(readFileSync(join(dir, 'written-retain.json'), 'utf8'));
    return Object.values(saved.current).map(id => {
        const { documentId, operationId, requestHash, phase } = saved.operations[String(id)]; return { documentId, operationId, requestHash, phase };
    });
}

test('真实App移除全部schedule后不能让已完成日记绕过不可核验来源的保护', async () => {
    const f = await fixture(), originalFetch = globalThis.fetch, originalBankId = LongTermMemory.prototype.commonBankId;
    let app: App | undefined, appMemory: LongTermMemory | undefined;
    const logs: string[] = []; let documentReads = 0;
    try {
        // The former author's messages still exist, but the current tier view
        // no longer permits them. No recall marker is used to trigger ADR0242.
        writeFileSync(join(f.dataDir, 'tiers.json'), JSON.stringify({ [A.qq]: { tier: A.tier, since: '2026-11-07T00:00:00Z' } }));
        for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(f.root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(f.root, 'synthetic-{tier}.json'), dataDir: f.dataDir,
            contacts: [A], memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic', timeoutMs: 1000, recallTimeoutMs: 100 },
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, f.root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async (input, init) => {
            const url = new URL(String(input)); assert.equal(url.origin, 'http://synthetic.invalid');
            if (!init?.method || init.method === 'GET') {
                const id = url.pathname.split('/documents/')[1];
                if (id) { documentReads++; const item = f.documents.get(decodeURIComponent(id)); return item ? Response.json({ original_text: item.content }) : new Response('', { status: 404 }); }
            }
            throw new Error('Unexpected synthetic startup request');
        };
        // Capture the instance that the real App owns via its existing startup
        // bank diagnostic; this does not change reads or source-check behavior.
        LongTermMemory.prototype.commonBankId = function () { appMemory = this; return originalBankId.call(this); };
        app = startApp({ config, transport: { friendHistory: async () => [], sendPrivateText: async () => 99 }, log: line => logs.push(line),
            pipeline: { now: () => now.getTime(), generate: async () => { assert.fail('No real model generation in source-disabled probe'); }, settle: { quietMs: 0, maxMs: 0 } } });
        LongTermMemory.prototype.commonBankId = originalBankId;
        assert.ok(logs.some(line => line.includes('她的日记：不写'))); assert.ok(appMemory);
        assert.equal(await appMemory.readDiary(date), undefined, '无writer不能把旧completed/body当来源仍有效');
        assert.equal(documentReads, 0);
    } finally { LongTermMemory.prototype.commonBankId = originalBankId; await app?.stop(); globalThis.fetch = originalFetch; clean(f.root); }
});

test('outbox已有completed但writer来源收据丢失时，重建writer不能把空confirmed当clean', async () => {
    const f = await fixture(), memory = f.create(); let writer: ReturnType<typeof diaryWriter> | undefined;
    try {
        const original = readFileSync(join(f.dir, 'diary.json'), 'utf8');
        unlinkSync(join(f.dir, 'diary.json'));
        writer = diaryWriter({ ...f.writerOptions, memory }); memory.setWrittenSourceVerifier(intents => writer!.verifySources(now, intents));
        assert.equal(await memory.readDiary(date), undefined, '原bank已发生的written intent没有对应来源，不能凭新空文件解封');
        assert.equal(f.documents.get(`diary:${date}`)!.content.includes(marker), true, '保留真实远端完成事实，不猜删除');
        writeFileSync(join(f.dir, 'diary.json'), original);
        assert.equal(await memory.readDiary(date), marker, '恢复原来源证据可重新核验，缺证本身不能制造永久污染');
    } finally { await writer?.stop(); await memory.stop(); clean(f.root); }
});

test('无writer且没有authored intent的正常App仍可读取公共QQ原始事实及私人关系', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-disabled-writer-')), dataDir = join(root, 'data'), dir = join(dataDir, 'memory'); mkdirSync(dir, { recursive: true });
    const originalFetch = globalThis.fetch, originalBankId = LongTermMemory.prototype.commonBankId;
    let app: App | undefined, appMemory: LongTermMemory | undefined;
    const api: HindsightApi = { putBank: async () => {}, retain: async () => {}, recall: async () => [], getMentalModel: async () => undefined,
        createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '' };
    const seed = new LongTermMemory({ api, dir, bankPrefix: 'synthetic', common: true, recallTimeoutMs: 100, now: () => now.getTime(), log() {} });
    try {
        await seed.sync(A, { user: A.name, char: '合成角色' }, [{ role: 'user', content: 'SYNTHETIC_SAFE_QQ_SOURCE', time: '2026-11-08T12:00:00+08:00' }]); await seed.stop();
        for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [A], memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic', timeoutMs: 1000, recallTimeoutMs: 100 },
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async input => {
            const url = new URL(String(input)); assert.equal(url.origin, 'http://synthetic.invalid');
            if (url.pathname.endsWith('/memories/recall')) return Response.json({ results: [{ id: 'safe', type: 'experience', text: 'SYNTHETIC_SAFE_OTHER_QQ_FACT', document_id: '2222222222222222:ep-1', mentioned_at: now.toISOString() }] });
            if (url.pathname.endsWith('/mental-models/relationship')) return Response.json({ id: 'relationship', content: 'SYNTHETIC_PRIVATE_SAFE_RELATIONSHIP' });
            throw new Error('Unexpected synthetic baseline route');
        };
        LongTermMemory.prototype.commonBankId = function () { appMemory = this; return originalBankId.call(this); };
        app = startApp({ config, transport: { friendHistory: async () => [], sendPrivateText: async () => 99 }, log() {}, pipeline: { now: () => now.getTime() } });
        LongTermMemory.prototype.commonBankId = originalBankId; assert.ok(appMemory);
        assert.equal(appMemory.derivedAvailable(), true);
        const recalled = await appMemory.recallCommon(A, [{ role: 'user', content: '合成查询' }], now, [A]); assert.match(recalled!, /SAFE_OTHER_QQ_FACT/);
        appMemory.relationship(A); await new Promise<void>(done => setImmediate(done)); assert.match(appMemory.relationship(A)!, /PRIVATE_SAFE_RELATIONSHIP/);
    } finally { LongTermMemory.prototype.commonBankId = originalBankId; await app?.stop(); await seed.stop(); globalThis.fetch = originalFetch; clean(root); }
});

test('同步来源复核验证早期时间戳但不为完全更早历史逐条计算herDay', async () => {
    const f = await fixture(), memory = f.create(); let writer: ReturnType<typeof diaryWriter> | undefined;
    try {
        let sleepReads = 0, rows = f.history.load(A.qq);
        const traced = structuredClone(schedule); Object.defineProperty(traced, 'sleep', { enumerable: true, get: () => { sleepReads++; return '02:00'; } });
        writer = diaryWriter({ ...f.writerOptions, memory, sources: { ...f.writerOptions.sources, schedule: traced }, history: { load: () => rows } });
        assert.equal(writer.verifySources(now, intents(f.dir)), true); const baseline = sleepReads; sleepReads = 0;
        const old = Array.from({ length: 5000 }, (_, i) => ({ role: 'user' as const, time: '2026-01-01T12:00:00Z', content: `SYNTHETIC_OLD_${i}`, messageId: i + 100 }));
        rows = [...old, ...f.history.load(A.qq)]; assert.equal(writer.verifySources(now, intents(f.dir)), true);
        assert.equal(sleepReads, baseline, '早于最早所需当地日的历史不应做5000次herDay/schedule投影');
        rows = [{ role: 'user', time: '2026-02-30T00:00:00Z', content: 'SYNTHETIC_INVALID_OLD' }, ...rows];
        assert.throws(() => writer!.verifySources(now, intents(f.dir)), error => !String(error).includes('INVALID_OLD'));
    } finally { await writer?.stop(); await memory.stop(); clean(f.root); }
});

test('最早当地日边界按真实instant比较，UTC前一日02点消息仍参与来源', async () => {
    const f = await fixture(), memory = f.create(); let writer: ReturnType<typeof diaryWriter> | undefined;
    try {
        let rows = f.history.load(A.qq);
        writer = diaryWriter({ ...f.writerOptions, memory, history: { load: () => rows } });
        rows = [{ role: 'user', content: 'SYNTHETIC_OLD_LAST_INSTANT', time: '2026-11-05T15:59:59.999Z' }, ...rows];
        assert.equal(writer.verifySources(now, intents(f.dir)), true);
        rows = [{ role: 'user', content: 'SYNTHETIC_FIRST_HER_DAY_MESSAGE', time: '2026-11-05T18:00:00Z' }, ...rows];
        assert.equal(writer.verifySources(now, intents(f.dir)), false, '不能按UTC日期前缀误跳过当地02点这条有效来源');
    } finally { await writer?.stop(); await memory.stop(); clean(f.root); }
});

test('同UUID prepared必须有fresh来源才覆盖，正常pending不自锁且失配后不重发正文', async () => {
    const f = await fixture(true), memory = f.create(); let writer: ReturnType<typeof diaryWriter> | undefined;
    try {
        let since: string | undefined;
        writer = diaryWriter({ ...f.writerOptions, memory, sourceSince: () => since });
        memory.setWrittenSourceVerifier(view => writer!.verifySources(now, view));
        assert.equal(writer.verifySources(now, intents(f.dir)), true);
        assert.equal(memory.derivedAvailable(), true, '有matching pending来源不能因prepare本身而自锁');
        const before = readFileSync(join(f.dir, 'diary.json'), 'utf8'), fake = intents(f.dir).map(intent => ({ ...intent, operationId: '33333333-3333-4333-8333-333333333333' }));
        assert.equal(writer.verifySources(now, fake), false); assert.equal(readFileSync(join(f.dir, 'diary.json'), 'utf8'), before);
        since = '2026-11-07T00:00:00Z'; assert.equal(writer.verifySources(now, intents(f.dir)), false);
        assert.equal(await memory.readDiary(date), undefined); assert.equal(f.documents.get(`diary:${date}`)!.content.includes(marker), true);
    } finally { await writer?.stop(); await memory.stop(); clean(f.root); }
});

test('pending summary同步以本地确认依赖重算；缺正文只拒证，恢复后可再核且不远读', async () => {
    const f = await fixture('summary'), memory = f.create(); let writer: ReturnType<typeof diaryWriter> | undefined;
    try {
        writer = diaryWriter({ ...f.writerOptions, memory }); memory.setWrittenSourceVerifier(view => writer!.verifySources(now, view));
        const original = readFileSync(join(f.dir, 'diary.json'), 'utf8'), view = intents(f.dir), pending = view.find(intent => intent.documentId === 'week:2026-11-02')!;
        assert.equal(writer.verifySources(now, view), true); assert.equal(memory.derivedAvailable(), true);
        const state = JSON.parse(original); delete state.texts[date]; writeFileSync(join(f.dir, 'diary.json'), JSON.stringify(state));
        const remote = f.api.getDocument; f.api.getDocument = async () => { assert.fail('同步summary来源核验不能fallback远端'); };
        assert.equal(writer.verifySources(now, [pending]), false);
        assert.equal(Object.keys(JSON.parse(readFileSync(join(f.dir, 'written-retain.json'), 'utf8')).blockedBanks).length, 0, '缺本地正文不等于已知来源变更');
        writeFileSync(join(f.dir, 'diary.json'), original); f.api.getDocument = remote;
        assert.equal(writer.verifySources(now, view), true); assert.equal(memory.derivedAvailable(), true);
    } finally { await writer?.stop(); await memory.stop(); clean(f.root); }
});

test('其它bank的历史written intent不关闭新prefix，切回原prefix仍须匹配来源', async () => {
    const f = await fixture();
    const next = new LongTermMemory({ dir: f.dir, api: f.api, bankPrefix: 'synthetic-new', common: true, recallTimeoutMs: 100, now: () => now.getTime(), log() {} });
    const prior = f.create();
    try {
        next.setWrittenSourceVerifier(null); prior.setWrittenSourceVerifier(null);
        assert.equal(next.derivedAvailable(), true); assert.equal(prior.derivedAvailable(), false);
        assert.equal(f.documents.get(`diary:${date}`)!.content.includes(marker), true);
    } finally { await next.stop(); await prior.stop(); clean(f.root); }
});
