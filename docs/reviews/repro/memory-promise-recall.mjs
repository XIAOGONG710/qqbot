/**
 * M33 correct-behavior probe; formal regressions live in packages/bot/test/.
 * Run from any directory: node docs/reviews/repro/memory-promise-recall.mjs
 * Requires the repository's Node version with TypeScript stripping.
 * Exit 0 confirms late stale extraction is rejected and the fresh source is re-extracted.
 *
 * Contracts: [ADR0082](../../adr/0082-recalls.md),
 * [ADR0047](../../adr/0047-meetups-in-her-day.md).
 * Only a pending, unanswered confirmation is withdrawn. This does not assert that
 * withdrawing an already answered message should cancel a confirmed appointment.
 * No world-action callback is installed: world-ledger effects are not proven here.
 * Everything is synthetic: no cards, runtime data, models, QQ, or network access.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatHistory, RECALLED_TEXT } from '../../../packages/bot/src/memory/history.ts';
import { promiseKeeper } from '../../../packages/bot/src/life/promises.ts';
import { readPromiseState } from '../../../packages/bot/src/life/promise-state.ts';

const root = mkdtempSync(join(tmpdir(), 'qqbot-promise-recall-'));
const contact = { qq: 10001, tier: 'boyfriend', name: '合成联系人' };
// Local wall-clock values avoid any dependency on the machine's timezone.
const at = clock => new Date(`2026-11-05T${clock}:00`);
const history = new ChatHistory(root);
history.append(contact.qq, {
    role: 'assistant', time: at('17:30').toISOString(),
    content: '今晚18点一起去门口吃个饭吗？', messageId: 1,
});
history.append(contact.qq, {
    role: 'user', time: at('17:31').toISOString(),
    content: '好，18点门口见，SYNTHETIC_CONFIRMATION', messageId: 2,
});

let release;
let entered = false;
let calls = 0;
const held = new Promise(done => { release = done; });
const dir = join(root, 'promises');
const options = {
    contacts: [contact], history,
    names: () => ({ char: '合成角色', user: contact.name }),
    dir, now: () => at('17:35').getTime(), log() {},
};
const keeper = promiseKeeper({
    ...options,
    extract: async () => {
        calls++;
        if (calls === 1) { entered = true; return held; }
        return JSON.stringify({ add: [], resolved: [] });
    },
});
let restarted;
try {
    const job = keeper.sync();
    const deadline = Date.now() + 3000;
    while (!entered) {
        assert.ok(Date.now() < deadline, 'synthetic extraction did not start');
        await new Promise(done => setImmediate(done));
    }

    // Fact 1: recall was accepted while the source confirmation remained unanswered.
    assert.equal(history.recall(contact.qq, 2), true);
    assert.equal(history.load(contact.qq).at(-1).content, RECALLED_TEXT);
    release(JSON.stringify({
        add: [{ what: '与合成联系人去门口吃饭', date: '2026-11-05', meet: { time: '18:00', where: '门口' } }],
        resolved: [],
    }));
    await job;

    const saved = readPromiseState(join(dir, '10001-boyfriend.json'));
    assert.equal(saved.promises.length, 0, '陈旧结果不能保存约见');
    assert.deepEqual(keeper.plansOn('2026-11-05'), []);
    assert.equal(keeper.appointmentsAt(at('18:10')).length, 0);
    // A fresh request uses the masked source even though its message count is unchanged.
    await keeper.sync();
    assert.equal(calls, 2);
    assert.equal(keeper.appointmentsAt(at('18:10')).length, 0);
    restarted = promiseKeeper({ ...options, extract: async () => { throw new Error('unexpected synthetic extraction'); } });
    assert.equal(restarted.appointmentsAt(at('18:10')).length, 0);
    await restarted.sync();
    console.log(JSON.stringify({
        diagnostic: 'M33-source-revision-protected',
        unansweredRecallAccepted: true,
        lateExtractPersistedEarlyMeet: false,
        diaryPlansContainMeet: false,
        appointmentsContainMeet: false,
        sameCountSyncReextracts: true,
        restartStillUsesMeet: false,
    }));
} finally {
    release('{}');
    await keeper.stop();
    await restarted?.stop();
    // Never recursively remove anything outside this independently created temp root.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('qqbot-promise-recall-'));
    rmSync(root, { recursive: true, force: true });
}
