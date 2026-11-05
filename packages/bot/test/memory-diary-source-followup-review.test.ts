import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { diaryWriter } from '../src/life/diary.ts';
import { ChatHistory } from '../src/memory/history.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { fileOps } from '../src/memory/json-file.ts';

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith('qqbot-diary-source-followup-'));
        rmSync(root, { recursive: true, force: true });
    }
});
const now = new Date('2026-11-09T12:00:00');
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-diary-source-followup-')); roots.push(root);
    const schedule: Schedule = {
        sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } },
        semester: { start: '2026-09-01', weeks: 20 }, holidays: [{ name: '合成假期', start: '2026-11-06', end: '2026-11-08' }],
        makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成学校',
    };
    const history = new ChatHistory(root), qq = 10001;
    history.append(qq, { role: 'user', content: 'SYNTHETIC_RETRACTABLE_SOURCE', time: new Date('2026-11-06T12:00:00').toISOString(), messageId: 1 });
    let since: string | undefined, generated = 0;
    const blocked = new Set<string>(), documents = new Map<string, string>(), writes: string[] = [];
    const memory = {
        derivedAvailable: () => blocked.size === 0,
        noteWrittenSourceChanged: (id: string) => { blocked.add(id); },
        retainDiary: async (date: string, _day: Date, body: string) => { writes.push(`diary:${date}`); documents.set(`diary:${date}`, body); return true; },
        retainSummary: async (id: string, _day: Date, _title: string, body: string) => { writes.push(id); documents.set(id, body); return true; },
        readDiary: async (date: string) => blocked.size ? undefined : documents.get(`diary:${date}`),
    } as unknown as LongTermMemory;
    const options = {
        dir: root, sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [{ qq, tier: 'boyfriend' as const, name: '合成甲' }],
        history: { load: (id: number) => history.load(id).filter(message => since === undefined || Date.parse(message.time) >= Date.parse(since)) },
        sourceSince: () => since, memory, log() {}, generate: async (messages: OpenAIMessage[]) => {
            const usesSource = messages.some(message => /SYNTHETIC_RETRACTABLE_SOURCE|DERIVED_FROM_RETRACTABLE_SOURCE/.test(message.content));
            return `${usesSource ? 'DERIVED_FROM_RETRACTABLE_SOURCE' : 'SYNTHETIC_DERIVED_BODY'}_${++generated}`;
        },
    };
    return { root, options, history, qq, blocked, documents, writes, generated: () => generated,
        changeSince: () => { since = new Date('2026-11-07T00:00:00').toISOString(); },
        state: () => JSON.parse(readFileSync(join(root, 'diary.json'), 'utf8')) };
}

for (const mode of ['recall', 'since', 'restart', 'outside-summary-window'] as const) {
    test(`completed diary/week/phase 的来源变化必须形成公共屏障：${mode}`, async () => {
        const f = fixture(); let writer = diaryWriter(f.options);
        try {
            await writer.catchUp(now);
            const before = f.state();
            for (const id of ['diary:2026-11-06', 'week:2026-11-02', 'phase:合成假期:2026-11-08']) {
                assert.equal(before.confirmed[id].sourceVerified, true);
                assert.ok(f.documents.has(id));
                assert.ok(f.documents.get(id)!.includes('DERIVED_FROM_RETRACTABLE_SOURCE'));
            }
            assert.equal(before.confirmed['week:2026-11-02'].manifest.dependencies.some((d: { documentId: string; legacy: boolean }) => d.documentId === 'diary:2026-11-06' && !d.legacy), true);
            if (mode === 'since') f.changeSince();
            else {
                assert.equal(f.history.recall(f.qq, 1), true);
                assert.equal(f.history.load(f.qq)[0]!.recalled, true);
                assert.equal(f.history.load(f.qq)[0]!.content.includes('SYNTHETIC_RETRACTABLE_SOURCE'), false);
            }
            if (mode === 'restart') { await writer.stop(); writer = diaryWriter(f.options); }
            const oldBody = f.documents.get('diary:2026-11-06');
            await writer.catchUp(mode === 'outside-summary-window' ? new Date('2026-11-30T12:00:00') : now);
            // A completed request is an actual fact; invalidation must not erase it
            // or call a different newly generated body the old request's ACK.
            assert.equal(f.documents.get('diary:2026-11-06'), oldBody);
            assert.ok(f.state().written['2026-11-06'] > 0);
            assert.ok(f.blocked.has('diary:2026-11-06'), '已完成或离开回填窗口不能跳过已知来源失效');
            assert.equal(f.state().confirmed['diary:2026-11-06'].sourceVerified, false);
            assert.equal(f.state().confirmed['week:2026-11-02'].sourceVerified, false);
            assert.equal(f.state().confirmed['phase:合成假期:2026-11-08'].sourceVerified, false);
        } finally { await writer.stop(); }
    });
}

