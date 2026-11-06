import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { diaryWriter } from '../src/life/diary.ts';
import { promiseKeeper, type HerPromise } from '../src/life/promises.ts';
import { emptyPromiseState, type PromiseState } from '../src/life/promise-state.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import type { Contact } from '../src/platform/config.ts';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-promises-review-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = new Date('2026-11-05T12:00:00+08:00');
const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-09-07', weeks: 20 },
    holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍' };
const contacts: Contact[] = [{ qq: 1, tier: 'boyfriend', name: '合成用户甲' }, { qq: 2, tier: 'known', name: '合成用户乙' }];
const initial = (qq = 1): HerPromise => ({ id: `p-old-${qq}`, what: '一起吃饭', date: '2026-11-05', said: '2026-11-04', episode: 'ep-1', meet: { time: '12:10', where: '东门', minutes: 90 } });
const path = (dir: string, qq = 1) => join(dir, `${qq}-${qq === 1 ? 'boyfriend' : 'known'}.json`);
const seed = (dir: string, qq = 1) => { const state = emptyPromiseState(); state.promises = [initial(qq)]; writeFileSync(path(dir, qq), JSON.stringify(state)); };
const read = (dir: string, qq = 1) => JSON.parse(readFileSync(path(dir, qq), 'utf8')) as PromiseState;
const history = (closed: boolean): StoredMessage[] => [{ role: 'user', content: '中午十二点十分见面改西门，一起吃饭', time: `2026-11-05T${closed ? '10' : '11'}:50:00+08:00` },
    { role: 'assistant', content: '好的，十二点十分见面', time: `2026-11-05T${closed ? '10' : '11'}:51:00+08:00` }];
const setup = (dir: string, chat: StoredMessage[], extract: () => Promise<string>) => promiseKeeper({ contacts,
    history: { load: qq => qq === 1 ? chat : [] }, names: contact => ({ user: contact.name, char: '合成角色' }),
    schedule, dir, now: () => now.getTime(), log: () => {}, extract });

test('开放片段取消此前约定立即释放日程，保留另一联系人同时间约定，重启后不恢复', async () => {
    const dir = fixture(); seed(dir); seed(dir, 2);
    const chat = history(false);
    const service = setup(dir, chat, async () => '{"add":[],"resolved":["p-old-1","p-old-2"]}');
    await service.sync();
    assert.deepEqual(read(dir).promises, []);
    assert.deepEqual(read(dir, 2).promises, [initial(2)]);
    const from = now; const to = new Date(now.getTime() + 3 * 3_600_000);
    assert.deepEqual(service.appointmentsBetween(from, to).map(a => a.contact.qq), [2]);
    assert.deepEqual(setup(dir, chat, async () => '{"add":[]}').appointmentsBetween(from, to).map(a => a.contact.qq), [2]);
});

test('开放片段抽取失败保持旧约定，不以失败结果释放占用', async () => {
    const dir = fixture(); seed(dir); const before = read(dir).promises;
    await setup(dir, history(false), async () => '{"error":"failed"}').sync();
    assert.deepEqual(read(dir).promises, before);
});

for (const closed of [false, true]) test(`跨片段改地点在正文相同时仍更新，稳定 ID 与来源正确 closed=${closed}`, async () => {
    const dir = fixture(); seed(dir); seed(dir, 2); const chat = history(closed);
    await setup(dir, chat, async () => '{"add":[{"what":"一起吃饭","date":"2026-11-05","meet":{"time":"12:10","where":"西门"}}],"resolved":[]}').sync();
    const [updated] = read(dir).promises;
    assert.equal(read(dir).promises.length, 1);
    assert.equal(updated!.id, 'p-old-1');
    assert.equal(updated!.meet!.where, '西门');
    assert.equal(updated!.episode, `ep-${Date.parse(chat[0]!.time)}`);
    assert.equal(updated!.said, '2026-11-05');
    assert.equal(updated!.early, closed ? undefined : true);
    assert.deepEqual(read(dir, 2).promises, [initial(2)]);
});

for (const invalid of [null, [], { written: [] }, { written: null }, { written: { '2026-02-30': 10 } },
    { written: { '2026-11-04': -1 } }, { texts: { '2026-11-04': 1 } }, { weeks: [] }, { phases: { broken: 1 } }]) {
    test(`坏日记状态失败关闭、保留原文件且不触发生成：${JSON.stringify(invalid)}`, async () => {
        const dir = fixture(); const statePath = join(dir, 'diary.json'); const text = JSON.stringify(invalid);
        writeFileSync(statePath, text); let generated = 0;
        const writer = diaryWriter({ sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [],
            history: { load: () => [] }, dir, log: () => {}, generate: async () => { generated++; return '日记'; },
            memory: {} as LongTermMemory });
        await assert.rejects(writer.catchUp(now), /日记状态.*无效/);
        assert.equal(generated, 0);
        assert.equal(readFileSync(statePath, 'utf8'), text);
        assert.deepEqual(readdirSync(dir), ['diary.json']);
    });
}

test('旧版仅有 written 字段的日记状态可读取并补全可选字段，重复运行不重复 retain', async () => {
    const dir = fixture(); writeFileSync(join(dir, 'diary.json'), JSON.stringify({ written: { '2026-11-02': 10, '2026-11-03': 10, '2026-11-04': 10 } }));
    let retained = 0;
    const writer = diaryWriter({ sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [],
        history: { load: () => [] }, dir, log: () => {}, generate: async () => assert.fail('不应生成日记'),
        memory: { retainDiary: async () => { retained++; return true; }, retainSummary: async () => true, readDiary: async () => undefined } as unknown as LongTermMemory });
    await writer.catchUp(now); await writer.catchUp(now);
    assert.equal(retained, 0);
    const state = JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8'));
    assert.deepEqual(Object.keys(state).sort(), ['confirmed', 'phases', 'prepared', 'texts', 'version', 'weeks', 'written']);
    assert.equal(state.version, 1);
    assert.deepEqual([state.prepared, state.confirmed], [{}, {}], '旧状态升级不伪造待提交或已确认的收据（ADR 0313）');
});

test('损坏日记 JSON 的错误不携带私人正文，也不隔离或覆盖原文件', async () => {
    const dir = fixture(); const file = join(dir, 'diary.json'); const raw = '{"texts":{"2026-11-04":合成私人日记正文}}';
    writeFileSync(file, raw);
    const writer = diaryWriter({ sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [],
        history: { load: () => [] }, dir, log: () => {}, generate: async () => assert.fail('不应生成'), memory: {} as LongTermMemory });
    await assert.rejects(writer.catchUp(now), error => error instanceof Error && error.message.includes('日记状态') && !error.message.includes('合成私人日记正文'));
    assert.equal(readFileSync(file, 'utf8'), raw);
    assert.deepEqual(readdirSync(dir), ['diary.json']);
});
