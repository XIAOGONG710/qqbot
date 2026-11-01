import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { speakViaWorker, takeVoiceLines, VOICE_MAX_CHARS } from '../src/vision/voice-out.ts';

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-voice-'));
    dirs.push(dir);
    return dir;
};
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('她说话（2026-11-01）', () => {
    test('拿走 <<语音：…>>，剩下的文字照常发；太长的截断', () => {
        const got = takeVoiceLines('嗯……我在呢。<<语音：我在呢，你说吧>>');
        assert.equal(got.text, '嗯……我在呢。');
        assert.deepEqual(got.lines, ['我在呢，你说吧']);
        assert.deepEqual(takeVoiceLines(`<<语音：${'啊'.repeat(80)}>>`).lines[0]!.length, VOICE_MAX_CHARS);
        assert.deepEqual(takeVoiceLines('没有标记').lines, []);
    });

    test('空标记不发；多句各发一条', () => {
        assert.deepEqual(takeVoiceLines('<<语音：>>').lines, []);
        assert.deepEqual(takeVoiceLines('<<语音：一>><<语音：二>>').lines, ['一', '二']);
        assert.equal(takeVoiceLines('<<语音：一>><<语音：二>>').text, '');
    });

    test('交给 worker：请求写进队列，结果出来就返回 wav 路径', async () => {
        const dir = tempDir();
        const inbox = join(dir, 'queue', 'in');
        const outbox = join(dir, 'queue', 'out');
        const done = speakViaWorker('嗯，我在呢', { dir });
        const { readdirSync } = await import('node:fs');
        let request = '';
        for (let i = 0; i < 50 && !request; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            const files = readdirSync(inbox);
            if (files.length) request = files[0]!;
        }
        assert.ok(request, '请求应该写进队列');
        assert.equal(JSON.parse(readFileSync(join(inbox, request!), 'utf8')).text, '嗯，我在呢');
        const id = request!.replace(/\.json$/, '');
        const wav = join(outbox, `${id}.wav`);
        writeFileSync(wav, 'RIFF');
        writeFileSync(join(outbox, `${id}.json`), JSON.stringify({ ok: true, wav }));
        assert.equal(await done, wav);
    });
});
