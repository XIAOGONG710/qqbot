import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { emptyPromiseState, PromiseStateUnavailable, readPromiseState } from '../src/life/promise-state.ts';
import { checkStates } from '../src/ops/state-check.ts';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) { const target = resolve(dir); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('qqbot-promise-source-schema-')); rmSync(target, { recursive: true, force: true }); } });
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'qqbot-promise-source-schema-')); roots.push(dir); return dir; }
const v1 = '11111111-1111-4111-8111-111111111111', v2 = '22222222-2222-4222-8222-222222222222';
const digest = 'a'.repeat(64);
const promise = { id: 'p-original', what: 'SYNTHETIC_PRIVATE_PROMISE', said: '2026-11-05', date: '2026-11-06', episode: 'ep-1', meet: { time: '19:00', minutes: 90, where: '合成地点' } };
const loop = { id: 'q-original', kind: 'unanswered', what: 'SYNTHETIC_PRIVATE_QUESTION', said: '2026-11-05', episode: 'ep-1' };
const source = () => ({ phase: 'closed', count: 4, digest,
    promiseEffects: [{ id: promise.id, before: promise, version: v2, beforeVersion: v1 }],
    loopEffects: [{ id: loop.id, after: loop, version: v2 }] });
const modern = () => ({ ...emptyPromiseState(), loops: [loop], sources: { 'ep-1': source() },
    promiseVersions: { [promise.id]: v2 }, loopVersions: { [loop.id]: v2 }, attemptSources: { 'ep-2': { count: 2, digest } }, uncertainSources: { 'ep-3': true },
    extension: { preserved: ['synthetic extension'] } });
function rejectsUntouched(value: unknown) {
    const dir = fixture(), path = join(dir, '10001-boyfriend.json'), raw = JSON.stringify(value); writeFileSync(path, raw);
    assert.throws(() => readPromiseState(path), error => error instanceof PromiseStateUnavailable && !String(error).includes('SYNTHETIC_PRIVATE'));
    assert.equal(readFileSync(path, 'utf8'), raw); assert.deepEqual(readdirSync(dir), ['10001-boyfriend.json']);
}

test('来源效果独立于可裁剪进度；删除tombstone与未知扩展合法且读取不改原件', () => {
    const dir = fixture(), path = join(dir, 'state.json'), state = modern();
    const raw = JSON.stringify(state); writeFileSync(path, raw);
    assert.deepEqual(readPromiseState(path), state);
    assert.equal(readFileSync(path, 'utf8'), raw);
    const early = { ...state, sources: { 'ep-1': { ...source(), phase: 'early' } }, early: { 'ep-1': 1 } };
    writeFileSync(path, JSON.stringify(early)); assert.deepEqual(readPromiseState(path), early, 'source count不强绑裁剪后的early count');
});

test('来源容器、phase、episode、count及digest坏形状失败关闭并保留私密原件', () => {
    for (const sources of [null, [], { 'ep-1': [] }, { 'ep-1': { ...source(), phase: 'unknown' } },
        { 'ep-private': source() }, ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(count => ({ 'ep-1': { ...source(), count } })),
        ...['', 'A'.repeat(64), 'a'.repeat(63), 'SYNTHETIC_PRIVATE_HASH'].map(digest => ({ 'ep-1': { ...source(), digest } }))]) rejectsUntouched({ ...modern(), sources });
});

