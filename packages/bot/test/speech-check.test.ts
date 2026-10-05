import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/config.ts';
import { loadTierCard } from '../src/contact.ts';
import type { StoredMessage } from '../src/history.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { inspectSpeech, opener, speechContext, stripOpeners, type SpeechContext, type SpeechKind } from '../src/speech-check.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const none: SpeechContext = { recent: [], his: [] };
const kinds = (text: string, kind: SpeechKind, context = none) => inspectSpeech(text, context).filter(i => i.kind === kind).map(i => i.match);

describe('说话的毛病：助手腔（ADR 0014 决策 2）', () => {
    test('客服式的收尾、套话、分点', () => {
        assert.deepEqual(kinds('要是想说了随时找我', 'service'), ['随时找我']);
        assert.deepEqual(kinds('就在这儿，想说了随时找我', 'service'), ['随时找我']);
        assert.deepEqual(kinds('有什么不懂的再问我', 'service'), ['有什么不懂的再问']);
        assert.deepEqual(kinds('有需要的话随时跟我说', 'service'), ['有需要的话随时跟']);
        assert.deepEqual(kinds('希望对你有帮助', 'service'), ['希望对你有帮助']);
        assert.deepEqual(kinds('不客气', 'service'), ['不客气']);
        assert.deepEqual(kinds('还有什么想问的吗', 'service'), ['还有什么想问']);
        assert.equal(kinds('1. 先把基础语法过一遍', 'service').length, 1);
        assert.equal(kinds('- 先把基础语法过一遍', 'service').length, 1);
    });
    test('不误伤', () => {
        for (const line of ['我在这儿，有空再来找我', '有问题吗你', '学习率是 2.5 倍那个', '1块钱一根的那种', '你有啥事', '那你先忙',
            '随便你', '你客气啥', '想说就跟我说，不想说我就陪你待会儿',
            '面试官问「你还有什么想问的」，好多人说没有，那基本就凉了']) {
            assert.deepEqual(inspectSpeech(line, none).filter(i => i.kind === 'service'), [], line);
        }
    });
});

describe('说话的毛病：算账', () => {
    test('取证里的原句', () => {
        for (const [line, match] of [
            ['醒啦？这会儿才想起来回我', '这会儿才想起'],
            ['你现在才想起问我', '现在才想起'],
            ['你呢，怎么这个点儿才冒出来', '这个点儿才冒出来'],
            ['你明天考今天才来问我，真有你的', '今天才来'],
            ['哎哟，明天考现在才来', '现在才来'],
            ['哟，还知道回来啊', '还知道回来'],
            ['哟，回青岛了还知道想我', '还知道想我'],
            ['你终于想起来还有我这么个人了', '终于想起'],
            ['你回青岛了不陪家里人，怎么想起我了', '想起我了'],
            ['你课忙完了就想起我啦', '想起我啦'],
            ['你今天干嘛去了，一整天没动静', '一整天没动静'],
            ['面试到底怎么样了，你昨天说完就没影了', '说完就没影了'],
            ['你妈叫你，你就把我晾这了？', '把我晾'],
            ['哟，回青岛了才想起我', '才想起我'],
            ['哟，还知道有个我啊', '还知道有个我'],
            ['你这两天是不是把我忘了', '把我忘了'],
            ['哟，失踪人口回归了', '失踪人口'],
            ['从昨天到今天一个字都没有，我还以为你被导师关起来了', '一个字都没有'],
            ['一句话也没回我', '一句话也没回我'],
            ['哟，还活着啊', '还活着啊'],
            ['你还活着呢', '还活着呢'],
        ] as const) {
            assert.deepEqual(kinds(line, 'ledger'), [match], line);
        }
    });
    test('说她自己的、说别的事、撒娇的不安，不算', () => {
        for (const line of ['你上午发的，我这会儿才翻到', '回去拿了没，还是已经躺床上了才想起来', '我终于想起来那个词叫什么了',
            '你会不会哪天就不理我了', '行吧，那这几天我就当你失踪了', '我现在才知道', '今天才周二啊', '人呢', '先去吃饭，吃完再回我',
            '我刚还在想你在干嘛呢', '辛苦啦', '你可别把我忘了', '我在这儿，想说的时候喊我',
            '我一个字都没看懂', '一句话都没有说错', '土豆还活着呢，好着呢', '那盆花还活着吗']) {
            assert.deepEqual(kinds(line, 'ledger'), [], line);
        }
    });
});

