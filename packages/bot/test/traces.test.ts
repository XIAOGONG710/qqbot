import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { readTraces, recordTrace, traceOf, tracesLine } from '../src/life/traces.ts';

// 10-31：他说过的话、做过的事留下痕迹
describe('他说过的话留下的痕迹', () => {
    test('认出亲密话 / 承诺 / 他做过的事；三件套和别人的事不算', () => {
        assert.deepEqual(traceOf('我喜欢你'), { kind: 'affection', text: '他说喜欢我' });
        assert.deepEqual(traceOf('宝宝我爱你'), { kind: 'affection', text: '他说爱我' });
        assert.equal(traceOf('在吗'), undefined);
        assert.equal(traceOf('吃了吗'), undefined);
        assert.equal(traceOf('哈哈哈'), undefined);
        const doing = traceOf('我今天去公司加班了');
        assert.equal(doing?.kind, 'doing');
        assert.match(doing!.text, /他.*加班/);
        const promise = traceOf('我答应周末带你出去玩');
        assert.equal(promise?.kind, 'promise');
    });

    test('同一天同一句只留一条；隔一天各算一条；三天内进提示词', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-traces-'));
        try {
            const now = Date.UTC(2026, 9, 31, 11, 0, 0);
            assert.equal(recordTrace(dir, { kind: 'affection', text: '他说喜欢我' }, now), true);
            assert.equal(recordTrace(dir, { kind: 'affection', text: '他说喜欢我' }, now + 3600_000), false, '同一天去重');
            assert.equal(recordTrace(dir, { kind: 'doing', text: '他今天加班' }, now + 86_400_000), true);
            assert.equal(readTraces(dir).traces.length, 2);
            const line = tracesLine(dir, now + 86_400_000 + 1000)!;
            assert.match(line, /他说喜欢我/);
            assert.match(line, /他今天加班/);
            assert.equal(tracesLine(dir, now + 10 * 86_400_000), undefined, '过期的不再提');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
