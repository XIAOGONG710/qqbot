import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import type { HindsightApi } from '../src/memory/hindsight.ts';
import { RELEVANCE_SYSTEM } from '../../../dsh-plugins/dsh-linmengyao-memory/memory-relevance.mjs';

// 记忆相关性判断经 app.ts 走一轮（硬编码改造第三批）：合成角色、合成记忆，Hindsight 和模型都是假的（fetch 只认 synthetic.invalid）

const OWNER = { qq: 10003, tier: 'boyfriend', name: '合成男友' }, OTHER = { qq: 10004, tier: 'bestie', name: '合成另一账号' };
const MEMORIES = ['合成男友说过周末想爬山', '合成男友的猫把杯子打翻了', '你说过怕晒'];
const OTHER_SECRET = '另一账号私聊里的合成秘密';
const roots: string[] = [], apps: App[] = [];
let originalFetch: typeof fetch, originalSwitch: string | undefined;
let ownerBank = '', otherBank = '', hang = false;
beforeEach(() => {
    originalFetch = globalThis.fetch; originalSwitch = process.env.QQBOT_MEMORY_RELEVANCE; hang = false;
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input)); assert.equal(url.origin, 'http://synthetic.invalid', '不得请求实际记忆服务');
        const bank = decodeURIComponent(url.pathname.split('/banks/')[1]?.split('/')[0] ?? '');
        if (url.pathname.endsWith('/memories/recall')) {
            if (hang) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
            const results = bank === ownerBank ? MEMORIES.map((text, i) => ({ id: `m-${i}`, document_id: `note-${i}`, type: 'world', text }))
                : bank === otherBank ? [{ id: 'x', document_id: 'note-x', type: 'world', text: OTHER_SECRET }] : [];
            return Response.json({ results });
        }
        if (url.pathname.endsWith('/entities')) return Response.json({ total: 0, items: [] });
        if (url.pathname.includes('/mental-models/')) return new Response('', { status: 404 });
        if (url.pathname.endsWith('/operations')) return Response.json({ bank_id: bank, total: 0, operations: [] });
        return Response.json({});
    };
});
afterEach(async () => {
    await Promise.allSettled(apps.splice(0).map(app => app.stop()));
    globalThis.fetch = originalFetch;
    if (originalSwitch === undefined) delete process.env.QQBOT_MEMORY_RELEVANCE; else process.env.QQBOT_MEMORY_RELEVANCE = originalSwitch;
    for (const root of roots.splice(0)) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-relevance-app-')); rmSync(root, { recursive: true, force: true }); }
});
async function until(check: () => boolean) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) assert.fail('synthetic timeout'); await new Promise(done => setTimeout(done, 5)); } }

