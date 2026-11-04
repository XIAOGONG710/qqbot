import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Acquaintances } from '../src/life/acquaintances.ts';
import { Tastes, type Experience } from '../src/life/tastes.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { TransientStateError } from '../src/memory/transient-io.ts';

const now = new Date('2026-11-05T12:00:00+08:00');
const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-life-records-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const experience = (i: number, at = now.toISOString()): Experience => ({ ref: `e${i}`, at, kind: '休闲', text: `合成经历${i}` });
const proposal = (strength: unknown = 2, refs = ['e0', 'e1']) => ({ name: '独立游戏', stance: 'like', strength, why: '多次真实体验', refs });

test('未来经历不进入当前反思，也不能作为偏好证据', async () => {
    let calls = 0;
    const future = Array.from({ length: 6 }, (_, i) => experience(i, '2026-11-06T12:00:00+08:00'));
    const service = new Tastes({ dataDir: fixture(), now: () => now, experiences: () => future,
        ask: async () => { calls++; return JSON.stringify([proposal()]); } });
    assert.equal(await service.reflect(), 0);
    assert.equal(calls, 0);
    assert.deepEqual(service.list(), []);
    let material: string | undefined;
    const mixed = new Tastes({ dataDir: fixture(), now: () => now,
        experiences: () => [...Array.from({ length: 6 }, (_, i) => experience(i + 6)), ...future],
        ask: async (_system, user) => { material = user; return JSON.stringify([proposal()]); } });
    assert.equal(await mixed.reflect(), 0);
    assert.ok(material);
    assert.doesNotMatch(material, /\be[01] \|/);
    assert.deepEqual(mixed.list(), []);
});

test('异常强度字段不抛错、不创建偏好，仍继续处理后面的有效提案', async () => {
    for (const invalid of [{ valueOf: null, toString: null }, {}, [], null, true, '', 'Infinity', '1e999']) {
        const service = new Tastes({ dataDir: fixture(), now: () => now,
            experiences: () => Array.from({ length: 6 }, (_, i) => experience(i)),
            ask: async () => JSON.stringify([proposal(invalid), { ...proposal('2'), name: '摄影' }]) });
        assert.equal(await service.reflect(), 1);
        assert.deepEqual(service.list().map(t => [t.name, t.strength]), [['摄影', 2]]);
    }
});

test('乱序收到观察时按事实时间保留最近摘录，并正确记录最早与最晚时间', () => {
    const people = new Acquaintances({ dataDir: fixture(), now: () => now });
    const observation = { platform: 'bilibili', uid: '7', name: '合成昵称', where: '评论区' };
    for (let i = 0; i < 10; i++) people.observe({ ...observation, eventId: `reply-${i}`, what: `合成回复${i}`, at: new Date(now.getTime() - i * 60_000) });
    const person = people.list()[0]!;
    assert.equal(person.first, new Date(now.getTime() - 9 * 60_000).toISOString());
    assert.equal(person.last, now.toISOString());
    assert.deepEqual(person.encounters.map(e => e.what), Array.from({ length: 8 }, (_, i) => `合成回复${7 - i}`));
    assert.match(people.promptLine()!, /合成回复1/);
});

test('未来相遇及未来元数据不进入今天提示；缺少历史快照时保守隐藏该人', () => {
    const people = new Acquaintances({ dataDir: fixture(), now: () => now });
    const observation = { platform: 'bilibili', uid: '7', name: '合成昵称', where: '评论区' };
    for (let i = 0; i < 2; i++) people.observe({ ...observation, eventId: `past-${i}`, what: `过去回复${i}`, at: new Date(now.getTime() - (2 - i) * 3_600_000) });
    const before = people.promptLine(now);
    assert.ok(before);
    for (let i = 0; i < 2; i++) people.observe({ ...observation, name: '未来昵称', eventId: `future-${i}`, what: `我是AI伙伴，未来回复${i}`, at: new Date(now.getTime() + (i + 1) * 86_400_000) });
    assert.equal(people.list()[0]!.name, '未来昵称');
    assert.equal(people.list()[0]!.kind, 'ai');
    assert.equal(people.promptLine(now), undefined);
    const onlyFuture = new Acquaintances({ dataDir: fixture(), now: () => now });
    for (let i = 0; i < 2; i++) onlyFuture.observe({ ...observation, eventId: `future-${i}`, what: `未来回复${i}`, at: new Date(now.getTime() + 86_400_000 + i) });
    assert.equal(onlyFuture.promptLine(now), undefined);
});

const taste = { ...proposal(), since: now.toISOString(), last: now.toISOString(), evidence: [{ ref: 'e0', at: now.toISOString(), text: '合成经历' }] };
const person = { id: 'bilibili:7', platform: 'bilibili', uid: '7', name: '合成昵称', kind: 'unknown', first: now.toISOString(), last: now.toISOString(), days: [now.toDateString()],
    encounters: [{ at: now.toISOString(), where: '评论区', what: '合成回复' }], stance: 'seen' };

