import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { afterNoIntent, FLAT_SILENCE_MS, lastNo, requestKind } from '../src/language/after-no.ts';
import { describeIntent, PRESSED_INTENT } from '../src/language/intent.ts';
import type { StoredMessage } from '../src/memory/history.ts';

// ADR 0214：拒绝之后。她本人（11-02 ask-her）：要不要看事情本身、跟他上次高不高兴没关系；变的是说法；后悔的是勉强答应的；什么都不存
const t = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const msg = (role: 'user' | 'assistant', at: number, content: string): StoredMessage => ({ time: new Date(at).toISOString(), role, content });
const him = (at: number, content: string) => msg('user', at, content);
const her = (at: number, content: string) => msg('assistant', at, content);

describe('拒绝之后：他在提哪一类请求', () => {
    test('认得出打游戏 / 视频 / 照片 / 出去 / 陪他；只是在讲自己的事不算', () => {
        assert.equal(requestKind('来打两把呗'), 'game');
        assert.equal(requestKind('晚上视频吗'), 'call');
        assert.equal(requestKind('发张照片看看'), 'photo');
        assert.equal(requestKind('周末出来吃饭吗'), 'outing');
        assert.equal(requestKind('再陪我聊会嘛'), 'stay');
        assert.equal(requestKind('我今天打了三局排位'), undefined);
        assert.equal(requestKind('在干嘛'), undefined);
    });
});

describe('拒绝之后：上次怎么样了', () => {
    const now = t(4, 20, 0);
    const today = him(now, '今晚打一把吗');

    test('上次她推了，他只回「行吧」就半天没吭声 → flat', () => {
        const history = [him(t(2, 20, 0), '来打两把呗'), her(t(2, 20, 1), '不想打，今天累死了'), him(t(2, 20, 2), '行吧'), her(t(2, 20, 3), '明天再说'), today];
        assert.deepEqual(lastNo(history, now), { kind: 'game', days: 2, how: 'flat' });
    });

    test('他「行吧」之后第二天才开口（中间她没说话）：那是新的一段，「行吧」照样认得出', () => {
        const history = [him(t(2, 20, 0), '来打两把王者呗'), her(t(2, 20, 1), '不想打，今天累死了'), him(t(2, 20, 2), '行吧'), him(t(3, 12, 0), '吃了没'), her(t(3, 12, 2), '吃了，食堂的面'), today];
        assert.deepEqual(lastNo(history, now), { kind: 'game', days: 2, how: 'flat' });
    });

    test('「行吧」之后很快又接着聊了、或者他回的是别的（「没事那我找别人」）：她说「我就过去了」，不算', () => {
        const soon = [him(t(2, 20, 0), '来打两把呗'), her(t(2, 20, 1), '不想打'), him(t(2, 20, 2), '行吧'), him(t(2, 20, 2) + FLAT_SILENCE_MS - 60_000, '那我去找室友打了'), her(t(2, 20, 30), '去吧'), today];
        assert.equal(lastNo(soon, now), undefined);
        const fine = [him(t(2, 20, 0), '来打两把呗'), her(t(2, 20, 1), '不想打'), him(t(2, 20, 2), '没事那我找别人'), today];
        assert.equal(lastNo(fine, now), undefined);
    });

    test('上次她推了、他磨、她勉强答应了 → yielded', () => {
        const history = [him(t(3, 21, 0), '打一把吗'), her(t(3, 21, 1), '不想，困了'), him(t(3, 21, 2), '就一把嘛'), her(t(3, 21, 3), '行吧行吧，就一把'), today];
        assert.deepEqual(lastNo(history, now), { kind: 'game', days: 1, how: 'yielded' });
    });

    test('磨了她也没松口、不是同一类、超过 7 天、这一串不是请求：都没有', () => {
        const held = [him(t(3, 21, 0), '打一把吗'), her(t(3, 21, 1), '不想，困了'), him(t(3, 21, 2), '就一把嘛'), her(t(3, 21, 3), '不打，睡了'), today];
        assert.equal(lastNo(held, now), undefined);
        const other = [him(t(2, 20, 0), '发张照片看看'), her(t(2, 20, 1), '不发，头发乱着'), him(t(2, 20, 2), '好吧'), today];
        assert.equal(lastNo(other, now), undefined);
        const old = [him(t(4, 20, 0) - 8 * 86_400_000, '来打两把呗'), her(t(4, 20, 1) - 8 * 86_400_000, '不想打'), him(t(4, 20, 2) - 8 * 86_400_000, '行吧'), today];
        assert.equal(lastNo(old, now), undefined);
        const notAsking = [him(t(2, 20, 0), '来打两把呗'), her(t(2, 20, 1), '不想打'), him(t(2, 20, 2), '行吧'), him(now, '今天好累')];
        assert.equal(lastNo(notAsking, now), undefined);
    });
});

describe('拒绝之后：给她的方向', () => {
    test('照她本人的话：要不要看事情本身、跟上次他高不高兴没关系；不想就换个说法、陪他聊会儿；勉强答应过的这次直说；别提上次', () => {
        const flat = afterNoIntent({ kind: 'game', days: 2, how: 'flat' });
        assert.ok(flat.includes('跟上次他高不高兴没关系') && flat.includes('换个说法好好跟他讲') && flat.includes('别提上次的事'), flat);
        assert.ok(!/答应他吧|别让他失望|补偿/.test(flat), '不会因为他上次失落就推她答应');
        const yielded = afterNoIntent({ kind: 'call', days: 1, how: 'yielded' });
        assert.ok(yielded.includes('昨天') && yielded.includes('不想就直说，不用再勉强自己'), yielded);
    });

    test('接进「这一轮你想」：开了、男朋友档才有；他难过时让路；他正在磨（herNo）时让给“别被磨两句就答应”', () => {
        const now = new Date(t(4, 20, 0));
        const history = [him(t(2, 20, 0), '来打两把呗'), her(t(2, 20, 1), '不想打，今天累死了'), him(t(2, 20, 2), '行吧'), her(t(2, 20, 3), '明天再说'), him(now.getTime(), '今晚打一把吗')];
        assert.match(describeIntent({ history, now, intimate: true, afterNo: true }) ?? '', /他回了句「行吧」就半天没吭声/);
        assert.doesNotMatch(describeIntent({ history, now, intimate: true }) ?? '', /行吧」就半天/, '没开');
        assert.doesNotMatch(describeIntent({ history, now, afterNo: true }) ?? '', /行吧」就半天/, '不是男朋友档');
        const sad = [...history.slice(0, -1), him(now.getTime(), '今天好难受，打一把吗')];
        assert.doesNotMatch(describeIntent({ history: sad, now, intimate: true, afterNo: true }) ?? '', /行吧」就半天/, '他难过时先关心');
        // herNo 只在她最近四段回复里推过不到两回时才守着（ADR 0103）：中间隔几段平常的聊天
        const chat = [him(t(3, 9, 0), '早'), her(t(3, 9, 1), '早呀'), him(t(3, 12, 0), '吃了吗'), her(t(3, 12, 1), '吃了，食堂'), him(t(3, 18, 0), '下课了？'), her(t(3, 18, 1), '刚下')];
        const pressing = [...history.slice(0, 3), ...chat, him(now.getTime(), '今晚打两把吗'), her(now.getTime() + 60_000, '不想打'), him(now.getTime() + 120_000, '就打两把嘛')];
        assert.equal(describeIntent({ history: pressing, now: new Date(now.getTime() + 120_000), intimate: true, afterNo: true, refuse: true }), PRESSED_INTENT);
    });
});