describe('说话的毛病：怪他没说', () => {
    test('取证里的原句', () => {
        for (const [line, match] of [
            ['你都回家了？也不说一声', '也不说一声'],
            ['都回家了也不跟我说一声 我还以为你在学校待着呢', '也不跟我说一声'],
            ['什么面试啊，昨天也不跟我说', '也不跟我说'],
            ['真的啊，你人都回青岛了，一个招呼都不打', '招呼都不打'],
            ['我就是酸你回青岛了都没想着告诉我一声', '没想着告诉我'],
            ['上班？你什么时候背着我有班上了', '背着我'],
            ['一放假就跑了，把我一个人扔学校', '把我一个人扔'],
            ['你回青岛了也不说带我玩，我在这边快发霉了', '也不说带'],
            ['倒是你，跑回青岛也不来找我', '也不来找我'],
            ['哟，去超市了也不叫我', '也不叫我'],
            ['你回青岛了也不说去我家看看', '也不说去'],
            ['哟，回青岛不带上我', '不带上我'],
            ['什么实习啊，之前也没听你说过', '也没听你说过'],
            ['你之前怎么没跟我说过，我还以为你就在宿舍躺着呢', '怎么没跟我说过'],
            ['爬山不叫我，我还在学校蹲着呢', '不叫我'],
            ['出去玩不带我玩', '不带我'],
            ['哦豁，一个人偷偷回青岛爬山去了', '一个人偷偷回'],
            ['你去的哪座山啊，怎么突然想起来爬山，也不提前说一声', '也不提前说一声'],
            ['面试也不先跟我说', '也不先跟我说'],
            ['面试？你什么时候投的简历，我咋不知道', '我咋不知道'],
            ['什么实习啊，跟你说过吗，我怎么不知道', '我怎么不知道'],
            ['你倒好，在家吃香的喝辣的，我在这儿啃食堂', '你倒好'],
            ['你倒是回家了，留我一个人在学校', '留我一个人'],
        ] as const) {
            assert.deepEqual(kinds(line, 'blame'), [match], line);
        }
    });
    test('不误伤', () => {
        for (const line of ['你别告诉我你又没吃饭', '我都不告诉你', '他背着我的相机跑了', '出门也不带伞', '我也不想去', '你回青岛那边怎么样，吃上家里的饭没',
            '爬的哪座啊，累成这样', '我把我的猫粮扔了', '你去吧，不带上我也行', '我从来没跟你说过吗',
            '上课呢，偷偷回的', '我偷偷回你一句', '他从来不叫我名字', '你别不叫我啊', '你不带我也行',
            '数学作业我一看就头疼 第三题是啥我都不知道', '我怎么不知道你喜欢吃辣', '你倒好意思说我', '你倒是回我啊',
            '对了跟你说个惨的，国庆没抢到票，就我一个人留守学校', '你别留我一个人', '我也不先说了，等你回来']) {
            assert.deepEqual(kinds(line, 'blame'), [], line);
        }
    });
});

