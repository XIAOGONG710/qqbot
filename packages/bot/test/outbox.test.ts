import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { inspectReply } from '../src/language/exit-check.ts';
import { outboxDesktopBlock } from '../src/life/desktop-now.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { OneBotNotDispatched } from '../src/platform/onebot.ts';
import { reconcileOutboxHistory } from '../src/social/outbox-host.ts';
import { drainOutbox, OUTBOX_DAILY_MAX, OUTBOX_MAX_AGE_MS, OUTBOX_MIN_GAP_MS, OUTBOX_MAX_TRIES, type OutboxDeps } from '../src/social/outbox.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-outbox-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-10-29T14:00:00+08:00');
const min = (n: number) => n * 60_000;
const row = (text: string, at: number, extra: Record<string, unknown> = {}) => `${JSON.stringify({ text, at, ...extra })}\n`;

/** 一套假的依赖：发出去的、记进聊天记录的、日志都收起来 */
function harness(options: { now?: number; blocked?: string; failSends?: number; inspect?: OutboxDeps['inspect'] } = {}) {
    const dir = tmp();
    const sent: string[] = [];
    const recorded: Array<{ text: string; id: number; at: number }> = [];
    const logs: string[] = [];
    let failures = options.failSends ?? 0;
    const clock = { now: options.now ?? T0 };
    const deps: OutboxDeps = {
        file: join(dir, 'OUTBOX.jsonl'),
        stateFile: join(dir, 'outbox-state.json'),
        now: () => clock.now,
        blocked: () => options.blocked,
        inspect: options.inspect ?? (() => undefined),
        send: async text => { if (failures > 0) { failures--; throw new OneBotNotDispatched('网络不通'); } sent.push(text); return 1000 + sent.length; },
        record: (text, id, at) => { recorded.push({ text, id, at }); },
        log: message => { logs.push(message); },
    };
    type Pending = { text: string; at: number; tries?: number };
    const left = (): Pending[] => {
        const saved = existsSync(deps.stateFile) ? (JSON.parse(readFileSync(deps.stateFile, 'utf8')) as { pending?: Pending[] }).pending ?? [] : [];
        const newLines = existsSync(deps.file) ? readFileSync(deps.file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Pending) : [];
        return [...saved, ...newLines];
    };
    return { dir, deps, sent, recorded, logs, clock, file: deps.file, left };
}

