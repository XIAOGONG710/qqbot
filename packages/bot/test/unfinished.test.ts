import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeShape } from '../src/shape.ts';
import { applyTexture } from '../src/texture.ts';
import { endsHanging, findUnfinished, finishReply, repairUnfinished } from '../src/unfinished.ts';

const kinds = (reply: string) => findUnfinished(reply).map(item => `${item.kind}:${reply.split('\n').filter(Boolean)[item.index]}`);

describe('话说到一半就停了：找出来（ADR 0141）', () => {
    test('线上那三处：多条回复的最后一条是转折加一小句态度；一条停在「说得」上', () => {
        assert.deepEqual(kinds('想啊，都想得有点睡不着了\n不过你别得意'), ['tail:不过你别得意']);
        assert.deepEqual(kinds('会伤心\n不过你别瞎想这些'), ['tail:不过你别瞎想这些']);
        assert.deepEqual(kinds('这话说得\n也太突然了\n我要想想'), ['cut:这话说得']);
    });

    test('不算的：只有一条、带问号 / 拖音、转折后面有内容、不是转折、完整的名词短语', () => {
        for (const ok of [
            '不过你别得意',
            '想啊\n但是你呢？',
            '想啊\n不过你别得意……',
            '想啊，都想得有点睡不着了\n不过说真的，我挺想你的',
            '想啊\n不过这周末你要是有空，我们可以一起去看电影，我请你',
            '行啊～\n就是周日晚上有事',
            '嘴上不说\n还有我在你面前不用装',
            '你睡了没\n对了，笔记本明天到',
            '等你说句正经的话\n算了 睡吧',
            '要是能这样就好了\n是吧',
            '如果你想去，我陪你\n万一下雨了就不去了',
            '我觉得……\n算了',
            '你觉得？\n说话啊',
            '好累啊\n<sticker:0123456789ab>',
            '不过你别得意\n<sticker:0123456789ab>',
        ]) assert.deepEqual(findUnfinished(ok), [], ok);
    });

    test('停在不能结句的词上的一条：连词、假设、觉得 / 说得；「要是……的话」才算，「……的话」单独不算', () => {
        for (const bad of ['要是你不来', '我觉得', '因为', '然后', '所以', '你要是不想去的话', '我也想跟你', '这个你说得']) {
            assert.deepEqual(kinds(`好\n${bad}`), [`cut:${bad}`], bad);
        }
        assert.equal(endsHanging('等你说句正经的话'), false);
        assert.equal(endsHanging('要是不行的话。'), true);
    });

    test('表情包行不占名额：最后一条文字才是「最后一条」', () => {
        assert.deepEqual(kinds('想啊\n不过你别得意\n<sticker:0123456789ab>'), ['tail:不过你别得意']);
        assert.deepEqual(findUnfinished('不过你别得意\n<sticker:0123456789ab>'), []);
    });
});

describe('话说到一半就停了：重写后还是这样时的处理', () => {
    test('tail 并回前一条；前一条是问句就去掉最后一条', () => {
        const merged = repairUnfinished('想啊，都想得有点睡不着了\n不过你别得意', findUnfinished('想啊，都想得有点睡不着了\n不过你别得意'));
        assert.equal(merged.reply, '想啊，都想得有点睡不着了，不过你别得意');
        assert.equal(merged.notes.length, 1);
        const question = '想我了没？\n不过你别得意';
        assert.equal(repairUnfinished(question, findUnfinished(question)).reply, '想我了没？');
    });

    test('cut 退到上一个逗号；退不回去时去掉那一条；只有一条就原样留着，不发空消息', () => {
        const back = '我想了想，要是你不来';
        assert.equal(repairUnfinished(back, findUnfinished(back)).reply, '我想了想');
        const multi = '好\n这话说得\n我要想想';
        assert.equal(repairUnfinished(multi, findUnfinished(multi)).reply, '好\n我要想想');
        const only = '这话说得';
        const kept = repairUnfinished(only, findUnfinished(only));
        assert.equal(kept.reply, '这话说得');
        assert.match(kept.notes.join(), /原样留着/);
    });
});

