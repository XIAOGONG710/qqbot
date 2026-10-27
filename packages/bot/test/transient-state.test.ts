// 暂时性的读写失败（句柄 / 内存不足、杀毒软件占文件）不等于状态坏了（transient-io.ts）。
// 10-19 22:08 一个失控脚本把虚拟机内存吃光，承诺、生活安排、主动消息各自把一次暂时失败当成永久失败，暂停了一小时。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Contact } from '../src/platform/config.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { fileOps, readJsonOr, writeJsonAtomic } from '../src/memory/json-file.ts';
import { createProactivePlanner, type Planner, type PlannerDeps } from '../src/proactive/proactive-planner.ts';
import { promiseKeeper } from '../src/life/promises.ts';
import type { Schedule } from '../src/life/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { createTransientGate, describeError, isTransientIoError, TransientStateError, TRANSIENT_GRACE_MS } from '../src/memory/transient-io.ts';

const dirs: string[] = [];
const restores: Array<() => void> = [];
const planners: Planner[] = [];
const original = { read: fileOps.readFileSync, write: fileOps.writeFileSync, readDelays: [...fileOps.readDelaysMs], writeDelays: [...fileOps.writeDelaysMs] };
beforeEach(() => {
    // 测试里不真等重试间隔
    fileOps.readDelaysMs = [0, 0, 0];
    fileOps.writeDelaysMs = [0, 0, 0];
});
afterEach(() => {
    planners.splice(0).forEach(p => p.stop());
    restores.splice(0).forEach(restore => restore());
    fileOps.readFileSync = original.read;
    fileOps.writeFileSync = original.write;
    fileOps.readDelaysMs = [...original.readDelays];
    fileOps.writeDelaysMs = [...original.writeDelays];
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-transient-')); dirs.push(dir); return dir; };
const ioError = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

/** 让匹配的路径的读（或写）抛 code；times 次之后恢复正常（不给就一直抛，直到 restore） */
function failReads(match: RegExp, code: string, times = Infinity): () => void {
    const real = fileOps.readFileSync;
    let left = times;
    fileOps.readFileSync = ((path: string, ...rest: unknown[]) => {
        if (match.test(String(path)) && left-- > 0) throw ioError(code);
        return (real as (...args: unknown[]) => unknown)(path, ...rest);
    }) as unknown as typeof fileOps.readFileSync;
    return () => { fileOps.readFileSync = real; };
}
function failWrites(match: RegExp, code: string, times = Infinity): () => void {
    const real = fileOps.writeFileSync;
    let left = times;
    fileOps.writeFileSync = ((path: string, ...rest: unknown[]) => {
        if (match.test(String(path)) && left-- > 0) throw ioError(code);
        return (real as (...args: unknown[]) => unknown)(path, ...rest);
    }) as unknown as typeof fileOps.writeFileSync;
    return () => { fileOps.writeFileSync = real; };
}

describe('transient-io：分类、闸门、日志只写错误码', () => {
    test('错误码分类：句柄 / 内存 / 占用算暂时，不存在和普通错误不算', () => {
        for (const code of ['EMFILE', 'ENOMEM', 'EBUSY', 'EPERM', 'UNKNOWN']) assert.equal(isTransientIoError(ioError(code)), true, code);
        for (const code of ['ENOENT', 'EISDIR', 'ENOTDIR', '']) assert.equal(isTransientIoError(code ? ioError(code) : new Error('x')), false, code || 'no code');
        assert.equal(isTransientIoError(new TransientStateError('x', 'EMFILE')), true);
    });

    test('描述原因只写错误码或错误类型，不带 message（JSON.parse 的 message 会带出文件内容）', () => {
        assert.equal(describeError(ioError('EMFILE')), 'EMFILE');
        assert.equal(describeError(new SyntaxError('Unexpected token, "PRIVATE_TEXT" is not valid JSON')), 'SyntaxError');
        assert.equal(describeError('plain'), 'string');
    });

    test('闸门：宽限期里 retry，超过宽限期 give-up；恢复后清零；日志 10 分钟内只记一次', () => {
        const gate = createTransientGate(1000);
        assert.equal(gate.fail('a', 0), 'retry');
        assert.equal(gate.fail('a', 999), 'retry');
        assert.equal(gate.fail('a', 1000), 'give-up');
        assert.equal(gate.ok('a'), true);
        assert.equal(gate.ok('a'), false);
        assert.equal(gate.fail('a', 5000), 'retry', '恢复后重新计时');
        assert.equal(gate.shouldLog('a', 0), true);
        assert.equal(gate.shouldLog('a', 60_000), false);
        assert.equal(gate.shouldLog('a', 600_000), true);
    });
});

describe('json-file：暂时失败不当成「不存在」也不当成「坏了」', () => {
    test('读：暂时读不到（EMFILE）短重试后读到', () => {
        const dir = fixture(); const path = join(dir, 'state.json');
        writeJsonAtomic(path, { records: [1] });
        restores.push(failReads(/state\.json$/, 'EMFILE', 2));
        assert.deepEqual(readJsonOr(path, { records: [] }), { records: [1] });
    });

    test('读：一直读不到 → 抛 TransientStateError；文件原样留着，没隔离、没当成空白', () => {
        const dir = fixture(); const path = join(dir, 'state.json');
        writeJsonAtomic(path, { records: [1, 2, 3] });
        restores.push(failReads(/state\.json$/, 'ENOMEM'));
        const logs: string[] = [];
        assert.throws(() => readJsonOr(path, { records: [] }, m => logs.push(m)), (error: unknown) => error instanceof TransientStateError && error.code === 'ENOMEM');
        restores.pop()!();
        assert.deepEqual(logs, [], '没有「读不了，挪到一边」那行');
        assert.deepEqual(readdirSync(dir), ['state.json'], '没有 .corrupt- 文件');
        assert.deepEqual(readJsonOr(path, { records: [] }), { records: [1, 2, 3] }, '恢复之后真实状态还在');
    });

    test('读：关键状态（invalid: throw）暂时读不到也是 TransientStateError，不是「无效」', () => {
        const dir = fixture(); const path = join(dir, 'state.json');
        writeJsonAtomic(path, { records: [1] });
        restores.push(failReads(/state\.json$/, 'EBUSY'));
        assert.throws(() => readJsonOr(path, { records: [] }, undefined, { invalid: 'throw' }), TransientStateError);
    });

    test('读：真的不存在才用初始值；内容坏了照旧隔离', () => {
        const dir = fixture(); const path = join(dir, 'state.json');
        assert.deepEqual(readJsonOr(path, { records: ['初始'] }), { records: ['初始'] });
        writeFileSync(path, '{"records": [1, 2');
        const logs: string[] = [];
        assert.deepEqual(readJsonOr(path, { records: [] }, m => logs.push(m)), { records: [] });
        assert.match(logs[0]!, /读不了.*挪到.*corrupt-/);
    });

    test('写：暂时写不进（ENOMEM）重试后成功，不留临时文件', () => {
        const dir = fixture(); const path = join(dir, 'state.json');
        restores.push(failWrites(/state\.json\.tmp-/, 'ENOMEM', 2));
        writeJsonAtomic(path, { records: [9] });
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { records: [9] });
        assert.deepEqual(readdirSync(dir), ['state.json']);
    });

    test('写：一直写不进 → TransientStateError；旧文件没动，没留临时文件', () => {
        const dir = fixture(); const path = join(dir, 'state.json');
        writeJsonAtomic(path, { records: ['旧'] });
        restores.push(failWrites(/state\.json\.tmp-/, 'EMFILE'));
        assert.throws(() => writeJsonAtomic(path, { records: ['新'] }), (error: unknown) => error instanceof TransientStateError && error.code === 'EMFILE');
        restores.pop()!();
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { records: ['旧'] });
        assert.deepEqual(readdirSync(dir), ['state.json']);
    });

    test('写：目录不存在这类不是暂时的错误，照旧直接抛、不包装', () => {
        const dir = fixture();
        assert.throws(() => writeJsonAtomic(join(dir, 'no-such-dir', 'state.json'), {}), (error: unknown) => !(error instanceof TransientStateError) && (error as { code?: string }).code === 'ENOENT');
    });
});

