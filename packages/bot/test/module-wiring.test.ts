import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// 一轮回复的模块接线（ADR 0336 第 6 步收尾）：App 已经从 platform/turn-modules.ts 的 buildTurnModules 取，模拟器还手写一份（下一步也改成从那里取）。这一步守住：
// 1. App 的解释器只有「旧逻辑」那一个加上 buildTurnModules 的结果，不再直接调模块工厂；
// 2. 模拟器手写的那份和 buildTurnModules 的先后一样，模块都在 buildTurnModules 里（小梗、口头习惯是外面建好放进去的）。
// 每个模块的先后和有先后要求的几对由 turn-modules.test.ts 核对。只看源码，不起 App、不跑模拟器。
const source = (file: string): string => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const region = (file: string, from: string, to: string): string => {
    const text = source(file);
    const start = text.indexOf(from);
    assert.ok(start >= 0, `${file} 里找不到「${from}」`);
    const end = text.indexOf(to, start);
    assert.ok(end > start, `${file} 里找不到「${to}」`);
    return text.slice(start, end);
};
/** 这一段里按出现先后的模块工厂名（去掉注释行、去重） */
const factories = (text: string): string[] => {
    const names = text.split('\n').filter(line => !/^\s*\/\//.test(line)).flatMap(line => [...line.matchAll(/\b([a-zA-Z]+Module)\(/g)].map(match => match[1]!));
    return [...new Set(names)];
};
const wiring = factories(region('platform/turn-modules.ts', 'export function buildTurnModules(', '\n}\n'));
const appWiring = region('platform/app.ts', 'const turnModules = buildTurnModules({', '\n        exec,\n');
const sim = factories(region('sim/runner.ts', '        turnModules: [\n', '\n        ],\n'));
/** 外面建好再放进 buildTurnModules 的（小梗、口头习惯） */
const PASSED_IN = ['jokesModule', 'idiomsModule', 'jokesTurnModule', 'idiomsTurnModule'];

describe('一轮回复的模块接线（ADR 0336 第 6 步）', () => {
    test('buildTurnModules 里找到了一长串模块', () => {
        assert.ok(wiring.length > 50, `${wiring.length} 个`);
    });

    test('App：解释器是「旧逻辑」加上 buildTurnModules 的结果，不再直接调模块工厂', () => {
        assert.deepEqual(factories(appWiring), []);
        assert.equal(source('platform/app.ts').split('buildTurnModules(').length - 1, 1, 'App 只调一次 buildTurnModules');
        assert.match(appWiring, /modules: \[\{\n\s+id: 'app-legacy',[\s\S]*\}, \.\.\.turnModules\],$/, '「旧逻辑」那一个在最前（事件分发的先后）');
    });

    test('模拟器手写的那份：模块都在 buildTurnModules 里，先后一样', () => {
        assert.ok(sim.length > 40, `模拟器 ${sim.length} 个`);
        const own = sim.filter(name => !PASSED_IN.includes(name));
        assert.deepEqual(own.filter(name => !wiring.includes(name)), []);
        assert.deepEqual(own, wiring.filter(name => own.includes(name)));
    });
});
