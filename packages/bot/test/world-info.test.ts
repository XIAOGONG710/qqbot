import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { substituteMacros } from '../src/st/macros.ts';
import {
    checkWorldInfo, DEFAULT_WORLD_INFO_SETTINGS, LOGIC, parseRegexFromString, parseWorldInfo, POSITION,
    type ScanInput, type WorldInfoEntry,
} from '../src/st/world-info.ts';

/** 用 parseWorldInfo 走一遍默认值，和从文件读出来的条目一致 */
function entries(...raws: Record<string, unknown>[]): WorldInfoEntry[] {
    const book = { entries: Object.fromEntries(raws.map((raw, uid) => [String(uid), { uid, ...raw }])) };
    return parseWorldInfo(book, 'test');
}

const names = { user: '阿明', char: '林梦瑶' };

function scan(list: WorldInfoEntry[], chatNewestFirst: string[], overrides: Partial<ScanInput> = {}) {
    return checkWorldInfo({
        entries: list,
        chat: chatNewestFirst,
        maxContext: 8192,
        settings: DEFAULT_WORLD_INFO_SETTINGS,
        substitute: text => substituteMacros(text, names),
        countTokens: text => text.length,
        ...overrides,
    });
}

describe('宏', () => {
    test('{{char}} {{user}} 不区分大小写，旧写法 <USER> <BOT> 也替换，未知宏原样保留', () => {
        assert.equal(substituteMacros('{{char}}/{{USER}}/{{ Char }}/<user>/<BOT>/{{time}}', names),
            '林梦瑶/阿明/林梦瑶/阿明/林梦瑶/{{time}}');
    });
    test('额外宏（如 {{original}}）由调用方提供', () => {
        assert.equal(substituteMacros('前 {{original}} 后', names, { original: '原文' }), '前 原文 后');
    });
});

describe('关键词匹配', () => {
    test('只扫描最近 depth 条消息（默认 2）', () => {
        const list = entries({ key: ['团子饼'], content: '猫' });
        assert.equal(scan(list, ['阿明: 在吗', '林梦瑶: 嗯', '阿明: 团子饼呢']).activated.length, 0);
        assert.equal(scan(list, ['阿明: 在吗', '林梦瑶: 团子饼在楼下']).activated.length, 1);
    });

    test('条目级 scanDepth 覆盖全局深度', () => {
        const list = entries({ key: ['团子饼'], content: '猫', scanDepth: 3 });
        assert.equal(scan(list, ['阿明: 在吗', '林梦瑶: 嗯', '阿明: 团子饼呢']).activated.length, 1);
    });

    test('扫描文本带“名字: ”前缀（ST 的 world_info_include_names 默认开启）', () => {
        const list = entries({ key: ['林梦瑶'], content: 'x' });
        assert.equal(scan(list, ['林梦瑶: 嗯']).activated.length, 1);
    });

    test('默认不区分大小写；条目可设为区分', () => {
        assert.equal(scan(entries({ key: ['MC'], content: 'x' }), ['阿明: 上mc']).activated.length, 1);
        assert.equal(scan(entries({ key: ['MC'], content: 'x', caseSensitive: true }), ['阿明: 上mc']).activated.length, 0);
    });

    test('/正则/flags 形式的关键词按正则匹配', () => {
        const list = entries({ key: ['/想(你|抱)/'], content: 'x' });
        assert.equal(scan(list, ['阿明: 好想抱'])
            .activated.length, 1);
        assert.equal(parseRegexFromString('/a/b/'), null);
        assert.equal(parseRegexFromString('普通词'), null);
    });

    test('整词匹配按 \\W 判边界：中文字符算边界，紧挨英文或数字时匹配失败', () => {
        const whole = (key: string, text: string, matchWholeWords: boolean) =>
            scan(entries({ key: [key], content: 'x', matchWholeWords }), [`阿明: ${text}`]).activated.length === 1;
        assert.equal(whole('cat', 'concat', true), false);
        assert.equal(whole('cat', 'a cat!', true), true);
        assert.equal(whole('抱抱', '要抱抱', true), true);
        assert.equal(whole('上分', '上分666', true), false);
        assert.equal(whole('上分', '上分666', false), true);
    });

    test('关键词里的宏会先替换', () => {
        assert.equal(scan(entries({ key: ['{{user}}来了'], content: 'x' }), ['林梦瑶: 阿明来了']).activated.length, 1);
    });

    test('次关键词四种逻辑', () => {
        const make = (selectiveLogic: number) => entries({ key: ['游戏'], keysecondary: ['王者', '排位'], selectiveLogic, content: 'x' });
        const hits = (logic: number, text: string) => scan(make(logic), [`阿明: ${text}`]).activated.length === 1;
        assert.equal(hits(LOGIC.AND_ANY, '游戏 王者'), true);
        assert.equal(hits(LOGIC.AND_ANY, '游戏'), false);
        assert.equal(hits(LOGIC.AND_ALL, '游戏 王者'), false);
        assert.equal(hits(LOGIC.AND_ALL, '游戏 王者 排位'), true);
        assert.equal(hits(LOGIC.NOT_ANY, '游戏 王者'), false);
        assert.equal(hits(LOGIC.NOT_ANY, '游戏'), true);
        assert.equal(hits(LOGIC.NOT_ALL, '游戏 王者'), true);
        assert.equal(hits(LOGIC.NOT_ALL, '游戏 王者 排位'), false);
    });

    test('selective 关闭时忽略次关键词', () => {
        const list = entries({ key: ['游戏'], keysecondary: ['王者'], selective: false, content: 'x' });
        assert.equal(scan(list, ['阿明: 游戏']).activated.length, 1);
    });
});

