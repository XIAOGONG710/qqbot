import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { CURIOUS_ASK_NOTE, CURIOUS_INTENT, CURIOUS_MIN_CHARS, CURIOUS_RECENT, CURIOUS_SHARE, curiousTurn } from '../src/curious.ts';
import { ENGAGED_INTENT } from '../src/expression.ts';
import { describeIntent } from '../src/intent.ts';
import { candidatesOn, occasionNote, withAsk, withCurious, type Candidate, type ProactiveInput } from '../src/proactive.ts';
import { planShape } from '../src/shape.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0126：会追问。线上量过：问句率 12%（和真人持平），但问的多是口头语，问他刚说那件事的很少——
// 因为他说自己的事时意图行写着“别急着追问细节，真要问也只问一两个字”
type Said = { role: 'user' | 'assistant'; content: string; time?: string };
const him = (content: string): Said => ({ role: 'user', content });
const her = (content: string): Said => ({ role: 'assistant', content });
const now = new Date(2026, 10, 12, 20, 30);

/** 找一句会触发的（约六成触发，同一类句子里挑一个） */
function triggering(build: (tail: string) => Said[]): Said[] {
    for (const tail of ['', '，挺顺利', '，还行', '，哈哈', '，今天', '。', '！', '，有点意外', '，比想的好']) {
        const history = build(tail);
        if (curiousTurn(history)) return history;
    }
    throw new Error('找不到会触发的一句');
}

describe('什么时候追问', () => {
    test('他说了件有事 / 人 / 计划细节的事：约 CURIOUS_SHARE 的情况追问，同一句每次一样', () => {
        const hits = Array.from({ length: 300 }, (_, i) => curiousTurn([her('在呢'), him(`今天和同事去吃了顿火锅${i}`)])).filter(Boolean).length;
        assert.ok(hits > 300 * CURIOUS_SHARE * 0.8 && hits < 300 * CURIOUS_SHARE * 1.2, `300 句里 ${hits}`);
        const history = triggering(tail => [her('在呢'), him(`下午去面试了一家公司${tail}`)]);
        assert.equal(curiousTurn(history), curiousTurn(history));
    });

    test('太短、是问句、在收尾、只有感受没有事、没有细节：都不追问', () => {
        for (const text of ['去吃饭', '你今天去哪了？', '我去睡了晚安', '今天好累好烦啊', '今天天气不错呢', '嗯嗯好的呀知道了']) {
            for (let i = 0; i < 20; i++) assert.equal(curiousTurn([her('嗯'), him(`${text}${'。'.repeat(i % 2)}`)]), false, text);
        }
        assert.ok(CURIOUS_MIN_CHARS >= 4);
    });

    test('她最近几条里问过就不再问；隔了 CURIOUS_RECENT 条以后可以', () => {
        const base = triggering(tail => [her('在呢'), him(`今天去见了个老同学${tail}`)]);
        const text = base.at(-1)!.content;
        const asked = [her('你吃了吗？'), her('好吧'), him('嗯'), her('哦'), him(text)];
        assert.equal(curiousTurn(asked), false);
        const filler = Array.from({ length: CURIOUS_RECENT }, (_, i) => [him(`嗯${i}`), her(`哦${i}`)]).flat();
        assert.equal(curiousTurn([her('你吃了吗？'), ...filler, him(text)]), true);
    });
});

