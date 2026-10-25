import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { reviewReply } from '../src/exit-check.ts';
import type { StoredMessage } from '../src/history.ts';
import { edgesOf, finalChar, hasTail, measureEdges, perThousandChars, share, tailParticle } from '../src/rough-edges.ts';
import { SENSITIVE_ON, useSensitiveSwitch } from '../src/sensitive.ts';
import { describeSpeechIssue, inspectSpeech, speechContext, stripOpeners, stripTailParticle, strippable, TAIL_CAPS, tailRecentOf } from '../src/speech-check.ts';

// 日志默认不写原文；这个文件靠日志里的原文断言
useSensitiveSwitch(SENSITIVE_ON);

const message = (role: 'user' | 'assistant', content: string): StoredMessage => ({ role, content, time: '2026-10-25T10:00:00.000Z' }) as StoredMessage;
/** 窗口里已经有 bubbles 条、各个字各收尾了几条 */
const recentWith = (bubbles: number, counts: Record<string, number>) => ({ recent: [] as string[][], his: [] as string[], tailCaps: TAIL_CAPS, tailRecent: { bubbles, counts } });

describe('毛刺的度量（ADR 0146，实验 C）', () => {
    test('句尾语气字：跳过标点、拖音和表情记号看最后一个字；吗不算；单个字的应声不算', () => {
        assert.equal(finalChar('我今天好累啊。'), '啊');
        assert.equal(finalChar('好啊[害羞]～'), '啊');
        assert.equal(hasTail('我今天好累啊。'), true);
        assert.equal(hasTail('好啊[害羞]~'), true);
        assert.equal(hasTail('吃饭了吗'), false);
        assert.equal(hasTail('啊'), false);
        assert.equal(hasTail('笑死我了[笑哭]'), false);
        assert.equal(hasTail(''), false);
        assert.equal(tailParticle('你自己招的吧。'), '吧');
        assert.equal(tailParticle('吃饭了吗'), undefined);
    });

    test('停半拍 / 省略号 / 笑：一条气泡最多算一次，表情记号不算字数', () => {
        assert.deepEqual(edgesOf('嗯，我想想'), { tail: false, hesitation: true, ellipsis: false, laugh: false });
        assert.deepEqual(edgesOf('那个……你先别急'), { tail: false, hesitation: true, ellipsis: true, laugh: false });
        assert.deepEqual(edgesOf('哈哈哈哈笑死我了呢'), { tail: true, hesitation: false, ellipsis: false, laugh: true });
        assert.equal(edgesOf('就是说你今天怎么样').hesitation, false, '「就是说」后面不是停顿位置，只认分句开头独立的就是');
        const stats = measureEdges(['我今天好累啊', '嗯', '行', '那个……算了吧', '笑死', '']);
        assert.equal(stats.bubbles, 5, '空串不算');
        assert.equal(stats.tail, 2);
        assert.equal(stats.hesitation, 2);
        assert.equal(stats.ellipsis, 1);
        assert.equal(stats.laugh, 1);
        assert.equal(stats.any, 4);
        assert.equal(share(stats, 'tail'), 2 / 5);
        assert.ok(perThousandChars(stats, 'tail') > 0);
        assert.equal(share({ bubbles: 0, chars: 0, tail: 0, hesitation: 0, ellipsis: 0, laugh: 0, any: 0 }, 'any'), 0);
    });
});