describe('激活规则', () => {
    test('常驻条目总是激活，禁用条目从不激活，没有关键词的不激活', () => {
        const list = entries(
            { constant: true, content: '常驻' },
            { key: ['在吗'], disable: true, content: '禁用' },
            { key: [], content: '无关键词' },
        );
        assert.deepEqual(scan(list, ['阿明: 在吗']).activated.map(e => e.content), ['常驻']);
    });

    test('生成类型过滤：只有包含 normal 的条目参与', () => {
        const list = entries({ constant: true, content: 'a', triggers: ['continue'] }, { constant: true, content: 'b', triggers: ['normal'] });
        assert.deepEqual(scan(list, []).activated.map(e => e.content), ['b']);
    });

    test('概率：random()*100 <= probability 才激活', () => {
        const list = entries({ constant: true, content: 'x', probability: 30 });
        assert.equal(scan(list, [], { random: () => 0.29 }).activated.length, 1);
        assert.equal(scan(list, [], { random: () => 0.31 }).activated.length, 0);
        const noRoll = entries({ constant: true, content: 'x', probability: 30, useProbability: false });
        assert.equal(scan(noRoll, [], { random: () => 0.99 }).activated.length, 1);
    });

    test('预算：累计内容超过预算后停止，ignoreBudget 的条目仍然加入', () => {
        // maxContext 100、25% → 预算 25；countTokens 按字符数
        const list = entries(
            { constant: true, order: 300, content: 'a'.repeat(10) },
            { constant: true, order: 200, content: 'b'.repeat(20) },
            { constant: true, order: 150, content: 'c'.repeat(5) },
            { constant: true, order: 100, content: 'd'.repeat(30), ignoreBudget: true },
        );
        const result = scan(list, [], { maxContext: 100 });
        assert.deepEqual(result.activated.map(e => e.content[0]), ['a', 'd']);
    });

    test('内容里的宏会替换', () => {
        const result = scan(entries({ constant: true, content: '{{char}}喜欢{{user}}' }), []);
        assert.equal(result.after || result.before, '林梦瑶喜欢阿明');
    });
});

describe('输出', () => {
    test('按插入位置分成 before / after，order 小的在前', () => {
        const list = entries(
            { constant: true, order: 10, position: POSITION.after, content: 'A10' },
            { constant: true, order: 5, position: POSITION.after, content: 'A5' },
            { constant: true, order: 1, position: POSITION.before, content: 'B1' },
        );
        const result = scan(list, []);
        assert.equal(result.before, 'B1');
        assert.equal(result.after, 'A5\nA10');
    });

    test('order 相同时，文件里靠后的条目排在前面（ST 逐个 unshift 的结果）', () => {
        const list = entries(
            { key: ['在干嘛'], position: POSITION.after, content: '第一条' },
            { key: ['在干嘛'], position: POSITION.after, content: '第二条' },
        );
        assert.equal(scan(list, ['阿明: 在干嘛']).after, '第二条\n第一条');
    });
});

describe('加载', () => {
    test('用到未实现的功能时报错', () => {
        assert.throws(() => entries({ key: ['a'], content: 'x', position: 4 }), /插入位置 4/);
        assert.throws(() => entries({ key: ['a'], content: 'x', group: 'g' }), /group/);
        assert.throws(() => entries({ key: ['a'], content: 'x', sticky: 2 }), /sticky/);
        assert.throws(() => entries({ key: ['a'], content: '@@activate\nx' }), /装饰器/);
        assert.throws(() => entries({ key: ['a'], content: 'x', characterFilter: { names: ['n'], tags: [] } }), /characterFilter/);
    });

    test('ST 新建条目的默认值（sticky 为 null、delayUntilRecursion 为 0 等）不算用到', () => {
        assert.equal(entries({ key: ['a'], content: 'x', sticky: null, cooldown: 0, delayUntilRecursion: 0, group: '' }).length, 1);
    });
});