describe('说话的毛病：重复（和她最近几次回复比）', () => {
    const recent = (...replies: string[]) => replies.map(r => r.split('\n'));
    test('开头：语气词按一种算，用过 2 次就算重复，去掉语气词', () => {
        const context = { recent: recent('行行行，那你去浇水', '你还真演上瘾了是吧', '行吧你待着\n别翻我抽屉'), his: [] };
        const issues = inspectSpeech('行，你留着吧\n一件都别还', context);
        assert.deepEqual(issues, [{ line: 0, kind: 'repeat', repeat: 'opener', match: '行', count: 2, stripped: '你留着吧' }]);
        assert.equal(stripOpeners('行，你留着吧\n一件都别还', issues), '你留着吧\n一件都别还');
        assert.deepEqual(inspectSpeech('行了不闹了，睡觉', context).map(i => i.stripped), ['不闹了，睡觉']);
    });
    test('只用过 1 次不算；「行不行」「好看」不是语气词', () => {
        assert.deepEqual(inspectSpeech('行，你喝', { recent: recent('行吧你待着', '你喝吧'), his: [] }), []);
        assert.equal(opener('行不行啊你'), undefined);
        assert.equal(opener('好看吗'), undefined);
        assert.deepEqual(opener('行吧'), { key: '行', stripped: '' });
        assert.deepEqual(opener('行了吧，满意没'), { key: '行', stripped: '满意没' });
        assert.deepEqual(opener('哎哟，还挺准时'), { key: '哟', stripped: '还挺准时' });
    });
    test('别的开头：第一个短句 3 个字以内，用过 2 次要重写（不能直接去掉）', () => {
        const context = { recent: recent('快睡，都两点了', '你别闹', '快睡，明天还早八'), his: [] };
        assert.deepEqual(inspectSpeech('快睡，明天别忘了', context), [{ line: 0, kind: 'repeat', repeat: 'opener', match: '快睡', count: 2 }]);
    });
    test('「我」「你」「宝宝」「晚安」这类开头不算', () => {
        const context = { recent: recent('我，在宿舍呢', '宝宝，吃饭没', '晚安，睡吧', '我，刚醒', '宝宝，在吗', '晚安，做个好梦'), his: [] };
        assert.deepEqual(inspectSpeech('宝宝，我来了\n晚安，明天见\n我，刚洗完澡', context), []);
    });
    test('4 字片段说过 2 次算重复；对方最近说过的话题词不算', () => {
        const context = { recent: recent('明天醒了芙芙拍清楚点', '不许似\n记得拍清楚点', '快睡'), his: ['你看这张怎么样'] };
        assert.deepEqual(inspectSpeech('赶紧睡你的 明天拍清楚给我', context), []);
        assert.deepEqual(inspectSpeech('明天醒了拍清楚点', context).map(i => [i.repeat, i.match, i.count]), [['phrase', '拍清楚点', 2]]);
        const topic = { recent: recent('三分糖的，你牙别又作', '三分糖那个，别手滑'), his: ['那我喝三分糖的'] };
        assert.deepEqual(inspectSpeech('就三分糖的吧', topic), []);
    });
    test('只剩语气词的那一行删掉；全是语气词就原样留着', () => {
        const issues = [{ line: 0, kind: 'repeat', stripped: '' }, { line: 1, kind: 'repeat', stripped: '' }];
        assert.equal(stripOpeners('行吧\n你待着', issues.slice(0, 1)), '你待着');
        assert.equal(stripOpeners('行吧\n哦', issues), '行吧\n哦');
    });
    test('比较用的上下文：连着的几条算一次，取最近 8 次和对方最近 3 条', () => {
        const history: StoredMessage[] = [];
        const add = (role: 'user' | 'assistant', content: string) => history.push({ time: '2026-10-05T08:00:00.000Z', role, content });
        for (let i = 0; i < 10; i++) {
            add('user', `问${i}`);
            add('assistant', `答${i}`);
            add('assistant', `又${i}`);
        }
        add('user', '最后');
        const context = speechContext(history);
        assert.equal(context.recent.length, 8);
        assert.deepEqual(context.recent[0], ['答2', '又2']);
        assert.deepEqual(context.recent.at(-1), ['答9', '又9']);
        assert.deepEqual(context.his, ['问8', '问9', '最后']);
    });
});

describe('模拟器的 speechClean 检查（假模型）', () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
        promptPostProcessing: '', extraBody: {},
    };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };

    test('和这一步之前她说过的比：第三次「行」开头才算', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'speech-'));
        const replies = ['行，你说', '行吧你待着', '行，你留着吧\n醒啦？这会儿才想起来回我'];
        try {
            const scenario = parseScenario({
                name: 'x', tier: 'boyfriend', user: '阿明', start: '2026-10-08T21:40:00+08:00', memory: false, schedule: false,
                steps: [
                    { say: '我跟你说个事' }, { check: { speechClean: true } },
                    { say: '算了不说了' }, { check: { speechClean: true } },
                    { say: '你的东西我拿走了' }, { check: { speechClean: true } },
                ],
            });
            const result = await runScenario(scenario, {
                runId: 't', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 },
                generate: async () => replies.shift()!,
            });
            const checks = result.steps.filter(s => s.kind === 'check').map(s => s.checks[0]!);
            assert.deepEqual(checks.map(c => c.ok), [true, true, false]);
            assert.match(checks[2]!.text, /第 1 行开头「行」最近用过 2 次、第 2 行算账「这会儿才想起」/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
