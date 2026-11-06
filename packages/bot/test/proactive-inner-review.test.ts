import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { innerLine, parseThought, pendingIntents, validInnerState, type InnerThought } from '../src/proactive/inner.ts';
import { fileText, shareText } from '../src/proactive/shares.ts';

const thought = (at: number, text = '今天有点想吃火锅'): InnerThought => ({ id: `th-${at}`, at: new Date(at).toISOString(), text, goes: 'tell' });

test('未来念头不能提前形成意图；提示按事实时序取最近两条', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    assert.deepEqual(pendingIntents([thought(now + 1), thought(now)], now), [thought(now)]);
    const text = innerLine([thought(now - 1, '最新念头'), thought(now - 3, '最早念头'), thought(now - 2, '中间念头')], now)!;
    assert.ok(text.includes('最新念头') && text.includes('中间念头') && !text.includes('最早念头'));
});

test('去向须明确：否定、额外解释及冲突不能变成主动意图', () => {
    for (const suffix of ['不要告诉他', '暂时不问他', '自己想想，不告诉他', '告诉他\n自己想想']) {
        assert.ok('rejected' in parseThought(`今天有点想吃火锅\n${suffix}`, [], 1), suffix);
    }
    assert.ok('rejected' in parseThought('今天有点想吃火锅（告诉他）\n自己想想', [], 1));
    assert.ok('rejected' in parseThought('今天有点想吃火锅，问他（告诉他）', [], 1));
    const parsed = parseThought('今天有点想吃火锅\n第二行：问他', [], 1);
    assert.ok('thought' in parsed && parsed.thought.goes === 'ask');
});

test('提取坏输出/坏时间安全拒绝，支持四位低年份自身持久化', () => {
    for (const value of [null, {}, 3]) assert.ok('rejected' in parseThought(value as unknown as string, [], 1));
    for (const at of [NaN, Infinity, 1.5, Date.parse('+010000-01-01T00:00:00Z')]) assert.ok('rejected' in parseThought('今天有点想吃火锅', [], at));
    const parsed = parseThought('今天有点想吃火锅', [], Date.parse('0099-01-01T00:00:00Z'));
    assert.ok('thought' in parsed && validInnerState({ thoughts: [parsed.thought] }));
});

test('状态时间拒绝归一化的假日期和非ISO，不猜测改写历史', () => {
    for (const at of ['2026-02-30T00:00:00Z', '2026-11-05']) {
        assert.equal(validInnerState({ thoughts: [{ ...thought(1), at }] }), false);
        assert.equal(validInnerState({ thoughts: [], lastThinkAt: at }), false);
    }
});

test('分享标题和通知栏不保留链接，其他可读文字保留', () => {
    for (const card of [
        { meta: { news: { title: '好看的视频 https://example.test/private?q=secret', tag: '网站' } } },
        { prompt: '[分享]好看的视频 HTTPS://example.test/private?q=secret' },
        { meta: { music: { title: '歌名', desc: '歌手 https://example.test/private?q=secret' } } },
    ]) {
        const text = shareText(JSON.stringify(card));
        assert.doesNotMatch(text, /https?:|example|secret/i);
        assert.match(text, /好看的视频|歌名/);
    }
    assert.equal(shareText({ prompt: 'https://example.test/private' }), '[分享]');
});

test('分享和文件40字按完整codepoint截断，不产生半个emoji', () => {
    for (const text of [fileText('字'.repeat(39) + '😀尾'), shareText({ meta: { news: { title: '字'.repeat(39) + '😀尾' } } })]) {
        assert.ok(text.includes('😀…'), text);
        assert.equal(text.isWellFormed(), true);
    }
});

test('异常多行模型数据在隔离有限堆内拒绝，不展开全部行', () => {
    const source = new URL('../src/proactive/inner.ts', import.meta.url).href;
    const code = `import { parseThought } from ${JSON.stringify(source)};
        const result = parseThought('今天有点想吃火锅\\n' + '自己想想\\n'.repeat(2_000_000), [], 1);
        if (!('rejected' in result)) process.exit(2);`;
    const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', code], {
        timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr.slice(-300));
});
