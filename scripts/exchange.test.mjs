import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isForMe, isOpen, markDone, messageFileName, parseArgs, parseMessage, renderMessage, slugify, stamp } from './exchange.mjs';

const when = new Date('2026-11-10T09:05:00Z'); // UTC+8 17:05

describe('exchange 信箱', () => {
    test('参数：值、开关、位置参数', () => {
        assert.deepEqual(parseArgs(['done', 'a.md', '--me', 'dsh', '--quiet']), { _: ['done', 'a.md'], me: 'dsh', quiet: true });
    });

    test('时间一律按 UTC+8', () => {
        assert.deepEqual(stamp(when), { day: '2026-11-10', hm: '1705', human: '2026-11-10 17:05 (UTC+8)' });
    });

    test('文件名：中文标题保留，标点和空格变成连字符，过长截断', () => {
        assert.equal(slugify('语音模块：还差 RVC 训练？'), '语音模块-还差-RVC-训练');
        assert.equal(slugify('///'), 'note');
        assert.equal([...slugify('字'.repeat(80))].length, 40);
        assert.equal(messageFileName({ from: 'dsh', to: 'claude', title: '先别动 voice-out.ts', date: when }),
            '2026-11-10-1705-dsh-to-claude-先别动-voice-out.ts.md');
    });

    test('写出来的留言能原样读回', () => {
        const text = renderMessage({ from: 'claude', to: 'dsh', title: '标题', body: '正文\n第二行', re: 'abc1234', date: when });
        const { meta, body } = parseMessage(text);
        assert.deepEqual(meta, { from: 'claude', to: 'dsh', date: '2026-11-10 17:05 (UTC+8)', re: 'abc1234', status: 'open' });
        assert.equal(body, '\n# 标题\n\n正文\n第二行\n');
        assert.ok(isOpen(meta));
    });

    test('CRLF 的文件也能读（Windows 上被 autocrlf 转过）', () => {
        const { meta } = parseMessage('---\r\nfrom: dsh\r\nto: both\r\nstatus: open\r\n---\r\n# x\r\n');
        assert.equal(meta.to, 'both');
        assert.ok(isForMe(meta, 'claude') && isForMe(meta, 'dsh'));
    });

    test('标成已办：改 status，附上一句话', () => {
        const text = renderMessage({ from: 'dsh', to: 'claude', title: 't', body: 'b', date: when });
        const done = markDone(text, { by: 'claude', date: when, note: '改好了，见 abc1234' });
        const { meta, body } = parseMessage(done);
        assert.equal(meta.status, 'done（claude，2026-11-10 17:05 (UTC+8)）');
        assert.ok(!isOpen(meta));
        assert.match(body, /> 已办：改好了，见 abc1234\n$/);
        assert.throws(() => markDone('随便一段话', { by: 'claude' }));
    });

    test('只认发给自己或 both 的', () => {
        assert.ok(isForMe({ to: 'claude' }, 'claude'));
        assert.ok(!isForMe({ to: 'dsh' }, 'claude'));
    });
});
