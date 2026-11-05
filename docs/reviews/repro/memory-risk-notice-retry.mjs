// Synthetic correctness probe: failed reads retry with unchanged unread count.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRiskMonitor, RISK_POLL_MS } from '../../../packages/bot/src/bilibili/bilibili-risk.ts';

const root = mkdtempSync(join(tmpdir(), 'qqbot-risk-notice-retry-review-')), logs = [];
let at = new Date('2026-11-05T12:00:00+08:00').getTime(), unread = 1, reads = 0, dms = 0;
const account = {
    systemNoticeUnread: async () => unread,
    systemNotices: async () => { reads++; if (reads === 1) throw new Error('SYNTHETIC_ONE_READ_FAILURE'); return [{ id: '123456', title: '合成账号警告', content: '合成风险通知现在可读取', at }]; },
    sendDm: async () => { dms++; },
};
const make = () => createRiskMonitor({ dir: root, uid: 456, now: () => at, log: line => logs.push(line), account });
let monitor = make();
const view = () => ({ noticeReads: reads, dms, halted: monitor.halted(), state: JSON.parse(readFileSync(join(root, 'bilibili-risk.json'), 'utf8')) });
try {
    await monitor.tick(); const failedFirst = view();
    at += RISK_POLL_MS; await monitor.tick(); const sameUnreadAfterInterval = view();
    await monitor.stop(); monitor = make(); at += RISK_POLL_MS; await monitor.tick(); const sameUnreadAfterRestart = view();
    // Positive control: changing the count lets the same fake API expose the warning.
    unread = 2; at += RISK_POLL_MS; await monitor.tick(); const changedUnreadControl = view();
    assert.equal(failedFirst.noticeReads, 1); assert.equal(failedFirst.halted, false);
    assert.equal(sameUnreadAfterInterval.noticeReads, 2); assert.equal(sameUnreadAfterInterval.halted, true);
    assert.equal(sameUnreadAfterRestart.noticeReads, 3); assert.equal(sameUnreadAfterRestart.halted, true);
    assert.equal(changedUnreadControl.noticeReads, 4); assert.equal(changedUnreadControl.halted, true);
    assert.equal(changedUnreadControl.dms, failedFirst.dms);
    console.log(JSON.stringify({ failedFirst, sameUnreadAfterInterval, sameUnreadAfterRestart, changedUnreadControl, logs }, null, 2));
} finally {
    await monitor.stop(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-risk-notice-retry-review-'));
    rmSync(root, { recursive: true, force: true });
}
