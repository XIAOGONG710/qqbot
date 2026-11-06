import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crisisInHistory } from '../src/emotion/crisis.ts';
import { createCrisisState, CRISIS_PAUSE_MS } from '../src/emotion/crisis-state.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { TransientStateError } from '../src/memory/transient-io.ts';

const dirs: string[] = [];
const originalRename = fileOps.renameSync;
afterEach(() => { fileOps.renameSync = originalRename; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-crisis-review-')); dirs.push(dir); return dir; };
const chat = (...contents: string[]) => contents.map(content => ({ role: 'user' as const, content }));
const time = Date.parse('2026-11-05T12:00:00Z');

test('危机mark发布失败保留已观察风险与原文件，同一事实恢复后可重试持久化', () => {
    for (const existing of [false, true]) {
        const dir = fixture(); const path = join(dir, 'crisis.json'); const state = createCrisisState(dir, () => {});
        if (existing) state.mark(1, time - 1000, 'concern');
        const before = existing ? readFileSync(path, 'utf8') : undefined;
        fileOps.renameSync = ((from, to) => { if (to === path) throw new Error('synthetic commit failure'); return originalRename(from, to); }) as typeof originalRename;
        assert.throws(() => state.mark(1, time, 'high'));
        assert.deepEqual(state.last(1), { at: time, level: 'high' }, '已观察的危险事实不因磁盘失败丢失');
        assert.equal(state.pausedAt(1, time + 1), true);
        assert.equal(existsSync(path), existing); if (existing) assert.equal(readFileSync(path, 'utf8'), before);
        fileOps.renameSync = originalRename;
        state.mark(1, time, 'high');
        assert.deepEqual(createCrisisState(dir, () => {}).last(1), { at: time, level: 'high' });
    }
});

test('有效低年份首次记录不被1970默认锚点吞掉，48小时边界与重启保持', () => {
    const dir = fixture(); const state = createCrisisState(dir, () => {}); const at = Date.parse('0099-11-05T12:00:00Z');
    state.mark(1, at, 'high'); assert.deepEqual(state.last(1), { at, level: 'high' });
    assert.equal(state.pausedAt(1, at + CRISIS_PAUSE_MS - 1), true); assert.equal(state.pausedAt(1, at + CRISIS_PAUSE_MS), false);
    assert.deepEqual(createCrisisState(dir, () => {}).last(1), { at, level: 'high' });
});

test('坏JSON错误不回显正文，坏日期与级别失败关闭且原文件不动', () => {
    const dir = fixture(); const path = join(dir, 'crisis.json');
    for (const raw of ['PRIVATE', JSON.stringify({ version: 2, contacts: { 1: { at: '2026-02-30T12:00:00Z', level: 'high' } } }), JSON.stringify({ version: 2, contacts: { 1: { at: new Date(time).toISOString(), level: 'PRIVATE' } } })]) {
        writeFileSync(path, raw); const logs: string[] = [];
        assert.throws(() => createCrisisState(dir, message => logs.push(message)), error => error instanceof Error && !error.message.includes('PRIVATE'));
        assert.equal(readFileSync(path, 'utf8'), raw); assert.deepEqual(readdirSync(dir), ['crisis.json']); assert.ok(logs.every(message => !message.includes('PRIVATE')));
    }
});

test('非法记录参数不能写出重启失败的危机状态或污染旧记录', () => {
    const dir = fixture(); const state = createCrisisState(dir, () => {}); state.mark(1, time, 'high'); const path = join(dir, 'crisis.json'); const before = readFileSync(path, 'utf8');
    for (const qq of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => state.mark(qq, time + 1, 'high'));
    assert.throws(() => state.mark(2, time + 1, 'invalid' as 'high'));
    for (const at of [NaN, Infinity, Date.parse('-000001-01-01T00:00:00Z'), Date.parse('+010000-01-01T00:00:00Z')]) assert.throws(() => state.mark(2, at, 'high'));
    assert.equal(readFileSync(path, 'utf8'), before); assert.deepEqual(state.last(1), { at: time, level: 'high' }); assert.equal(state.last(2), undefined);
});

test('瞬时读取错误保持原类别与原文件，不被当成空危机状态', () => {
    const dir = fixture(); const path = join(dir, 'crisis.json'); const raw = JSON.stringify({ version: 2, contacts: {} }); writeFileSync(path, raw);
    const read = fileOps.readFileSync; const delays = fileOps.readDelaysMs; fileOps.readDelaysMs = [0];
    fileOps.readFileSync = (() => { throw Object.assign(new Error('synthetic IO'), { code: 'EMFILE' }); }) as typeof read;
    try { assert.throws(() => createCrisisState(dir, () => {}), error => error instanceof TransientStateError); }
    finally { fileOps.readFileSync = read; fileOps.readDelaysMs = delays; }
    assert.equal(readFileSync(path, 'utf8'), raw);
});

test('电影或他人的安全状态和现实支持不能解除本人的高风险，也不能借上轮安全拼接解除', () => {
    for (const foreign of ['电影里的主角现在安全了，室友在旁边', '朋友现在安全了，家人陪着我', '她的室友在旁边，我现在安全了']) {
        assert.equal(crisisInHistory(chat('我不想活了', foreign))?.level, 'high', foreign);
        assert.equal(crisisInHistory(chat('我不想活了', '我现在安全了', foreign))?.level, 'high', foreign);
    }
    for (const own of ['我现在安全了，室友在旁边', '医生说我现在安全了，朋友陪着我', '朋友说我现在安全了，室友在我旁边', '室友已经把我的药收起来，我现在安全了']) assert.equal(crisisInHistory(chat('我不想活了', own)), undefined, own);
    assert.equal(crisisInHistory(chat('我不想活了', '我现在安全了', '室友在旁边')), undefined);
});

test('疑问形式的纠正不解除关切级，既定明确肯定纠正照旧解除', () => {
    for (const question of ['刚才是夸张，我没有想伤害自己吗？', '刚才是夸张，我没有想伤害自己吗']) assert.equal(crisisInHistory(chat('活着好累', question))?.level, 'concern');
    assert.equal(crisisInHistory(chat('活着好累', '刚才是夸张，我没有想伤害自己')), undefined);
});


test('dirty信号能显式flush或由更旧mark重试，但不能降级或回退观察事实', () => {
 for (const retry of ['flush', 'older'] as const) {
  const dir = fixture(); const path = join(dir, 'crisis.json'); const state = createCrisisState(dir, () => {});
  fileOps.renameSync = ((from, to) => { if (to === path) throw new Error('synthetic failure'); return originalRename(from, to); }) as typeof originalRename;
  assert.throws(() => state.mark(1, time, 'imminent')); fileOps.renameSync = originalRename;
  if (retry === 'flush') (state as typeof state & { flush(): void }).flush(); else state.mark(1, time - 1000, 'concern');
  assert.deepEqual(createCrisisState(dir, () => {}).last(1), { at: time, level: 'imminent' });
 }
});

test('假设或愿望中的纠正和否认不解除，明确否认之后的希望不被误当成假设', () => {
    for (const text of ['如果刚才是夸张，我没有想伤害自己', '希望刚才是夸张，我没有想伤害自己', '要是这样，我没有想自杀']) {
        assert.equal(crisisInHistory(chat('活着好累', text))?.level, 'concern', text);
    }
    for (const text of ['我没有想伤害自己，希望能好起来', '刚才只是夸张，我没有想伤害自己，希望能好起来']) {
        assert.equal(crisisInHistory(chat('活着好累', text)), undefined, text);
    }
});

test('明确剧情歌词或角色的一人称引述不解除本人危机，现实中关于本人的证明保留', () => {
    for (const text of ['电影里的主角说“我现在安全了，室友在旁边”', '电影主角说我现在安全了，室友在旁边', '小说中的角色说我现在安全了，朋友陪着我', '歌词里唱我现在安全了，朋友陪着我', '游戏里角色说我现在安全了，室友在旁边']) {
        assert.equal(crisisInHistory(chat('我不想活了', text))?.level, 'high', text);
        assert.equal(crisisInHistory(chat('我不想活了', '我现在安全了', text))?.level, 'high', text);
    }
    for (const text of ['朋友说我现在安全，室友在旁边', '医生说我现在安全了，朋友陪着我', '室友已经把我的药收起来，我现在安全了']) {
        assert.equal(crisisInHistory(chat('我不想活了', text)), undefined, text);
    }
});
