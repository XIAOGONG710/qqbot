import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { diaryWriter } from '../src/life/diary.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { diaryMaterial, DIARY_CHAT_CHARS } from '../src/life/diary.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-diary-prepared-')); rmSync(root, { recursive: true, force: true }); } });
const now = new Date('2026-11-05T12:00:00');
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(done => { release = done; }); return { promise, release }; }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-diary-prepared-')); roots.push(root); let complete = false, blocked = false, generated = 0;
    const schedule: Schedule = { sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } }, semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成' };
    const rows: StoredMessage[] = [{ role: 'user', content: 'SYNTHETIC_SOURCE', time: new Date('2026-11-02T12:00:00').toISOString(), messageId: 1, messageSeq: '101' }];
    const calls: { kind: string; body: string; char: string; options?: { operationId?: string; allowSubmit?: boolean } }[] = [];
    const memory = { derivedAvailable: () => !blocked, noteWrittenSourceChanged: () => { blocked = true; },
        retainDiary: async (_date: string, _day: Date, body: string, char: string, options?: { operationId?: string; allowSubmit?: boolean }) => { calls.push({ kind: 'diary', body, char, options }); return complete; },
        retainSummary: async (_id: string, _day: Date, _title: string, body: string, char: string, _tag: string, options?: { operationId?: string; allowSubmit?: boolean }) => { calls.push({ kind: 'summary', body, char, options }); return complete; },
        readDiary: async () => undefined,
    } as unknown as LongTermMemory;
    const options = { sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [{ qq: 10001, name: '合成甲', tier: 'boyfriend' as const }], history: { load: () => rows }, sourceSince: () => '2026-11-01T00:00:00Z', memory, dir: root, log() {}, generate: async () => `GENERATED_BODY_${++generated}` };
    return { root, rows, memory, options, calls, state: () => existsSync(join(root, 'diary.json')) ? JSON.parse(readFileSync(join(root, 'diary.json'), 'utf8')) : {}, generated: () => generated, blocked: () => blocked, complete: () => { complete = true; }, block: () => { blocked = true; } };
}

test('pending prepared跨重启固定正文和UUID，只有completed才推进written/texts', async () => {
    const f = fixture(), first = diaryWriter(f.options); await first.catchUp(now); await first.stop();
    const record = f.state().prepared['diary:2026-11-02']; assert.ok(record); assert.equal(record.phase, 'dispatched'); assert.equal(f.state().written['2026-11-02'], undefined);
    const second = diaryWriter(f.options); await second.catchUp(now); assert.equal(f.generated(), 1); assert.equal(f.calls[1]!.body, record.body); assert.equal(f.calls[1]!.options!.operationId, record.operationId);
    f.complete(); await second.catchUp(now); assert.equal(f.state().texts['2026-11-02'], record.body); assert.equal(f.state().confirmed['diary:2026-11-02'].sourceVerified, true); await second.stop();
});

test('模型await期间来源变更不派旧草稿，下一轮按最新来源重生成', async () => {
    const f = fixture(), held = gate<string>(); let started = false;
    const writer = diaryWriter({ ...f.options, generate: async () => { started = true; return held.promise; } });
    const job = writer.catchUp(now); while (!started) await new Promise(done => setImmediate(done));
    f.rows[0] = { ...f.rows[0]!, content: '[撤回了一条消息]', recalled: true }; held.release('OLD_SOURCE_DRAFT'); await job;
    assert.equal(f.calls.length, 0); assert.equal(f.state().written?.['2026-11-02'], undefined); await writer.stop();
});

test('已派prepared遇源撤回/公共dirty仍query-only结真实ACK，不能重发或供summary', async () => {
    const f = fixture(), writer = diaryWriter(f.options); await writer.catchUp(now); const prepared = f.state().prepared['diary:2026-11-02'];
    f.rows[0] = { ...f.rows[0]!, content: '[撤回了一条消息]', recalled: true }; f.block(); f.complete(); await writer.catchUp(now);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.body, prepared.body); assert.equal(f.calls[1]!.options!.allowSubmit, false);
    assert.equal(f.state().texts['2026-11-02'], prepared.body); assert.equal(f.state().confirmed['diary:2026-11-02'].sourceVerified, false); assert.equal(f.generated(), 1); await writer.stop();
});

