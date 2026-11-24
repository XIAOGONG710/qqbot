// 开关合并在 Koishi 这边（docs/plans/2026-11-24-switch-merge-design.md 第一节 4，M0）：migrateSwitches / routeSwitchInput / legacy()。
// 合并表是参数，这里用只在测试里的示例表；真表现在是空的，最后几条核对插件和今天一模一样。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type * as Koishi from 'koishi';
import { parseAppConfig } from '../../bot/src/platform/config.ts';
import type { SwitchMerge } from '../../bot/src/platform/switch-merge.ts';
import { Config, legacy, migrateSwitches, routeSwitchInput, switchMigrations, toAppConfigInput } from '../src/index.ts';

const { Schema } = createRequire(import.meta.url)('koishi') as typeof Koishi;
const repoRoot = resolve(import.meta.dirname, '../../..');
const env = { QQBOT_LLM_API_KEY: 'k' };
const minimal = {
    contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }],
    llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
};

/** 示例：两个假旧键并成一个新起名字的布尔键（任一开就开） */
const lamp: SwitchMerge = {
    key: 'lamp',
    values: [false, true],
    legacy: ['lampA', 'lampB'],
    fromLegacy: input => input.lampA === true || input.lampB === true,
    toLegacy: value => ({ lampA: value, lampB: value }),
};
const lampDefaults = { lamp: false, lampA: false, lampB: false };
const withLamp = (extra: object) => Config({ ...minimal, ...extra } as never);

describe('migrateSwitches（示例组）', () => {
    test('只写着旧键、对得上：并成新键、删掉旧键；表单补的新键默认值不算「写了新键」', () => {
        const config = withLamp({ lampA: true, lampB: true });
        const migrated = migrateSwitches(config, [lamp], lampDefaults) as unknown as Record<string, unknown>;
        assert.ok(migrated);
        assert.equal(migrated.lamp, true);
        assert.equal('lampA' in migrated, false);
        assert.equal('lampB' in migrated, false);
        assert.deepEqual(switchMigrations(config, [lamp], lampDefaults).map(m => [m.merge.key, m.written, m.value]), [['lamp', ['lampA', 'lampB'], true]]);
        assert.equal(migrateSwitches(migrated as never, [lamp], lampDefaults), undefined, '迁移一次就够');
    });

    test('旧键之间对不上：不写回（照旧按旧键跑）', () => {
        assert.equal(migrateSwitches(withLamp({ lampA: true, lampB: false }), [lamp], lampDefaults), undefined);
        assert.equal(migrateSwitches(withLamp({ lampA: true }), [lamp], lampDefaults), undefined, '另一个按默认值是关，也对不上');
    });

    test('没写旧键：不迁', () => {
        assert.equal(migrateSwitches(withLamp({}), [lamp], lampDefaults), undefined);
        assert.equal(migrateSwitches(withLamp({ lamp: true }), [lamp], lampDefaults), undefined);
    });
});

describe('routeSwitchInput：新键和旧键哪个往下传', () => {
    test('写着旧键：传旧键、不传新键（表单补的默认值会盖掉旧值）', () => {
        const config = withLamp({ lamp: false, lampA: true });
        assert.deepEqual(routeSwitchInput(config, { lamp: false, other: 1 }, [lamp]), { other: 1, lampA: true });
    });

    test('没写旧键：传新键', () => {
        assert.deepEqual(routeSwitchInput(withLamp({ lamp: true }), { other: 1 }, [lamp]), { other: 1, lamp: true });
    });

    test('existing 的组：写着旧键时新键也照传（它的值本来就算数）', () => {
        const qzone: SwitchMerge = { key: 'qzone', existing: true, values: ['off', 'dryRun', 'on'], legacy: ['qzoneBrowse', 'qzonePeek'], fromLegacy: input => input.qzone, toLegacy: value => ({ qzoneBrowse: value, qzonePeek: value }) };
        const config = Config({ ...minimal, qzone: 'on', qzoneBrowse: 'on', qzonePeek: 'dryRun' } as never);
        const routed = routeSwitchInput(config, {}, [qzone]);
        assert.deepEqual(routed, { qzone: 'on', qzoneBrowse: 'on', qzonePeek: 'dryRun' });
        // 对不上 → 不迁；解析出来和今天一样（旧字段原样）
        assert.equal(migrateSwitches(config, [qzone]), undefined);
        const today = parseAppConfig(toAppConfigInput(config), repoRoot, env);
        const merged = parseAppConfig(routeSwitchInput(config, toAppConfigInput(config), [qzone]), repoRoot, env, [qzone]);
        assert.deepEqual(merged, today);
    });
});

