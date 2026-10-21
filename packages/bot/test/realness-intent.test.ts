import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { recentCrutches } from '../src/expression.ts';
import { ABSTRACT_INTENT, CHALLENGE_INTENT, describeIntent, STALL_INTENT } from '../src/intent.ts';
import { planShape } from '../src/shape.ts';

// 10-22 深夜测试对话（用户：「她现在还是会有 AI 的味道」）量出来的三处：被指出不像真人时自证、被问很抽象的问题时答成金句、被追问答案时原地打转；
// 再加“最近反复说的字词”那一行。台词都是虚构的，只照真实对话的形状写
const now = new Date('2026-10-22T01:20:00+08:00');
const user = (content: string) => ({ role: 'user' as const, content });
const her = (content: string) => ({ role: 'assistant' as const, content });
const intent = (...history: { role: 'user' | 'assistant'; content: string }[]) => describeIntent({ history, now, intimate: true, playful: true });

describe('被指出不像真人 / 重复 / 敷衍：不自证（CHALLENGE_INTENT）', () => {
    test('他说她像 AI、没有活人感、真人不会这样说、老重复、敷衍：给不辩解的意图', () => {
        for (const text of ['你看，说话又跟ai似的', '真人哪有这么说话的', '你觉得你有活人感吗？', '毕竟你会老是重复一件事', '又敷衍我', '你总是这样，模棱两可', '这句话太像稿子了']) {
            assert.equal(intent(her('嗯'), user(text)), CHALLENGE_INTENT, text);
        }
        assert.match(CHALLENGE_INTENT, /别替自己辩解/);
        assert.match(CHALLENGE_INTENT, /嗔一句、笑着认个怂/);
    });

    test('问她是不是 AI / 真人是身份那一路，不在这里；平常的话不触发', () => {
        for (const text of ['你是不是AI啊', '你到底是不是真人', '你是机器人吗']) assert.notEqual(intent(her('嗯'), user(text)), CHALLENGE_INTENT, text);
        for (const text of ['在干嘛', '我今天吃了泡面', '你喜欢吃什么']) assert.notEqual(intent(her('嗯'), user(text)), CHALLENGE_INTENT, text);
    });
});

describe('很抽象的问题：别答成金句（ABSTRACT_INTENT）', () => {
    test('谈恋爱是什么样子、喜欢我什么、真实想法、伤心什么感觉、理想型', () => {
        for (const text of ['你说谈恋爱到底是什么样子的？', '那就说说你喜欢我什么？', '就这些吗？我想听到你真正的想法', '伤心是什么感觉，你能跟我说说吗？', '你希望和什么样子的人谈恋爱呢？']) {
            assert.equal(intent(her('嗯'), user(text)), ABSTRACT_INTENT, text);
        }
        assert.match(ABSTRACT_INTENT, /别总结成一句漂亮的话/);
        assert.match(ABSTRACT_INTENT, /不要排比、对仗/);
    });

    test('这一类轮次形状只用长的几档（不会只回两个字）', () => {
        const plans = Array.from({ length: 200 }, (_, i) => planShape({
            history: [{ role: 'user', content: `你说谈恋爱到底是什么样子的${i}`, time: new Date(Date.UTC(2026, 9, 21, 17, 0, i)).toISOString() }], intent: ABSTRACT_INTENT,
        })!);
        assert.ok(plans.every(plan => plan.cap >= 14));
    });
});

describe('被连着追问一个答案：别原地打转（STALL_INTENT）', () => {
    const stalling = [her('这也太突然了吧'), her('太急了吧'), her('我困了，改天好好说行不行'), her('今晚是真的急')];

    test('他在追答案、她前面 6 条里至少 3 条在往后推：换成给态度的意图', () => {
        for (const text of ['回答我，你愿意吗？', '不要回避', '那么你到底愿不愿意接受我呢', '我想知道你的真实想法']) {
            assert.equal(intent(...stalling, user(text)), STALL_INTENT, text);
        }
        assert.match(STALL_INTENT, /别再用同样的理由往后推/);
        assert.match(STALL_INTENT, /现在就给一个态度/);
    });

    test('她没怎么推（不够 3 条）、或者他没在追：不触发', () => {
        assert.notEqual(intent(her('嗯'), her('太急了吧'), user('回答我，你愿意吗？')), STALL_INTENT);
        assert.notEqual(intent(...stalling, user('你吃了吗')), STALL_INTENT);
    });

    test('追答案的轮次形状只用长的几档', () => {
        const plans = Array.from({ length: 200 }, (_, i) => planShape({
            history: [{ role: 'user', content: `回答我你愿意吗${i}`, time: new Date(Date.UTC(2026, 9, 21, 17, 0, i)).toISOString() }], intent: STALL_INTENT,
        })!);
        assert.ok(plans.every(plan => plan.cap >= 14));
    });
});

describe('最近反复说的字词（recentCrutches）', () => {
    test('追问那一段：太急 / 急 / 困 / 明天 这些被点出来', () => {
        const history = [
            her('这也太突然了吧'), her('太急了吧'), her('现在说这个啊'), her('我困了，改天好好说行不行'),
            her('今晚是真的急'), her('急也没用'), her('就是太急了，我脑子都懵了'), her('明天说'),
        ];
        const found = recentCrutches(history);
        assert.ok(found.length >= 1 && found.length <= 4, found.join());
        assert.ok(found.some(word => word.includes('急')), found.join());
    });

    test('话题各不相同、条数不够、称呼和笑声：不算', () => {
        assert.deepEqual(recentCrutches([her('在宿舍'), her('刚下课'), her('晚上吃什么'), her('今天猫没来')]), []);
        assert.deepEqual(recentCrutches([her('急'), her('急了')]), [], '不够 4 条');
        const only = [her('宝宝'), her('哈哈哈'), her('宝宝你好'), her('哈哈哈哈'), her('宝宝~'), her('哈哈')];
        assert.deepEqual(recentCrutches(only), [], '称呼和笑声不算');
    });

    test('只看她自己的气泡，他的话不算', () => {
        const history = [user('急急急'), her('嗯'), user('急死了'), her('好'), user('急'), her('啊'), user('急'), her('哦')];
        assert.deepEqual(recentCrutches(history), []);
    });
});
