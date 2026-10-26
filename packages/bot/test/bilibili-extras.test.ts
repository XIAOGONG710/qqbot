import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { cleanTranscript, readTranscript, runAsr, transcribe } from '../src/bilibili-asr.ts';
import { findCommand, schemaLine, BILI_COMMANDS } from '../src/bilibili-schema.ts';
import { unreplied } from '../src/bilibili-inbox.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-asr-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('语音转写：接外部命令（ADR 0168）', () => {
    test('SRT/纯文本清洗：去序号、时间轴、标签、方括号、相邻重复', () => {
        const srt = ['1', '00:00:01,000 --> 00:00:03,000', '<i>今天</i>去了食堂', '', '2', '00:00:03,000 --> 00:00:05,000', '今天去了食堂', '', '3', '00:00:05,000 --> 00:00:07,000', '[笑声] 新窗口开了'].join('\n');
        assert.equal(cleanTranscript(srt), '今天去了食堂 新窗口开了');
    });

    test('跑命令：模板替换、非 0 退出只记日志；读回 srt / txt；都没有就 undefined', async () => {
        const dir = tmp();
        const out = join(dir, 'out');
        const calls: string[][] = [];
        const ok = await runAsr({ template: 'fake-asr --in {input} --out {out}', input: join(dir, 'v.mp4'), out, runner: async (_cmd, args) => { calls.push([...args]); return { code: 0, stderr: '' }; } });
        assert.equal(ok, true);
        assert.deepEqual(calls[0], ['--in', join(dir, 'v.mp4'), '--out', out]);
        const failed = await runAsr({ template: 'fake-asr {input}', input: 'x', out, runner: async () => ({ code: 2, stderr: 'boom' }), log: () => undefined });
        assert.equal(failed, false);
        writeFileSync(`${out}.srt`, '1\n00:00:00,000 --> 00:00:01,000\n字幕一句话');
        assert.equal(readTranscript(out), '字幕一句话');
        assert.equal(readTranscript(join(dir, 'missing')), undefined);
        writeFileSync(`${out}.txt`, '纯文本版本');
        assert.equal(readTranscript(out), '字幕一句话', '优先 srt');
    });

    test('transcribe：命令没输出文件 → undefined', async () => {
        const dir = tmp();
        assert.equal(await transcribe({ template: 'noop {out}', input: 'x', out: join(dir, 'o'), runner: async () => ({ code: 0, stderr: '' }) }), undefined);
    });
});

describe('命令清单（schema）', () => {
    test('每条都有名字 / 说明 / 归属；findCommand 找得到；没写的命令不在表里', () => {
        assert.ok(BILI_COMMANDS.length >= 6);
        for (const command of BILI_COMMANDS) {
            assert.ok(command.name && command.summary && command.entry);
            assert.ok(command.mode === 'read' || command.mode === 'write');
        }
        assert.equal(findCommand('video view')?.login, false);
        assert.equal(findCommand('upload video'), undefined, '没写的就不列');
        assert.match(schemaLine(findCommand('video view')!), /\[read\]/);
        assert.match(schemaLine(findCommand('video summary')!), /要登录/);
    });
});

describe('只列没回过的回复', () => {
    test('handled 里的跳过；@ 和赞不受影响（调用方自己筛）', () => {
        const replies = [{ id: '1' }, { id: '2' }, { id: '3' }];
        assert.deepEqual(unreplied(replies, new Set(['2'])).map(reply => reply.id), ['1', '3']);
        assert.deepEqual(unreplied(replies, new Set()).map(reply => reply.id), ['1', '2', '3']);
    });
});