test('prepared冻结角色identity，rename/tier/since变化后只以原identity查询旧UUID', async () => {
    const f = fixture(); let since = '2026-11-01T00:00:00Z';
    const writer = diaryWriter({ ...f.options, sourceSince: () => since }); await writer.catchUp(now);
    const old = f.state().prepared['diary:2026-11-02']; f.options.sources.charName = '合成新角色'; f.options.contacts[0]!.tier = 'stranger' as 'boyfriend'; since = '2026-11-04T00:00:00Z'; f.complete();
    await writer.catchUp(now); assert.equal(f.calls[1]!.char, old.charName); assert.equal(f.calls[1]!.options!.allowSubmit, false);
    assert.equal(f.state().confirmed['diary:2026-11-02'].sourceVerified, false); assert.equal(f.generated(), 1); await writer.stop();
});

test('prepared持久失败不得派发；发布后EIO读回确认仍复用同一正文', async () => {
    for (const published of [false, true]) {
        const f = fixture(), writer = diaryWriter(f.options), rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
        let first = true;
        try {
            fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => {
                if (first && String(to) === join(f.root, 'diary.json')) { first = false; if (published) rename(from, to); throw Object.assign(new Error('SYNTHETIC_SECRET_IO'), { code: 'EIO' }); }
                return rename(from, to);
            };
            if (published) { await writer.catchUp(now); assert.equal(f.calls.length, 1); assert.equal(f.state().prepared['diary:2026-11-02'].phase, 'dispatched'); }
            else { await assert.rejects(writer.catchUp(now)); assert.equal(f.calls.length, 0); }
        } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; await writer.stop(); }
    }
});

test('prepared坏body/hash保原文件安全失败，不隔离重置或把它发送', async () => {
    const f = fixture(), writer = diaryWriter(f.options); await writer.catchUp(now); await writer.stop();
    const state = f.state(); state.prepared['diary:2026-11-02'].body = 'SECRET_TAMPERED_BODY';
    const original = JSON.stringify(state); writeFileSync(join(f.root, 'diary.json'), original);
    const next = diaryWriter(f.options); await assert.rejects(next.catchUp(now), error => !String(error).includes('SECRET_TAMPERED_BODY'));
    assert.equal(f.calls.length, 1); assert.equal(readFileSync(join(f.root, 'diary.json'), 'utf8'), original); await next.stop();
});

test('实际1500代码点尾部语义保持，manifest只记真正参与材料的消息身份', async () => {
    const f = fixture(); f.rows.splice(0, 1, ...Array.from({ length: 60 }, (_, i) => ({ role: 'user' as const, content: `行${i}😀\n${'合成'.repeat(25)}`, time: new Date('2026-11-02T12:00:00').toISOString(), messageId: i + 1 })));
    const raw = f.rows.map(message => `${String(new Date(message.time).getHours()).padStart(2, '0')}:${String(new Date(message.time).getMinutes()).padStart(2, '0')} 合成甲：${message.content.replaceAll('\n', '／')}`).join('\n');
    const expected = `……${[...raw].slice(-DIARY_CHAT_CHARS).join('')}`;
    assert.ok(diaryMaterial(f.options.sources, new Date('2026-11-02T00:00:00'), [{ name: '合成甲', messages: f.rows }]).endsWith(expected));
    const writer = diaryWriter(f.options); await writer.catchUp(now); const p = f.state().prepared['diary:2026-11-02'];
    assert.ok(p.manifest.contributors[0].messages.length < f.rows.length); assert.ok(p.manifest.contributors[0].messages.length > 0); assert.equal(p.manifest.contributors[0].sinceKnown, true); await writer.stop();
});

