import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn } from '../src/interpreter/interpreter.ts';
import { interruptionsModule } from '../src/modules/interruptions.ts';

// 直接测 interruptions.ts 的接线：assess 写 facts.interruption + 日志，contribute 放 interrupt 槽。
const at = new Date('2026-11-22T13:00:00.000Z');
const event = { id: 'e1', text: '室友喊她去拿外卖', at: new Date('2026-11-22T12:58:00.000Z') };
const history = [
    { role: 'user' as const, content: '在干嘛', time: '2026-11-22T12:56:00.000Z' },
    { role: 'assistant' as const, content: '刚吃完', time: '2026-11-22T12:56:30.000Z' },
];
/** 聊天正在进行：最后一句是 12:59:50，小事发生在 12:58（2 分钟前）。 */
const live = (content: string): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' },
    at,
    history: [...history, { role: 'user', content, time: '2026-11-22T12:59:50.000Z' }],
    thinking: false,
    facts: { world: { events: [event] } as never },
});
const LOG_LINE = '[1] 被打断：聊着的时候她那边发生了一件小事（提示词里多一行；日志不记内容）';

describe('interruptionsModule（ADR 0115 / 0336）', () => {
    test('模块 id 正确；命中时 assess 写进 facts.interruption 并记一行日志，contribute 给出完整的一行提示词', () => {
        const logs: string[] = [];
        const module = interruptionsModule(line => logs.push(line));
        assert.equal(module.id, 'interruptions');

        const turn = live('好吧'); // hash 命中（另见「哈希没抽中的轮次」一例）
        module.assess!(turn);
        assert.deepEqual(turn.facts.interruption, { text: '室友喊她去拿外卖', minutesAgo: 2 });
        assert.deepEqual(logs, [LOG_LINE]);

        const pieces = module.contribute!(turn) as readonly { slot: string; text: string }[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'interrupt');
        assert.equal(pieces[0]!.text, '[你正聊着，2 分钟前你这边发生了一件小事：室友喊她去拿外卖。先接他的话，顺带说一声你刚被这件事岔了一下（像当场说的：“等下，……”）；事情的细节只用这一句写的，没写的别编；要花点时间的可以说一声“等下”再去弄，别写成长段]');
    });

    test('缺字段：没有 world / events 为空 / 最后一句没有 time / 她没回过话，都不打断也不记日志', () => {
        const logs: string[] = [];
        const module = interruptionsModule(line => logs.push(line));

        const noWorld: Turn = { ...live('好吧'), facts: {} };
        module.assess!(noWorld);
        assert.equal(noWorld.facts.interruption, undefined);

        const noEvents: Turn = { ...live('好吧'), facts: { world: { events: [] } as never } };
        module.assess!(noEvents);
        assert.equal(noEvents.facts.interruption, undefined);

        const noLastTime: Turn = { ...live('好吧'), history: [...history, { role: 'user' as const, content: '好吧' }] };
        module.assess!(noLastTime);
        assert.equal(noLastTime.facts.interruption, undefined);

        const noHerReply: Turn = { ...live('好吧'), history: [{ role: 'user' as const, content: '好吧', time: '2026-11-22T12:59:50.000Z' }] };
        module.assess!(noHerReply);
        assert.equal(noHerReply.facts.interruption, undefined);

        assert.deepEqual(logs, []);
        for (const turn of [noWorld, noEvents, noLastTime, noHerReply]) assert.deepEqual(module.contribute!(turn), []);
    });

    test('让路的轮次不写：非男朋友档、主动找他、只想一想、他难过，即使有小事也不打断', () => {
        const logs: string[] = [];
        const module = interruptionsModule(line => logs.push(line));
        const world = { events: [event] } as never;
        const variants: Turn[] = [
            { ...live('好吧'), contact: { qq: 1, name: '阿明', tier: 'classmate' } },
            { ...live('好吧'), initiate: { note: '', topic: '' } },
            { ...live('好吧'), thinking: true },
            { ...live('好吧'), facts: { world, baseIntent: '[这一轮你想：先接住他此刻的情绪]' } },
        ];
        for (const turn of variants) {
            const copy: Turn = { ...turn, facts: { ...turn.facts } };
            module.assess!(copy);
            assert.equal(copy.facts.interruption, undefined);
            assert.deepEqual(module.contribute!(copy), []);
        }
        assert.deepEqual(logs, []);
    });

    test('哈希没抽中的轮次（约六成）不打断：同样的世界事件，换一句他的话就不算', () => {
        const logs: string[] = [];
        const module = interruptionsModule(line => logs.push(line));
        const turn = live('在吗'); // hash >= 0.6，命中不了
        module.assess!(turn);
        assert.equal(turn.facts.interruption, undefined);
        assert.deepEqual(logs, []);
        assert.deepEqual(module.contribute!(turn), []);
    });

    test('contribute 只读 facts.interruption：minutesAgo=0 说「刚刚」，超长小事文字原样保留', () => {
        const module = interruptionsModule(() => {});
        const justNow: Turn = { ...live('好吧'), facts: { interruption: { text: '快递到了', minutesAgo: 0 } } };
        const piece = (module.contribute!(justNow) as readonly { slot: string; text: string }[])[0]!;
        assert.equal(piece.slot, 'interrupt');
        assert.ok(piece.text.startsWith('[你正聊着，刚刚你这边发生了一件小事：快递到了。'));
        assert.ok(piece.text.endsWith('别写成长段]'));

        const longText = '室友喊'.repeat(2000);
        const longPiece = (module.contribute!({ ...live('好吧'), facts: { interruption: { text: longText, minutesAgo: 7 } } }) as readonly { slot: string; text: string }[])[0]!;
        assert.ok(longPiece.text.includes(`7 分钟前你这边发生了一件小事：${longText}。`));
        assert.ok(longPiece.text.length > longText.length);
    });
});
