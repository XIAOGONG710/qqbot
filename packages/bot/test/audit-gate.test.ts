import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { advisoriesOf, judgeAudit, type AuditReport } from '../src/ops/audit-gate.ts';

const report = (...via: object[]): AuditReport => ({
    vulnerabilities: {
        a: { severity: 'moderate', via: [...via, 'b'] },
        b: { severity: 'moderate', via: [...via] },
    },
});
const fileType = { source: 1, name: 'file-type', severity: 'moderate', title: 't', url: 'u' };

describe('依赖审计门（ADR 0070 第 11 项）', () => {
    test('同一个公告沿依赖链重复出现只算一个；字符串形式的 via 不算公告', () => {
        assert.deepEqual(advisoriesOf(report(fileType)).map(item => item.id), [1]);
    });

    test('基线里的 moderate 放行；基线之外的新公告、任何 high / critical 都不通过', () => {
        assert.equal(judgeAudit(report(fileType), { advisories: [1] }).ok, true);
        const fresh = judgeAudit(report(fileType, { source: 2, name: 'x', severity: 'moderate' }), { advisories: [1] });
        assert.equal(fresh.ok, false);
        assert.deepEqual(fresh.fresh.map(item => item.id), [2]);
        const high = judgeAudit(report({ ...fileType, severity: 'high' }), { advisories: [1] });
        assert.equal(high.ok, false);
        assert.deepEqual(high.blocking.map(item => item.id), [1]);
    });

    test('基线里已经消失的公告会被指出来，但不挡住', () => {
        const verdict = judgeAudit({ vulnerabilities: {} }, { advisories: [7] });
        assert.equal(verdict.ok, true);
        assert.deepEqual(verdict.gone, [7]);
    });
});
