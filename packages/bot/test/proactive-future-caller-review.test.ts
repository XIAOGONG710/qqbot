import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResponder, type InitiateRequest, type ResponderDeps } from '../src/social/responder.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const now = Date.parse('2026-11-05T12:00:00Z');
const message = (role: StoredMessage['role'], offset: number, content = '合成消息'): StoredMessage => ({ role, time: new Date(now + offset).toISOString(), content });
const request = (): InitiateRequest => ({ label: '合成主动', note: '合成', topic: '合成', maxBubbles: 1, dryRun: true, commit() {} });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(stored: StoredMessage[], patch: Partial<ResponderDeps> = {}) {
    const prompted: StoredMessage[] = [];
    const responder = createResponder({
        userId: 1, history: { load: () => [...stored], append: (_id, value) => { stored.push(value); } }, now: () => now,
        buildPrompt: history => { prompted.push(...history as StoredMessage[]); return { messages: [], activatedWorldInfo: [] }; },
        generate: async () => '合成主动内容', clean: value => value, send: async () => 1, log() {}, ...patch,
    });
    return { responder, prompted };
}

test('未来user及无效时间不能挡住真实主动入口，过去未回user仍会挡住', async () => {
    for (const stored of [[message('user', 1)], [{ ...message('user', 0), time: 'invalid' }]]) {
        const f = fixture(stored);
        try { assert.equal((await f.responder.initiate(request())).result, 'dryRun'); }
        finally { f.responder.stop(); }
    }
    const f = fixture([message('user', 0)]);
    try { assert.equal((await f.responder.initiate(request())).result, 'skipped'); }
    finally { f.responder.stop(); }
});

test('主动/内心提示只传已发生有限时间消息', async () => {
    for (const think of [false, true]) {
        const f = fixture([message('assistant', -1, '已发生'), message('assistant', 1, '未来内容'), { ...message('assistant', 0), time: 'invalid' }]);
        try {
            await f.responder.initiate({ ...request(), think });
            assert.deepEqual(f.prompted.map(message => message.content), ['已发生']);
        } finally { f.responder.stop(); }
    }
});

test('生成期间新增未来user不丢合法草稿，索引基于原始历史长度', async () => {
    let release!: (value: string) => void;
    const stored = [message('assistant', 1), message('assistant', 2), message('user', -2), message('assistant', -1)];
    const f = fixture(stored, { generate: () => new Promise(resolve => { release = resolve; }) });
    try {
        const task = f.responder.initiate(request()); await tick();
        stored.push(message('user', 1)); release('合成主动内容');
        assert.equal((await task).result, 'dryRun');
    } finally { release?.('清理'); f.responder.stop(); }
});

test('生成期间已发生新增user仍取消草稿且不commit', async () => {
    let release!: (value: string) => void; let commits = 0;
    const stored: StoredMessage[] = [];
    const f = fixture(stored, { generate: () => new Promise(resolve => { release = resolve; }) });
    try {
        const task = f.responder.initiate({ ...request(), commit() { commits++; } }); await tick();
        stored.push(message('user', 0)); release('合成主动内容');
        assert.equal((await task).result, 'skipped'); assert.equal(commits, 0);
    } finally { release?.('清理'); f.responder.stop(); }
});

test('气泡之间也用相同事实时界：未来插话不打断，已发生插话会停后续', async () => {
    for (const offset of [1, 0]) {
        const stored: StoredMessage[] = []; let sent = 0;
        const f = fixture(stored, {
            generate: async () => '合成第一句\n合成第二句', sleep: async () => {},
            send: async () => { if (++sent === 1) stored.push(message('user', offset)); return sent; },
        });
        try {
            const outcome = await f.responder.initiate({ ...request(), maxBubbles: 2, dryRun: false });
            assert.equal(outcome.result, 'sent'); assert.equal(sent, offset ? 2 : 1);
        } finally { f.responder.stop(); }
    }
});
