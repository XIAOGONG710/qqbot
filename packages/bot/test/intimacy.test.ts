import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { armIntimate, INTIMATE_REPLIES, intimateRemaining, takeIntimateLine } from '../src/intimacy.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-intimacy-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('/亲热：十条临时黏一点（ADR 0170）', () => {
    test('默认十条，取到 0 就没了；状态落盘，重启不丢', () => {
        const dir = tmp();
        armIntimate(dir, 2260168937);
        assert.equal(intimateRemaining(dir, 2260168937), INTIMATE_REPLIES);
        for (let index = 0; index < INTIMATE_REPLIES; index += 1) {
            const line = takeIntimateLine(dir, 2260168937);
            assert.ok(line && line.includes('亲热'), `第 ${index + 1} 条应有提示`);
        }
        assert.equal(takeIntimateLine(dir, 2260168937), undefined);
        assert.equal(intimateRemaining(dir, 2260168937), 0);
    });

    test('只认那个 QQ；别人没有', () => {
        const dir = tmp();
        armIntimate(dir, 2260168937, 3);
        assert.equal(takeIntimateLine(dir, 2306669773), undefined);
        assert.equal(intimateRemaining(dir, 2260168937), 3);
    });

    test('再发一次重置为十条', () => {
        const dir = tmp();
        armIntimate(dir, 1, 2);
        takeIntimateLine(dir, 1);
        armIntimate(dir, 1);
        assert.equal(intimateRemaining(dir, 1), INTIMATE_REPLIES);
    });
});