test('promise/loop效果错id、重复id、坏before/after、缺效果及无效版本不能冒认可回撤证据', () => {
    const effect = source().promiseEffects[0]!;
    for (const promiseEffects of [null, {}, [{ ...effect, id: 'different' }], [effect, effect],
        [{ ...effect, before: null }], [{ ...effect, before: { ...promise, said: '2026-02-30' } }],
        [{ id: promise.id, version: v2 }], [{ ...effect, version: 'SYNTHETIC_PRIVATE_UUID' }],
        [{ ...effect, beforeVersion: v2 }], [{ ...effect, beforeVersion: 'invalid' }]])
        rejectsUntouched({ ...modern(), sources: { 'ep-1': { ...source(), promiseEffects } } });
    for (const loopEffects of [[{ id: loop.id, version: v2 }], [{ id: loop.id, after: promise, version: v2 }],
        [{ id: loop.id, after: { ...loop, kind: 'other' }, version: v2 }], [source().loopEffects[0], source().loopEffects[0]]])
        rejectsUntouched({ ...modern(), sources: { 'ep-1': { ...source(), loopEffects } } });
});

test('版本/tombstone、抽取尝试与不确定来源字典拒坏类型，不以坏进度放开抽取', () => {
    for (const field of ['promiseVersions', 'loopVersions']) for (const value of [null, [], { 'p-original': false }, { 'p-original': 'not-uuid' }, { 'bad\nkey': v1 }])
        rejectsUntouched({ ...modern(), [field]: value });
    for (const attemptSources of [null, [], { bad: { count: 1, digest } }, { 'ep-2': { count: -1, digest } }, { 'ep-2': { count: 1, digest: 'bad' } }])
        rejectsUntouched({ ...modern(), attemptSources });
    for (const uncertainSources of [null, [], { 'ep-3': false }, { 'ep-3': 1 }, { bad: true }]) rejectsUntouched({ ...modern(), uncertainSources });
});

test('同一promise id/version不能由两个来源声称不同before，避免JSON插入顺序决定恢复旧约', () => {
    const first = source(), second = { ...source(), promiseEffects: [{ ...source().promiseEffects[0]!,
        before: { ...promise, meet: { ...promise.meet, where: '不同的旧约地点' } } }] };
    for (const entries of [[['ep-1', first], ['ep-2', second]], [['ep-2', second], ['ep-1', first]]])
        rejectsUntouched({ ...modern(), sources: Object.fromEntries(entries) });
    // beforeVersion=v1仍可没有原source：合法旧来源裁剪/迁移不能被这个约束拒绝。
    const dir = fixture(), path = join(dir, 'valid.json'); writeFileSync(path, JSON.stringify(modern()));
    assert.deepEqual(readPromiseState(path), modern());
});

test('合法旧v1及无version格式只在内存补默认字段，扩展与两次读取的对象隔离', () => {
    const dir = fixture(), path = join(dir, 'state.json');
    for (const value of [{ ...emptyPromiseState(), promises: [promise], extension: { tag: 'preserve' } },
        { promises: [promise], extracted: { 'ep-1': true }, extension: { tag: 'preserve' } }]) {
        const raw = JSON.stringify(value); writeFileSync(path, raw);
        const read = readPromiseState(path); assert.deepEqual(read.promises, [promise]); assert.equal(read.version, 1);
        assert.deepEqual((read as unknown as Record<string, unknown>).extension, { tag: 'preserve' });
        read.promises[0]!.meet!.where = 'mutated caller snapshot';
        assert.equal(readPromiseState(path).promises[0]!.meet!.where, promise.meet.where);
        assert.equal(readFileSync(path, 'utf8'), raw);
    }
});

test('state-check直接消费者识别来源schema损坏，原状态不被隔离/改写且错误不含正文', () => {
    const dir = fixture(), folder = join(dir, 'promises'); mkdirSync(folder);
    const path = join(folder, '10001-boyfriend.json');
    const raw = JSON.stringify({ ...modern(), sources: { 'ep-1': { ...source(), digest: 'SYNTHETIC_PRIVATE_DIGEST' } } }); writeFileSync(path, raw);
    const result = checkStates(dir).find(row => row.name === 'promises/10001-boyfriend.json');
    assert.equal(result?.ok, false); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
    assert.equal(readFileSync(path, 'utf8'), raw); assert.deepEqual(readdirSync(folder), ['10001-boyfriend.json']);
});
