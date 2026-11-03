import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { checkStates } from '../src/ops/state-check.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-state-check-fixture-'));
    dirs.push(dir);
    for (const sub of ['world', 'memory', 'chats']) mkdirSync(join(dir, sub), { recursive: true });
    return dir;
}

describe('状态文件兼容检查（ADR 0070 第 13 项）', () => {
    test('主动消息和天气缓存检查实际 schema；未知 JSON 仍标出只做语法检查', () => {
        const dir = fixture();
        mkdirSync(join(dir, 'proactive'));
        mkdirSync(join(dir, 'weather'));
        const bad = JSON.stringify({ version: 99 });
        writeFileSync(join(dir, 'proactive', '10001-boyfriend.json'), bad);
        writeFileSync(join(dir, 'weather', 'jinan.json'), JSON.stringify({ since: '2026-10-11', fetchedAt: '2026-10-31T12:36:45.984Z', hours: { '2026-10-11T08': { t: 'cold', p: 0, c: 2 } } }));
        writeFileSync(join(dir, 'weather', 'test.json'), '{}');
        const checks = checkStates(dir);
        assert.equal(checks.find(c => c.name === 'proactive/10001-boyfriend.json')!.ok, false);
        assert.equal(checks.find(c => c.name === 'weather/jinan.json')!.ok, false);
        assert.match(checks.find(c => c.name === 'weather/test.json')!.detail, /仅 JSON 语法/);
        assert.equal(readFileSync(join(dir, 'proactive', '10001-boyfriend.json'), 'utf8'), bad, '原目录不动');
    });

    test('承诺文件检查实际 schema：坏的报「会拒绝启动」，原文件不动', () => {
        const dir = fixture();
        mkdirSync(join(dir, 'promises'));
        const bad = JSON.stringify({ version: 99 });
        writeFileSync(join(dir, 'promises', '10001-boyfriend.json'), bad);
        const check = checkStates(dir).find(c => c.name === 'promises/10001-boyfriend.json')!;
        assert.equal(check.ok, false);
        assert.match(check.detail, /拒绝启动/);
        assert.equal(readFileSync(join(dir, 'promises', '10001-boyfriend.json'), 'utf8'), bad);
    });

    test('什么文件都没有：全部按空状态开始，通过', () => {
        const checks = checkStates(fixture());
        assert.ok(checks.length > 0);
        assert.ok(checks.every(check => check.ok), JSON.stringify(checks));
    });

    test('关键状态结构不对：报「会拒绝启动」；合法的照常通过；原目录一个字节都不动', () => {
        const dir = fixture();
        const bad = JSON.stringify({ version: 99, items: 'not-a-list' });
        writeFileSync(join(dir, 'world', 'action-queue.json'), bad);
        writeFileSync(join(dir, 'tiers.json'), JSON.stringify({ 10001: 'boyfriend' }));
        writeFileSync(join(dir, 'chats', '10001.jsonl'), `${JSON.stringify({ time: '2026-10-13T10:00:00.000Z', role: 'user', content: '虚构的一句' })}\nnot json\n`);
        const checks = checkStates(dir);
        const byName = (name: string) => checks.find(check => check.name === name)!;
        assert.equal(byName('行动队列').ok, false);
        assert.match(byName('行动队列').detail, /拒绝启动/);
        assert.equal(byName('档位记录').ok, true);
        assert.match(byName('聊天记录 10001').detail, /1 条可用，1 行会被跳过/);
        assert.equal(existsSync(join(dir, 'world', 'action-queue.json')), true, '原文件还在原处');
        assert.equal(existsSync(join(dir, 'world', 'action-queue.json.corrupt-1')), false);
    });
});
