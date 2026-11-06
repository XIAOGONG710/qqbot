import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { numberWords, speechText, voiceStyle } from '../src/vision/voice-text.ts';

const evening = new Date(2026, 10, 6, 20, 0);
const lateNight = new Date(2026, 10, 7, 0, 30);

describe('语音念什么：整理成念得顺的样子', () => {
    test('数字和时刻换成汉字', () => {
        assert.equal(numberWords(0), '零');
        assert.equal(numberWords(10), '十');
        assert.equal(numberWords(15), '十五');
        assert.equal(numberWords(20), '二十');
        assert.equal(numberWords(105), '一百零五');
        assert.equal(numberWords(110), '一百一十');
        assert.equal(numberWords(2026), '二千零二十六');
        assert.equal(speechText('我20:30去吃饭'), '我八点半去吃饭');
        assert.equal(speechText('7:05就起了'), '七点零五就起了');
        assert.equal(speechText('还剩3章'), '还剩三章');
        assert.equal(speechText('14:00见'), '两点见');
    });

    test('表情、小黄脸、链接、内部令牌念不出来，去掉；拖长的「～」念成停顿', () => {
        assert.equal(speechText('想你了[doge]😊'), '想你了');
        assert.equal(speechText('你看这个 https://b23.tv/abc 好好笑'), '你看这个 好好笑');
        assert.equal(speechText('好呀～<sticker:0123456789ab>'), '好呀');
        assert.equal(speechText('嗯～我在呢'), '嗯，我在呢');
        assert.equal(speechText('真的吗？？？'), '真的吗？');
        assert.equal(speechText('[捂脸]'), '', '整理完没有能念的就是空的');
    });

    test('不改她说的话：语气词、停顿原样留着', () => {
        assert.equal(speechText('嗯……我在呢，你说吧'), '嗯……我在呢，你说吧');
    });
});

describe('语音怎么念：按她这一刻的心境', () => {
    test('平常是对男朋友的甜：口语、带一点笑、语速稍慢', () => {
        const plain = voiceStyle(undefined, '在呢', evening);
        assert.deepEqual({ oral: plain.oral, laugh: plain.laugh, breaks: plain.breaks, speed: plain.speed }, { oral: 4, laugh: 1, breaks: 4, speed: 4 });
        assert.match(plain.emo, /甜/);
        assert.deepEqual(voiceStyle({ kind: 'sad', level: 'faint' }, '在呢', evening), plain, '刚能察觉的感受不改语气');
    });

    test('开心更轻快、笑得多；难过、累慢一点、停顿多；句子里有「哈哈」就笑', () => {
        const joy = voiceStyle({ kind: 'joy', level: 'clear' }, '今天好开心', evening);
        assert.equal(joy.laugh, 2);
        assert.ok(joy.speed > voiceStyle({ kind: 'tired', level: 'clear' }, '好累', evening).speed);
        const sad = voiceStyle({ kind: 'sad', level: 'strong' }, '有点难受', evening);
        assert.ok(sad.breaks > 4 && sad.speed < 4);
        assert.equal(voiceStyle({ kind: 'worry', level: 'clear' }, '哈哈哈你太逗了', evening).laugh, 2);
    });

    test('深夜慢一点、停顿多一点；参数都在 ChatTTS 的范围里', () => {
        const night = voiceStyle(undefined, '还不睡呀', lateNight);
        const day = voiceStyle(undefined, '还不睡呀', evening);
        assert.equal(night.speed, day.speed - 1);
        assert.equal(night.breaks, day.breaks + 1);
        const extreme = voiceStyle({ kind: 'sad', level: 'strong' }, '嗯', lateNight);
        assert.ok(extreme.oral >= 0 && extreme.oral <= 9 && extreme.laugh >= 0 && extreme.laugh <= 2 && extreme.breaks >= 0 && extreme.breaks <= 7 && extreme.speed >= 0 && extreme.speed <= 9);
    });
});