describe('约定模块：暂时读不到不再永久暂停', () => {
    const amin: Contact = { qq: 1, name: '阿明', tier: 'boyfriend' };
    const schedule = { sleep: '02:00' } as Schedule;
    const names = { user: '阿明', char: '林梦瑶' };

    function setup() {
        const dir = fixture();
        const logs: string[] = [];
        let clock = Date.parse('2026-10-19T22:00:00+08:00');
        const history: StoredMessage[] = [];
        const keeper = promiseKeeper({
            contacts: [amin], history: { load: () => history }, names: () => names, schedule,
            extract: async () => '{"add":[],"resolved":[]}', dir, log: m => logs.push(m), now: () => clock,
        });
        return { keeper, logs, dir, advance: (ms: number) => { clock += ms; } };
    }

    test('暂时读不到（EMFILE）：这一轮约定不可用，但不暂停；好了就恢复，日志写原因', () => {
        const { keeper, logs } = setup();
        assert.equal(keeper.available(), true);
        const restore = failReads(/1-boyfriend\.json$/, 'EMFILE');
        assert.equal(keeper.available(), false, '读不到时不把未知约定当成空日历');
        assert.equal(keeper.available(), false);
        assert.equal(logs.filter(l => /暂时读不了/.test(l)).length, 1, '同一件事只记一次');
        assert.ok(logs.some(l => l.includes('EMFILE')), '日志写错误码');
        assert.ok(logs.every(l => !/暂停承诺抽取与使用/.test(l)), '没有永久暂停');
        restore();
        assert.equal(keeper.available(), true, '好了就恢复，不用重启');
        assert.ok(logs.some(l => /读得动了，恢复正常/.test(l)));
    });

    test('持续超过宽限期才暂停，暂停后即使文件读得动也不恢复（失败关闭），日志写原因', () => {
        const { keeper, logs, advance } = setup();
        const restore = failReads(/1-boyfriend\.json$/, 'EMFILE');
        assert.equal(keeper.available(), false);
        advance(TRANSIENT_GRACE_MS + 1000);
        assert.equal(keeper.available(), false);
        assert.ok(logs.some(l => /暂停承诺抽取与使用.*原因：EMFILE/.test(l)), logs.join('\n'));
        restore();
        assert.equal(keeper.available(), false, '已经按永久处理，要人来修');
    });

    test('内容坏了照旧立刻暂停（不是暂时的）', () => {
        const { keeper, logs, dir } = setup();
        writeFileSync(join(dir, '1-boyfriend.json'), 'PRIVATE_BAD not json');
        assert.equal(keeper.available(), false);
        assert.ok(logs.some(l => /暂停承诺抽取与使用/.test(l)));
        assert.ok(logs.every(l => !l.includes('PRIVATE_BAD')), '日志不回显内容');
        assert.equal(readFileSync(join(dir, '1-boyfriend.json'), 'utf8'), 'PRIVATE_BAD not json', '原文件没动');
    });
});

