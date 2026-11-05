import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { promiseKeeper } from '../src/life/promises.ts';

const A = { qq: 10001, tier: 'boyfriend' as const, name: '合成甲' }, B = { qq: 10002, tier: 'boyfriend' as const, name: '合成乙' };
const roots: string[] = [], apps: App[] = [], releases: (() => void)[] = [];
const at = (clock: string) => new Date(`2026-11-05T${clock}:00`);
const answer = JSON.stringify({ add: [{ what: '合成晚饭约定', date: '2026-11-05', meet: { time: '18:00', where: '合成门口' } }], resolved: [] });
let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = globalThis.fetch; globalThis.fetch = async input => {
    assert.ok(String(input).startsWith('http://synthetic.invalid/')); return new Response('', { status: 503 });
}; });
afterEach(async () => {
    const drains = apps.splice(0).map(app => app.stop()); for (const release of releases.splice(0)) release(); await Promise.allSettled(drains); globalThis.fetch = originalFetch;
    for (const root of roots.splice(0)) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-promise-app-')); rmSync(root, { recursive: true, force: true }); }
});
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) assert.fail('synthetic timeout'); await new Promise(done => setTimeout(done, 5)); } }
function fixture(content = '好，18点合成门口见') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-promise-app-')); roots.push(root); const dataDir = join(root, 'bot'); mkdirSync(dataDir);
    const schedule = { sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } }, semester: { start: '2026-09-01', weeks: 20 },
        holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [], free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成学校' };
    for (const tier of ['classmate', 'classmate-open', 'boyfriend', 'boyfriend-open']) writeFileSync(join(root, `${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule } } } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, '{tier}.json'), dataDir, contacts: [A, B],
        memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic', timeoutMs: 100, recallTimeoutMs: 50 }, recalls: true, schedule: true, moody: false,
        speechCheck: false, herDays: false, realWeather: false, proactive: 'off' }, root, { QQBOT_LLM_API_KEY: 'synthetic' });
    const history = new ChatHistory(dataDir);
    history.append(A.qq, { role: 'assistant', time: at('17:30').toISOString(), content: '今晚18点一起去门口吃个饭吗？', messageId: 1 });
    history.append(A.qq, { role: 'user', time: at('17:31').toISOString(), content, messageId: 2 });
    return { root, dataDir, history, config, promisePath: join(dataDir, 'promises', '10001-boyfriend.json') };
}
function start(f: ReturnType<typeof fixture>, options: { heldExtract?: boolean } = {}) {
    let clock = at('17:35').getTime(), extracts = 0; const prompts: string[] = [], logs: string[] = [];
    let releaseExtract!: (text: string) => void; const held = new Promise<string>(done => { releaseExtract = done; }); releases.push(() => releaseExtract('{}'));
    const app = startApp({ config: f.config, log: text => logs.push(text), sensitive: { on: () => false, describe: () => '' }, transport: { friendHistory: async () => [], sendPrivateText: async () => 999 },
        pipeline: { now: () => clock, waitUntil: async deadline => { clock = Math.max(clock, deadline); }, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
            if (messages[0]?.content.includes('你在帮一个聊天程序记')) { extracts++; return options.heldExtract ? held : answer; }
            prompts.push(messages.map(message => message.content).join('\n'));
            return new Promise<string>(release => releases.push(() => release('合成迟到回复')));
        } } }); apps.push(app);
    return { app, prompts, logs, extracts: () => extracts, releaseExtract, advance: () => { clock = at('18:10').getTime(); } };
}
function recall(app: App) { app.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: 20000, user_id: A.qq, message_id: 2 }); }
function ask(app: App, qq = B.qq, id = 90) { app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: qq, message_id: id, real_seq: String(900000 + id),
    time: Math.floor(at('18:10').getTime() / 1000), sender: { user_id: qq }, raw_message: '', message: [{ type: 'text', data: { text: '你现在在干嘛' } }] }); }
const appointed = (prompts: string[]) => prompts.some(prompt => /正在赴约|约了人（|约好的：|快出门了.*约/.test(prompt));

test('真实App早提取held期间撤回未答确认，晚结果不进入下一个联系人的赴约提示', async () => {
    const f = fixture(), run = start(f, { heldExtract: true }); await run.app.connected(20000); await until(() => run.extracts() === 1);
    recall(run.app); assert.equal(new ChatHistory(f.dataDir).load(A.qq).at(-1)!.recalled, true); run.releaseExtract(answer);
    // Wait for the extraction continuation, without requiring another sync cycle.
    await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
    run.advance(); ask(run.app); await until(() => run.prompts.some(prompt => prompt.includes('你现在在干嘛')));
    assert.equal(appointed(run.prompts), false);
});

test('已保存early在撤回后立即经App读口失效，重启也不恢复旧约', async () => {
    const f = fixture(); const keeper = promiseKeeper({ contacts: [A], history: f.history, names: () => ({ char: '合成角色', user: A.name }), dir: join(f.dataDir, 'promises'), now: () => at('17:35').getTime(), extract: async () => answer, log() {} });
    await keeper.sync(); await keeper.stop(); assert.equal(JSON.parse(readFileSync(f.promisePath, 'utf8')).promises.length, 1);
    const first = start(f); recall(first.app); first.advance(); ask(first.app); try { await until(() => first.prompts.length > 0); } catch { assert.fail(first.logs.join('\n')); } assert.equal(appointed(first.prompts), false);
    await first.app.stop(); const restarted = start(f); restarted.advance(); ask(restarted.app, B.qq, 91); await until(() => restarted.prompts.length > 0); assert.equal(appointed(restarted.prompts), false);
});

test('已经回复的约定与危机keep不因撤回通知失效', async () => {
    for (const kind of ['answered', 'crisis'] as const) {
        const f = fixture(kind === 'crisis' ? '好，18点门口见，我想自杀' : undefined);
        if (kind === 'answered') f.history.append(A.qq, { role: 'assistant', time: at('17:32').toISOString(), content: '好的，约好了', messageId: 3 });
        const keeper = promiseKeeper({ contacts: [A], history: f.history, names: () => ({ char: '合成角色', user: A.name }), dir: join(f.dataDir, 'promises'), now: () => at('17:35').getTime(), extract: async () => answer, log() {} });
        await keeper.sync(); await keeper.stop(); assert.ok(existsSync(f.promisePath));
        const run = start(f); recall(run.app); run.advance(); ask(run.app); await until(() => run.prompts.length > 0); assert.equal(appointed(run.prompts), true, kind); await run.app.stop();
    }
});

test('一个联系人撤回只使该来源早约失效，另一联系人有效约仍进入真实赴约提示', async () => {
    const f = fixture();
    f.history.append(B.qq, { role: 'assistant', time: at('17:30').toISOString(), content: '今晚18点一起去门口吃个饭吗？', messageId: 11 });
    f.history.append(B.qq, { role: 'user', time: at('17:31').toISOString(), content: '好，18点见', messageId: 12 });
    const keeper = promiseKeeper({ contacts: [A, B], history: f.history, names: contact => ({ char: '合成角色', user: contact.name }), dir: join(f.dataDir, 'promises'), now: () => at('17:35').getTime(), extract: async () => answer, log() {} });
    await keeper.sync(); await keeper.stop();
    const run = start(f); recall(run.app); run.advance(); ask(run.app, A.qq); await until(() => run.prompts.length > 0);
    assert.ok(run.prompts.some(prompt => prompt.includes('约了人（')), '仍然赴另一联系人的有效约');
    assert.ok(run.prompts.every(prompt => !prompt.includes('约好的：')), '不能优先赴当前联系人已失效的约');
});
