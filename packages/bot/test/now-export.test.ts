import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NOW_STALE_MS, nowFresh, nowGeneratedAt, renderNow, writeNow } from '../src/life/now-export.ts';

const now = Date.parse('2026-10-30T00:10:00+08:00');

test('渲染：带生成时间、干的事、心情和最近', () => {
    const text = renderNow({ doing: '在宿舍睡觉，7:20 起', feeling: '跟他很亲', recent: ['宝宝跟我说：晚安'], at: now });
    assert.equal(nowGeneratedAt(text), now);
    assert.ok(text.includes('在宿舍睡觉'));
    assert.ok(text.includes('跟他很亲'));
    assert.ok(text.includes('最近：宝宝跟我说：晚安'));
    assert.ok(text.includes('别手改'));
});

test('过期判据：30 分钟以内能用，超过不能；没有时间戳也当过期', () => {
    const text = renderNow({ doing: '在图书馆看书', at: now });
    assert.equal(nowFresh(text, now + 29 * 60_000), true);
    assert.equal(nowFresh(text, now + NOW_STALE_MS + 60_000), false);
    assert.equal(nowFresh('没有时间戳的正文', now), false);
});

test('原子写：写出来的能读回、时间戳对得上', () => {
    const dir = mkdtempSync(join(tmpdir(), 'now-export-'));
    const path = join(dir, 'NOW.md');
    writeNow(path, renderNow({ doing: '在食堂吃饭', at: now }));
    const content = readFileSync(path, 'utf8');
    assert.ok(content.includes('在食堂吃饭'));
    assert.equal(nowGeneratedAt(content), now);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上可能删不掉 */ }
});