describe('主动消息计划器：暂时写不进先撑着，恢复后补写', () => {
    const at = '2026-10-14T09:00:00+08:00';
    const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
    const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

    function deps(dir: string, patch: Partial<PlannerDeps> = {}): PlannerDeps {
        return { dir, contact: { qq: 10001, name: '阿明', tier: 'boyfriend' }, schedule: card.schedule!,
            settings: { occasions: [], dailyMax: 2, unansweredMax: 1 }, dates: [], mode: 'on', names: { char: card.name, user: '阿明' },
            now: () => Date.parse(at), history: { load: () => [] }, responder: { initiate: async () => assert.fail('不应发消息') },
            log: () => {}, waitUntil: (_at, signal) => new Promise(done => signal.addEventListener('abort', () => done(), { once: true })), ...patch };
    }
    const talk = [{ time: '2026-10-13T10:00:00+08:00', role: 'user' as const, content: '明天下午面试' }];

    test('暂时写不进（EMFILE）：不暂停、日志写原因；写得进去了就补写并记「恢复」', async () => {
        const dir = fixture(); const path = join(dir, '10001-boyfriend.json');
        const logs: string[] = [];
        let calls = 0;
        const planner = createProactivePlanner(deps(dir, { log: l => logs.push(l), history: { load: () => talk },
            extract: async () => { calls++; return '{"add":[],"resolved":[]}'; } }));
        planners.push(planner);
        restores.push(failWrites(/10001-boyfriend\.json\.tmp-/, 'EMFILE'));
        await planner.syncFollowUps();
        assert.equal(calls, 1);
        assert.equal(planner.status().paused, undefined, '宽限期里不暂停');
        assert.ok(logs.some(l => /暂时写不进（EMFILE）/.test(l)), logs.join('\n'));
        assert.equal(existsSync(path), false, '磁盘上还没有（上一版是空）');
        restores.pop()!();
        planner.poke();
        await sleep(30);
        assert.ok(logs.some(l => /写得进去了，恢复正常/.test(l)), logs.join('\n'));
        assert.ok(Object.values(JSON.parse(readFileSync(path, 'utf8')).extracted).includes(true), '补写了抽取进度');
        assert.equal(planner.status().paused, undefined);
    });

    test('持续超过宽限期才暂停，日志写原因（失败关闭不变）', async () => {
        const dir = fixture();
        const logs: string[] = [];
        let clock = Date.parse(at);
        const planner = createProactivePlanner(deps(dir, { now: () => clock, log: l => logs.push(l), history: { load: () => talk },
            extract: async () => '{"add":[],"resolved":[]}' }));
        planners.push(planner);
        restores.push(failWrites(/10001-boyfriend\.json\.tmp-/, 'EMFILE'));
        await planner.syncFollowUps();
        assert.equal(planner.status().paused, undefined);
        clock += TRANSIENT_GRACE_MS + 1000;
        planner.poke();
        await planner.running;
        assert.match(planner.status().paused!, /状态处理失败/);
        assert.ok(logs.some(l => /已暂停.*原因：EMFILE/.test(l)), logs.join('\n'));
    });

    test('不是暂时的写失败（ENOENT）仍然立刻暂停，日志写原因', async () => {
        const dir = fixture();
        const logs: string[] = [];
        const planner = createProactivePlanner(deps(dir, { log: l => logs.push(l), history: { load: () => talk },
            extract: async () => '{"add":[],"resolved":[]}' }));
        planners.push(planner);
        const real = fileOps.writeFileSync;
        fileOps.writeFileSync = (() => { throw ioError('ENOENT'); }) as unknown as typeof fileOps.writeFileSync;
        restores.push(() => { fileOps.writeFileSync = real; });
        await planner.syncFollowUps(); await planner.running;
        assert.match(planner.status().paused!, /状态处理失败/);
        assert.ok(logs.some(l => /已暂停.*原因：ENOENT/.test(l)), logs.join('\n'));
    });
});
