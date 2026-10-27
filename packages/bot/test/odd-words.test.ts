import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspectReply } from '../src/language/exit-check.ts';
import { ODD_BODY_WORDING, ODD_BODY_WORDS } from '../src/language/expression.ts';

// 用户 10-22：「她最近老是说肚子坠着，这不是正常人的语言说话方式」。线上 10-20 到 10-22 四条原话都要被抓住
describe('医书里的词：出口检查当禁用词', () => {
    const flagged = (text: string) => inspectReply(text, [...ODD_BODY_WORDS]).filter(issue => issue.kind === 'banned');

    test('线上出现过的四种说法都抓得住（坠着 / 坠得 / 有点坠 / 还坠着）', () => {
        for (const text of ['肚子有点坠，今天的题先欠着', '肚子还坠着，就陪你说说话', '洗完澡了，肚子坠得难受', '小腹有点坠', '下坠感好烦', '坠胀的那种疼']) {
            assert.ok(flagged(text).length > 0, text);
        }
    });

    test('大白话和别的“坠”不误伤', () => {
        for (const text of ['肚子疼，躺着呢', '小腹酸酸的，懒得动', '一抽一抽地疼', '她爱得坠入爱河', '那颗星星在坠落', '摇摇欲坠的房子']) {
            assert.equal(flagged(text).length, 0, text);
        }
    });

    test('教她的大白话那句里写明不要哪几个词', () => {
        assert.ok(ODD_BODY_WORDING.includes('肚子疼') && ODD_BODY_WORDING.includes('坠着') && ODD_BODY_WORDING.includes('下坠') && ODD_BODY_WORDING.includes('坠胀'));
    });
});

describe('小说腔的动作神态：线上读到的两句也抓得住', () => {
    const flagged = (text: string) => inspectReply(text, [...ODD_BODY_WORDS]).filter(issue => issue.kind === 'banned');
    test('「听得我嘴角上扬」「笔都没落下去」「心口发紧」被抓；平常说法不误伤', () => {
        for (const text of ['哟，这声宝宝叫的，听得我嘴角上扬', '我坐了一下午，笔都没落下去', '听到这个心口发紧', '眼眶一热差点哭了']) assert.ok(flagged(text).length > 0, text);
        for (const text of ['笑得我嘴角都压不住', '一道题都没动', '心里有点堵', '差点哭了']) assert.equal(flagged(text).length, 0, text);
    });
});