test('口味状态必须验证元素和版本；无效状态保持原文件且明确失败', () => {
    for (const value of [{ version: 1, tastes: [null] }, { version: 1, tastes: [{ ...taste, evidence: [null] }] }, { version: 1, tastes: [{ ...taste, strength: '2' }] },
        { version: 2, tastes: [] }, { version: 1, tastes: [], lastReflectAt: '不是日期' }]) {
        const dir = fixture(); const file = join(dir, 'tastes.json'); const text = JSON.stringify(value);
        writeFileSync(file, text);
        const service = new Tastes({ dataDir: dir, experiences: () => [], ask: async () => '[]' });
        assert.throws(() => service.promptLine(), /状态.*读取或校验失败/);
        assert.equal(readFileSync(file, 'utf8'), text);
        assert.deepEqual(readdirSync(dir), ['tastes.json']);
    }
});

test('熟人状态必须验证元素和版本；无效状态保持原文件且明确失败', () => {
    for (const value of [{ version: 1, people: [null] }, { version: 1, people: [{ ...person, encounters: [null] }] }, { version: 1, people: [{ ...person, seenObservations: 7 }] },
        { version: 1, people: [{ ...person, last: '不是日期' }] }, { version: 1, people: [{ ...person, days: ['不是日期'] }] },
        { version: 1, people: [{ ...person, kind: ['ai'] }] }, { version: 2, people: [] }]) {
        const dir = fixture(); const file = join(dir, 'people.json'); const text = JSON.stringify(value);
        writeFileSync(file, text);
        const service = new Acquaintances({ dataDir: dir, now: () => now });
        assert.throws(() => service.promptLine(), /状态.*读取或校验失败/);
        assert.equal(readFileSync(file, 'utf8'), text);
        assert.deepEqual(readdirSync(dir), ['people.json']);
    }
});

test('无指纹的旧熟人状态和合法偏好状态仍可读取；未来偏好不进入当前提示', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'people.json'), JSON.stringify({ version: 1, people: [person] }));
    assert.equal(new Acquaintances({ dataDir: dir, now: () => now }).list().length, 1);
    writeFileSync(join(dir, 'tastes.json'), JSON.stringify({ version: 1, tastes: [taste] }));
    assert.ok(new Tastes({ dataDir: dir, now: () => now, experiences: () => [], ask: async () => '[]' }).promptLine());
    const future = '2026-11-06T12:00:00+08:00';
    writeFileSync(join(dir, 'tastes.json'), JSON.stringify({ version: 1, tastes: [{ ...taste, since: future, last: future }] }));
    assert.equal(new Tastes({ dataDir: dir, now: () => now, experiences: () => [], ask: async () => '[]' }).promptLine(), undefined);
    writeFileSync(join(dir, 'tastes.json'), JSON.stringify({ version: 1, tastes: [{ ...taste, evidence: [{ ref: 'e0', at: future, text: '未来经历' }] }] }));
    assert.equal(new Tastes({ dataDir: dir, now: () => now, experiences: () => [], ask: async () => '[]' }).promptLine(), undefined);
});

test('状态解析失败的错误不含原文，原文件不隔离或重建', () => {
    for (const file of ['people.json', 'tastes.json']) {
        const dir = fixture(); const path = join(dir, file); const secret = 'SYNTHETIC_PRIVATE_STATE';
        const text = `{"private":"${secret}" trailing}`;
        writeFileSync(path, text);
        const read = () => file === 'people.json' ? new Acquaintances({ dataDir: dir }).list()
            : new Tastes({ dataDir: dir, experiences: () => [], ask: async () => '[]' }).list();
        assert.throws(read, error => error instanceof Error && !error.message.includes(secret) && /读取或校验失败/.test(error.message));
        assert.equal(readFileSync(path, 'utf8'), text);
        assert.deepEqual(readdirSync(dir), [file]);
    }
});

test('暂时读失败保留 TransientStateError 语义，不覆盖原有记录', () => {
    const dir = fixture(); const originalRead = fileOps.readFileSync; const originalDelays = fileOps.readDelaysMs;
    writeFileSync(join(dir, 'people.json'), JSON.stringify({ version: 1, people: [person] }));
    writeFileSync(join(dir, 'tastes.json'), JSON.stringify({ version: 1, tastes: [taste] }));
    try {
        fileOps.readDelaysMs = [0];
        fileOps.readFileSync = (() => { throw Object.assign(new Error('synthetic EMFILE'), { code: 'EMFILE' }); }) as typeof fileOps.readFileSync;
        assert.throws(() => new Acquaintances({ dataDir: dir }).list(), TransientStateError);
        assert.throws(() => new Tastes({ dataDir: dir, experiences: () => [], ask: async () => '[]' }).list(), TransientStateError);
    } finally { fileOps.readFileSync = originalRead; fileOps.readDelaysMs = originalDelays; }
    assert.equal(JSON.parse(readFileSync(join(dir, 'people.json'), 'utf8')).people.length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'tastes.json'), 'utf8')).tastes.length, 1);
});