test('来源未变化的completed记录不误设公共屏障或重复写远端文档', async () => {
    const f = fixture(), writer = diaryWriter(f.options);
    try {
        await writer.catchUp(now); const generated = f.generated(), writes = f.writes.length;
        await writer.catchUp(now);
        assert.equal(f.blocked.size, 0); assert.equal(f.generated(), generated); assert.equal(f.writes.length, writes);
    } finally { await writer.stop(); }
});

test('同步读取前复核不访问远端/模型/derivedReady，多个日记每联系人只加载一次', async () => {
    const f = fixture(), writer = diaryWriter(f.options);
    try {
        await writer.catchUp(now);
        let loads = 0, sinceReads = 0;
        const load = f.options.history.load, since = f.options.sourceSince;
        f.options.history.load = qq => { loads++; return load(qq); };
        f.options.sourceSince = () => { sinceReads++; return since(); };
        f.options.memory.derivedAvailable = () => { assert.fail('同步复核不得重入derived hook'); };
        f.options.memory.readDiary = async () => { assert.fail('同步复核不得读远端'); };
        const generated = f.generated(), writes = f.writes.length;
        assert.equal(writer.verifySources(now), true);
        assert.equal(loads, 1); assert.equal(sinceReads, 1);
        assert.equal(f.generated(), generated); assert.equal(f.writes.length, writes);
    } finally { await writer.stop(); }
});

test('真正未进入1500代码点尾部的消息撤回不误伤已确认正文', async () => {
    const f = fixture();
    f.history.append(f.qq, { role: 'user', content: '合成'.repeat(1800), time: new Date('2026-11-06T13:00:00').toISOString(), messageId: 2 });
    const writer = diaryWriter(f.options);
    try {
        await writer.catchUp(now);
        assert.equal(f.state().confirmed['diary:2026-11-06'].manifest.contributors[0].messages.length, 1);
        assert.equal(f.history.recall(f.qq, 1), true);
        assert.equal(writer.verifySources(now), true);
        assert.equal(f.blocked.size, 0); assert.equal(f.state().confirmed['diary:2026-11-06'].sourceVerified, true);
    } finally { await writer.stop(); }
});

test('来源读取未知失败保原并安全拒读，恢复后可重新复核而不永久误标污染', async () => {
    const f = fixture(), writer = diaryWriter(f.options);
    try {
        await writer.catchUp(now); const before = readFileSync(join(f.root, 'diary.json'), 'utf8'), load = f.options.history.load;
        f.options.history.load = () => { throw new Error('SYNTHETIC_PRIVATE_READ'); };
        assert.throws(() => writer.verifySources(now), error => !String(error).includes('SYNTHETIC_PRIVATE_READ'));
        assert.equal(readFileSync(join(f.root, 'diary.json'), 'utf8'), before); assert.equal(f.blocked.size, 0);
        f.options.history.load = load;
        assert.equal(writer.verifySources(now), true);
    } finally { await writer.stop(); }
});

test('屏障或收据发布失败保原，恢复后补完整失效闭包且不重发真实文档', async () => {
    for (const failure of ['barrier', 'receipt'] as const) {
        const f = fixture(), writer = diaryWriter(f.options);
        const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs, mark = f.options.memory.noteWrittenSourceChanged;
        try {
            await writer.catchUp(now); assert.equal(f.history.recall(f.qq, 1), true);
            const before = readFileSync(join(f.root, 'diary.json'), 'utf8'), writes = f.writes.length;
            if (failure === 'barrier') f.options.memory.noteWrittenSourceChanged = () => { throw new Error('SYNTHETIC_PRIVATE_BARRIER'); };
            else {
                fileOps.writeDelaysMs = [0];
                fileOps.renameSync = (from, to) => {
                    if (String(to) === join(f.root, 'diary.json')) throw Object.assign(new Error('SYNTHETIC_PRIVATE_DISK'), { code: 'EIO' });
                    return rename(from, to);
                };
            }
            assert.throws(() => writer.verifySources(now), error => !String(error).includes('SYNTHETIC_PRIVATE'));
            assert.equal(readFileSync(join(f.root, 'diary.json'), 'utf8'), before);
            if (failure === 'receipt') assert.equal(f.blocked.has('diary:2026-11-06'), true);
            f.options.memory.noteWrittenSourceChanged = mark; fileOps.renameSync = rename; fileOps.writeDelaysMs = delays;
            assert.equal(writer.verifySources(now), false);
            assert.equal(f.state().confirmed['diary:2026-11-06'].sourceVerified, false);
            assert.equal(f.state().confirmed['week:2026-11-02'].sourceVerified, false);
            assert.equal(f.state().confirmed['phase:合成假期:2026-11-08'].sourceVerified, false);
            assert.equal(f.writes.length, writes);
        } finally {
            f.options.memory.noteWrittenSourceChanged = mark; fileOps.renameSync = rename; fileOps.writeDelaysMs = delays;
            await writer.stop();
        }
    }
});

