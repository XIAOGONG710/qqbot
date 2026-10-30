import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { collectRuns, herBubbles, numbersLine, numbersOf } from '../src/ops/depth-report.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-depth-')); dirs.push(dir); return dir; };

const REPORT = [
    '# 深度探针（x-s1r1）',
    '',
    '- `10-29 周四 22:10:00` **对方**：人为什么非得上班啊',
    '- `22:10:43` 她：怎么突然想这个？',
    '- `22:10:50` 她：不是不想上，是怕上完班就没力气活了',
    '- `22:12:00` **对方**：你睡了吗',
    '- `22:12:05` 她：嗯',
    '- `22:12:06` 她：半夜睡不着，突然觉得有点烦',
    '生成 2 次（提示词约 3258 token）；冷场',
].join('\n');
const LOG = [
    '[2026/10/29 22:10:24] [10001] 深思：他在认真问她，这一轮不套字数和条数',
    '[2026/10/29 22:10:59] [10001] 深思：语义路由认为他这一轮是「要她的看法」',
    '[2026/10/29 22:11:00] [10001] 别的日志',
].join('\n');

describe('深度评估的数字', () => {
    test('herBubbles：只取“她：”的行，其他（他的话、标题、统计行）不取', () => {
        assert.deepEqual(herBubbles(REPORT), ['怎么突然想这个？', '不是不想上，是怕上完班就没力气活了', '嗯', '半夜睡不着，突然觉得有点烦']);
    });

    test('numbersOf：几句、几轮深思（其中语义路由几轮）、气泡数、中位字数、两字以内、三种说法的比例', () => {
        const numbers = numbersOf([{ report: REPORT, log: LOG }]);
        assert.equal(numbers.steps, 2);
        assert.equal(numbers.deliberate, 2);
        assert.equal(numbers.routed, 1);
        assert.equal(numbers.bubbles, 4);
        assert.equal(numbers.medianChars, 10.5, '1、8、13、17 字 → 偶数个取中间两个的平均 (8+13)/2');
        assert.equal(numbers.tinyShare, 0.25);
        assert.deepEqual(numbers.tropes, { aphorism: 0.25, insomnia: 0.25, sudden: 0.25 });
    });

    test('numbersOf：多遍合起来算；没有任何话时全 0', () => {
        const two = numbersOf([{ report: REPORT, log: LOG }, { report: REPORT, log: '' }]);
        assert.deepEqual([two.steps, two.deliberate, two.bubbles], [4, 2, 8]);
        const none = numbersOf([]);
        assert.deepEqual([none.steps, none.bubbles, none.medianChars, none.tinyShare], [0, 0, 0, 0]);
        assert.deepEqual(none.tropes, { aphorism: 0, insomnia: 0, sudden: 0 });
    });

    test('collectRuns：目录下每个带 report.md 的跑法都取；没有 sim.log 当空；不存在的目录是空', () => {
        const root = tmp();
        mkdirSync(join(root, 'scene', 'r1'), { recursive: true });
        mkdirSync(join(root, 'scene', 'r2'), { recursive: true });
        writeFileSync(join(root, 'scene', 'r1', 'report.md'), REPORT);
        writeFileSync(join(root, 'scene', 'r1', 'sim.log'), LOG);
        writeFileSync(join(root, 'scene', 'r2', 'report.md'), REPORT);
        const runs = collectRuns(root);
        assert.equal(runs.length, 2);
        assert.equal(runs[0]!.log, LOG);
        assert.equal(runs[1]!.log, '');
        assert.deepEqual(collectRuns(join(root, '没有这个')), []);
    });

    test('numbersLine：只有数字，不含她的话', () => {
        const line = numbersLine('x', numbersOf([{ report: REPORT, log: LOG }]), 1);
        assert.match(line, /^x：1 遍 · 他说了 2 句 · 走深思 2（其中语义路由 1） · 她发了 4 个气泡/);
        assert.match(line, /警句式 25.0% \/ 半夜睡不着 25.0% \/ 突然明白 25.0%/);
        assert.doesNotMatch(line, /怎么突然想这个|上班/);
    });
});