describe('句尾「吧」「呢」封顶（ADR 0146，实验 B）', () => {
    test('去掉句尾那个字，标点和表情记号原样留着', () => {
        assert.equal(stripTailParticle('我今天真的有点累啊。'), '我今天真的有点累。');
        assert.equal(stripTailParticle('他最近怎么样呢～'), '他最近怎么样～');
        assert.equal(stripTailParticle('我去吃饭啦[开心]'), '我去吃饭[开心]');
        assert.equal(stripTailParticle('你先别急嘛……'), '你先别急……');
    });

    test('固定搭配、省略问句、太短的应声不动', () => {
        assert.equal(stripTailParticle('好啊'), undefined, '太短');
        assert.equal(stripTailParticle('你干嘛'), undefined);
        assert.equal(stripTailParticle('我们去网吧'), undefined, '网吧是个词');
        assert.equal(stripTailParticle('那就这样吧'), undefined, '固定的让步说法');
        assert.equal(stripTailParticle('你自己呢'), undefined, '省略问句，且太短');
        assert.equal(stripTailParticle('我今天去上课了'), undefined, '没挂尾巴');
        assert.equal(stripTailParticle('今晚吃什么呀好呢你说'), undefined, '最后一个字不是语气字');
    });

    test('统计她最近的文字气泡：表情包、图片不算，只数她自己的，按字分开数', () => {
        const history = [
            message('user', '在吗啊'), message('assistant', '在呢'), message('assistant', '<sticker:abc>'), message('assistant', '[图片表情] 笑'),
            message('assistant', '刚吃完饭'), message('assistant', '好累啊'), message('assistant', '你自己招的吧'),
        ];
        assert.deepEqual(tailRecentOf(history), { bubbles: 4, counts: { 呢: 1, 啊: 1, 吧: 1 } });
    });

    test('只封吧和呢；啊、呀、嘛、啦不管，挂多少都不动', () => {
        const heavy = recentWith(80, { 啊: 30, 呀: 20, 嘛: 10, 啦: 10 });
        assert.deepEqual(inspectSpeech('我今天真的有点累啊\n你这样不行嘛\n今天天气真好呀', heavy), []);
    });

    test('「吧」到了封顶：这一轮再用吧收尾的行被去掉，不挂的不动', () => {
        // 窗口 80 条里已有 2 次吧：下一次是 3/81 = 3.7% > 3%
        const issues = inspectSpeech('你今天是存心来气我的吧\n先睡了', recentWith(80, { 吧: 2 }));
        assert.equal(issues.length, 1);
        assert.deepEqual([issues[0]!.line, issues[0]!.kind, issues[0]!.match, issues[0]!.stripped], [0, 'tail', '吧', '你今天是存心来气我的']);
        assert.equal(strippable(issues[0]!), true);
        assert.match(describeSpeechIssue(issues[0]!), /句尾「吧」/);
        assert.equal(stripOpeners('你今天是存心来气我的吧\n先睡了', issues), '你今天是存心来气我的\n先睡了');
    });

    test('还有名额：放过；放过的算进名额，同一轮里后面再用同一个字收尾就开始去', () => {
        // 1/80 → 这次 2/81 = 2.5% ≤ 3%：放过；同轮第二个吧 3/82 = 3.7% > 3%：去
        const issues = inspectSpeech('你自己招的吧\n那我先走了吧', recentWith(80, { 吧: 1 }));
        assert.deepEqual(issues.map(i => i.line), [1]);
        // 两个字各管各的名额：呢满了不影响吧
        const mixed = inspectSpeech('你自己招的吧\n他最近怎么样呢', recentWith(80, { 呢: 2 }));
        assert.deepEqual(mixed.map(i => [i.line, i.match]), [[1, '呢']]);
    });

    test('固定搭配的吧不会被去，也不占名额的判断：好吧 / 网吧 / 你干嘛', () => {
        assert.deepEqual(inspectSpeech('那就这样吧\n我们去网吧', recentWith(80, { 吧: 9 })), []);
    });

    test('没开（不传 tailCaps）不查；已经被「去开头」处理的行，尾巴留到下一轮再查', () => {
        assert.deepEqual(inspectSpeech('我今天真的有点累吧', { recent: [], his: [] }), []);
        const context = { ...recentWith(80, { 吧: 9 }), recent: [['行，好'], ['行，知道了']] };
        const issues = inspectSpeech('行，那我先睡了吧', context);
        assert.equal(issues.filter(i => i.kind === 'tail').length, 0);
        assert.equal(issues.filter(i => i.repeat === 'opener').length, 1);
    });

    test('speechContext 只在开了封顶时带上统计', () => {
        const history = [message('assistant', '好累啊'), message('assistant', '先睡了'), message('assistant', '你自己招的吧')];
        assert.equal(speechContext(history).tailCaps, undefined);
        assert.equal(speechContext(history).tailRecent, undefined);
        const on = speechContext(history, { tailCaps: TAIL_CAPS });
        assert.equal(on.tailCaps, TAIL_CAPS);
        assert.deepEqual(on.tailRecent, { bubbles: 3, counts: { 啊: 1, 吧: 1 } });
    });

    test('出口检查：封顶的尾巴直接去掉，不重写、不多花一次模型', async () => {
        const logs: string[] = [];
        const notes: string[] = [];
        const reply = await reviewReply('你今天是存心来气我的吧\n先睡了', {
            banned: [],
            userName: '阿明',
            speech: recentWith(80, { 吧: 3 }),
            regenerate: async note => { notes.push(note); return 'x'; },
            log: m => logs.push(m),
        });
        assert.equal(reply, '你今天是存心来气我的\n先睡了');
        assert.equal(notes.length, 0);
        assert.equal(logs.length, 1);
        assert.match(logs[0]!, /出口检查：第 1 行句尾「吧」.*去掉/);
    });
});
