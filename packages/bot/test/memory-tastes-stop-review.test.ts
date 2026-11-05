import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Tastes, type Experience } from '../src/life/tastes.ts';

const now = new Date('2026-11-09T12:00:00+08:00'), tick = () => new Promise<void>(done => setImmediate(done));
const experiences: Experience[] = Array.from({ length: 6 }, (_, i) => ({ ref: `synthetic-${i}`, at: '2026-11-08T12:00:00+08:00', kind: '休闲', text: `合成摄影经历${i}` }));
const proposal = JSON.stringify([{ name: '合成摄影', stance: 'like', strength: 2, why: '多次合成经历', refs: ['synthetic-0', 'synthetic-1'] }]);
type OwnedTastes = Tastes & { stop?: () => Promise<void> | undefined };
function temp() { const dir = mkdtempSync(join(tmpdir(), 'qqbot-tastes-stop-')); return { dir, path: join(dir, 'tastes.json'), clean() { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-tastes-stop-')); rmSync(dir, { recursive: true, force: true }); } }; }

test('同步stop阻止反思尚未派发的微任务模型，后续reflect不写状态', async () => {
    const f = temp(); let calls = 0;
    const tastes: OwnedTastes = new Tastes({ dataDir: f.dir, now: () => now, experiences: () => experiences, ask: async () => { calls++; return proposal; } });
    try {
        const task = tastes.reflect(); await tastes.stop?.(); await task;
        assert.equal(calls, 0); assert.equal(existsSync(f.path), false); assert.equal(await tastes.reflect(), 0); assert.equal(calls, 0);
        assert.equal(typeof tastes.stop, 'function');
    } finally { await tastes.stop?.(); f.clean(); }
});

for (const fail of [false, true]) test(`stop取消不合作模型等待并复用drain，晚${fail ? '失败' : '成功'}不写口味/通知/日志`, async () => {
    const f = temp(), logs: string[] = []; let changes = 0, calls = 0, release!: (value: string) => void, reject!: (error: Error) => void;
    const held = new Promise<string>((done, error) => { release = done; reject = error; });
    const tastes: OwnedTastes = new Tastes({ dataDir: f.dir, now: () => now, experiences: () => experiences,
        ask: () => { calls++; return held; }, log: line => logs.push(line), onChange: () => { changes++; } });
    const task = tastes.reflect(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await tick(); assert.equal(calls, 1); assert.equal(typeof tastes.stop, 'function');
        const drain = tastes.stop!(); assert.ok(drain instanceof Promise); assert.equal(tastes.stop!(), drain);
        await Promise.race([drain, new Promise<never>((_, error) => { timer = setTimeout(() => error(new Error('stopped tastes still waits for uncooperative model')), 1000); })]);
        assert.equal(await task, 0); assert.equal(await tastes.reflect(), 0); const before = [...logs];
        if (fail) reject(new Error('SYNTHETIC_PRIVATE_TASTES_FAILURE')); else release(proposal);
        await tick(); await tick(); assert.equal(existsSync(f.path), false); assert.equal(changes, 0); assert.deepEqual(logs, before); assert.equal(calls, 1);
    } finally { clearTimeout(timer); release('[]'); await task; await tastes.stop?.(); f.clean(); }
});

test('正常反思已写事实在stop后保留，新实例读取并遵守原反思间隔', async () => {
    const f = temp(); let calls = 0, changes = 0;
    const make = () => new Tastes({ dataDir: f.dir, now: () => now, experiences: () => experiences,
        ask: async () => { calls++; return proposal; }, onChange: () => { changes++; } }) as OwnedTastes;
    const first = make(); let restarted: OwnedTastes | undefined;
    try {
        assert.equal(await first.reflect(), 1); assert.equal(changes, 1); const saved = readFileSync(f.path, 'utf8'); await first.stop?.();
        assert.equal(readFileSync(f.path, 'utf8'), saved); assert.equal(await first.reflect(), 0);
        restarted = make(); assert.equal(restarted.list()[0]?.name, '合成摄影'); assert.ok(restarted.promptLine()?.includes('合成摄影'));
        assert.equal(await restarted.reflect(), 0); assert.equal(calls, 1); assert.equal(readFileSync(f.path, 'utf8'), saved);
        assert.equal(typeof first.stop, 'function');
    } finally { await first.stop?.(); await restarted?.stop?.(); f.clean(); }
});