async function run(options: { relevance: boolean; judge?: string; from?: { qq: number; tier: string; name: string } }) {
    if (options.relevance) process.env.QQBOT_MEMORY_RELEVANCE = '1'; else delete process.env.QQBOT_MEMORY_RELEVANCE;
    const root = mkdtempSync(join(tmpdir(), 'qqbot-relevance-app-')); roots.push(root);
    const dataDir = join(root, 'bot'); mkdirSync(dataDir);
    for (const tier of ['classmate', 'classmate-open', 'bestie', 'bestie-open', 'boyfriend', 'boyfriend-open']) writeFileSync(join(root, `${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, '{tier}.json'), dataDir, contacts: [OWNER, OTHER],
        memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic', timeoutMs: 1000, recallTimeoutMs: 150 },
        schedule: false, moody: false, speechCheck: false, herDays: false, realWorld: false, proactive: 'off',
    }, root, { QQBOT_LLM_API_KEY: 'synthetic' });
    // 先让两个人的 bank 都建好（假的 Hindsight 只记 bank 名）
    const history = new ChatHistory(dataDir), time = new Date(Date.now() - 3600_000).toISOString();
    history.append(OWNER.qq, { role: 'user', time, content: '合成的旧话', messageId: 1 });
    history.append(OTHER.qq, { role: 'user', time, content: '合成的旧话', messageId: 2 });
    const fake: HindsightApi = { putBank: async () => {}, retain: async () => {}, recall: async () => [], getMentalModel: async () => undefined,
        createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => 'synthetic' };
    const seed = new LongTermMemory({ api: fake, dir: join(dataDir, 'memory'), bankPrefix: 'synthetic', recallTimeoutMs: 100, log() {} });
    await seed.sync(OWNER, { char: '合成角色', user: OWNER.name }, history.load(OWNER.qq));
    await seed.sync(OTHER, { char: '合成角色', user: OTHER.name }, history.load(OTHER.qq));
    ownerBank = seed.bankId(OWNER); otherBank = seed.bankId(OTHER);
    await seed.stop();
    const prompts: string[] = [], logs: string[] = [], sent: string[] = [];
    let asked = 0;
    const app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
        transport: { friendHistory: async () => [], sendPrivateText: async (_, text) => { sent.push(text); return 9; } }, pipeline: { generate: async messages => {
            const text = messages.map(m => m.content).join('\n');
            if (text.includes(RELEVANCE_SYSTEM)) { asked++; return options.judge ?? '{"keep":[],"uncertainty":0}'; }
            prompts.push(text); return '合成回复';
        }, settle: { quietMs: 0, maxMs: 0 } } });
    apps.push(app);
    const from = options.from ?? OWNER;
    app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: from.qq, message_id: 50, real_seq: '950050',
        time: Math.floor(Date.now() / 1000), sender: { user_id: from.qq }, raw_message: '', message: [{ type: 'text', data: { text: '周末想去爬山，你上次说怕晒' } }] });
    await until(() => sent.length >= 1);
    return { prompts, logs, asked };
}

test('开着：只问一次，他的私人记忆那一段只留挑中的；关着：不问、照规则全放；日志不记内容和 QQ 号', async () => {
    const on = await run({ relevance: true, judge: '{"keep":[1,3],"uncertainty":0.1}' });
    assert.equal(on.asked, 1);
    assert.ok(on.prompts[0]!.includes(MEMORIES[0]!) && on.prompts[0]!.includes(MEMORIES[2]!));
    assert.ok(!on.prompts[0]!.includes(MEMORIES[1]!));
    assert.ok(!on.prompts[0]!.includes(OTHER_SECRET), '别人的私聊记忆读不到');
    const line = on.logs.find(entry => entry.includes('记忆相关性'));
    assert.equal(line, '记忆相关性：候选 3 条，留 2 条，不确定性 0.1');
    const off = await run({ relevance: false });
    assert.equal(off.asked, 0);
    for (const memory of MEMORIES) assert.ok(off.prompts[0]!.includes(memory));
    assert.ok(!off.logs.some(entry => entry.includes('记忆相关性')));
});

test('模型答非所问或想挑进别的编号：照规则全放；别人的照样读不到', async () => {
    const bad = await run({ relevance: true, judge: '{"keep":[1,2,3,4],"uncertainty":0}' });
    assert.equal(bad.asked, 1);
    for (const memory of MEMORIES) assert.ok(bad.prompts[0]!.includes(memory));
    assert.ok(!bad.prompts[0]!.includes(OTHER_SECRET));
    assert.ok(bad.logs.some(entry => entry === '记忆相关性：照规则全放（回答读不懂），候选 3 条'));
});

test('另一个账号来问：只读她自己的 bank，读不到男朋友的；不是男朋友档也不问相关性', async () => {
    const other = await run({ relevance: true, judge: '{"keep":[1],"uncertainty":0}', from: OTHER });
    assert.equal(other.asked, 0);
    assert.ok(other.prompts[0]!.includes(OTHER_SECRET));
    for (const memory of MEMORIES) assert.ok(!other.prompts[0]!.includes(memory));
});

test('记忆超时：这一轮不带记忆照常回，也不问相关性', async () => {
    hang = true;
    const slow = await run({ relevance: true, judge: '{"keep":[],"uncertainty":0}' });
    assert.equal(slow.asked, 0);
    for (const memory of MEMORIES) assert.ok(!slow.prompts[0]!.includes(memory));
    assert.equal(slow.prompts.length, 1, '照常生成了回复');
});
