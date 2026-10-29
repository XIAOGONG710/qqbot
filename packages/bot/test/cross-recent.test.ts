import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { CROSS_WINDOW_MS, DESKTOP_MAX_TURNS, desktopBlock, desktopRecentPath, readDesktopTurns, tailLines } from '../src/memory/cross-recent.ts';
import { readOwnerBank, writeOwnerBank } from '../src/memory/owner-bank.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-cross-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = new Date(2026, 9, 29, 15, 30).getTime();
const min = (n: number) => n * 60_000;
const row = (ago: number, user: string, assistant: string) => `${JSON.stringify({ at: NOW - ago, user, assistant })}\n`;

describe('文件尾部读法', () => {
    test('只读最后一段字节：头上被截断的那一行丢掉，其余完整行都在', () => {
        const dir = tmp();
        const file = join(dir, 'big.jsonl');
        let text = '';
        for (let i = 0; i < 3000; i++) text += `${JSON.stringify({ i, pad: '内容'.repeat(10) })}\n`;
        writeFileSync(file, text);
        const lines = tailLines(file, 4096);
        assert.ok(lines.length > 10 && lines.length < 200);
        for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), '每一行都是完整的 JSON');
        assert.equal(JSON.parse(lines.at(-1)!).i, 2999, '最后一行就是文件的最后一行');
    });

    test('没有文件 / 空文件：空', () => {
        const dir = tmp();
        assert.deepEqual(tailLines(join(dir, '没有.jsonl')), []);
        writeFileSync(join(dir, 'empty.jsonl'), '');
        assert.deepEqual(tailLines(join(dir, 'empty.jsonl')), []);
    });
});

describe('QQ 这边读桌面对话（ADR 0177）', () => {
    test('只取 6 小时内的、按时间从旧到新；超过窗口、未来的时间、坏行、缺字段都丢掉', () => {
        const file = desktopRecentPath(tmp());
        writeFileSync(file, row(CROSS_WINDOW_MS + min(1), '太久以前', '丢') + row(min(90), '一个半小时前', '好') + '写到一半的行 {"at": 1\n'
            + `${JSON.stringify({ at: NOW - min(5), user: '缺了 assistant' })}\n` + `${JSON.stringify({ at: NOW + min(30), user: '未来', assistant: '丢' })}\n` + row(min(10), '十分钟前', '嗯'));
        const turns = readDesktopTurns(file, NOW);
        assert.deepEqual(turns.map(turn => turn.user), ['一个半小时前', '十分钟前']);
    });

    test('desktopBlock：最多放最近 3 轮；每句超长截断；带时刻；说明是同一个他、同一个你', () => {
        const file = desktopRecentPath(tmp());
        writeFileSync(file, row(min(50), '第一', '回一') + row(min(40), '第二', '回二') + row(min(30), '第三', '回三') + row(min(20), '很长的一句'.repeat(60), '好'));
        const block = desktopBlock(file, NOW)!;
        assert.match(block, /^\[你刚才在电脑上（DSH）和他的对话——同一个他、同一个你/);
        const lines = block.split('\n').slice(1);
        assert.equal(lines.length, DESKTOP_MAX_TURNS * 2);
        assert.ok(!block.includes('第一'), '第 4 老的丢掉');
        assert.match(lines[0]!, /^14:50 他：第二$/, '最老的一轮是第二轮，带时刻');
        assert.match(lines.at(-2)!, /^15:10 他：(很长的一句){1,40}…$/, '超长截断，加省略号');
        assert.match(lines.at(-1)!, /^15:10 你：好$/);
    });

    test('没有文件、或都超过窗口：不放（返回 undefined，提示词里一个字都不多）', () => {
        const dir = tmp();
        assert.equal(desktopBlock(desktopRecentPath(dir), NOW), undefined);
        writeFileSync(desktopRecentPath(dir), row(CROSS_WINDOW_MS + min(5), '很久以前', '嗯'));
        assert.equal(desktopBlock(desktopRecentPath(dir), NOW), undefined);
    });

    test('QQ 那边边写边读：最后一行写到一半也不崩', () => {
        const file = desktopRecentPath(tmp());
        writeFileSync(file, row(min(5), '完整的', '好'));
        appendFileSync(file, '{"at": 1730');
        assert.deepEqual(readDesktopTurns(file, NOW).map(turn => turn.user), ['完整的']);
    });
});

describe('owner-bank.json 带上第 2 层的文件路径', () => {
    const base = { ownerBank: 'linmengyao-aaaa111122223333', commonBank: 'linmengyao-common', legacyBank: 'linmengyao' };
    test('开了 crossRecent 才有路径；开关改了就重写', () => {
        const dir = tmp();
        assert.equal(writeOwnerBank(dir, base), true);
        assert.equal(readOwnerBank(dir)!.chatFile, undefined);
        const files = { chatFile: '/x/chats/10002.jsonl', recalledFile: '/x/chats/10002.recalled.json', desktopFile: '/x/memory/desktop-recent.jsonl' };
        assert.equal(writeOwnerBank(dir, { ...base, ...files }), true, '开关打开：重写');
        assert.deepEqual(readOwnerBank(dir), { ...base, ...files, writtenAt: readOwnerBank(dir)!.writtenAt });
        assert.equal(writeOwnerBank(dir, { ...base, ...files }), false, '没变不重写');
        assert.equal(writeOwnerBank(dir, base), true, '开关关掉：重写成没有路径，DSH 那边就停了');
        assert.equal(readOwnerBank(dir)!.desktopFile, undefined);
    });
});
