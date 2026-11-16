import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// App 和模拟器各有一份模块接线（ADR 0336 第 6 步收尾还没把它们合成一份）。合并之前先守住两件事：
// 1. 两边挂的模块对得上——新模块只接了一边（线上有、模拟器里没有，或者反过来）会红；确实只该一边有的写在下面的清单里，带原因。
// 2. 有先后要求的几对在两边都是这个先后（模块之间靠 turn.facts 交接：写的在前、读的在后）。
// 只看源码里的接线顺序，不起 App、不跑模拟器。
const region = (file: string, from: string, to: string): string => {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const start = source.indexOf(from);
    assert.ok(start >= 0, `${file} 里找不到「${from}」`);
    const end = source.indexOf(to, start);
    assert.ok(end > start, `${file} 里找不到「${to}」`);
    return source.slice(start, end);
};
/** 这一段里按出现先后的模块工厂名（去掉注释行、去重） */
const factories = (text: string): string[] => {
    const names = text.split('\n').filter(line => !/^\s*\/\//.test(line)).flatMap(line => [...line.matchAll(/\b([a-zA-Z]+Module)\(/g)].map(match => match[1]!));
    return [...new Set(names)];
};
const app = factories(region('platform/app.ts', 'const interpreter = createInterpreter({', '\n        exec,\n'));
const sim = factories(region('sim/runner.ts', '        turnModules: [\n', '\n        ],\n'));

/** 只有 App 挂的，和为什么模拟器不挂 */
const APP_ONLY: Record<string, string> = {
    // 这些功能模拟器的接线里整个没有（runner.ts 里搜不到对应的选项和数据来源）；要在模拟器里测就得先把数据来源接上
    selfMemoryModule: '她自己决定记不记的那几行（selfDirectedMemory）',
    workModeModule: '工作模式 / 动电脑',
    selfNotesModule: '摘 <<记住>> / <<日记>> / <<私密>>：模拟器没有 absorb',
    soulModule: '她在本机的灵魂目录',
    learningQuestionModule: '她学的时候没想通的地方',
    exemplarsModule: '真人例子',
    consentModule: '他的请求等她点头',
    continuityModule: '连续性（模拟器不取，facts 里没有）',
    groupModule: '群聊（模拟器只有私聊）',
    humanStateModule: '真人数值和人格成长层（模拟器不算，facts 里没有）',
    memeDictModule: '梗百科词库（runner.ts 的注释：模拟器没有词库，不挂）',
};
/** 只有模拟器挂的，和为什么 */
const SIM_ONLY: Record<string, string> = {
    solveFrameModule: '「做题式」写法的实验（--frame solve）',
    jokesTurnModule: '小梗：模拟器直接给场景里写好的梗，不抽；App 的 jokesModule 在列表外先建好再放进来',
    idiomsTurnModule: '口头习惯：同上',
};

describe('App 和模拟器的模块接线对得上（ADR 0336 第 6 步之前的防线）', () => {
    test('两边都找到了一长串模块', () => {
        assert.ok(app.length > 50, `App ${app.length} 个`);
        assert.ok(sim.length > 40, `模拟器 ${sim.length} 个`);
    });

    test('只在一边挂的模块就是清单里那些（新模块两边都要接，或者写进清单说明原因）', () => {
        assert.deepEqual(app.filter(name => !sim.includes(name)).sort(), Object.keys(APP_ONLY).sort());
        assert.deepEqual(sim.filter(name => !app.includes(name)).sort(), Object.keys(SIM_ONLY).sort());
    });

    test('有先后要求的几对，两边都是这个先后', () => {
        const before = (list: readonly string[], first: string, second: string, where: string) => {
            assert.ok(list.includes(first) && list.includes(second), `${where} 里要有 ${first} 和 ${second}`);
            assert.ok(list.indexOf(first) < list.indexOf(second), `${where}：${first} 要排在 ${second} 前面`);
        };
        for (const [list, where] of [[app, 'App'], [sim, '模拟器']] as const) {
            before(list, 'herNowModule', 'crisisModule', where);       // perceive 的她此刻最先
            before(list, 'crisisModule', 'intentModule', where);       // 意图阶梯读危机和小别扭的起因
            before(list, 'intentModule', 'interruptionsModule', where); // 被打断读 baseIntent
            before(list, 'intentModule', 'repetitionModule', where);
            before(list, 'shapeModule', 'lengthModule', where);        // 长短读形状
            before(list, 'memesModule', 'watchedModule', where);
        }
        before(app, 'memesModule', 'memeDictModule', 'App');           // 梗百科读热梗这一轮放的那个词
    });
});
