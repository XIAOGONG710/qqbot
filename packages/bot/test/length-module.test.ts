import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn, TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { describeLength, lengthHint } from '../src/language/expression.ts';
import { lengthModule } from '../src/modules/length.ts';

// 长短不一（ADR 0024）迁成模块（ADR 0336）：行为基线里深思的轮次碰巧都抽不中长短，挡长短的那几样由这里逐个核对
describe('长短不一模块（ADR 0024 / 0336）', () => {
    const at = new Date('2026-11-20T20:00:00+08:00');
    const said = (text: string) => [{ role: 'user' as const, content: text, time: at.toISOString() }];
    // 找一句按哈希能抽中长短的话（同一句每次一样）
    const hit = Array.from({ length: 200 }, (_, i) => `今天去食堂吃了第${i}个窗口，排了好久的队才吃上饭`).find(text => lengthHint({ history: said(text) }));
    const turnOf = (facts: TurnFacts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: said(hit!), thinking: false, facts, ...patch,
    });
    const run = (t: Turn) => lengthModule({ log: () => {} }).contribute!(t) as Piece[];

    test('抽中了：放 length 槽，写法同 describeLength', () => {
        assert.ok(hit, '200 句里应该有能抽中的');
        const hint = lengthHint({ history: said(hit!) })!;
        assert.deepEqual(run(turnOf()), [{ slot: 'length', text: describeLength(hint) }]);
    });

    test('危机、形状、记忆线索、只发表情、照片、被打断、只想一想、深思：都不放', () => {
        const blocked: [string, Turn][] = [
            ['危机', turnOf({ crisis: { level: 'high' } as TurnFacts['crisis'] })],
            ['形状', turnOf({ shape: { cap: 20, maxBubbles: 2 } as TurnFacts['shape'] })],
            ['记忆线索', turnOf({ cue: '国庆' })],
            ['只发表情', turnOf({ stickerOnly: true })],
            ['照片', turnOf({ photo: 'cat' })],
            ['被打断', turnOf({ interruption: { text: '土豆跳上桌了', minutesAgo: 1 } })],
            ['只想一想', turnOf({}, { thinking: true })],
            ['深思', turnOf({ deliberate: true })],
        ];
        for (const [name, t] of blocked) assert.deepEqual(run(t), [], name);
    });
});
