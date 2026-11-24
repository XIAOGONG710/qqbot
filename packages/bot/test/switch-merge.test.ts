// 开关合并的机制（docs/plans/2026-11-24-switch-merge-design.md 第一节，M0）：合并表是参数，这里用只在测试里的示例表；
// 真表现在是空的，最后几条核对它让 parseAppConfig 和今天一模一样。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { configSwitchNotes, DEFAULTS, parseAppConfig } from '../src/platform/config.ts';
import { checkSwitchMerges, legacySwitchKeys, mergeSwitchInput, representable, SWITCH_MERGES, switchMergeNotes, type SwitchMerge } from '../src/platform/switch-merge.ts';

/** 示例：两个假旧键并成一个新起名字的布尔键，没有总开关，任一开就开 */
const lamp: SwitchMerge = {
    key: 'lamp',
    values: [false, true],
    legacy: ['lampA', 'lampB'],
    fromLegacy: input => input.lampA === true || input.lampB === true,
    toLegacy: value => ({ lampA: value, lampB: value }),
};
const lampDefaults = { lamp: false, lampA: false, lampB: false };
const merge = (input: Record<string, unknown>) => mergeSwitchInput(input, lampDefaults, [lamp]);
const notes = (input: Record<string, unknown>) => switchMergeNotes(input, lampDefaults, [lamp]);

describe('示例组：两个旧键 → 一个新键', () => {
    test('表本身自检通过', () => {
        assert.deepEqual(checkSwitchMerges([lamp], lampDefaults), []);
        assert.deepEqual([...legacySwitchKeys([lamp])], ['lampA', 'lampB']);
    });

    test('只有旧键：新键由旧键算出，旧字段原样（不经过派生），日志请改用新键', () => {
        assert.deepEqual(merge({ lampA: true, lampB: true }), { lampA: true, lampB: true, lamp: true });
        assert.deepEqual(merge({ lampA: false }), { lampA: false, lamp: false });
        assert.deepEqual(notes({ lampA: true, lampB: true }), ['开关合并：旧键 lampA、lampB 已并进 lamp（= true），请改用 lamp']);
    });

    test('旧键之间对不上（一开一关）：表达不了，旧字段照旧原样，日志多一句', () => {
        const input = { lampA: true, lampB: false };
        assert.equal(representable(lamp, input, lampDefaults), false);
        assert.deepEqual(merge(input), { lampA: true, lampB: false, lamp: true });
        // 只写一个、另一个按默认值（关）：也对不上
        assert.equal(representable(lamp, { lampA: true }, lampDefaults), false);
        assert.deepEqual(merge({ lampA: true }), { lampA: true, lamp: true });
        const [line] = notes(input);
        assert.match(line!, /已并进 lamp（= true）/);
        assert.match(line!, /对不上：lampB=false（lamp=true 时是 true），过渡期照旧按旧键/);
    });

    test('只有新键：旧字段由新键派生，没有日志', () => {
        assert.deepEqual(merge({ lamp: true }), { lamp: true, lampA: true, lampB: true });
        assert.deepEqual(merge({ lamp: false }), { lamp: false, lampA: false, lampB: false });
        assert.deepEqual(notes({ lamp: true }), []);
    });

    test('两边都写了：以新键为准，日志列出被改掉的旧键', () => {
        assert.deepEqual(merge({ lamp: false, lampA: true, lampB: false }), { lamp: false, lampA: false, lampB: false });
        assert.deepEqual(notes({ lamp: false, lampA: true, lampB: false }), ['开关合并：lamp 和旧键 lampA、lampB 都写了，以 lamp 为准（和 lamp 对不上、按 lamp 改掉的：lampA true→false）']);
        assert.deepEqual(notes({ lamp: true, lampA: true }), ['开关合并：lamp 和旧键 lampA 都写了，以 lamp 为准']);
    });

    test('都没写：新键取默认值，旧字段由默认值派生', () => {
        assert.deepEqual(merge({ other: 1 }), { other: 1, lamp: false, lampA: false, lampB: false });
        assert.deepEqual(notes({ other: 1 }), []);
    });

    test('新键的值不合法：报错；输入本身不被改动', () => {
        assert.throws(() => merge({ lamp: 'yes' }), /配置 lamp 应为 false \/ true 之一/);
        const input = { lampA: true };
        merge(input);
        assert.deepEqual(input, { lampA: true });
    });

    test('自检能查出写错的表', () => {
        const broken: SwitchMerge = { ...lamp, toLegacy: value => ({ lampA: value }), fromLegacy: () => 'maybe' };
        const problems = checkSwitchMerges([broken, { ...lamp, key: 'lamp2' }], lampDefaults);
        assert.ok(problems.some(p => /fromLegacy 给出 maybe/.test(p)), problems.join('\n'));
        assert.ok(problems.some(p => /toLegacy 给出 lampA，应恰好是 lampA、lampB/.test(p)), problems.join('\n'));
        assert.ok(problems.some(p => /lampA 同时出现在 lamp 和 lamp2/.test(p)), problems.join('\n'));
    });
});