describe('主动留话（ADR 0174）：outbox 不再是直通的', () => {
    test('QQ 已确认但本地提交失败，重建时按真实历史匹配补记且不重发', async ({ mock }) => {
        const h = harness();
        const scope = '20001:10001';
        writeFileSync(h.file, row('本地提交断点', T0));
        await assert.rejects(drainOutbox({ ...h.deps, scope, send: async text => {
            const id = await h.deps.send(text);
            mock.method(fileOps, 'renameSync', () => { throw new Error('合成落盘中断'); });
            return id;
        } }), /合成落盘中断/);
        mock.restoreAll();
        assert.deepEqual(h.recorded, []);
        h.clock.now += min(1);
        const history = [{ message_id: 1001, time: T0 / 1000, sender: { user_id: 20001 }, message: '本地提交断点' }];
        const restart: OutboxDeps = { ...h.deps, scope, reconcile: async (text, startedAt) => reconcileOutboxHistory(history, 20001, text, startedAt) };
        await drainOutbox({ ...restart, scope: '其他账号' });
        assert.deepEqual(h.recorded, []);
        await drainOutbox(restart);
        await drainOutbox(restart);
        assert.deepEqual(h.sent, ['本地提交断点']);
        assert.deepEqual(h.recorded, [{ text: '本地提交断点', id: 1001, at: T0 }]);
    });

    test('QQ 历史空页、只有对方同文、重复候选或太早的同文都属未知', () => {
        const match = { message_id: 1001, time: T0 / 1000, user_id: 20001, message: '待核对' };
        for (const rows of [[], [{ ...match, user_id: 10001 }], [match, { ...match, message_id: 1002 }], [{ ...match, time: match.time - 1 }]]) {
            assert.deepEqual(reconcileOutboxHistory(rows, 20001, '待核对', T0), { kind: 'unknown' });
        }
    });
    test('发送结果丢失后先核对，确认送达只补记，确认未送达才补发', async () => {
        for (const received of [true, false]) {
            const h = harness();
            writeFileSync(h.file, row('断点留话', T0));
            const interrupted = { ...h.deps, send: async (text: string) => {
                if (received) h.sent.push(text);
                throw new Error('合成断点');
            } };
            await drainOutbox(interrupted);
            const unknown = await drainOutbox({ ...h.deps, reconcile: async () => ({ kind: 'unknown' }) });
            assert.equal(unknown.blockedBy, '投递结果待核对');
            assert.deepEqual(h.sent, received ? ['断点留话'] : []);
            const reconciled = { ...h.deps, reconcile: async () => received
                ? { kind: 'delivered' as const, messageId: 1001, at: T0 } : { kind: 'not-delivered' as const } };
            await drainOutbox(reconciled);
            await drainOutbox(reconciled);
            assert.deepEqual(h.sent, ['断点留话']);
            assert.deepEqual(h.recorded, [{ text: '断点留话', id: 1001, at: T0 }]);
            assert.deepEqual(h.left(), []);
        }
    });
    test('在场和刚离开时保留旧批次及新留话，恢复后历史写入失败也不重发', async () => {
        const h = harness();
        const lease = { kind: 'dsh-presence', version: 1, session: 'mock', ttlMs: min(15),
            startedAt: new Date(T0 - min(1)).toISOString(), renewedAt: new Date(T0).toISOString() };
        const leftAt = T0 + min(1);
        const deps = {
            ...h.deps,
            blocked: (now: number) => outboxDesktopBlock({ turns: () => [], lease: () => now < leftAt ? lease : { ...lease, ended: new Date(leftAt).toISOString() } }, now),
            record: () => { throw new Error('合成记录失败'); },
        };
        writeFileSync(`${h.file}.next`, row('已暂存', T0 - min(2)));
        writeFileSync(h.file, row('新留话', T0));
        assert.ok((await drainOutbox(deps)).blockedBy);
        h.clock.now = leftAt + min(10);
        assert.ok((await drainOutbox(deps)).blockedBy);
        h.clock.now++;
        await drainOutbox(deps);
        await drainOutbox(deps);
        assert.deepEqual(h.sent, ['已暂存']);
        h.clock.now += OUTBOX_MIN_GAP_MS;
        await drainOutbox(h.deps);
        await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['已暂存', '新留话']);
    });
    test('发送结果一直核对不了（风控拦截、NapCat 回失败）：12 小时内照旧待核对，过了就放弃这一条，后面的留话照常发', async () => {
        const h = harness();
        writeFileSync(h.file, row('被风控拦下的那条', T0) + row('后面那条', T0));
        // NapCat 回失败：抛的不是 OneBotNotDispatched，进「待核对」；其实没送达，历史里永远核对不到
        await drainOutbox({ ...h.deps, send: async () => { throw new Error('合成的风控失败'); } });
        const stuck = { ...h.deps, reconcile: async () => ({ kind: 'unknown' as const }) };
        h.clock.now = T0 + min(60);
        assert.equal((await drainOutbox(stuck)).blockedBy, '投递结果待核对', '一小时后还在核对');
        assert.deepEqual(h.sent, []);
        h.clock.now = T0 + 12 * min(60) + min(1);
        // 「后面那条」到这时也过期了：再写一条新的，确认队列真的恢复
        writeFileSync(h.file, row('新的一条', h.clock.now));
        const resumed = await drainOutbox(stuck);
        assert.equal(resumed.blockedBy, undefined);
        assert.deepEqual(h.sent, ['新的一条'], '放弃那一条以后队列继续');
        assert.ok(h.logs.some(line => /投递结果超过 12 小时还核对不了，放弃这一条/.test(line)));
        assert.deepEqual(h.left(), []);
    });

    test('已送达但聊天记录一直写不进去：12 小时内照旧等，过了就放弃补记，队列继续', async () => {
        const h = harness();
        writeFileSync(h.file, row('送到了的那条', T0));
        await drainOutbox({ ...h.deps, record: () => { throw new Error('合成的写入失败'); } });
        assert.deepEqual(h.sent, ['送到了的那条']);
        const failing = { ...h.deps, record: () => { throw new Error('合成的写入失败'); } };
        h.clock.now = T0 + min(60);
        writeFileSync(h.file, row('下一条', h.clock.now));
        assert.equal((await drainOutbox(failing)).blockedBy, '已投递，聊天记录待核对');
        h.clock.now = T0 + 12 * min(60) + min(1);
        writeFileSync(h.file, row('再下一条', h.clock.now));
        await drainOutbox(failing);
        assert.ok(h.sent.includes('再下一条'), '放弃补记以后队列继续');
        assert.ok(h.logs.some(line => /聊天记录超过 12 小时还核对不了/.test(line)));
        assert.equal(h.sent.filter(text => text === '送到了的那条').length, 1, '送到了的那条不重发');
    });

    test('正常一条：发出去、记进聊天记录、文件清空', async () => {
        const h = harness();
        writeFileSync(h.file, row('刚看了个视频，想起你', T0 - min(1)));
        const result = await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['刚看了个视频，想起你']);
        assert.deepEqual(h.recorded, [{ text: '刚看了个视频，想起你', id: 1001, at: T0 }]);
        assert.equal(result.sent, 1);
        assert.equal(h.left().length, 0);
        assert.equal(existsSync(`${h.file}.work`), false);
    });

    test('危机后暂停 / 睡了 / 休眠：整个文件原样留着，一条都不发也不丢', async () => {
        const h = harness({ blocked: '他最近说过想伤害自己的话，普通主动消息暂停 48 小时' });
        writeFileSync(h.file, row('在吗', T0 - min(5)) + row('想你了', T0 - min(4)));
        const result = await drainOutbox(h.deps);
        assert.equal(result.blockedBy, '他最近说过想伤害自己的话，普通主动消息暂停 48 小时');
        assert.equal(h.sent.length, 0);
        assert.deepEqual(h.left().map(line => line.text), ['在吗', '想你了']);
        // 能说话了再发
        const open = { ...h.deps, blocked: () => undefined };
        await drainOutbox(open);
        assert.deepEqual(h.sent, ['在吗']);
    });

    test('一次只发一条，两条之间至少隔一段时间，每天有上限', async () => {
        const h = harness();
        writeFileSync(h.file, row('一', T0 - min(30)) + row('二', T0 - min(29)) + row('三', T0 - min(28)) + row('四', T0 - min(27)));
        await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['一']);
        assert.deepEqual(h.left().map(line => line.text), ['二', '三', '四']);
        // 间隔不够：不发
        h.clock.now = T0 + min(5);
        await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['一']);
        // 间隔够了：再发一条
        h.clock.now = T0 + OUTBOX_MIN_GAP_MS + 1;
        await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['一', '二']);
        h.clock.now += OUTBOX_MIN_GAP_MS + 1;
        await drainOutbox(h.deps);
        assert.equal(h.sent.length, OUTBOX_DAILY_MAX);
        // 当天到顶：第四条留着，不发
        h.clock.now += OUTBOX_MIN_GAP_MS + 1;
        await drainOutbox(h.deps);
        assert.equal(h.sent.length, OUTBOX_DAILY_MAX);
        assert.deepEqual(h.left().map(line => line.text), ['四']);
    });

    test('隔天重新算条数', async () => {
        const h = harness();
        writeFileSync(h.file, row('一', T0));
        await drainOutbox(h.deps);
        writeFileSync(h.file, row('二', T0 + 20 * 3_600_000));
        h.clock.now = T0 + 21 * 3_600_000;
        await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['一', '二']);
        const state = JSON.parse(readFileSync(h.deps.stateFile, 'utf8')) as { day: string; sent: number };
        assert.equal(state.sent, 1, '新的一天从 1 开始');
    });

    test('过期的不发：「刚看了」隔了一天就不是刚看了', async () => {
        const h = harness();
        writeFileSync(h.file, row('刚看了个视频', T0 - OUTBOX_MAX_AGE_MS - min(1)) + row('新的', T0 - min(1)));
        const result = await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['新的']);
        assert.equal(result.dropped, 1);
        assert.ok(h.logs.some(line => line.includes('过期')));
    });

    test('出口检查命中就不发（做不到的承诺 / 禁用词），日志写明原因', async () => {
        const banned = ['亲爱的'];
        const inspect: OutboxDeps['inspect'] = text => { const issues = inspectReply(text, banned).filter(issue => issue.kind === 'banned' || issue.kind === 'promise'); return issues.length ? issues.map(issue => issue.match).join('、') : undefined; };
        const h = harness({ inspect });
        writeFileSync(h.file, row('亲爱的，我马上给你打电话', T0 - min(2)) + row('刚路过楼下那家店', T0 - min(1)));
        const result = await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['刚路过楼下那家店']);
        assert.equal(result.dropped, 1);
        assert.ok(h.logs.some(line => line.includes('没过出口检查')));
    });

    test('发不出去不丢：留着重试，试满次数才丢；后面的行也不动', async () => {
        const h = harness({ failSends: 99 });
        writeFileSync(h.file, row('一', T0 - min(2)) + row('二', T0 - min(1)));
        for (let attempt = 1; attempt < OUTBOX_MAX_TRIES; attempt++) {
            await drainOutbox(h.deps);
            assert.deepEqual(h.left().map(line => [line.text, line.tries ?? 0]), [['一', attempt], ['二', 0]]);
            h.clock.now += min(1);
        }
        const result = await drainOutbox(h.deps);
        assert.equal(result.dropped, 1, '试满次数才丢');
        assert.deepEqual(h.left().map(line => line.text), ['二']);
        assert.equal(h.recorded.length, 0, '没发出去的不记进聊天记录');
    });

    test('读文件期间常驻进程又写了一行：不会被覆盖掉', async () => {
        const h = harness();
        writeFileSync(h.file, row('一', T0 - min(3)) + row('二', T0 - min(2)));
        const deps: OutboxDeps = {
            ...h.deps,
            send: async text => {
                // 发送期间，常驻进程往同一个文件追加了一行
                appendFileSync(h.file, row('三', T0 - min(1)));
                h.sent.push(text);
                return 7;
            },
        };
        await drainOutbox(deps);
        assert.deepEqual(h.sent, ['一']);
        assert.deepEqual(h.left().map(line => line.text).sort(), ['三', '二'].sort());
    });

    test('上次中途崩了留下的 .work 会被接着处理；读不懂的行丢掉但不挡后面的', async () => {
        const h = harness();
        writeFileSync(`${h.file}.work`, row('崩之前的', T0 - min(10)));
        writeFileSync(h.file, '这不是 JSON\n' + row('新的', T0 - min(1)));
        const result = await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['崩之前的']);
        assert.equal(result.dropped, 1);
        assert.deepEqual(h.left().map(line => line.text), ['新的']);
        assert.equal(existsSync(`${h.file}.work`), false);
    });

    test('没有文件：什么都不做', async () => {
        const h = harness();
        assert.deepEqual(await drainOutbox(h.deps), { sent: 0, held: 0, dropped: 0 });
    });

    test('导入提交后、删除暂存前中断，下一拍不会重复导入', async () => {
        const h = harness();
        const next = `${h.file}.next`;
        writeFileSync(next, row('同一条', T0));
        writeFileSync(h.deps.stateFile, JSON.stringify({ pending: [{ text: '同一条', at: T0 }], imported: ['next'] }));
        await drainOutbox(h.deps);
        h.clock.now += OUTBOX_MIN_GAP_MS;
        await drainOutbox(h.deps);
        assert.deepEqual(h.sent, ['同一条']);
    });
});