describe('迁移前后行为不变（真实键名的示例组，照「留痕」的形状）', () => {
    const ledgers: SwitchMerge = {
        key: 'ledgersExample',
        values: [false, true],
        legacy: ['identityLedger', 'memoryAudit'],
        fromLegacy: input => input.identityLedger === true || input.memoryAudit === true,
        toLegacy: value => ({ identityLedger: value === true, memoryAudit: value === true }),
    };
    const parseWith = (config: Config) => parseAppConfig(routeSwitchInput(config, toAppConfigInput(config), [ledgers]), repoRoot, env, [ledgers]);

    for (const value of [true, false]) {
        test(`两个都 ${value}：迁移前、迁移后、今天，三份解析结果一样`, () => {
            const old = Config({ ...minimal, identityLedger: value, memoryAudit: value } as never);
            const migrated = migrateSwitches(old, [ledgers])!;
            assert.ok(migrated);
            const fields = (config: Record<string, unknown>) => [config.ledgersExample, config.identityLedger, config.memoryAudit];
            assert.deepEqual(fields(migrated as never), [value, undefined, undefined]);
            const today = parseAppConfig(toAppConfigInput(old), repoRoot, env);
            assert.deepEqual(parseWith(old), today);
            assert.deepEqual(parseWith(migrated), today);
        });
    }
});

describe('legacy()：表单上隐藏、不带默认值', () => {
    const form = Schema.object({ lamp: Schema.boolean().default(false), lampA: legacy(), mode: legacy(['off', 'on']) });

    test('隐藏、没有默认值', () => {
        const dict = (form as unknown as { dict: Record<string, Koishi.Schema> }).dict;
        assert.equal(dict.lampA!.meta.hidden, true);
        assert.equal(dict.lampA!.meta.default, undefined);
        assert.equal(dict.mode!.meta.hidden, true);
        assert.equal(dict.mode!.meta.default, undefined);
    });

    test('控制台保存（simplify）不抹掉旧键，哪怕值是 false；新键等于默认值照旧不写', () => {
        const saved = form.simplify(form({ lamp: false, lampA: false, mode: 'off' })) as Record<string, unknown>;
        assert.deepEqual(saved, { lampA: false, mode: 'off' });
        assert.deepEqual(form(saved), { lamp: false, lampA: false, mode: 'off' }, '往返不变');
    });

    test('没写旧键时解析结果里没有它（不会被当成「写着旧键」）', () => {
        assert.equal('lampA' in form({}), false);
    });

    test('模式联合只认列出的几档', () => {
        assert.throws(() => form({ mode: 'dryRun' }));
    });
});

describe('真表（M0：一组都没并）：插件和今天一样', () => {
    test('migrateSwitches 永远是 undefined，routeSwitchInput 原样返回', () => {
        for (const extra of [{}, { qzone: 'on', qzoneBrowse: 'dryRun' }, { proactive: 'on', proactiveReach: true }, { lampA: true, lampB: true }]) {
            const config = Config({ ...minimal, ...extra } as never);
            assert.equal(migrateSwitches(config), undefined);
            assert.deepEqual(switchMigrations(config), []);
            const input = { a: 1 };
            assert.equal(routeSwitchInput(config, input), input);
        }
    });
});
