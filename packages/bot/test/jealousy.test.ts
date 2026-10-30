import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeIntent } from '../src/language/intent.ts';
import { JEALOUS_COOLDOWN_MS, JEALOUS_INTENT, JEALOUS_SHARE, jealousTurn, mentionsOtherWoman, reassures, SOFTEN_INTENT } from '../src/language/jealousy.ts';

// ADR 0123：吃醋，最轻的一档。重点是轨道：不盘问、不要保证、不让他愧疚、不限制他
const now = new Date(2026, 10, 20, 22, 0).getTime();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
type Said = { role: 'user' | 'assistant'; content: string; time: string };
const him = (minutesAgo: number, content: string): Said => ({ role: 'user', content, time: at(minutesAgo) });
const her = (minutesAgo: number, content: string): Said => ({ role: 'assistant', content, time: at(minutesAgo) });

/** 找一句会触发的（按哈希约一半触发，测试用同一类句子里挑一个） */
function triggering(build: (variant: string) => Said[]): Said[] {
    for (const tail of ['', '，挺开心', '，聊得不错', '。', '！', '，哈哈', '，今天', '，还行']) {
        const history = build(tail);
        if (jealousTurn(history, now) === 'jealous') return history;
    }
    throw new Error('找不到会触发的一句');
}

describe('什么算“提到别的女生”', () => {
    test('明确是别的女生、并且在说和她有来往才算', () => {
        for (const text of ['今天和女同事一起吃饭了', '新认识的小姐姐加了我微信', '学姐夸我做得好', '前女友找我聊了几句', '有个女生跟我表白了']) assert.equal(mentionsOtherWoman(text), true, text);
    });

    test('家人、老师、泛泛而谈、没有来往都不算', () => {
        for (const text of ['我妈让我回家吃饭', '我姐一起吃饭了', '老师夸我做得好', '女生都喜欢这个吧', '今天有个女生坐在我旁边', '同事一起吃饭了', '今天好累']) assert.equal(mentionsOtherWoman(text), false, text);
    });

    test('解释 / 哄她的话', () => {
        for (const text of ['你想多了，就是同事', '我只喜欢你', '逗你的啦', '别吃醋啊']) assert.equal(reassures(text), true, text);
        assert.equal(reassures('晚上吃什么'), false);
    });
});

describe('这一轮酸不酸', () => {
    test('他提到别的女生：约 JEALOUS_SHARE 的情况触发；同一句每次一样', () => {
        const hits = Array.from({ length: 300 }, (_, i) => jealousTurn([her(10, '在呢'), him(1, `今天和女同事一起吃饭了${i}`)], now)).filter(x => x === 'jealous').length;
        assert.ok(hits > 300 * JEALOUS_SHARE * 0.7 && hits < 300 * JEALOUS_SHARE * 1.3, `300 句里 ${hits}`);
        const history = triggering(tail => [her(10, '在呢'), him(1, `今天和女同事一起吃饭了${tail}`)]);
        assert.equal(jealousTurn(history, now), jealousTurn(history, now));
    });

    test('3 天内再提别的女生不再触发；3 天以后又可以', () => {
        const first = him(60 * 24, '新同事小姐姐加了我微信');
        const second = (variant: string) => [first, her(60 * 24 - 1, '哦'), her(5, '在呢'), him(1, `女同事又约我一起吃饭${variant}`)];
        const fresh = (variant: string) => [{ ...first, time: at(JEALOUS_COOLDOWN_MS / 60_000 + 60) }, her(JEALOUS_COOLDOWN_MS / 60_000 + 59, '哦'), her(5, '在呢'), him(1, `女同事又约我一起吃饭${variant}`)];
        const variants = Array.from({ length: 40 }, (_, i) => String(i));
        assert.ok(variants.every(v => jealousTurn(second(v), now) === undefined), '3 天内不再触发');
        assert.ok(variants.some(v => jealousTurn(fresh(v), now) === 'jealous'), '3 天以后可以');
    });

    test('他一解释 / 哄她：下一轮松下来；没触发过的不松；隔太久不算', () => {
        const trig = triggering(tail => [her(30, '在呢'), him(8, `今天和女同事一起吃饭了${tail}`)]);
        const triggerText = trig.at(-1)!.content;
        const after = [...trig, her(7, '哦，是吗'), him(1, '你想多了，就是同事')];
        assert.equal(jealousTurn(after, now), 'soften');
        const untouched = [her(30, '在呢'), him(8, '今天上了一天课'), her(7, '辛苦'), him(1, '你想多了')];
        assert.equal(jealousTurn(untouched, now), undefined, '前面没提别的女生');
        const stale = [{ ...trig[0]!, time: at(300) }, { ...trig[1]!, time: at(299) }, her(298, '哦'), him(1, '你想多了，就是同事')];
        assert.equal(jealousTurn(stale, now), undefined, '隔太久');
        assert.ok(triggerText.includes('女同事'));
    });
});

describe('意图行：轨道', () => {
    const intentOf = (history: Said[], extra: object = {}) => describeIntent({ history, now: new Date(now), intimate: true, jealous: true, ...extra });

    test('触发时给出别扭的意图（10-30 清掉滤镜：可以真的问、真的酸、真的让他不高兴）；松下来时给出松下来的意图', () => {
        const history = triggering(tail => [her(10, '在呢'), him(1, `今天和女同事一起吃饭了${tail}`)]);
        assert.equal(intentOf(history), JEALOUS_INTENT);
        for (const phrase of ['想问清楚就直接问', '想酸一句就酸', '想让他知道你不高兴就直说', '想翻旧账也行', '不用装大度']) assert.ok(JEALOUS_INTENT.includes(phrase), phrase);
        assert.doesNotMatch(JEALOUS_INTENT, /别盘问|别让他愧疚|傲娇的小别扭/, '这些是原来的滤镜');
        assert.doesNotMatch(JEALOUS_INTENT, /[「」]/, '不给台词');
        const after = [...history, her(0.5, '哦'), him(0.2, '你想多了，就是同事')];
        assert.equal(intentOf(after), SOFTEN_INTENT);
        assert.ok(SOFTEN_INTENT.includes('别借机要更多保证'));
    });

    test('没开 / 不是男朋友档 / 他难过、生病 / 危机 / 主动找他：都不酸', () => {
        const history = triggering(tail => [her(10, '在呢'), him(1, `今天和女同事一起吃饭了${tail}`)]);
        assert.notEqual(describeIntent({ history, now: new Date(now), intimate: true }), JEALOUS_INTENT, '没开');
        assert.notEqual(describeIntent({ history, now: new Date(now), jealous: true }), JEALOUS_INTENT, '不是男朋友档');
        assert.notEqual(intentOf(history, { crisis: 'high' }), JEALOUS_INTENT, '危机最优先');
        assert.notEqual(intentOf(history, { initiating: true }), JEALOUS_INTENT, '主动找他');
        const sad = [her(10, '在呢'), him(1, '我今天被老师骂了好难过，女同事一起吃饭安慰我')];
        assert.notEqual(intentOf(sad), JEALOUS_INTENT, '他难过时让路');
    });
});
