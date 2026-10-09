import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeIntent, isEndingTurn, saysOwnThing } from '../src/intent.ts';
import type { Schedule, State } from '../src/schedule.ts';

const now = new Date('2026-10-06T20:00:00+08:00');
const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });
const free = (text: string): State => ({ activity: { kind: 'free', text }, where: '学校', outsideSemester: false });

describe('这一轮你想（ADR 0019）', () => {
    test('他刚说了自己的事：问一个具体细节；普通提问不算', () => {
        assert.equal(saysOwnThing([assistant('嗯'), user('我刚下课，累死了')]), true);
        assert.equal(saysOwnThing([assistant('嗯'), user('你今天干嘛')]), false);
        assert.match(describeIntent({ history: [user('昨晚去看电影了')], now })!, /回应他刚说的/);
        assert.match(describeIntent({ history: [user('你帮我讲讲梯度下降是怎么回事')], now, state: free('打独立游戏') })!, /直接回答/);
        // 「到了没」「写完没」「去不去」也是问句（10-07：「你那快递到了没」被当成闲聊，意图行让她讲起了打游戏的进度）
        for (const asked of ['你那快递到了没', '作业写完没有', '周末去不去', '这样行不行']) {
            assert.match(describeIntent({ history: [user(asked)], now, state: free('打独立游戏') })!, /直接回答/, asked);
        }
        assert.doesNotMatch(describeIntent({ history: [user('我今天没')], now, state: free('打独立游戏') }) ?? '', /直接回答/, '只是没说完');
        // 「干嘛」「啥」也是问句（10-08：「你昨天都干嘛了」被当成闲聊，意图行让她讲手上追剧的进度，问昨天常常想不起那天的麻辣烫）
        for (const asked of ['你昨天都干嘛了', '在干嘛', '你晚饭吃的啥', '你上周都忙啥了', '那前天呢，前天干嘛了']) {
            assert.match(describeIntent({ history: [user(asked)], now, state: free('在追一部剧') })!, /直接回答/, asked);
        }
        assert.doesNotMatch(describeIntent({ history: [user('没啥，就是有点累')], now, state: free('在追一部剧') }) ?? '', /直接回答/, '「没啥」不是问');
    });

    test('按线索顺序只给一个：他的事优先于答应的事，答应的事优先于手上的事', () => {
        assert.match(describeIntent({ history: [user('我今天去面试了')], now, promised: true, books: true })!, /回应他刚说的/);
        assert.match(describeIntent({ history: [user('在吗')], now, promised: true, books: true })!, /答应/);
        assert.equal(describeIntent({ history: [user('在吗')], now, books: true }), undefined);
    });

    test('不强塞空闲活动；开场时忙、上硬课、快睡才限制长度；没线索就没有', () => {
        assert.equal(describeIntent({ history: [user('在吗')], now, state: free('在图书馆看《长安的荔枝》') }), undefined);
        assert.match(describeIntent({ history: [user('在吗')], now, state: free('在图书馆赶作业') })!, /回两句/);
        const hard: State = { activity: { kind: 'class', lesson: { kind: 'hard', start: now, end: new Date(now.getTime() + 3_600_000) } }, where: '学校', outsideSemester: false };
        assert.match(describeIntent({ history: [user('在吗')], now, state: hard })!, /回两句/);
        const schedule = { sleep: '02:00' } as Schedule;
        assert.match(describeIntent({ history: [user('在吗')], now: new Date('2026-10-07T01:00:00+08:00'), state: free(''), schedule })!, /回两句/);
        assert.equal(describeIntent({ history: [user('在吗')], now, state: free('') }), undefined);
    });

    test('主动找他时不给：主动说明本身就是意图', () => {
        assert.equal(describeIntent({ history: [user('我今天去面试了')], now, initiating: true }), undefined);
    });

    test('他说晚安、不想聊或只附和时只给收尾意图，不再追问或分享进度', () => {
        for (const text of ['今天累死了，我先睡了，晚安', '今天不想说话', '嗯', '哈哈', '那我去写代码了，你慢慢看']) {
            const history = [assistant('前一句'), user(text)];
            assert.equal(isEndingTurn(history), true, text);
            assert.match(describeIntent({ history, now, state: free('打独立游戏'), promised: true })!, /收尾/, text);
        }
        assert.equal(isEndingTurn([user('你睡了吗')]), false);
    });

    test('撒娇要她哄、陪不是收尾：带「睡觉」也照亲密话接（10-09 13:11 线上「哄我睡觉呗」）', () => {
        for (const text of ['哄我睡觉呗', '陪我聊会儿嘛', '给我讲个睡前故事', '摸摸头']) {
            const history = [assistant('那睡吧，我下午还有节课'), user(text)];
            assert.equal(isEndingTurn(history), false, text);
            const line = describeIntent({ history, now, state: free('打独立游戏'), promised: true })!;
            assert.match(line, /撒娇要你哄他、陪他/, text);
            assert.match(line, /只接他刚说的你们两个人的事/, '候选挑选和气泡上限照亲密话算');
            assert.doesNotMatch(line, /收尾/);
        }
        assert.equal(isEndingTurn([user('想睡觉了')]), true, '他自己说要睡还是收尾');
    });

    test('明确难过时只接住，不转去讲自己的猫、书或进度；普通短句不脑补', () => {
        for (const text of ['悲', '我哭得很伤心', '今天累死了', '有点难受', '今天被导师骂了，烦死', '好烦啊', '心累']) {
            const line = describeIntent({ history: [user(text)], now, state: free('在追一部剧'), books: true })!;
            assert.match(line, /先接住他此刻的情绪/, text);
            assert.match(line, /第一句先安慰或问怎么了，不先损他/, text);
        }
        assert.equal(describeIntent({ history: [user('烦人精')], now, state: free('在追一部剧') }), undefined, '烦人精是叫他，不是心情');
        assert.match(describeIntent({ history: [user('已经见面5150天了呢')], now, state: free('刷摄影区'), books: true })!, /只接他刚说的你们两个人的事/);
    });
});

describe('挂着的事进意图行（ADR 0023）', () => {
    const waiting = ['阿明周四下午字节面试'];
    const unanswered = ['他国庆回不回家'];

    test('等他说结果的：开口时最先问，只表达想知道，不写介意；收尾、他直接问时让路', () => {
        const line = describeIntent({ history: [user('在吗')], now, waiting, unanswered, promised: true })!;
        assert.match(line, /知道「阿明周四下午字节面试」后来怎么样了/);
        assert.doesNotMatch(line, /介意|委屈|失望|怪他|生气/);
        assert.match(describeIntent({ history: [user('我刚下班，累死了')], now, waiting })!, /接住他此刻的情绪/, '他说自己的事时不拿旧事抢话');
        assert.match(describeIntent({ history: [user('晚安')], now, waiting })!, /收尾/);
        assert.match(describeIntent({ history: [user('你今天吃的啥')], now, waiting })!, /直接回答/);
        assert.equal(describeIntent({ history: [user('在吗')], now, waiting, initiating: true }), undefined);
    });

    test('她问了他没答的：排在答应的事之后，轻轻再问，不追究', () => {
        assert.match(describeIntent({ history: [user('在吗')], now, unanswered, promised: true })!, /答应/);
        const line = describeIntent({ history: [user('在吗')], now, unanswered, books: true })!;
        assert.match(line, /上次问他「他国庆回不回家」他没顾上回，轻轻再问一次；他不接就算了，不追究/);
    });
});
