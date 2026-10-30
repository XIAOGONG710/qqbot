import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { APHORISM, INSOMNIA, SUDDEN, tropeLine, tropeShares } from '../src/language/tropes.ts';

describe('句式比例（只是数字）', () => {
    test('APHORISM：不是X，是Y / 与其X不如Y / 所谓X就是Y；普通的否定句不算', () => {
        for (const text of ['不是不想回你，是在忙', '不是累，而是烦', '与其等着不如去问', '所谓成长就是学会闭嘴']) assert.ok(APHORISM.test(text), text);
        for (const text of ['我不是故意的', '不是吧', '这个不是我的，那个才是', '是啊，不是很贵']) assert.equal(APHORISM.test(text), false, text);
    });

    test('INSOMNIA：半夜睡不着 / 一个人躺在床上；睡了一觉、早起不算', () => {
        for (const text of ['半夜睡不着，刷了会手机', '昨晚睡不着', '一个人躺在床上瞎想', '深夜胡思乱想']) assert.ok(INSOMNIA.test(text), text);
        for (const text of ['昨晚睡得挺好', '早上起不来', '床太软了']) assert.equal(INSOMNIA.test(text), false, text);
    });

    test('SUDDEN：突然觉得 / 忽然明白 / 一下子懂了；“突然”单独出现不算', () => {
        for (const text of ['突然觉得有点累', '忽然明白了他的意思', '一下子懂了']) assert.ok(SUDDEN.test(text), text);
        for (const text of ['突然下雨了', '他一下子就跑了']) assert.equal(SUDDEN.test(text), false, text);
    });

    test('tropeShares：各占多少个气泡；一个气泡同时中几种各算各的；没有气泡全 0', () => {
        assert.deepEqual(tropeShares([]), { aphorism: 0, insomnia: 0, sudden: 0 });
        const shares = tropeShares(['不是累，是烦', '半夜睡不着，突然觉得好累', '好', '嗯']);
        assert.deepEqual(shares, { aphorism: 0.25, insomnia: 0.25, sudden: 0.25 });
    });

    test('tropeLine：只列出现过的，一位小数；全 0 或没有数据返回 undefined（不占行）', () => {
        assert.equal(tropeLine(undefined), undefined);
        assert.equal(tropeLine({ aphorism: 0, insomnia: 0, sudden: 0 }), undefined);
        assert.equal(tropeLine({ aphorism: 0.03, insomnia: 0, sudden: 0 }), '这几种说法占气泡的比例：警句式「不是 X，是 Y」3.0%');
        assert.equal(
            tropeLine({ aphorism: 0.016, insomnia: 0.02, sudden: 0.005 }),
            '这几种说法占气泡的比例：警句式「不是 X，是 Y」1.6%、「半夜睡不着」一类 2.0%、「突然明白」一类 0.5%',
        );
    });

    test('只是数字：行里没有禁止、不许、避免这类字眼', () => {
        const line = tropeLine({ aphorism: 0.1, insomnia: 0.1, sudden: 0.1 })!;
        assert.doesNotMatch(line, /禁止|不许|不要|避免|别再|少用/);
    });
});
