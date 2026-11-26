import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
    catAlternative,
    catName,
    cityAlternatives,
    noteCharacterTerms,
    useCharacterTerms,
} from '../src/character-terms.ts';

const reset = () => useCharacterTerms({ cities: [] });

describe('角色专有名字（character-terms，ADR 0335）', () => {
    beforeEach(reset);

    test('没读到卡时用通用说法：猫叫「猫」，没有城市', () => {
        assert.equal(catName(), '猫');
        assert.equal(catAlternative(), '');
        assert.equal(cityAlternatives(), '');
    });

    test('useCharacterTerms 记下猫和城市，城市按给定顺序拼成 alternation', () => {
        useCharacterTerms({ cat: '团子饼', cities: ['雾岚市', '溪口镇'], home: '溪口镇' });
        assert.equal(catName(), '团子饼');
        assert.equal(catAlternative(), '团子饼|');
        assert.equal(cityAlternatives(), '|雾岚市|溪口镇');
    });

    test('空串被丢掉、重复城市去重；空数组拼出空串', () => {
        useCharacterTerms({ cat: '', cities: ['A', '', 'A', 'B'], home: '' });
        assert.equal(catName(), '猫');
        assert.equal(catAlternative(), '');
        assert.equal(cityAlternatives(), '|A|B');

        useCharacterTerms({ cities: [] });
        assert.equal(cityAlternatives(), '');
    });

    test('正则专用字符被转义，拼出来的 alternation 不会被误解析', () => {
        useCharacterTerms({ cat: 'a.b(c)', cities: ['x.y', 'z[1]'] });
        assert.equal(catAlternative(), 'a\\.b\\(c\\)|');
        assert.equal(cityAlternatives(), '|x\\.y|z\\[1\\]');
    });

    test('极端长度不截断', () => {
        const long = '城'.repeat(500);
        useCharacterTerms({ cat: long, cities: [long] });
        assert.equal(catAlternative(), `${long}|`);
        assert.equal(cityAlternatives(), `|${long}`);
    });

    test('noteCharacterTerms(undefined) 什么都不改', () => {
        useCharacterTerms({ cat: '团子饼', cities: ['雾岚市', '溪口镇'] });
        noteCharacterTerms(undefined);
        assert.equal(catName(), '团子饼');
        assert.equal(catAlternative(), '团子饼|');
        assert.equal(cityAlternatives(), '|雾岚市|溪口镇');
    });

    test('读卡时记下猫名和学校/家两座城市', () => {
        noteCharacterTerms({
            cat: { name: '团子饼' },
            weather: { places: { school: { name: '雾岚市' }, home: { name: '溪口镇' } } },
        });
        assert.equal(catName(), '团子饼');
        assert.equal(catAlternative(), '团子饼|');
        assert.equal(cityAlternatives(), '|雾岚市|溪口镇');
    });

    test('卡上没有的字段不清空已有名字', () => {
        useCharacterTerms({ cat: '团子饼', cities: ['雾岚市', '溪口镇'] });
        noteCharacterTerms({});
        assert.equal(catName(), '团子饼');
        assert.equal(cityAlternatives(), '|雾岚市|溪口镇');

        noteCharacterTerms({ weather: { places: { school: { name: '雪原市' }, home: { name: '星海镇' } } } });
        assert.equal(catName(), '团子饼');
        assert.equal(cityAlternatives(), '|雪原市|星海镇');
    });

    test('卡上只带猫名时覆盖旧猫名，城市保持原样', () => {
        useCharacterTerms({ cat: '旧猫', cities: ['雾岚市'] });
        noteCharacterTerms({ cat: { name: '新猫' } });
        assert.equal(catName(), '新猫');
        assert.equal(catAlternative(), '新猫|');
        assert.equal(cityAlternatives(), '|雾岚市');
    });
});
