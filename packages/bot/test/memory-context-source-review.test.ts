import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { contextSummarizer } from '../src/language/context-window.ts';
import type { ChatMessage } from '../src/language/prompt.ts';

const names = { user: '合成甲', char: '合成乙' };
const chat = (): ChatMessage[] => [{ role: 'user', content: 'SYNTHETIC_PRIVATE', time: '2026-11-01T12:00:00+08:00' }, { role: 'assistant', content: '固定末条', time: '2026-11-01T12:01:00+08:00' }];

test('同长度同末条的前文撤回必须重新整理，不能返回旧隐私摘要', async () => {
    let calls = 0;
    const summarize = contextSummarizer({ names, log: () => {}, generate: async () => ++calls === 1 ? '- SYNTHETIC_PRIVATE' : '- 撤回后无约定' });
    const source = chat(); summarize(source); await summarize.idle();
    source[0]!.content = '[对方撤回了一条消息]';
    assert.deepEqual(summarize(source), { ready: false }); await summarize.idle();
    assert.equal(calls, 2);
    const result = summarize(source); assert.ok(result.ready); assert.ok(!result.text?.includes('SYNTHETIC_PRIVATE'));
    source[0]!.role = 'assistant'; assert.deepEqual(summarize(source), { ready: false }); await summarize.idle();
    assert.equal(calls, 3, '相同文字但说话人变化也是输入变化');
});

test('在途旧摘要完成后不能命中新来源；下一次调用重建来源匹配摘要', async () => {
    let release!: (text: string) => void, calls = 0;
    const held = new Promise<string>(resolve => { release = resolve; });
    const summarize = contextSummarizer({ names, log: () => {}, generate: async () => ++calls === 1 ? held : '- 新来源' });
    const old = chat(), fresh = chat(); fresh[0]!.content = '合成已修订';
    summarize(old); assert.deepEqual(summarize(fresh), { ready: false });
    release('- SYNTHETIC_PRIVATE'); await summarize.idle();
    assert.deepEqual(summarize(fresh), { ready: false }); await summarize.idle();
    const result = summarize(fresh); assert.ok(result.ready); assert.ok(!result.text?.includes('SYNTHETIC_PRIVATE'));
});

test('持久摘要跨重启核对完整输入和人物；旧弱key不能追认为新来源', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-context-source-'));
    try {
        const file = join(dir, 'summary.json'), source = chat(); let calls = 0;
        const make = (user = names.user) => contextSummarizer({ names: { ...names, user }, file, log: () => {}, generate: async () => { calls++; return '- 合成摘要'; } });
        const first = make(); first(source); await first.idle();
        assert.ok(make()(source).ready); assert.equal(calls, 1);
        const other = make('合成丙'); assert.deepEqual(other(source), { ready: false }); await other.idle();
        writeFileSync(file, JSON.stringify({ key: `${source.length}|${source.at(-1)!.time}|${source.at(-1)!.content}`, text: 'SYNTHETIC_PRIVATE' }));
        const legacy = make(); assert.deepEqual(legacy(source), { ready: false }); await legacy.idle();
    } finally { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-context-source-')); rmSync(dir, { recursive: true, force: true }); }
});
