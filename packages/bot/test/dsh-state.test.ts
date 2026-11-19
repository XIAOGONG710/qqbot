import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { dshStateSource, type DshStateDeps } from '../src/dsh-state.ts';

// 给 DSH 的脱敏状态摘要和 STATE.json（ADR 0336 第 6 步从 app.ts 搬出来时补的测试：行为基线里没有开 DSH 的场景）
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const owner = { qq: 1001, name: '他', tier: 'boyfriend' } as DshStateDeps['deviceOwner'];

function setup(overrides: Partial<DshStateDeps> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-state-'));
    const logs: string[] = [];
    const removed: string[] = [];
    const deps: DshStateDeps = {
        dshEnabled: true,
        needsAnchor: { at: new Date(NOW - 2 * 3_600_000).toISOString(), energy: 60, hunger: 40, stress: 30 },
        sharedWorld: undefined,
        deviceOwner: owner,
        history: {
            load: () => [
                { time: new Date(NOW - 10 * 60_000).toISOString(), role: 'user', content: '今天好累' },
                { time: new Date(NOW - 9 * 60_000).toISOString(), role: 'assistant', content: '抱抱' },
            ],
            append: () => {},
        } as unknown as DshStateDeps['history'],
        aiPhotoDrafts: {
            status: () => ({ total: 3, pending: 1, approved: 2, rejected: 0 }),
            list: () => [{ kind: 'cat', status: 'pending_review' }],
        } as unknown as DshStateDeps['aiPhotoDrafts'],
        worldNow: () => NOW,
        exec: { files: { remove: (path: string) => { removed.push(path); } } } as unknown as DshStateDeps['exec'],
        dshStateFile: join(dir, 'soul', 'STATE.json'),
        log: message => { logs.push(message); },
        ...overrides,
    };
    return { deps, dir, logs, removed, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('DSH 状态摘要', () => {
    test('有需要锚点时给数值、关系、趋势和照片草稿的计数，不带聊天原文', () => {
        const { deps, cleanup } = setup();
        try {
            const state = dshStateSource(deps).dshState();
            assert.ok(state);
            assert.equal(state.at, new Date(NOW).toISOString());
            assert.equal(state.tier, 'boyfriend');
            assert.deepEqual(Object.keys(state.needs!).sort(), ['energy', 'hunger', 'stress']);
            assert.ok(Number.isFinite(state.values!.mood));
            assert.ok(state.relationship);
            assert.ok(state.development);
            assert.equal(state.trends!.windowMinutes, 60);
            assert.deepEqual(state.photoDrafts, { pending: 1, approved: 2, rejected: 0, lastKind: 'cat', lastStatus: 'pending_review' });
            assert.doesNotMatch(JSON.stringify(state), /今天好累|抱抱/);
        } finally { cleanup(); }
    });

    test('没有需要锚点就没有摘要，写快照时删掉旧的', () => {
        const { deps, removed, cleanup } = setup({ needsAnchor: undefined });
        try {
            const source = dshStateSource(deps);
            assert.equal(source.dshState(), undefined);
            source.exportDshState();
            assert.deepEqual(removed, [deps.dshStateFile]);
            assert.equal(existsSync(deps.dshStateFile), false);
        } finally { cleanup(); }
    });

    test('写快照：STATE.json 是 qq-dsh-state，时间取她那边的现在', () => {
        const { deps, cleanup } = setup();
        try {
            dshStateSource(deps).exportDshState();
            const written = JSON.parse(readFileSync(deps.dshStateFile, 'utf8')) as { kind: string; generatedAt: string; state: { at: string } };
            assert.equal(written.kind, 'qq-dsh-state');
            assert.equal(written.generatedAt, new Date(NOW).toISOString());
            assert.equal(written.state.at, new Date(NOW).toISOString());
        } finally { cleanup(); }
    });

    test('DSH 没开：不写也不删', () => {
        const { deps, removed, cleanup } = setup({ dshEnabled: false });
        try {
            dshStateSource(deps).exportDshState();
            assert.deepEqual(removed, []);
            assert.equal(existsSync(deps.dshStateFile), false);
        } finally { cleanup(); }
    });

    test('读状态出错：记一行日志，没有摘要', () => {
        const { deps, logs, cleanup } = setup({
            history: { load: () => { throw new Error('坏了'); }, append: () => {} } as unknown as DshStateDeps['history'],
        });
        try {
            assert.equal(dshStateSource(deps).dshState(), undefined);
            assert.deepEqual(logs, ['DSH：读取状态摘要失败（坏了）']);
        } finally { cleanup(); }
    });
});
