import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadOthers } from '../src/social/others.ts';

test('动态联系人：读 others.json、默认 classmate、跳过重复和坏条目', () => {
    const dir = mkdtempSync(join(tmpdir(), 'others-'));
    writeFileSync(join(dir, 'others.json'), JSON.stringify({
        people: [
            { qq: 10002, name: '新同学', note: '选修课认识的' },
            { qq: 10001, name: '重复' },
            { qq: 'bad', name: '坏' },
            { qq: 10003, name: '', tier: 'bestie' },
        ],
    }));
    const loaded = loadOthers(dir, [{ qq: 10001, name: '宝宝', tier: 'boyfriend' }]);
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], { qq: 10002, name: '新同学', tier: 'classmate', persona: '选修课认识的' });
});