describe('意图行', () => {
    const intentOf = (history: Said[], extra: object = {}) => describeIntent({ history, now, intimate: true, curious: true, ...extra });

    test('触发时给出追问的意图；没开 / 不是男朋友档时还是原来的“别急着追问细节”', () => {
        const history = triggering(tail => [her('在呢'), him(`今天去面试了一家公司${tail}`)]);
        assert.equal(intentOf(history), CURIOUS_INTENT);
        assert.match(describeIntent({ history, now, intimate: true })!, /别急着追问细节/, '没开');
        assert.match(describeIntent({ history, now, curious: true })!, /别急着追问细节/, '不是男朋友档');
    });

    test('追问的意图行：问这件事本身、一个就够、不问客套、不是反问；不给台词；长短照“认真接话”算', () => {
        for (const phrase of ['这件事本身', '一个问题就够', '在干嘛', '吃了吗', '不是客套', '更不是反问']) assert.ok(CURIOUS_INTENT.includes(phrase), phrase);
        assert.doesNotMatch(CURIOUS_INTENT, /[「」]“/, '不给整句台词');
        assert.match(CURIOUS_INTENT, ENGAGED_INTENT);
    });

    test('他难过 / 问她 / 收尾的时候让路：走原来的意图', () => {
        const sad = [her('在呢'), him('今天去面试被拒了，好难过')];
        assert.notEqual(intentOf(sad), CURIOUS_INTENT);
        const ask = [her('在呢'), him('我今天去面试了一家公司，你觉得怎么样？')];
        assert.equal(intentOf(ask), '[这一轮你想：先直接回答他刚问的，不另起话题]');
        const ending = [her('在呢'), him('今天去面试了，我先去睡了晚安')];
        assert.notEqual(intentOf(ending), CURIOUS_INTENT);
    });
});

describe('说话的形状：追问的轮次留得下一个问题', () => {
    const plans = (extra: Partial<Parameters<typeof planShape>[0]> = {}) => Array.from({ length: 600 }, (_, i) => planShape({
        history: [{ role: 'assistant', content: '在呢', time: '2026-11-12T20:00:00+08:00' }, { role: 'user', content: `今天去面试了一家公司${i}`, time: '2026-11-12T20:10:00+08:00' }],
        intent: CURIOUS_INTENT, ...extra,
    })!);

    test('不是极短的几个字、不是废话 / 情绪轮 / 带自己的事、没有“顺着说，别用反问句”', () => {
        const all = plans({ filler: true, feel: true, agenda: true });
        assert.ok(all.every(plan => plan.kind !== 'micro' && !plan.filler && !plan.feel && !plan.agenda && !plan.plain && plan.cap >= 14), '追问轮次留够字数');
    });
});

describe('主动问他：ask 时机换成“想多了解他一点”', () => {
    const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
    const input = (settings: ProactiveInput['settings']): ProactiveInput => ({ qq: 10001, schedule: boyfriend.schedule!, settings, dates: [], history: [], records: [], mode: 'on' });
    const firstAsk = (settings: ProactiveInput['settings']): Candidate => {
        for (let i = 0; i < 40; i++) {
            const c = candidatesOn(new Date(2026, 9, 9 + i), input(settings)).find(x => x.occasion === 'ask');
            if (c) return c;
        }
        throw new Error('no ask');
    };

    test('withCurious 自带 ask 时机（不开 proactiveAsk 也有）并标记 curious；原来的 withAsk 不带', () => {
        assert.ok(!boyfriend.proactive!.occasions.includes('ask'));
        const settings = withCurious(boyfriend.proactive!);
        assert.ok(settings.occasions.includes('ask') && settings.curious === true);
        assert.equal(withAsk(boyfriend.proactive!).curious, undefined);
    });

    test('提示词：问他自己的事（从聊天和她记得的里挑，不编，不问客套，不问她自己的事）；原来的是问意见', () => {
        const curious = firstAsk(withCurious(boyfriend.proactive!));
        assert.equal(curious.curious, true);
        const note = occasionNote(curious, '他');
        assert.ok(note.includes(CURIOUS_ASK_NOTE), note);
        for (const phrase of ['不编他没说过的事', '「在干嘛」「吃了吗」', '也不问你自己的事', '他没回也不催']) assert.ok(CURIOUS_ASK_NOTE.includes(phrase), phrase);
        const old = firstAsk(withAsk(boyfriend.proactive!));
        assert.equal(old.curious, undefined);
        assert.ok(occasionNote(old, '他').includes('拿不准'), '原来的问意见');
    });

    test('没有“在忙就不问”之类的闸被绕开：到点再查的各种原因照旧（同一个 ask 的闸）', () => {
        const curious = firstAsk(withCurious(boyfriend.proactive!));
        assert.match(curious.reason, /想多了解他/);
        assert.equal(curious.occasion, 'ask');
    });
});
