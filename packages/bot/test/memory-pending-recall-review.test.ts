import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, type App, type Transport } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory, RECALLED_TEXT } from '../src/memory/history.ts';
import type { HistoryMessage } from '../src/memory/backfill.ts';
import type { MessageEvent } from '../src/platform/onebot.ts';
import type { MediaReader } from '../src/vision/media.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { TierRecord } from '../src/memory/tier-record.ts';

const PEER = 10001, SELF = 20000;
const roots: string[] = [], apps: App[] = [];
let originalFetch: typeof fetch; let networkCalls = 0;
beforeEach(() => {
    originalFetch = globalThis.fetch; networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network in synthetic pending-recall fixture'); };
});
afterEach(() => {
    for (const app of apps.splice(0)) app.stop();
    globalThis.fetch = originalFetch;
    for (const root of roots.splice(0)) {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith('qqbot-pending-recall-'));
        rmSync(root, { recursive: true, force: true });
    }
    assert.equal(networkCalls, 0, '全部提供方均为假实现，不得尝试访问网络');
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-pending-recall-')); roots.push(root);
    const dataDir = join(root, 'bot'); mkdirSync(dataDir);
    for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', description: '合成测试角色' } }));
    const config = parseAppConfig({
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic', timeoutMs: 1000 },
        characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: PEER, tier: 'classmate', name: '合成联系人' }],
        recalls: true, media: true, schedule: false, herDays: false, moody: false, speechCheck: false,
        realWeather: false, proactive: 'off',
    }, root, { QQBOT_LLM_API_KEY: 'synthetic-only-key' });
    return { root, dataDir, config };
}

function runApp(f: ReturnType<typeof fixture>, options: { media?: MediaReader; fetched?: HistoryMessage[]; holdHistory?: Promise<void> } = {}) {
    const prompts: string[] = [], sent: string[] = []; let nextId = 900; let historyCalls = 0;
    const transport: Transport = {
        friendHistory: async () => { historyCalls++; await options.holdHistory; return options.fetched ?? []; },
        sendPrivateText: async (_peer, text) => { sent.push(text); return nextId++; },
    };
    const app = startApp({
        config: f.config, transport, log() {}, ...(options.media ? { media: options.media } : {}),
        mediaTimeouts: { voice: 5000, ocr: 5000, vision: 5000 },
        sensitive: { on: () => false, describe: () => '' },
        pipeline: { generate: async messages => { prompts.push(messages.map(message => message.content).join('\n')); return '合成回复'; }, settle: { quietMs: 0, maxMs: 0 } },
    });
    apps.push(app);
    return { app, prompts, sent, historyCalls: () => historyCalls };
}

