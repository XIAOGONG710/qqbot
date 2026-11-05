// Synthetic failure diagnostic. Exit 0 reports bad observed facts, not correctness.
// No character cards, private runtime, real account, model or network are used.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { createRiskMonitor } from '../../../packages/bot/src/bilibili/bilibili-risk.ts';
import { createReplyWatcher, REPLY_DAY_MAX } from '../../../packages/bot/src/bilibili/bilibili-replies.ts';
import { formatDate } from '../../../packages/bot/src/life/schedule.ts';

const root = mkdtempSync(join(tmpdir(), 'qqbot-bili-state-schema-'));
let clock = new Date(2026, 10, 5, 12).getTime(), sends = 0, monitor, watcher;
try {
 const riskPath = join(root, 'bilibili-risk.json');
 const malformedRisk = JSON.stringify({ version: 1, seen: [], until: 'not-a-time' });
 writeFileSync(riskPath, malformedRisk);
 monitor = createRiskMonitor({ dir: root, now: () => clock, uid: 456, log() {}, account: {} });
 const invalidRiskAccepted = true, invalidRiskHalted = monitor.halted();
 await monitor.stop();
 assert.equal(readFileSync(riskPath, 'utf8'), malformedRisk);

 const repliesPath = join(root, 'bilibili-replies.json');
 writeFileSync(repliesPath, JSON.stringify({ version: 1, handled: [], day: formatDate(new Date(clock)), count: 'not-a-number', perPerson: {}, nextReplyAt: 0 }));
 watcher = createReplyWatcher({ mode: 'on', dir: root, userUid: 999, now: () => clock, random: () => 0, log() {},
  account: { mid: 123,
   fetchReplies: async () => [{ id: String(sends + 1), root: '700', parent: '700', aid: 1, title: '合成视频', uid: 456 + sends, name: '合成留言者', text: '这个猫咪确实很可爱', mine: '合成猫咪', at: clock }],
   postReply: async () => { sends++; return { rpid: String(800 + sends) }; },
  }, compose: async () => '看起来确实挺开心',
 });
 for (let i = 0; i < 7; i++) { await watcher.tick(); clock += 10 * 60_000; }
 await watcher.stop();
 const persisted = JSON.parse(readFileSync(repliesPath, 'utf8'));
 console.log(JSON.stringify({ failureDiagnostic: true, invalidRiskAccepted, invalidRiskHalted, nominalOtherDayMax: REPLY_DAY_MAX, actualDistinctPersonSends: sends, malformedCountBypassedQuota: sends > REPLY_DAY_MAX, persistedCount: persisted.count }));
} finally {
 await monitor?.stop(); await watcher?.stop();
 assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-bili-state-schema-'));
 rmSync(root, { recursive: true, force: true });
}