describe('ignorable：本来就不起作用的子项对不上不算', () => {
    // 照「深思」的形状：主开关关着时子项单开不起作用
    const deep: SwitchMerge = {
        key: 'deep',
        values: ['off', 'keywords', 'routed'],
        legacy: ['deepOn', 'deepRouting'],
        fromLegacy: input => input.deepOn !== true ? 'off' : input.deepRouting === true ? 'routed' : 'keywords',
        toLegacy: value => ({ deepOn: value !== 'off', deepRouting: value === 'routed' }),
        ignorable: (key, input) => key === 'deepRouting' && input.deepOn !== true,
    };
    const defaults = { deep: 'off', deepOn: false, deepRouting: false };
    test('主开关关着时子项单开：仍可表达；主开关开着按两档算', () => {
        assert.deepEqual(checkSwitchMerges([deep], defaults), []);
        assert.equal(representable(deep, { deepOn: false, deepRouting: true }, defaults), true);
        assert.equal(representable(deep, { deepOn: true, deepRouting: true }, defaults), true);
        assert.deepEqual(mergeSwitchInput({ deepOn: true }, defaults, [deep]), { deepOn: true, deep: 'keywords' });
    });
});

describe('existing：新键合并前就是开关（照「QQ 空间」的形状，用真实键名过 parseAppConfig）', () => {
    const env = { QQBOT_LLM_API_KEY: 'k' };
    const base = {
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' },
        contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }],
        characterCard: 'synthetic/{tier}.json',
    };
    const qzone: SwitchMerge = {
        key: 'qzone',
        existing: true,
        values: ['off', 'dryRun', 'on'],
        legacy: ['qzoneBrowse', 'qzonePeek'],
        fromLegacy: input => input.qzone,
        toLegacy: value => ({ qzoneBrowse: value, qzonePeek: value }),
    };
    const parse = (file: Record<string, unknown>, merges: readonly SwitchMerge[] = [qzone]) => parseAppConfig({ ...base, ...file }, '/repo', env, merges);

    test('写着旧键（线上 koishi.yml 现在的样子）：新键也写着也按「只有旧键」，旧字段原样，和今天解析的一样', () => {
        for (const file of [
            { qzone: 'on', qzoneBrowse: 'on', qzonePeek: 'on' },
            { qzone: 'on', qzoneBrowse: 'dryRun' }, // 对不上的也原样
            { qzoneBrowse: 'on' },
        ]) {
            assert.deepEqual(parse(file), parse(file, []), JSON.stringify(file));
        }
        assert.match(configSwitchNotes({ qzone: 'on', qzoneBrowse: 'dryRun' }, [qzone])[0]!, /已并进 qzone（= on）.*对不上：qzoneBrowse=dryRun/);
    });

    test('只写新键：app 照旧读得到派生出来的旧字段', () => {
        const config = parse({ qzone: 'dryRun' });
        assert.equal(config.qzone, 'dryRun');
        assert.equal(config.qzoneBrowse, 'dryRun');
        assert.equal(config.qzonePeek, 'dryRun');
    });

    test('新起名字的组：两边都写了以新键为准，旧字段跟着新键', () => {
        const ledgers: SwitchMerge = {
            key: 'ledgersExample',
            values: [false, true],
            legacy: ['identityLedger', 'memoryAudit'],
            fromLegacy: input => input.identityLedger === true || input.memoryAudit === true,
            toLegacy: value => ({ identityLedger: value === true, memoryAudit: value === true }),
        };
        const both = parse({ ledgersExample: true, identityLedger: false }, [ledgers]);
        assert.equal(both.identityLedger, true);
        assert.equal(both.memoryAudit, true);
        const oldOnly = parse({ identityLedger: true }, [ledgers]);
        assert.equal(oldOnly.identityLedger, true);
        assert.equal(oldOnly.memoryAudit, false);
        assert.throws(() => parse({ ledgersExample: 1 }, [ledgers]), /配置 ledgersExample 应为/);
    });
});

describe('真表（M0：一组都没并）', () => {
    test('是空的、自检通过、没有旧键', () => {
        assert.equal(SWITCH_MERGES.length, 0);
        assert.deepEqual(checkSwitchMerges(SWITCH_MERGES, DEFAULTS as unknown as Record<string, unknown>), []);
        assert.equal(legacySwitchKeys().size, 0);
    });

    test('规范化原样返回同一个对象，没有日志：parseAppConfig 和今天一样', () => {
        for (const input of [{}, { qzone: 'on', qzoneBrowse: 'dryRun' }, { proactive: 'on', proactiveReach: true }, { deliberate: true, depthRouting: false }]) {
            assert.equal(mergeSwitchInput(input, DEFAULTS as unknown as Record<string, unknown>), input);
            assert.deepEqual(configSwitchNotes(input), []);
        }
    });
});
