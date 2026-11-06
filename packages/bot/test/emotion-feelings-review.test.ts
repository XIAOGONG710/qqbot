import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmSignal } from '../src/emotion/affect.ts';
import { appraisals, criedRecently, feelingsAt, validMoment, voicedKinds, type Appraisal, type Moment } from '../src/emotion/feelings.ts';
import { momentsReader } from '../src/emotion/moments.ts';
import { grievanceNow, ignoredNow, isRepairText } from '../src/emotion/grievance.ts';
const now = Date.parse('2026-11-05T12:00:00Z'); const hour = 3_600_000;
const message = (offset: number, role: 'user' | 'assistant', content: string) => ({ time: new Date(now + offset * hour).toISOString(), role, content });
const moment = (patch: Partial<Moment> = {}): Moment => ({ id: 'synthetic', at: new Date(now).toISOString(), kind: 'sad', strength: 2, cause: '合成事实', ...patch });
const appraisal = (patch: Partial<Appraisal> = {}): Appraisal => ({ id: 'synthetic', at: now, kind: 'sad', strength: 2, cause: '合成事实', source: 'author', ...patch });
const dirs: string[] = []; afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('作者事实必须有明确ISO真实日历，原因按2到60代码点校验', () => {
    for (const at of ['2026-02-30T12:00:00Z', '2026-11-05', '11/05/2026']) assert.equal(validMoment(moment({ at })), false);
    for (const at of ['0000-02-29T12:00:00Z', '0099-11-05T12:00:00+08:00', '2026-11-05T12:00:00Z']) assert.equal(validMoment(moment({ at })), true);
    assert.equal(validMoment(moment({ cause: '😀' })), false); assert.equal(validMoment(moment({ cause: '😀😀' })), true);
});

test('未来的assistant消息不能预先算作已表达情绪或已经哭过', () => {
    const future = [message(1, 'assistant', '我难过，哭了')];
    assert.equal(voicedKinds(future, now).size, 0); assert.equal(criedRecently(future, now), false);
});

test('未来消息不能抹掉当前已经持续四小时的未回事实', () => {
    const past = [message(-7, 'user', '好的'), message(-6, 'assistant', '合成日常')];
    const expected = appraisals({ now, history: past }); assert.ok(expected.some(item => item.id.startsWith('him:silent:')));
    assert.deepEqual(appraisals({ now, history: [...past, message(1, 'user', '未来才回来')] }), expected);
});

test('坏评估不以NaN清空同类的合法评估，坏时钟也不投影事实', () => {
    const valid = appraisal(); const expected = feelingsAt([valid], now);
    for (const patch of [{ at: NaN }, { strength: 4 }, { halfLifeH: 0 }, { halfLifeH: NaN }, { halfLifeH: { valueOf: 'not a function', toString: 'not a function' } }, { kind: 'invalid' }]) {
        assert.deepEqual(feelingsAt([valid, appraisal({ ...patch, id: 'bad' } as Partial<Appraisal>)], now), expected);
    }
    assert.deepEqual(feelingsAt([valid], NaN), []);
});

test('直接传入的非法作者事实不绕过持久入口校验', () => {
    assert.deepEqual(appraisals({ now, history: [], moments: [moment({ strength: 99 as never })] }), []);
});

test('缺少时间的assistant记录不能构造主动未回或倾诉证据', () => {
    assert.equal(grievanceNow([message(-100, 'user', '晚安'), message(-99, 'assistant', '晚安'), { role: 'assistant', content: '没有时间的主动消息' }, message(0, 'user', '我回来了')]), undefined);
    assert.equal(ignoredNow([message(-3, 'assistant', '在吗'), { role: 'assistant', content: '没有时间的难过倾诉' }, message(-2, 'assistant', '合成日常'), message(0, 'user', '刚看到')]), undefined);
});

test('回来以前尚未发生的assistant记录不能构造被晾着的事实', () => {
    assert.equal(grievanceNow([message(-100, 'user', '晚安'), message(-99, 'assistant', '晚安'), message(1, 'assistant', '未来才发的主动消息'), message(0, 'user', '我回来了')]), undefined);
});

