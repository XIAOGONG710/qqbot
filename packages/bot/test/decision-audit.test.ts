import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { exportDecisionAudit, judgmentReasons } from '../src/platform/decision-audit.ts';
import type { Turn } from '../src/interpreter/interpreter.ts';

test('审计导出重建允许字段，忽略夹带的私聊、账号和自由文本原因', () => {
    const id = randomUUID();
    const source = [{ v: 1, id, phase: 'quality', outcome: 'blocked', reasons: ['unsupported-action', 'PRIVATE_SENTINEL'],
        qq: 123456789, raw: 'PRIVATE_SENTINEL', detail: { qq: 123456789 } }];
    const exported = exportDecisionAudit(source.map(row => JSON.stringify(row)).join('\n'));
    assert.deepEqual(exported, [{ v: 1, id, phase: 'quality', outcome: 'blocked', reasons: ['unsupported-action'] }]);
    assert.doesNotMatch(JSON.stringify(exported), /123456789|PRIVATE_SENTINEL/);
});

test('情绪修复和打断的依据只投影类别，不传原始细节', () => {
    const turn: Turn = { at: new Date(), history: [], thinking: false, contact: { qq: 123456789, name: 'PRIVATE_SENTINEL', tier: 'boyfriend' },
        facts: { grievanceActive: true, interruption: { text: 'PRIVATE_SENTINEL', minutesAgo: 1 } } };
    assert.deepEqual(judgmentReasons(turn), ['private-reply', 'relationship-state', 'interruption']);
});