test('已confirmed日记源后来变化，生成周记前fresh核验并屏障，不把旧receipt永远当证明', async () => {
    const f = fixture(); f.complete(); let summaries = 0;
    const writer = diaryWriter({ ...f.options, generate: async messages => {
        if (messages[0]!.content.includes('翻着自己')) summaries++; return f.options.generate();
    } });
    await writer.catchUp(now); assert.equal(f.state().confirmed['diary:2026-11-02'].sourceVerified, true);
    const original = f.state().texts['2026-11-02']; f.rows[0] = { ...f.rows[0]!, content: '[撤回了一条消息]', recalled: true };
    await writer.catchUp(new Date('2026-11-09T12:00:00'));
    assert.equal(summaries, 0); assert.equal(f.state().confirmed['diary:2026-11-02'].sourceVerified, false);
    assert.equal(f.state().texts['2026-11-02'], original); assert.ok(f.calls.every(call => call.kind !== 'summary')); await writer.stop();
});

test('旧summary完成ACK合入fresh状态，不覆盖刚持久失效的日记依赖收据', async () => {
    const f = fixture(); f.complete(); let completed = false;
    f.memory.retainSummary = async () => completed;
    const writer = diaryWriter(f.options); await writer.catchUp(now); await writer.catchUp(new Date('2026-11-09T12:00:00'));
    assert.ok(f.state().prepared['week:2026-11-02']);
    f.rows[0] = { ...f.rows[0]!, content: '[撤回了一条消息]', recalled: true }; completed = true;
    await writer.catchUp(new Date('2026-11-09T12:00:00'));
    assert.equal(f.state().confirmed['diary:2026-11-02'].sourceVerified, false);
    assert.equal(f.state().confirmed['week:2026-11-02'].sourceVerified, false); assert.ok(f.state().written['2026-11-02'] > 0); await writer.stop();
});

test('transport排队await后必须fresh检查来源，不能复用派发入口捕获的allowSubmit', async () => {
    const f = fixture(), held = gate<void>(); let entered = false, posts = 0;
    f.memory.retainDiary = async (_date, _day, _body, _char, options) => {
        entered = true; await held.promise;
        const fresh = options as { allowSubmit?: boolean; canSubmit?: () => Promise<boolean> };
        if (fresh.allowSubmit && (fresh.canSubmit ? await fresh.canSubmit() : true)) posts++;
        return false;
    };
    const writer = diaryWriter(f.options), job = writer.catchUp(now);
    while (!entered) await new Promise(done => setImmediate(done));
    f.rows[0] = { ...f.rows[0]!, content: '[撤回了一条消息]', recalled: true }; held.release(); await job;
    assert.equal(posts, 0); assert.equal(f.state().written['2026-11-02'], undefined); assert.equal(f.generated(), 1); await writer.stop();
});

test('canSubmit探针停止或预算取消后晚发现源变，不写屏障或writer副状态', async () => {
    for (const mode of ['abort', 'stop'] as const) {
        const f = fixture(), controller = new AbortController(); let checking = false;
        let writer: ReturnType<typeof diaryWriter>;
        f.memory.retainDiary = async (_date, _day, _body, _char, options) => {
            const before = readFileSync(join(f.root, 'diary.json'), 'utf8'); checking = true;
            const guard = options as { canSubmit: (signal?: AbortSignal) => Promise<boolean> };
            assert.equal(await guard.canSubmit(controller.signal), false);
            assert.equal(f.blocked(), false); assert.equal(readFileSync(join(f.root, 'diary.json'), 'utf8'), before); checking = false; return false;
        };
        writer = diaryWriter({ ...f.options, sourceSince: () => {
            if (checking) { if (mode === 'abort') controller.abort(); else void writer.stop(); return '2026-11-04T00:00:00Z'; }
            return '2026-11-01T00:00:00Z';
        } });
        await writer.catchUp(now); await writer.stop(); assert.equal(f.state().written['2026-11-02'], undefined);
    }
});
