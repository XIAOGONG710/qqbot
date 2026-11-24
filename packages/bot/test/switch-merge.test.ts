// 开关合并的机制（docs/plans/2026-11-24-switch-merge-design.md 第一节，M0）：合并表是参数，这里用只在测试里的示例表；
// 最后一节核对真表：线上快照（test/fixtures/live-switches.ts）里每一组都能并、迁移前后解析出来一样。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { configSwitchNotes, DEFAULTS, parseAppConfig } from '../src/platform/config.ts';
import { FEATURES } from '../src/platform/features.ts';
import { checkSwitchMerges, legacySwitchKeys, legacyValue, mergeSwitchInput, representable, SWITCH_MERGES, switchMergeNotes, writtenLegacy, type SwitchMerge } from '../src/platform/switch-merge.ts';
import { LIVE_2026_11_20, LIVE_LATER_ON } from './fixtures/live-switches.ts';

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
        assert.throws(() => merge({ lamp: 'yes' }), /配置 lamp 应为 true 或 false/);
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

describe('真表：已经并了的组', () => {
    const defaults = DEFAULTS as unknown as Record<string, unknown>;
    /** 线上快照（11-20 那份 + 之后补开的）里每一组旧键并成的新值 */
    const LIVE = { ...LIVE_2026_11_20, ...LIVE_LATER_ON };
    const EXPECTED_LIVE: Record<string, unknown> = {
        qzone: 'on',
        factCheck: 'fix',
        qqControl: 'on',
        autonomousLife: true,
        media: true,
        realWorld: true,
        bilibili: 'on',
        watching: true,
    };
    const env = { QQBOT_LLM_API_KEY: 'k' };
    const base = {
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' },
        contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }],
        characterCard: 'synthetic/{tier}.json',
    };
    const parse = (file: Record<string, unknown>, merges?: readonly SwitchMerge[]) => parseAppConfig({ ...base, ...file }, '/repo', env, merges);
    /** 新起名字的新键（合并前没有这个开关）：不合并时解析出来是默认值，比较时去掉 */
    const newNames = SWITCH_MERGES.filter(merge => !merge.existing).map(merge => merge.key);
    const withoutNewNames = (config: object) => Object.fromEntries(Object.entries(config).filter(([key]) => !newNames.includes(key)));

    test('自检通过；旧键就是各组 legacy 的并集', () => {
        assert.deepEqual(checkSwitchMerges(SWITCH_MERGES, defaults), []);
        assert.deepEqual([...legacySwitchKeys()].sort(), SWITCH_MERGES.flatMap(merge => merge.legacy).sort());
        assert.deepEqual(SWITCH_MERGES.map(merge => merge.key), Object.keys(EXPECTED_LIVE), '每并一组，在 EXPECTED_LIVE 里写上它线上的新值');
    });

    test('功能总表：每组新键一行、absorbs 恰好是并进来的旧键；旧键不再单独成行', () => {
        const keys = new Set(FEATURES.map(def => def.key));
        for (const merge of SWITCH_MERGES) {
            const def = FEATURES.find(row => row.key === merge.key);
            assert.ok(def, `${merge.key} 在功能总表里`);
            assert.deepEqual(def.absorbs?.map(item => item.key), [...merge.legacy], `${merge.key} 的 absorbs`);
            for (const old of merge.legacy) assert.equal(keys.has(old), false, `${old} 不再单独成行`);
        }
        assert.deepEqual(FEATURES.filter(def => def.absorbs?.length && !SWITCH_MERGES.some(merge => merge.key === def.key)).map(def => def.key), [], '有 absorbs 的都在合并表里');
    });

    test('线上快照：每一组都能一字不差地并成新键，新值就是线上现在的行为', () => {
        for (const merge of SWITCH_MERGES) {
            assert.equal(representable(merge, LIVE, defaults), true, `${merge.key} 线上可表达`);
            assert.deepEqual(legacyValue(merge, LIVE, defaults), EXPECTED_LIVE[merge.key], merge.key);
        }
        for (const note of configSwitchNotes(LIVE)) assert.doesNotMatch(note, /对不上/);
    });

    test('线上快照：合并前（今天）、写着旧键（迁移前）、只写新键（迁移后），解析出来的旧字段一样', () => {
        const today = withoutNewNames(parse(LIVE, []));
        const migrated: Record<string, unknown> = { ...LIVE };
        for (const merge of SWITCH_MERGES) {
            const written = writtenLegacy(merge, LIVE);
            if (!written.length) continue;
            migrated[merge.key] = legacyValue(merge, LIVE, defaults);
            for (const key of written) delete migrated[key];
        }
        assert.deepEqual(withoutNewNames(parse(LIVE)), today, '写着旧键：旧字段原样');
        assert.deepEqual(withoutNewNames(parse(migrated)), today, '只写新键：旧字段由新键派生，和今天一样');
        const after = parse(migrated) as unknown as Record<string, unknown>;
        for (const merge of SWITCH_MERGES) assert.deepEqual(after[merge.key], EXPECTED_LIVE[merge.key], merge.key);
    });

    test('只写新键：每一档都能派生出全部旧字段；都没写：旧字段由新键的默认值派生', () => {
        for (const merge of SWITCH_MERGES) {
            for (const value of merge.values) {
                const config = parse({ [merge.key]: value }) as unknown as Record<string, unknown>;
                assert.deepEqual(config[merge.key], value, merge.key);
                const derived = merge.toLegacy(value, config);
                for (const old of merge.legacy) assert.deepEqual(config[old], derived[old], `${merge.key}=${String(value)} → ${old}`);
            }
            const none = parse({}) as unknown as Record<string, unknown>;
            assert.deepEqual(none[merge.key], defaults[merge.key], `${merge.key} 默认值`);
        }
    });
});
