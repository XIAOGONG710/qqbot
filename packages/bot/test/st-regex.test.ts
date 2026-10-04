import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { cleanUpReply } from '../src/reply.ts';
import { loadCharacterCard, parseCharacterCard } from '../src/st/card.ts';
import { AI_OUTPUT, applyAiOutputScripts, parseRegexScripts, regexFromString, runRegexScript, type RegexScript } from '../src/st/regex.ts';

// 对照 vendor/SillyTavern public/scripts/extensions/regex/engine.js（runRegexScript / getRegexedString）与 utils.js regexFromString

const names = { user: '阿明', char: '林梦瑶' };
const script = (s: Partial<RegexScript>): RegexScript => ({
    scriptName: 't', findRegex: '', replaceString: '', trimStrings: [], placement: [AI_OUTPUT],
    disabled: false, markdownOnly: false, promptOnly: false, substituteRegex: 0, ...s,
});

describe('regexFromString（utils.js）', () => {
    test('/模式/标志', () => {
        const re = regexFromString('/a+b/gi')!;
        assert.equal(re.source, 'a+b');
        assert.equal(re.flags, 'gi');
    });
    test('不带斜杠时整串是模式、没有标志', () => {
        const re = regexFromString('abc')!;
        assert.equal(re.source, 'abc');
        assert.equal(re.flags, '');
    });
    test('标志不合法（重复、不认识）时整串当模式', () => {
        assert.equal(regexFromString('/a/gg')!.source, '\\/a\\/gg');
        assert.equal(regexFromString('/a/q')!.source, '\\/a\\/q');
    });
    test('JS 不支持的标志或模式写错返回 undefined', () => {
        assert.equal(regexFromString('/a/x'), undefined);
        assert.equal(regexFromString('/(/'), undefined);
        assert.equal(regexFromString(''), undefined);
    });
});

describe('runRegexScript（engine.js）', () => {
    test('{{match}} 是整个匹配，$1 和 $<名字> 是捕获组', () => {
        assert.equal(runRegexScript(script({ findRegex: '/(\\d+)元/g', replaceString: '[{{match}}|$1]' }), '3元和5元', names), '[3元|3]和[5元|5]');
        assert.equal(runRegexScript(script({ findRegex: '/(?<n>\\d+)元/', replaceString: '$<n>块' }), '3元', names), '3块');
    });
    test('没匹配上的捕获组、没有命名组时的 $<名字> 都替换成空', () => {
        assert.equal(runRegexScript(script({ findRegex: '/a(b)?/', replaceString: '[$1]' }), 'a', names), '[]');
        assert.equal(runRegexScript(script({ findRegex: '/a/', replaceString: '[$<x>]' }), 'a', names), '[]');
    });
    test('捕获内容去掉 trimStrings（trimStrings 先替换宏），替换结果再替换宏', () => {
        const s = script({ findRegex: '/<(.*)>/', replaceString: '$1，{{user}}', trimStrings: ['{{char}}：'] });
        assert.equal(runRegexScript(s, '<林梦瑶：你好>', names), '你好，阿明');
    });
    test('Find Regex 里的宏：RAW 原样替换，ESCAPED 先转义', () => {
        assert.equal(runRegexScript(script({ findRegex: '/^{{char}}：/', substituteRegex: 1 }), '林梦瑶：在呢', names), '在呢');
        const dotted = { user: '阿明', char: 'a.b' };
        assert.equal(runRegexScript(script({ findRegex: '/{{char}}/g', substituteRegex: 2 }), 'axb a.b', dotted), 'axb ');
        assert.equal(runRegexScript(script({ findRegex: '/{{char}}/g', substituteRegex: 1 }), 'axb a.b', dotted), ' ');
    });
    test('停用的、Find Regex 为空或写错的脚本不改原文', () => {
        assert.equal(runRegexScript(script({ findRegex: '/a/', disabled: true }), 'a', names), 'a');
        assert.equal(runRegexScript(script({ findRegex: '' }), 'a', names), 'a');
        assert.equal(runRegexScript(script({ findRegex: '/(/' }), 'a(', names), 'a(');
    });
});

describe('作用于 AI 输出的脚本（getRegexedString）', () => {
    test('只执行 placement 含 AI 输出、且不是只作用于显示 / 提示词的脚本，按顺序', () => {
        const scripts = [
            script({ findRegex: '/a/g', replaceString: 'b' }),
            script({ findRegex: '/b/g', replaceString: 'c' }),
            script({ findRegex: '/c/g', replaceString: 'X', placement: [1] }),
            script({ findRegex: '/c/g', replaceString: 'Y', markdownOnly: true }),
            script({ findRegex: '/c/g', replaceString: 'Z', promptOnly: true }),
        ];
        assert.equal(applyAiOutputScripts('a', scripts, names), 'c');
    });
    test('读角色卡的 extensions.regex_scripts：不是数组当没有，缺的字段按默认值', () => {
        assert.deepEqual(parseRegexScripts(undefined), []);
        assert.deepEqual(parseRegexScripts({}), []);
        const [s] = parseRegexScripts([{ findRegex: '/a/', placement: [2] }]);
        assert.deepEqual(s, script({ scriptName: '', findRegex: '/a/' }));
        const card = parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { regex_scripts: [{ findRegex: '/a/', placement: [2] }] } } });
        assert.equal(card.regexScripts.length, 1);
    });
    test('cleanUpReply 先执行脚本，再做原来的清理', () => {
        const scripts = [script({ findRegex: '/^林梦瑶：/gm', replaceString: '林梦瑶: ' })];
        assert.equal(cleanUpReply('林梦瑶：在呢  ', names, scripts), '在呢');
    });
});

describe('林梦瑶卡上的括号正则（ADR 0006 取证里的原句）', () => {
    const { regexScripts } = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-classmate.json'));
    const clean = (text: string) => cleanUpReply(text, names, regexScripts);
    test('整行括号、行首括号里的动作和心理活动删掉', () => {
        assert.equal(clean('土豆在楼下\n（拍的照片）'), '土豆在楼下');
        assert.equal(clean('（先看看他找我干嘛，顺便说一句我正喂猫呢，别让他以为我故意不理人）\n喂猫呢'), '喂猫呢');
        assert.equal(clean('（想拍张它的照片给你但拍不到）哦对，我发不了照片'), '哦对，我发不了照片');
        assert.equal(clean('  (停顿一下) 明天吃什么'), '明天吃什么');
        assert.equal(clean('（算了，随便你）'), '');
    });
    test('句中、句末的补充说明不动', () => {
        const lines = [
            '梯度就是那个最陡的方向（下降最快），你往反方向挪一小步',
            '为什么不保证到全局最优（可能卡在局部最低或者鞍点）。',
            '就那家（拍照的那家店）',
        ];
        for (const line of lines) assert.equal(clean(line), line);
    });
});