describe('话说到一半就停了：出口（重写一次，不行再处理）', () => {
    const logs: string[] = [];
    const deps = (regenerate: (note: string) => Promise<string>) => { logs.length = 0; return { regenerate, log: (line: string) => { logs.push(line); } }; };

    test('没问题就不重写', async () => {
        let called = 0;
        const reply = await finishReply('想啊\n我也是', deps(async () => { called++; return 'x'; }));
        assert.equal(reply, '想啊\n我也是');
        assert.equal(called, 0);
        assert.deepEqual(logs, []);
    });

    test('有问题：带说明重写一次，说明里不引用原句，日志里没有原话；重写好了就用重写的', async () => {
        const notes: string[] = [];
        const reply = await finishReply('想啊，都想得有点睡不着了\n不过你别得意', deps(async note => { notes.push(note); return '想啊，都想得有点睡不着了\n不过你别得意，我就想了一下下'; }));
        assert.equal(notes.length, 1);
        assert.ok(!notes[0]!.includes('得意') && notes[0]!.includes('没有发出去'), notes[0]);
        assert.equal(reply, '想啊，都想得有点睡不着了\n不过你别得意，我就想了一下下');
        assert.ok(logs.length === 1 && logs[0]!.includes('带说明重写一次') && !logs.join().includes('得意'), logs.join('|'));
    });

    test('重写后还是这样就处理；重写失败 / 重写成空也处理；处理后不会是空的', async () => {
        const bad = '想啊，都想得有点睡不着了\n不过你别得意';
        assert.equal(await finishReply(bad, deps(async () => '嗯\n不过你别瞎想')), '嗯，不过你别瞎想');
        assert.equal(await finishReply(bad, deps(async () => { throw new Error('断网'); })), '想啊，都想得有点睡不着了，不过你别得意');
        assert.ok(logs.some(line => line.includes('重写失败（断网）')));
        assert.equal(await finishReply(bad, deps(async () => '\n')), '想啊，都想得有点睡不着了，不过你别得意');
        assert.equal(await finishReply('这话说得', deps(async () => '这话说得')), '这话说得');
    });
});

describe('话说到一半就停了：另外两处会造成它的地方', () => {
    test('提示词里不再说「半句也行」「不用把话说圆」「留半句」，换成「把意思说完」；一个词的反应（micro）不受影响', () => {
        const all = [
            describeShape({ kind: 'short', cap: 8, maxBubbles: 2 }),
            describeShape({ kind: 'medium', cap: 14, maxBubbles: 2 }),
            describeShape({ kind: 'long', cap: 24, maxBubbles: 2, parts: 2 }),
            describeShape({ kind: 'short', cap: 8, maxBubbles: 1, drawl: true }),
        ].join('\n');
        assert.doesNotMatch(all, /半句也行|不用把话说圆|不用凑成完整|留半句/);
        assert.match(describeShape({ kind: 'medium', cap: 14, maxBubbles: 2 }), /把意思说完/);
        assert.match(describeShape({ kind: 'long', cap: 24, maxBubbles: 2, parts: 2 }), /最后一条要有自己的内容/);
        assert.match(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1 }), /单个词都可以/);
    });

    test('质感不把停在连词 / 假设词上的「……」去掉（去掉就成了话说到一半）；别的省略号照旧', () => {
        for (let i = 0; i < 30; i++) {
            const kept = applyTexture(['要是你不来……'], { seed: `s${i}`, serious: false, recentFaces: 9 });
            assert.deepEqual(kept.parts, ['要是你不来……'], `seed s${i}`);
        }
        const stripped = Array.from({ length: 30 }, (_, i) => applyTexture(['我今天不想动了……'], { seed: `s${i}`, serious: false, recentFaces: 9 }).parts[0]);
        assert.ok(stripped.some(part => part === '我今天不想动了'), '别的省略号还是会去掉');
    });
});