test('两轮别扭已经自然结束，迟到的道歉不能重新开启和好状态', () => {
    const history = [message(-100, 'user', '晚安'), message(-99, 'assistant', '晚安'), message(-60, 'assistant', '合成主动消息'),
        message(-1, 'user', '回来了'), message(-0.9, 'assistant', '嗯'), message(-0.8, 'user', '在干嘛'), message(-0.7, 'assistant', '合成日常'), message(-0.6, 'user', '对不起')];
    assert.equal(grievanceNow(history), undefined);
});

test('明确否定不是好意信号，后句有明确正向表达仍保留', () => {
    for (const text of ['我不喜欢你', '我不爱你', '我没想你了', '别误会我没想你']) assert.equal(warmSignal(text), undefined, text);
    assert.equal(warmSignal('我不喜欢你骗我，可我爱你'), 'affection');
    assert.equal(warmSignal('我不是不爱你'), 'affection');
});

test('道歉与认错的分支共用明确否定边界，正向后句和双重否定仍可修补', () => {
    const history = [message(-2.1, 'assistant', '我有点难过'), message(-2, 'assistant', '还有点烦')];
    assert.equal(ignoredNow([...history, message(0, 'user', '我不说对不起')])?.cause, 'ignored');
    assert.equal(isRepairText('这不是我的错'), false);
    assert.equal(ignoredNow([...history, message(0, 'user', '我不说对不起，但抱抱你')]), undefined);
    assert.equal(isRepairText('这不是我的错，但我对不起你'), true);
    assert.equal(isRepairText('不是不想你了'), true);
});

test('不是很喜欢不虚构开心，正在做事的我在不是安慰信号', () => {
    for (const content of ['我不是很喜欢你', '我在打游戏', '我在上课']) {
        assert.equal(warmSignal(content), undefined, content);
        assert.deepEqual(appraisals({ now, history: [message(0, 'user', content)] }), []);
    }
    for (const content of ['我在', '我在呢', '别怕，我在', '我不是很喜欢你骗我，可我爱你']) assert.ok(warmSignal(content), content);
});

test('作者坏JSON只记安全错误，沿用上次有效事实并保留原文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-emotion-reader-')); dirs.push(dir); const path = join(dir, 'moments.json'); const logs: string[] = [];
    const read = momentsReader(dir, text => logs.push(text)); writeFileSync(path, JSON.stringify({ moments: [moment()] })); assert.equal(read().length, 1);
    const broken = 'PRIVATE_MOMENT_BODY'; writeFileSync(path, broken); assert.equal(read().length, 1); read();
    assert.equal(logs.length, 1); assert.ok(logs.every(line => !line.includes('PRIVATE'))); assert.equal(readFileSync(path, 'utf8'), broken);
});

test('作者删除文件后旧缓存不因之后新坏文件而复活，返回快照也不能污染缓存', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-emotion-cache-')); dirs.push(dir); const path = join(dir, 'moments.json');
    const read = momentsReader(dir, () => {}); writeFileSync(path, JSON.stringify({ moments: [moment()] })); const first = read(); first[0]!.cause = '被外部修改';
    assert.equal(read()[0]!.cause, '合成事实'); unlinkSync(path); assert.deepEqual(read(), []); writeFileSync(path, '{synthetic bad'); assert.deepEqual(read(), []);
});

test('原子替换且保持mtime和大小的作者新文件仍刷新事实', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-emotion-replace-')); dirs.push(dir); const path = join(dir, 'moments.json');
    writeFileSync(path, JSON.stringify({ moments: [moment({ id: 'first' })] })); const fixed = new Date('2026-11-01T00:00:00Z'); utimesSync(path, fixed, fixed);
    const stamp = statSync(path); const read = momentsReader(dir, () => {}); assert.equal(read()[0]!.id, 'first');
    const temp = join(dir, 'replacement.json'); writeFileSync(temp, JSON.stringify({ moments: [moment({ id: 'other' })] })); utimesSync(temp, stamp.atime, stamp.mtime); renameSync(temp, path);
    assert.equal(read()[0]!.id, 'other');
});
