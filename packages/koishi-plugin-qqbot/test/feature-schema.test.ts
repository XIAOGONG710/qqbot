import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { DEFAULTS } from '../../bot/src/platform/config.ts';
import { FEATURES, featureDetail } from '../../bot/src/platform/features.ts';
import { Config } from '../src/index.ts';

// 配置页上的功能开关从功能总表生成（ADR 0336 第 6 步）：插件只排先后，类型、默认值、说明、下拉选项都取 bot 的 platform/features.ts。
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

interface Node { type?: string; meta?: { description?: string; default?: unknown }; dict?: Record<string, Node>; list?: Node[]; value?: unknown; inner?: Node }
/** Config 里每个对象字段（按名字；同名的都收） */
function fields(root: unknown): Map<string, Node[]> {
    const out = new Map<string, Node[]>(), seen = new Set<unknown>();
    const walk = (node: Node | undefined) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        for (const [key, child] of Object.entries(node.dict ?? {})) { out.set(key, [...out.get(key) ?? [], child]); walk(child); }
        for (const child of node.list ?? []) walk(child);
        walk(node.inner);
    };
    walk(root as Node);
    return out;
}

describe('配置页的功能开关从功能总表生成', () => {
    test('每个开关在插件里只写一行 toggle / choice（DSH 是对象，开关那一格用 described），不再手写说明', () => {
        for (const def of FEATURES) {
            if (def.key === 'dsh') { assert.match(source, /enabled: described\(Schema\.boolean\(\)\.default\(DEFAULTS\.dsh\.enabled\), 'dsh'\)/); continue; }
            const helper = def.kind === 'mode' ? 'choice' : 'toggle';
            assert.equal(source.split(`\n        ${def.key}: ${helper}('${def.key}'),`).length - 1, 1, `${def.key} 写成 ${helper}('${def.key}')`);
            assert.doesNotMatch(source, new RegExp(`\\n {8}${def.key}: Schema\\.`), `${def.key} 不再手写 Schema`);
        }
        assert.doesNotMatch(source, /\[[A-Z_]+\.key\]:/, '模块常量给的那几项也只写一行');
    });

    test('配置页上每个开关的说明、默认值、下拉选项和功能总表一致', () => {
        const byKey = fields(Config);
        for (const def of FEATURES) {
            const nodes = byKey.get(def.key) ?? [];
            assert.equal(nodes.length, 1, `${def.key} 在配置页上出现一次`);
            const node = def.key === 'dsh' ? nodes[0]!.dict!.enabled! : nodes[0]!;
            const fallback = def.key === 'dsh' ? DEFAULTS.dsh.enabled : (DEFAULTS as unknown as Record<string, unknown>)[def.key];
            assert.equal(node.meta?.description, featureDetail(def), `${def.key} 的说明`);
            assert.equal(node.meta?.default, fallback, `${def.key} 的默认值`);
            if (def.modeLabels) assert.deepEqual(node.list!.map(choice => [choice.value, choice.meta?.description]), Object.entries(def.modeLabels), `${def.key} 的选项`);
            else assert.equal(node.type, 'boolean', def.key);
        }
    });
});