function source(kind: 'voice' | 'image', seq = '730001', time = Math.floor(Date.now() / 1000)): MessageEvent {
    return {
        post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: PEER,
        message_id: 741, real_seq: seq, time, raw_message: '', sender: { user_id: PEER },
        message: kind === 'voice' ? [{ type: 'record', data: { file: 'synthetic.amr' } }]
            : [{ type: 'image', data: { file: 'synthetic.jpg', url: 'https://synthetic.invalid/image', sub_type: 0 } }],
    };
}
const recall = (app: App, event: MessageEvent) => app.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: SELF, user_id: PEER, message_id: event.message_id, time: event.time + 1 });
const followUp = (app: App, event: MessageEvent) => app.receive({ ...event, message_id: 742, real_seq: '730099', message: [{ type: 'text', data: { text: '合成后续问题' } }] });
const users = (f: ReturnType<typeof fixture>) => new ChatHistory(f.dataDir).load(PEER).filter(message => message.role === 'user');
async function until(check: () => boolean) {
    const deadline = Date.now() + 2500;
    while (!check()) { if (Date.now() >= deadline) assert.fail('合成等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
    await new Promise(resolve => setTimeout(resolve, 20));
}
function heldReader(text: string) {
    let entered = false; let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const media: MediaReader = {
        voiceToText: async () => { entered = true; await held; return text; },
        ocr: async () => { entered = true; await held; return [text]; },
    };
    return { media, entered: () => entered, release: () => release() };
}

for (const kind of ['voice', 'image'] as const) test(`待解码${kind}先撤回：完成后仅占位，正文不进后续模型提示`, async () => {
    const f = fixture(); const marker = `SYNTHETIC_WITHDRAWN_${kind}`; const reader = heldReader(marker); const run = runApp(f, { media: reader.media });
    try {
        await run.app.connected(SELF); const event = source(kind); run.app.receive(event);
        await until(reader.entered); assert.equal(users(f).length, 0);
        recall(run.app, event); reader.release();
        await until(() => users(f).length === 1);
        assert.equal(users(f)[0]!.content, RECALLED_TEXT);
        followUp(run.app, event); await until(() => users(f).length === 2 && run.prompts.length > 0);
        assert.ok(run.prompts.every(prompt => !prompt.includes(marker)));
    } finally { reader.release(); run.app.stop(); }
});

test('先撤回的语音转写若有明确本人危机，仍保留原文与危机状态', async () => {
    const f = fixture(); const text = '我现在想自杀'; const reader = heldReader(text); const run = runApp(f, { media: reader.media });
    try {
        await run.app.connected(SELF); const event = source('voice'); run.app.receive(event); await until(reader.entered);
        recall(run.app, event); reader.release(); await until(() => users(f).length === 1 && run.prompts.length > 0);
        assert.ok(users(f)[0]!.content.includes(text)); assert.ok(run.prompts.some(prompt => prompt.includes(text)));
        const crisisPath = join(f.dataDir, 'crisis.json'); assert.equal(existsSync(crisisPath), true);
        const crisis = JSON.parse(readFileSync(crisisPath, 'utf8')); assert.ok(crisis.contacts?.[String(PEER)] ?? crisis[String(PEER)]);
    } finally { reader.release(); run.app.stop(); }
});

test('处理中进入休眠仅保存prepared，不追加或生成，醒来后复用解码与撤回', async () => {
    const f = fixture();
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(f.root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', description: '合成测试角色' } }));
    f.config = { ...f.config, dormancy: true, contacts: [{ qq: PEER, tier: 'boyfriend', name: '合成联系人' }] };
    const marker = 'SYNTHETIC_DORMANT_PENDING'; const held = heldReader(marker); let decodes = 0;
    const run = runApp(f, { media: { voiceToText: async id => { decodes++; return held.media.voiceToText!(id); } } });
    const path = join(f.dataDir, 'dormancy.json');
    try {
        await run.app.connected(SELF); const event = source('voice'); run.app.receive(event); await until(held.entered);
        recall(run.app, event);
        writeFileSync(path, JSON.stringify({ state: 'dormant', since: new Date().toISOString(), archive: join(f.root, 'synthetic-archive') }));
        held.release();
        await until(() => Boolean(new ChatHistory(f.dataDir).pendingIncoming(PEER)[0]?.prepared));
        assert.equal(users(f).length, 0); assert.equal(run.prompts.length, 0); assert.equal(run.sent.length, 0);
        writeFileSync(path, JSON.stringify({ state: 'awake' }));
        await run.app.connected(SELF);
        await until(() => users(f).length === 1 && run.prompts.length > 0);
        assert.equal(users(f)[0]!.content, RECALLED_TEXT); assert.equal(decodes, 1);
        assert.ok(run.prompts.every(prompt => !prompt.includes(marker)));
    } finally { held.release(); run.app.stop(); }
});

test('解码前撤回后停止，重启从同源假补回仍遮盖正文', async () => {
    const f = fixture(); const marker = 'SYNTHETIC_RESTART_WITHDRAWN'; const reader = heldReader(marker); const first = runApp(f, { media: reader.media });
    try {
        await first.app.connected(SELF); const event = source('voice'); first.app.receive(event); await until(reader.entered);
        recall(first.app, event); first.app.stop(); reader.release();
        const restarted = runApp(f, { media: { voiceToText: async () => marker }, fetched: [{ message_id: event.message_id, real_seq: event.real_seq, time: event.time, sender: { user_id: PEER }, message: event.message }] });
        try {
            await restarted.app.connected(SELF); await until(() => users(f).length === 1);
            assert.equal(users(f)[0]!.content, RECALLED_TEXT);
            followUp(restarted.app, event); await until(() => users(f).length === 2 && restarted.prompts.length > 0);
            assert.ok(restarted.prompts.every(prompt => !prompt.includes(marker)));
        } finally { restarted.app.stop(); }
    } finally { reader.release(); first.app.stop(); }
});

test('中断的设备命令不自动重做，也不擅自删除其私有原始请求', async () => {
    const f = fixture();
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(f.root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', description: '合成测试角色' } }));
    f.config = { ...f.config, contacts: [{ qq: PEER, tier: 'boyfriend', name: '合成联系人' }] };
    const event = source('voice'); const text = '/屏幕 SYNTHETIC_INTERRUPTED_PRIVATE_REQUEST';
    const history = new ChatHistory(f.dataDir);
    history.stageIncoming(PEER, { source: { role: 'user', time: new Date(event.time * 1000).toISOString(), messageId: event.message_id, messageSeq: event.real_seq }, message: text });
    const run = runApp(f, { fetched: [] });
    try {
        await run.app.connected(SELF);
        assert.equal(users(f).length, 0); assert.equal(run.prompts.length, 0); assert.equal(run.sent.length, 0);
        assert.equal(new ChatHistory(f.dataDir).pendingIncoming(PEER)[0]?.message, text);
        followUp(run.app, event); await until(() => users(f).length === 1 && run.prompts.length > 0);
        assert.ok(run.prompts.every(prompt => !prompt.includes('SYNTHETIC_INTERRUPTED_PRIVATE_REQUEST')));
        assert.equal(new ChatHistory(f.dataDir).pendingIncoming(PEER)[0]?.message, text);
    } finally { run.app.stop(); }
});

test('旧待解码撤回不能遮盖同ID同秒不同源序号的后来新消息', async () => {
    const f = fixture(); const marker = 'SYNTHETIC_OLD_WITHDRAWN'; const reader = heldReader(marker); const run = runApp(f, { media: reader.media });
    try {
        await run.app.connected(SELF); const event = source('voice'); run.app.receive(event); await until(reader.entered);
        recall(run.app, event); reader.release(); await until(() => users(f).length === 1);
        const fresh = { ...event, real_seq: '730002', message: [{ type: 'text', data: { text: 'SYNTHETIC_FRESH_CONTENT' } }] };
        run.app.receive(fresh); await until(() => users(f).length === 2);
        assert.deepEqual(users(f).map(message => message.content), [RECALLED_TEXT, 'SYNTHETIC_FRESH_CONTENT']);
        assert.equal(users(f)[1]!.messageSeq, '730002');
    } finally { reader.release(); run.app.stop(); }
});

test('撤回保存暂时EIO时正文和模型不泄漏，恢复存储后不靠新通知自动完成占位', async () => {
    const f = fixture(); const marker = 'SYNTHETIC_DIRTY_RECALL'; const reader = heldReader(marker); const run = runApp(f, { media: reader.media });
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        await run.app.connected(SELF); const event = source('voice'); run.app.receive(event); await until(reader.entered);
        const recalled = join(f.dataDir, 'chats', `${PEER}.recalled.json`);
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from, to) => { if (String(to) === recalled) throw Object.assign(new Error('SYNTHETIC_PRIVATE_IO'), { code: 'EIO' }); return rename(from, to); }) as typeof rename;
        recall(run.app, event); reader.release(); await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(users(f).length, 0, '撤回未持久时不接受媒体正文'); assert.equal(run.prompts.length, 0);
        fileOps.renameSync = rename; fileOps.writeDelaysMs = delays;
        await until(() => users(f).length === 1);
        assert.equal(users(f)[0]!.content, RECALLED_TEXT);
        followUp(run.app, event); await until(() => users(f).length === 2 && run.prompts.length > 0);
        assert.ok(run.prompts.every(prompt => !prompt.includes(marker)));
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; reader.release(); run.app.stop(); }
});

test('停止后晚媒体结果不追加，重启无任何最近历史仍从持久原始载荷恢复撤回', async () => {
    const f = fixture(); const marker = 'SYNTHETIC_DURABLE_RAW_RECALL'; const reader = heldReader(marker); const first = runApp(f, { media: reader.media });
    try {
        await first.app.connected(SELF); const event = source('voice'); first.app.receive(event); await until(reader.entered);
        recall(first.app, event); first.app.stop(); reader.release(); await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(users(f).length, 0); assert.equal(first.prompts.length, 0);
        let decoded = 0;
        const restarted = runApp(f, { fetched: [], media: { voiceToText: async () => { decoded++; return marker; } } });
        try {
            await restarted.app.connected(SELF); await until(() => users(f).length === 1);
            assert.equal(decoded, 1); assert.equal(users(f)[0]!.content, RECALLED_TEXT);
            followUp(restarted.app, event); await until(() => users(f).length === 2 && restarted.prompts.length > 0);
            assert.ok(restarted.prompts.every(prompt => !prompt.includes(marker)));
        } finally { restarted.app.stop(); }
    } finally { reader.release(); first.app.stop(); }
});

test('prepared暂存重启直接使用持久解码结果，不再次读取媒体或泄漏撤回正文', async () => {
    const f = fixture(); const event = source('voice'); const marker = 'SYNTHETIC_PREPARED_RECALL';
    const history = new ChatHistory(f.dataDir);
    const identity = { role: 'user' as const, messageId: event.message_id, time: new Date(event.time * 1000).toISOString(), messageSeq: event.real_seq };
    const token = history.stageIncoming(PEER, { source: identity, message: event.message });
    history.recall(PEER, event.message_id);
    history.prepareIncoming(PEER, token, { ...identity, content: `[语音：${marker}]` }, () => false);
    let decoded = 0;
    const run = runApp(f, { fetched: [], media: { voiceToText: async () => { decoded++; return '不得使用的新解码'; } } });
    try {
        await run.app.connected(SELF); await until(() => users(f).length === 1);
        assert.equal(decoded, 0); assert.equal(users(f)[0]!.content, RECALLED_TEXT);
        followUp(run.app, event); await until(() => users(f).length === 2 && run.prompts.length > 0);
        assert.ok(run.prompts.every(prompt => !prompt.includes(marker)));
    } finally { run.app.stop(); }
});

test('connected补回还held时缓冲的媒体先撤回，drain后仍占位', async () => {
    const f = fixture(); const marker = 'SYNTHETIC_BUFFERED_RECALL'; let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let decoded = 0;
    const run = runApp(f, { holdHistory: held, media: { voiceToText: async () => { decoded++; return marker; } } });
    try {
        const connecting = run.app.connected(SELF); await until(() => run.historyCalls() === 1);
        const event = source('voice'); run.app.receive(event); recall(run.app, event);
        assert.equal(decoded, 0); assert.equal(users(f).length, 0);
        release(); await connecting; await until(() => users(f).length === 1);
        assert.equal(decoded, 1); assert.equal(users(f)[0]!.content, RECALLED_TEXT);
        followUp(run.app, event); await until(() => users(f).length === 2 && run.prompts.length > 0);
        assert.ok(run.prompts.every(prompt => !prompt.includes(marker)));
    } finally { release?.(); run.app.stop(); }
});

test('更换档位since后旧prepared载荷不进入较低档历史或提示', async () => {
    const f = fixture(); const marker = 'SYNTHETIC_PREVIOUS_TIER_PRIVATE'; const event = source('voice', '730001', Math.floor(Date.now() / 1000) - 120);
    const history = new ChatHistory(f.dataDir);
    const identity = { role: 'user' as const, messageId: event.message_id, time: new Date(event.time * 1000).toISOString(), messageSeq: event.real_seq };
    const token = history.stageIncoming(PEER, { source: identity, message: event.message });
    history.prepareIncoming(PEER, token, { ...identity, content: `[语音：${marker}]` }, () => false);
    const tiers = new TierRecord(join(f.dataDir, 'tiers.json')); tiers.update(PEER, 'boyfriend', new Date((event.time - 1) * 1000));
    tiers.update(PEER, 'classmate', new Date((event.time + 60) * 1000));
    let decoded = 0;
    const run = runApp(f, { fetched: [], media: { voiceToText: async () => { decoded++; return marker; } } });
    try {
        await run.app.connected(SELF); assert.equal(decoded, 0); assert.equal(users(f).length, 0);
        assert.equal(new ChatHistory(f.dataDir).pendingIncoming(PEER)[0]?.prepared?.content, `[语音：${marker}]`, '降档只阻止重放，不擅自删除旧私有待处理资料');
        followUp(run.app, source('voice')); await until(() => users(f).length === 1 && run.prompts.length > 0);
        assert.ok(run.prompts.every(prompt => !prompt.includes(marker)));
    } finally { run.app.stop(); }
});

test('首次stage写入EIO且撤回也失败，恢复IO后无重投仍从RAM源预约自动占位', async () => {
    const f = fixture(); const marker = 'SYNTHETIC_UNPUBLISHED_STAGE'; let decoded = 0;
    const run = runApp(f, { media: { voiceToText: async () => { decoded++; return marker; } } });
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        await run.app.connected(SELF);
        const recalled = join(f.dataDir, 'chats', `${PEER}.recalled.json`);
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from, to) => { if (String(to) === recalled) throw Object.assign(new Error('SYNTHETIC_STAGE_IO'), { code: 'EIO' }); return rename(from, to); }) as typeof rename;
        const event = source('voice'); run.app.receive(event); recall(run.app, event);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(decoded, 0, 'stage未确认持久，不开始媒体读取'); assert.equal(users(f).length, 0); assert.equal(run.prompts.length, 0);
        fileOps.renameSync = rename; fileOps.writeDelaysMs = delays;
        await until(() => users(f).length === 1);
        assert.equal(decoded, 1); assert.equal(users(f)[0]!.content, RECALLED_TEXT);
        followUp(run.app, event); await until(() => users(f).length === 2 && run.prompts.length > 0);
        assert.ok(run.prompts.every(prompt => !prompt.includes(marker)));
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; run.app.stop(); }
});