test('来源暂不可读时公开hook仍拒读，但catchUp可纯查已派UUID并如实结completed', async () => {
    const f = fixture(); let completed = false, submissions = 0;
    const calls: { body: string; operationId?: string; allowSubmit?: boolean }[] = [];
    f.options.memory.retainDiary = async (date, _day, body, _char, options) => {
        calls.push({ body, operationId: options?.operationId, allowSubmit: options?.allowSubmit });
        if (options?.allowSubmit) submissions++;
        return date === '2026-11-06' || completed;
    };
    const writer = diaryWriter(f.options);
    try {
        await writer.catchUp(now);
        const prepared = f.state().prepared['diary:2026-11-07'], generated = f.generated();
        assert.equal(prepared.phase, 'dispatched'); assert.equal(submissions, 2);
        assert.equal(f.state().confirmed['diary:2026-11-06'].sourceVerified, true);
        f.options.history.load = () => { throw new Error('SYNTHETIC_SOURCE_UNAVAILABLE'); };
        assert.throws(() => writer.verifySources(now), error => !String(error).includes('SYNTHETIC_SOURCE_UNAVAILABLE'));
        completed = true; await writer.catchUp(now);
        assert.equal(calls.length, 3); assert.equal(calls[2]!.allowSubmit, false);
        assert.equal(calls[2]!.operationId, prepared.operationId); assert.equal(calls[2]!.body, prepared.body);
        assert.equal(submissions, 2); assert.equal(f.generated(), generated);
        assert.equal(f.state().texts['2026-11-07'], prepared.body);
        assert.equal(f.state().confirmed['diary:2026-11-07'].sourceVerified, false);
        assert.equal(f.blocked.has('diary:2026-11-07'), true);
    } finally { await writer.stop(); }
});

test('另一confirmed日期来源未知时，即使pending自己的来源匹配也只能查ACK', async () => {
    const f = fixture(); let completed = false, unavailable = false;
    const permissions: boolean[] = [];
    f.options.memory.retainDiary = async (date, _day, _body, _char, options) => {
        permissions.push(options?.allowSubmit === true); return date === '2026-11-06' || completed;
    };
    const writer = diaryWriter({ ...f.options, plans: date => {
        if (unavailable && date === '2026-11-06') throw new Error('SYNTHETIC_UNAVAILABLE_PLAN');
        return [];
    } });
    try {
        await writer.catchUp(now); const generated = f.generated();
        unavailable = true; completed = true; await writer.catchUp(now);
        assert.deepEqual(permissions, [true, true, false]); assert.equal(f.generated(), generated);
        assert.equal(f.state().confirmed['diary:2026-11-07'].sourceVerified, true);
    } finally { await writer.stop(); }
});

test('新summary声明已确认依赖但对应receipt丢失时不能假装legacy或继续开放', async () => {
    const f = fixture(), writer = diaryWriter(f.options);
    try {
        await writer.catchUp(now); const state = f.state(), before = f.documents.get('week:2026-11-02');
        assert.equal(state.confirmed['week:2026-11-02'].manifest.dependencies[0].legacy, false);
        delete state.confirmed['diary:2026-11-06'];
        writeFileSync(join(f.root, 'diary.json'), JSON.stringify(state));
        assert.equal(writer.verifySources(now), false);
        assert.equal(f.blocked.has('week:2026-11-02'), true);
        assert.equal(f.state().confirmed['week:2026-11-02'].sourceVerified, false);
        assert.equal(f.state().confirmed['phase:合成假期:2026-11-08'].sourceVerified, false);
        assert.equal(f.documents.get('week:2026-11-02'), before);
        assert.equal(f.state().confirmed['diary:2026-11-06'], undefined);
    } finally { await writer.stop(); }
});

test('已完成summary的legacy依赖本地原文明确变更仍须核bodyHash，缺原文不猜改写', async () => {
    for (const change of ['changed', 'missing'] as const) {
        const f = fixture();
        writeFileSync(join(f.root, 'diary.json'), JSON.stringify({ written: { '2026-11-06': 18 }, texts: { '2026-11-06': 'SYNTHETIC_LEGACY_BODY' }, weeks: {}, phases: {} }));
        const writer = diaryWriter(f.options);
        try {
            await writer.catchUp(now);
            const state = f.state(), dependency = state.confirmed['week:2026-11-02'].manifest.dependencies.find((d: { documentId: string }) => d.documentId === 'diary:2026-11-06');
            assert.equal(dependency.legacy, true); assert.equal(dependency.sourceHash, undefined);
            assert.equal(state.confirmed['diary:2026-11-06'], undefined);
            if (change === 'changed') state.texts['2026-11-06'] = 'SYNTHETIC_REPLACED_LEGACY_BODY';
            else delete state.texts['2026-11-06'];
            writeFileSync(join(f.root, 'diary.json'), JSON.stringify(state));
            const beforeWrites = f.writes.length;
            f.options.memory.readDiary = async () => { assert.fail('同步verify不能补远端legacy正文'); };
            assert.equal(writer.verifySources(now), change === 'missing');
            assert.equal(f.state().confirmed['week:2026-11-02'].sourceVerified, change === 'missing');
            assert.equal(f.blocked.has('week:2026-11-02'), change === 'changed');
            assert.equal(f.writes.length, beforeWrites);
        } finally { await writer.stop(); }
    }
});
