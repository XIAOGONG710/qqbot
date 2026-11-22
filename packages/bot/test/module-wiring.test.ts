import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// 一轮回复的模块接线（ADR 0336 第 6 步收尾）：App 和模拟器都从 platform/turn-modules.ts 的 buildTurnModules 取，先后只在那里写一次
// （每个模块的先后、有先后要求的几对、构造时不调 deps 里的函数，由 turn-modules.test.ts 核对）。这里守住：
// 1. 两边都只调一次 buildTurnModules，不再直接调模块工厂（小梗、口头习惯在外面建好再放进去）；App 的「旧逻辑」那一个在解释器的最前面。
// 2. 只在一边给的可选项（= 只在一边挂的模块）就是下面清单里那些，带原因；新加的可选项要么两边都给，要么写进清单。
// 只看源码，不起 App、不跑模拟器。
const source = (file: string): string => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const region = (file: string, from: string, to: string): string => {
    const text = source(file);
    const start = text.indexOf(from);
    assert.ok(start >= 0, `${file} 里找不到「${from}」`);
    const end = text.indexOf(to, start);
    assert.ok(end > start, `${file} 里找不到「${to}」`);
    return text.slice(start, end);
};
const code = (text: string): string => text.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
/** 这一段里按出现先后的模块工厂名（去掉注释行、去重） */
const factories = (text: string): string[] => [...new Set([...code(text).matchAll(/\b([a-zA-Z]+Module)\(/g).map(match => match[1]!)])];

const appWiring = region('platform/app.ts', 'const turnModules = buildTurnModules({', '\n        exec,\n');
const simWiring = region('sim/runner.ts', 'turnModules: buildTurnModules({', '\n        }),\n');
/** TurnModuleDeps 里的可选项（给了才挂 / 才有的那些） */
const optional = [...region('platform/turn-modules.ts', 'export interface TurnModuleDeps {', '\n}\n').matchAll(/^ {4}(\w+)\?:/gm)].map(match => match[1]!);
/** 这一段 deps 里给了哪些可选项（`key:` 或简写的 `key,` / `{ key }`） */
const given = (text: string): string[] => optional.filter(key => new RegExp(`(^|[\\s{,])${key}\\s*(:|,|\\s*\\})`, 'm').test(code(text)));

/** 只有 App 给的，和为什么模拟器不给 */
const APP_ONLY: Record<string, string> = {
    shell: '命令结果和 <<执行>>：模拟器不跑命令（「可以跑命令」那一行照样有）',
    reviewPull: '<<查>> 真的去查：模拟器没有查记忆，只摘标记',
    selfMemory: '她自己决定记不记的那几行（selfDirectedMemory）',
    workMode: '工作模式 / 动电脑',
    selfNotes: '摘 <<记住>> / <<日记>> / <<私密>>：模拟器没有 absorb',
    soul: '她在本机的灵魂目录',
    learningQuestion: '她学的时候没想通的地方',
    exemplars: '真人例子',
    consent: '他的请求等她点头',
    continuity: '连续性（模拟器不取，facts 里没有）',
    group: '群聊（模拟器只有私聊）',
    humanState: '真人数值和人格成长层（模拟器不算，facts 里没有）',
    memeDict: '梗百科词库（模拟器没有词库）',
    mediaDiscovery: '货架周期发现：模拟器不扫描外部来源',
    syncedJobs: '补回后的周期任务：模拟器不刷 B 站、不抓热梗、不生成周报',
};
/** 只有模拟器给的，和为什么 */
const SIM_ONLY: Record<string, string> = {
    deliberateNote: '深思那一句换掉的说法（--deliberate-note 实验）',
    solveFrame: '「做题式」写法的实验（--frame solve）',
};

describe('一轮回复的模块接线只有一份（ADR 0336 第 6 步）', () => {
    test('两边都只调一次 buildTurnModules，不再直接调模块工厂', () => {
        for (const file of ['platform/app.ts', 'sim/runner.ts']) {
            assert.equal(code(source(file)).split('buildTurnModules(').length - 1, 1, `${file} 只调一次 buildTurnModules`);
        }
        assert.deepEqual(factories(appWiring), []);
        // 模拟器的小梗、口头习惯直接给场景里写好的（只放提示词的那一半）；App 的在列表外建好（带定时抽取和收尾）
        assert.deepEqual(factories(simWiring), ['jokesTurnModule', 'idiomsTurnModule']);
    });

    test('App：「旧逻辑」那一个在解释器的最前面，然后是群聊的入口，后面是 buildTurnModules 的结果，最后是只有定时任务的（不进一轮回复）', () => {
        assert.match(appWiring, /modules: \[\{\n\s+id: 'app-legacy',[\s\S]*\}, groupRoomEntry, friendRequests, pokes, recalls, followUps, \.\.\.turnModules, worldUpkeep, dshInbox, tastesJob, memorySync, nowExport, outbox, reflections, dreams, leaveNote, dshStateExport, selfExport\],$/);
    });

    test('只在一边给的可选项就是清单里那些（新加的可选项两边都给，或者写进清单说明原因）', () => {
        assert.ok(optional.length > 25, `TurnModuleDeps 的可选项 ${optional.length} 个`);
        const app = given(appWiring), sim = given(simWiring);
        assert.deepEqual(app.filter(key => !sim.includes(key)).sort(), Object.keys(APP_ONLY).sort());
        assert.deepEqual(sim.filter(key => !app.includes(key)).sort(), Object.keys(SIM_ONLY).sort());
    });
});
