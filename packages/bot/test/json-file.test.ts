import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { readJsonOr, writeJsonAtomic } from '../src/memory/json-file.ts';

describe('状态文件', () => {
    test('写完不留临时文件，读回来一样；没有文件用初始值', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-json-'));
        try {
            const path = join(dir, 'state.json');
            assert.deepEqual(readJsonOr(path, { records: [] }), { records: [] });
            writeJsonAtomic(path, { records: [1] });
            writeJsonAtomic(path, { records: [1, 2] });
            assert.deepEqual(readJsonOr(path, {}), { records: [1, 2] });
            assert.deepEqual(readdirSync(dir), ['state.json']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('读坏了：挪到一边、记一行日志、用初始值；之后照常写', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-json-'));
        try {
            const path = join(dir, 'state.json');
            writeFileSync(path, '{"records": [1, 2');
            const logs: string[] = [];
            assert.deepEqual(readJsonOr(path, { records: [] }, m => logs.push(m)), { records: [] });
            assert.equal(logs.length, 1);
            assert.match(logs[0]!, /读不了.*挪到.*corrupt-\d+.*从头开始/);
            assert.equal(existsSync(path), false);
            const aside = readdirSync(dir).find(f => f.startsWith('state.json.corrupt-'))!;
            assert.equal(readFileSync(join(dir, aside), 'utf8'), '{"records": [1, 2', '坏文件原样留着，可以查');
            writeJsonAtomic(path, { records: [3] });
            assert.deepEqual(readJsonOr(path, {}), { records: [3] });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('有效 JSON 也要过 schema；可迁移旧版本；关键状态校验失败时不挪走、不静默清空', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-json-schema-'));
        try {
            const path = join(dir, 'state.json');
            writeFileSync(path, JSON.stringify({ values: [1, 2] }));
            const current = readJsonOr(path, { version: 1, values: [] as number[] }, undefined, {
                migrate: value => ({ version: 1, ...(value as object) }),
                validate: (value): value is { version: 1; values: number[] } => Boolean(value && typeof value === 'object'
                    && (value as { version?: unknown }).version === 1 && Array.isArray((value as { values?: unknown }).values)),
            });
            assert.deepEqual(current, { version: 1, values: [1, 2] });

            writeFileSync(path, JSON.stringify({ version: 2, values: [] }));
            assert.throws(() => readJsonOr(path, { version: 1, values: [] as number[] }, undefined, {
                validate: (value): value is { version: 1; values: number[] } => (value as { version?: unknown })?.version === 1,
                invalid: 'throw', label: '行动账',
            }), /行动账.*schema.*拒绝启动/);
            assert.equal(existsSync(path), true, '失败关闭保留原文件供修复');
            assert.equal(readdirSync(dir).some(file => file.includes('.corrupt-')), false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
