import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { contextSummarizer } from '../src/language/context-window.ts';
import type { ChatMessage } from '../src/language/prompt.ts';

const names = { user: '合成甲', char: '合成乙' };
const source: ChatMessage[] = [{ role: 'user', content: 'SYNTHETIC_CONTEXT_PRIVATE', time: '2026-11-01T12:00:00+08:00' }];
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
type WithStop = ReturnType<typeof contextSummarizer> & { stop?: () => Promise<void> | undefined };

function temp() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-context-stop-'));
    return { root, file: join(root, 'summary.json'), cleanup() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-context-stop-')); rmSync(root, { recursive: true, force: true }); } };
}

test('停止后模型晚成功不能落旧摘要、日志或重新派发', async () => {
    const dir = temp(), pending = deferred<string>(), logs: string[] = []; let calls = 0;
    const summarize: WithStop = contextSummarizer({ names, file: dir.file, log: line => logs.push(line), generate: () => { calls++; return pending.promise; } });
    try {
        summarize(source); await settle(); assert.equal(calls, 1);
        const count = logs.length, draining = summarize.stop?.();
        pending.resolve('- SYNTHETIC_CONTEXT_PRIVATE'); await draining; await summarize.idle(); await settle();
        assert.equal(existsSync(dir.file), false, '停止后的旧模型结果不能持久化');
        assert.equal(logs.length, count, '停止不产生late成功日志');
        assert.deepEqual(summarize(source), { ready: false }); await settle(); assert.equal(calls, 1);
        assert.equal(typeof summarize.stop, 'function');
    } finally { pending.resolve('- 无'); await summarize.idle(); dir.cleanup(); }
});

test('停止后模型晚失败不泄漏错误正文且不再重试', async () => {
    const pending = deferred<string>(), logs: string[] = []; let calls = 0, now = 0;
    const summarize: WithStop = contextSummarizer({ names, now: () => now, log: line => logs.push(line), generate: () => { calls++; return pending.promise; } });
    summarize(source); await settle(); const count = logs.length, draining = summarize.stop?.();
    pending.reject(new Error('SYNTHETIC_PROVIDER_PRIVATE_ERROR')); await draining; await summarize.idle(); await settle();
    assert.equal(logs.length, count, '已停止实例不得输出晚到的provider错误');
    now += 10 * 60_000; assert.deepEqual(summarize(source), { ready: false }); await settle(); assert.equal(calls, 1);
});

test('stop取消不合作模型的本地等待，idle及重复stop有界结束', async () => {
    const pending = deferred<string>();
    const summarize: WithStop = contextSummarizer({ names, log: () => {}, generate: () => pending.promise, timeoutMs: 60_000 });
    summarize(source); await settle();
    try {
        assert.equal(typeof summarize.stop, 'function');
        const first = summarize.stop!(), second = summarize.stop!(); assert.equal(first, second, '重复stop复用相同收尾');
        const result = await Promise.race([Promise.resolve(first).then(() => summarize.idle()).then(() => 'done'), new Promise<string>(resolve => setTimeout(() => resolve('held'), 100))]);
        assert.equal(result, 'done', '不等待不会遵守取消的provider完成');
    } finally { pending.resolve('- 无'); await summarize.idle(); }
});

test('同步stop阻止尚未派发的微任务模型请求', async () => {
    let calls = 0; const logs: string[] = [];
    const summarize: WithStop = contextSummarizer({ names, log: line => logs.push(line), generate: async () => { calls++; return '- 合成内容'; } });
    summarize(source); const count = logs.length; await summarize.stop?.(); await summarize.idle();
    assert.equal(calls, 0, 'stop先发生时不得再派发generate'); assert.equal(logs.length, count);
});

test('停止拒绝已缓存ready，但保留先前确认文件供新实例复用', async () => {
    const dir = temp(); let calls = 0;
    const make = () => contextSummarizer({ names, file: dir.file, log: () => {}, generate: async () => { calls++; return '- 合成已确认'; } }) as WithStop;
    try {
        const first = make(); first(source); await first.idle(); assert.ok(first(source).ready);
        const bytes = readFileSync(dir.file, 'utf8'); await first.stop?.();
        assert.deepEqual(first(source), { ready: false }); assert.equal(readFileSync(dir.file, 'utf8'), bytes);
        const restarted = make(); assert.ok(restarted(source).ready); assert.equal(calls, 1); await restarted.stop?.();
    } finally { dir.cleanup(); }
});