test('首个dirty撤回不能阻断排队第二来源的撤回观察，IO恢复后两条都占位', async () => {
    const f = fixture(); const marker = 'SYNTHETIC_TWO_DIRTY_RECALLS'; const reader = heldReader(marker); let decoded = 0;
    const run = runApp(f, { media: { voiceToText: async (id, signal) => { decoded++; return reader.media.voiceToText!(id, signal); } } });
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        await run.app.connected(SELF);
        const first = source('voice'); const second = { ...first, message_id: 743, real_seq: '730002' };
        run.app.receive(first); await until(reader.entered); run.app.receive(second);
        const recalled = join(f.dataDir, 'chats', `${PEER}.recalled.json`);
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from, to) => { if (String(to) === recalled) throw Object.assign(new Error('SYNTHETIC_TWO_RECALL_IO'), { code: 'EIO' }); return rename(from, to); }) as typeof rename;
        recall(run.app, first); recall(run.app, second); reader.release(); await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(users(f).length, 0); assert.equal(run.prompts.length, 0);
        fileOps.renameSync = rename; fileOps.writeDelaysMs = delays;
        await until(() => users(f).length === 2);
        assert.deepEqual(users(f).map(message => [message.messageId, message.content]), [[741, RECALLED_TEXT], [743, RECALLED_TEXT]]);
        assert.ok(decoded >= 2, '两条来源均完成自己的媒体解码');
        followUp(run.app, first); await until(() => users(f).length === 3 && run.prompts.length > 0);
        assert.ok(run.prompts.every(prompt => !prompt.includes(marker)));
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; reader.release(); run.app.stop(); }
});
