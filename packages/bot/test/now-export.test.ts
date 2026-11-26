import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activityWithChat, CHATTING_WINDOW_MS, laterOf, NOW_STALE_MS, nowDoing, nowFresh, nowGeneratedAt, renderNow, writeNow } from '../src/life/now-export.ts';

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

// 2026-10-30：中断层——他刚说过话，别让她一边回消息一边「在看剧」
test('中断层：窗口内改成和你聊天中，窗口外回原轨迹，没记录不动', () => {
    assert.equal(activityWithChat('在宿舍看剧', now - 60_000, now), '和你聊天中');
    assert.equal(activityWithChat('在宿舍看剧', now - CHATTING_WINDOW_MS - 1, now), '在宿舍看剧');
    assert.equal(activityWithChat('在宿舍看剧', undefined, now), '在宿舍看剧');
});

// 一个生活（ADR 0347 第 1 层）：常驻进程看 NOW.md 的 asleep 行判断她睡没睡，不再看 her-life 自己编的「睡觉」
test('睡没睡：给了就紧跟生成时间写一行 yes / no，没给就不写', () => {
    const asleep = renderNow({ doing: '在宿舍睡觉，7:20 起', at: now, asleep: true }).split('\n');
    const at = asleep.findIndex(line => line.includes('generated-at:'));
    assert.equal(asleep[at + 1], '<!-- asleep: yes -->');
    assert.ok(renderNow({ doing: '在图书馆看书', at: now, asleep: false }).includes('<!-- asleep: no -->'));
    assert.ok(!renderNow({ doing: '在图书馆看书', at: now }).includes('asleep:'));
    // 生成时间照旧读得出来，插件和常驻的过期判断不受影响
    assert.equal(nowGeneratedAt(asleep.join('\n')), now);
});

// 一个生活（ADR 0347 第 3 层 B 块，desktopDay）：他在电脑上陪她的时候，NOW.md（DSH 会注入到这一场桌面对话本身）也是「和你聊天中」
test('中断层带桌面：QQ 和桌面谁晚算谁、在场也算聊着；本来在上课 / 睡觉带括号；不给 context 逐字照旧', () => {
    const old = now - 3 * 3_600_000;
    // 桌面最后一轮较晚
    assert.equal(activityWithChat('在宿舍看剧', old, now, CHATTING_WINDOW_MS, { desktopAt: now - 60_000 }), '和你聊天中');
    // QQ 较晚、桌面老了
    assert.equal(activityWithChat('在宿舍看剧', now - 60_000, now, CHATTING_WINDOW_MS, { desktopAt: old }), '和你聊天中');
    // 两边都老了
    assert.equal(activityWithChat('在宿舍看剧', old, now, CHATTING_WINDOW_MS, { desktopAt: old }), '在宿舍看剧');
    // 桌面在场（租约）：最后一轮早就过了也算聊着
    assert.equal(activityWithChat('在宿舍看剧', undefined, now, CHATTING_WINDOW_MS, { desktopWith: true }), '和你聊天中');
    assert.equal(activityWithChat('在宿舍看剧', undefined, now, CHATTING_WINDOW_MS, { desktopWith: false }), '在宿舍看剧');
    // 作息上本来在干嘛
    assert.equal(activityWithChat('在教室上课', undefined, now, CHATTING_WINDOW_MS, { desktopAt: now - 60_000, was: 'class' }), '和你聊天中（本来在上课）');
    assert.equal(activityWithChat('在宿舍睡觉', undefined, now, CHATTING_WINDOW_MS, { desktopWith: true, was: 'sleep' }), '和你聊天中（本来该睡了）');
    assert.equal(activityWithChat('在宿舍看剧', undefined, now, CHATTING_WINDOW_MS, { desktopWith: true, was: 'free' }), '和你聊天中');
    assert.equal(activityWithChat('在去教室的路上', undefined, now, CHATTING_WINDOW_MS, { desktopWith: true, was: 'between' }), '和你聊天中');
    // 没聊着就不带括号
    assert.equal(activityWithChat('在教室上课', undefined, now, CHATTING_WINDOW_MS, { was: 'class' }), '在教室上课');
    // 未来的时刻不算（钟没对齐）
    assert.equal(activityWithChat('在宿舍看剧', undefined, now, CHATTING_WINDOW_MS, { desktopAt: now + 60_000 }), '在宿舍看剧');
});

test('laterOf：取较晚的；没有 / 不是有限数的当没有', () => {
    assert.equal(laterOf(1, 2), 2);
    assert.equal(laterOf(3, 2), 3);
    assert.equal(laterOf(undefined, 2), 2);
    assert.equal(laterOf(NaN, 2), 2);
    assert.equal(laterOf(1, undefined), 1);
    assert.equal(laterOf(undefined, undefined), undefined);
});

test('nowDoing：桌面上聊着改「在干嘛」，但 asleep 行只有 QQ 上聊着才改成 no（她是被叫起来的，不是醒了）', () => {
    const sleeping = { base: '在宿舍睡觉，7:20 起', kind: 'sleep' as const, now };
    assert.deepEqual(nowDoing({ ...sleeping, desktopLastAt: now - 60_000 }), { doing: '和你聊天中（本来该睡了）', asleep: true });
    assert.deepEqual(nowDoing({ ...sleeping, desktopLastAt: now - 60_000, desktopWith: false }), nowDoing(sleeping));
    assert.deepEqual(nowDoing({ ...sleeping, desktopWith: true }), { doing: '和你聊天中（本来该睡了）', asleep: true });
    assert.deepEqual(nowDoing({ ...sleeping, qqLastAt: now - 60_000 }), { doing: '和你聊天中（本来该睡了）', asleep: false });
    assert.deepEqual(nowDoing(sleeping), { doing: '在宿舍睡觉，7:20 起', asleep: true });
    assert.deepEqual(nowDoing({ base: '在教室上课', kind: 'class', now, desktopLastAt: now - 60_000 }), { doing: '和你聊天中（本来在上课）', asleep: false });
    assert.deepEqual(nowDoing({ base: '在宿舍看剧', kind: 'free', now }), { doing: '在宿舍看剧', asleep: false });
});
