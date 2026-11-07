import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assessTurn, contributeTurn, createInterpreter, reviewTurn, runTurn, type Module, type Turn } from '../src/interpreter/interpreter.ts';
import { AFTER_HISTORY_SLOTS, AFTER_MAIN_SLOTS, ALL_SLOTS, assemblePrompt, NOW_SLOTS, type Piece } from '../src/interpreter/slots.ts';
import type { MessageEvent } from '../src/platform/onebot.ts';
import { createExecutor } from '../src/executor/executor.ts';
import { jokesTurnModule } from '../src/modules/jokes.ts';
import { idiomsTurnModule } from '../src/modules/idioms.ts';
import { interruptionsModule } from '../src/modules/interruptions.ts';
import { closenessAllowed, closenessModule } from '../src/modules/closeness.ts';
import { playfulAllowed } from '../src/modules/playful.ts';
import { togetherAllowed, togetherModule } from '../src/modules/together.ts';
import { memesModule } from '../src/modules/memes.ts';

const exec = createExecutor({ transport: { sendPrivateText: async () => 1, friendHistory: async () => [] } });

const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'classmate' }, at: new Date(0), history: [], thinking: false, facts: {} };
const message = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 2, user_id: 1, message_id: 3, time: 0, message: '在吗', raw_message: '在吗', sender: { user_id: 1 } } as MessageEvent;

describe('提示词槽位表（ADR 0263）', () => {
    test('每个槽名只出现一次', () => {
        assert.equal(new Set(ALL_SLOTS).size, ALL_SLOTS.length);
        assert.equal(ALL_SLOTS.length, AFTER_MAIN_SLOTS.length + AFTER_HISTORY_SLOTS.length + NOW_SLOTS.length);
    });

    test('按表排序：消息槽各一条，「此刻」行拼成最后一条；同槽按给出的顺序', () => {
        const pieces: Piece[] = [
            { slot: 'intent', text: '[意图]' }, { slot: 'time', text: '[时间]' }, { slot: 'people', text: '人1' }, { slot: 'relationship', text: '关系' },
            { slot: 'summary', text: '要点' }, { slot: 'people', text: '人2' }, { slot: 'mood', text: '[心情]' },
        ];
        assert.deepEqual(assemblePrompt(pieces), { afterMain: ['关系'], afterHistory: ['要点', '人1', '人2', '[时间]\n[心情]\n[意图]'] });
        assert.deepEqual(assemblePrompt([]), { afterMain: [], afterHistory: [] });
        assert.throws(() => assemblePrompt([{ slot: 'nope' as never, text: 'x' }]), /没有这个提示词槽/);
    });
});

describe('解释器骨架（ADR 0263）', () => {
    test('一轮回复：先全部 assess 再全部 contribute；都同步时同步返回', () => {
        const order: string[] = [];
        const a: Module = { id: 'a', assess: () => { order.push('a.assess'); }, contribute: () => { order.push('a.contribute'); return [{ slot: 'intent', text: 'A' }]; } };
        const b: Module = { id: 'b', assess: () => { order.push('b.assess'); }, contribute: () => { order.push('b.contribute'); return [{ slot: 'time', text: 'B' }]; } };
        const result = runTurn([a, b], turn);
        assert.ok(!(result instanceof Promise));
        assert.deepEqual(result, { afterMain: [], afterHistory: ['B\nA'] });
        assert.deepEqual(order, ['a.assess', 'b.assess', 'a.contribute', 'b.contribute']);
    });

    test('有异步钩子时整轮变成 promise，顺序不变', async () => {
        const order: string[] = [];
        const a: Module = { id: 'a', assess: async () => { await null; order.push('a'); } };
        const b: Module = { id: 'b', assess: () => { order.push('b'); }, contribute: async () => [{ slot: 'time', text: 'T' }] };
        const result = runTurn([a, b], turn);
        assert.ok(result instanceof Promise);
        assert.deepEqual(await result, { afterMain: [], afterHistory: ['T'] });
        assert.deepEqual(order, ['a', 'b']);
    });

    test('review 按模块顺序逐个改草稿', async () => {
        const modules: Module[] = [{ id: 'x', review: draft => `${draft}1` }, { id: 'y' }, { id: 'z', review: async draft => `${draft}2` }];
        assert.equal(reviewTurn([modules[0]!, modules[1]!], '稿', turn), '稿1');
        assert.equal(await reviewTurn(modules, '稿', turn), '稿12');
    });

    test('分发：按注册顺序；只有一个返回 promise 时原样返回它；没有处理的事件返回 undefined', async () => {
        const seen: string[] = [];
        const pending = Promise.resolve();
        const interpreter = createInterpreter({ exec, modules: [
            { id: 'one', on: { message: () => { seen.push('one'); } } },
            { id: 'two', on: { message: () => { seen.push('two'); }, connected: () => pending } },
            { id: 'turn', contribute: () => [] },
        ] });
        assert.equal(interpreter.dispatch({ kind: 'message', event: message }), undefined);
        assert.deepEqual(seen, ['one', 'two']);
        assert.equal(interpreter.dispatch({ kind: 'connected', selfId: 2 }), pending);
        assert.equal(interpreter.dispatch({ kind: 'recall', event: { post_type: 'notice', notice_type: 'friend_recall', self_id: 2, user_id: 1, message_id: 3 } }), undefined);
        assert.deepEqual(interpreter.turnModules.map(m => m.id), ['turn']);
    });

    test('处理函数同步抛错照样抛；模块 id 不能重复', () => {
        const interpreter = createInterpreter({ exec, modules: [{ id: 'bad', on: { message: () => { throw new Error('坏了'); } } }] });
        assert.throws(() => interpreter.dispatch({ kind: 'message', event: message }), /坏了/);
        assert.throws(() => createInterpreter({ exec, modules: [{ id: 'a' }, { id: 'a' }] }), /重复/);
    });

    test('定时任务经执行器开、只开一次，stop 时关；stop 按注册顺序收各模块的收尾；状态按顺序合并', () => {
        const opened: number[] = [];
        let cancelled = 0;
        const fake = { every: (_fn: () => void, ms?: number) => { opened.push(ms!); return { unref() { return this; } } as unknown as ReturnType<typeof setInterval>; }, cancel: () => { cancelled++; } };
        const drain = Promise.resolve();
        const stopped: string[] = [];
        const interpreter = createInterpreter({ exec: fake, modules: [
            { id: 'a', schedules: [{ every: 60_000, run: () => {} }], stop: () => { stopped.push('a'); return drain; }, status: () => ({ a: 1 }) },
            { id: 'b', stop: () => { stopped.push('b'); return undefined; }, status: () => ({ b: 2 }) },
            { id: 'c' },
        ] });
        interpreter.startSchedules();
        interpreter.startSchedules();
        assert.deepEqual(opened, [60_000]);
        assert.equal(interpreter.hasStatus, true);
        assert.deepEqual(interpreter.status(), { a: 1, b: 2 });
        assert.deepEqual(interpreter.stop(), [drain]);
        assert.deepEqual(stopped, ['a', 'b']);
        assert.equal(cancelled, 1);
        interpreter.startSchedules();
        assert.deepEqual(opened, [60_000], '停下之后不再开');
    });
});

describe('小梗模块（ADR 0114 / 0263）', () => {
    const boyfriend = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' as const }, history: [{ role: 'user' as const, content: '小土豆在干嘛', time: '2026-11-20T11:00:00.000Z' }], at: new Date('2026-11-20T11:00:00.000Z') };
    test('只有男朋友档；主动找他、只想一想、危机、小别扭、他难过的轮次让路', () => {
        assert.equal(playfulAllowed(boyfriend), true);
        assert.equal(playfulAllowed({ ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, thinking: true }), false);
        assert.equal(playfulAllowed({ ...boyfriend, initiate: { note: '', topic: '' } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, facts: { crisis: { level: 'high' } as never } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, facts: { grievance: {} as never } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：回两句]' } }), true);
    });
    test('放进 joke 槽；让路的轮次不看梗', () => {
        const logs: string[] = [];
        let asked = 0;
        const module = jokesTurnModule(() => { asked++; return [{ phrase: '小土豆', origin: '他老这么叫她' }]; }, line => logs.push(line));
        const pieces = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(i => module.contribute!({ ...boyfriend, history: [{ ...boyfriend.history[0]!, content: `小土豆在干嘛${i}` }] }) as never[]);
        assert.ok(pieces.length > 0 && pieces.every((piece: { slot: string; text: string }) => piece.slot === 'joke' && piece.text.includes('小土豆')));
        assert.ok(logs.every(line => line.startsWith('[1] 小梗：')) && logs.length === pieces.length);
        asked = 0;
        assert.deepEqual(module.contribute!({ ...boyfriend, thinking: true }), []);
        assert.equal(asked, 0);
    });
});

describe('口头习惯模块（ADR 0138 / 0263）', () => {
    const boyfriend = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' as const }, history: [{ role: 'user' as const, content: '笑死 又迟到了', time: '2026-11-20T11:00:00.000Z' }], at: new Date('2026-11-20T11:00:00.000Z') };
    test('放进 idiom 槽；share 为 0 时不放，让路的轮次不看词', () => {
        const logs: string[] = [];
        let asked = 0;
        const idioms = () => { asked++; return [{ phrase: '笑死', kind: '口头禅', count: 9, days: 5 }]; };
        const always = idiomsTurnModule(idioms, line => logs.push(line), 1);
        const pieces = always.contribute!(boyfriend) as { slot: string; text: string }[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'idiom');
        assert.ok(pieces[0]!.text.includes('「笑死」'));
        assert.deepEqual(logs, ['[1] 口头习惯：这一轮提示词里放了他爱说的词（日志不记内容）']);
        assert.deepEqual(idiomsTurnModule(idioms, () => {}, 0).contribute!(boyfriend), []);
        asked = 0;
        assert.deepEqual(always.contribute!({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), []);
        assert.equal(asked, 0);
    });
});

describe('分开的两个阶段（ADR 0263）', () => {
    test('assessTurn 只写判断、不收段落；contributeTurn 只收段落、不再 assess；都同步时同步返回', () => {
        const calls: string[] = [];
        const module: Module = {
            id: 'a',
            assess: t => { calls.push('assess'); t.facts.baseIntent = '写下的'; },
            contribute: t => { calls.push('contribute'); return [{ slot: 'intent', text: t.facts.baseIntent ?? '' }]; },
        };
        const t: Turn = { ...turn, facts: {} };
        assert.equal(assessTurn([module], t), undefined);
        assert.deepEqual(calls, ['assess']);
        assert.deepEqual(contributeTurn([module], t), { afterMain: [], afterHistory: ['写下的'] });
        assert.deepEqual(calls, ['assess', 'contribute']);
    });
    test('有异步的 assess 时返回 promise', async () => {
        const t: Turn = { ...turn, facts: {} };
        const result = assessTurn([{ id: 'a', assess: async x => { x.facts.baseIntent = '晚到'; } }], t);
        assert.ok(result instanceof Promise);
        await result;
        assert.equal(t.facts.baseIntent, '晚到');
    });
});

describe('被打断模块（ADR 0115 / 0263）', () => {
    const at = new Date('2026-11-22T13:00:00.000Z');
    const world = { events: [{ id: 'e1', text: '室友喊她去拿外卖', at: new Date('2026-11-22T12:58:00.000Z') }] } as never;
    const history = [
        { role: 'user' as const, content: '在干嘛', time: '2026-11-22T12:56:00.000Z' },
        { role: 'assistant' as const, content: '刚吃完', time: '2026-11-22T12:56:30.000Z' },
    ];
    const live = (content: string): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [...history, { role: 'user', content, time: '2026-11-22T12:59:50.000Z' }], facts: { world } });
    test('assess 写进 facts.interruption 并记日志，contribute 放进 interrupt 槽；让路的轮次不写', () => {
        const logs: string[] = [];
        const module = interruptionsModule(line => logs.push(line));
        // 按他最后一句取哈希，约六成的轮次才打断：挑几句里第一句会打断的
        const hit = ['你呢', '然后呢', '好吧', '哈哈', '在吗', '嗯嗯', '真的吗', '我也是'].map(live).find(t => { module.assess!(t); return t.facts.interruption; });
        assert.ok(hit, '几句里至少有一句会被打断');
        assert.equal(hit.facts.interruption!.text, '室友喊她去拿外卖');
        assert.equal(hit.facts.interruption!.minutesAgo, 2);
        const pieces = module.contribute!(hit) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'interrupt');
        assert.ok(pieces[0]!.text.includes('室友喊她去拿外卖'));
        assert.deepEqual(logs, ['[1] 被打断：聊着的时候她那边发生了一件小事（提示词里多一行；日志不记内容）']);
        const sad: Turn = { ...hit, facts: { world, baseIntent: '[这一轮你想：先接住他此刻的情绪]' } };
        module.assess!(sad);
        assert.equal(sad.facts.interruption, undefined);
        assert.deepEqual(module.contribute!(sad), []);
        const noWorld: Turn = { ...hit, facts: {} };
        module.assess!(noWorld);
        assert.equal(noWorld.facts.interruption, undefined);
    });
});

describe('关系阶段模块（ADR 0113 / 0263）', () => {
    const at = new Date('2026-11-25T12:00:00+08:00');
    // 最近 20 天每天他说 3 条
    const history = Array.from({ length: 20 }, (_, day) => [0, 1, 2].map(i => ({ role: 'user' as const, content: '在吗', time: new Date(at.getTime() - (day + 1) * 86_400_000 + i * 3600_000).toISOString() }))).flat();
    const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history };
    test('只有男朋友档；只想一想、危机、小别扭时不放；主动找他、他难过时照样放', () => {
        assert.equal(closenessAllowed(boyfriend), true);
        assert.equal(closenessAllowed({ ...boyfriend, initiate: { note: '', topic: '' } }), true);
        assert.equal(closenessAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), true);
        assert.equal(closenessAllowed({ ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' } }), false);
        assert.equal(closenessAllowed({ ...boyfriend, thinking: true }), false);
        assert.equal(closenessAllowed({ ...boyfriend, facts: { crisis: { level: 'high' } as never } }), false);
        assert.equal(closenessAllowed({ ...boyfriend, facts: { grievance: {} as never } }), false);
    });
    test('放进 closeness 槽并记日志；聊得少时不放', () => {
        const logs: string[] = [];
        const module = closenessModule(line => logs.push(line));
        const pieces = module.contribute!(boyfriend) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'closeness');
        assert.ok(pieces[0]!.text.includes('这个月已经聊了 20 天'));
        assert.deepEqual(logs, ['[1] 关系：最近几乎天天在聊，她更放得开一点（提示词里多一行）']);
        assert.deepEqual(module.contribute!({ ...boyfriend, history: history.slice(0, 30) }), []);
    });
});

describe('陪玩模块（ADR 0111 / 0263）', () => {
    const at = new Date('2026-11-27T20:30:00+08:00');
    const history = [
        { role: 'user' as const, content: '今晚王者双排吗', time: new Date('2026-11-27T20:00:00+08:00').toISOString() },
        { role: 'assistant' as const, content: '来呀', time: new Date('2026-11-27T20:01:00+08:00').toISOString() },
        { role: 'user' as const, content: '这把输了', time: new Date('2026-11-27T20:29:50+08:00').toISOString() },
    ];
    const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history };
    test('只有男朋友档；主动找他（含只想一想）、危机时不算；小别扭、他难过时照样算', () => {
        assert.equal(togetherAllowed(boyfriend), true);
        assert.equal(togetherAllowed({ ...boyfriend, facts: { grievance: {} as never } }), true);
        assert.equal(togetherAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), true);
        assert.equal(togetherAllowed({ ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' } }), false);
        assert.equal(togetherAllowed({ ...boyfriend, initiate: { note: '', topic: '' } }), false);
        assert.equal(togetherAllowed({ ...boyfriend, initiate: { note: '', topic: '', think: true } as never, thinking: true }), false);
        assert.equal(togetherAllowed({ ...boyfriend, facts: { crisis: { level: 'high' } as never } }), false);
    });
    test('assess 写进 facts.together 并记日志，contribute 放进 together 槽；说了下了就不算', () => {
        const logs: string[] = [];
        const module = togetherModule(line => logs.push(line));
        const live: Turn = { ...boyfriend, facts: {} };
        module.assess!(live);
        assert.deepEqual(live.facts.together, { activity: 'wzry', since: Date.parse('2026-11-27T20:01:00+08:00') });
        assert.deepEqual(logs, ['[1] 陪玩：他们正一起打王者（从答应起 29 分钟）']);
        const pieces = module.contribute!(live) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'together');
        assert.ok(pieces[0]!.text.includes('打王者（双排）（已经玩了约 29 分钟）'));
        const ended: Turn = { ...boyfriend, history: [...history, { role: 'user', content: '我先下了', time: history[2]!.time }], facts: {} };
        module.assess!(ended);
        assert.equal(ended.facts.together, undefined);
        assert.deepEqual(module.contribute!(ended), []);
        const crisis: Turn = { ...boyfriend, facts: { crisis: { level: 'high' } as never } };
        module.assess!(crisis);
        assert.equal(crisis.facts.together, undefined);
        assert.equal(logs.length, 1);
    });
});

describe('网络热梗模块（ADR 0129 / 0263）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const entry = { term: '尊嘟假嘟', meaning: '“真的假的”的卖萌说法', example: '', confidence: 'high' as const, firstSeen: '2026-11-20', lastSeen: '2026-11-28', seen: 3 };
    const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '尊嘟假嘟', time: at.toISOString() }] };
    test('他用了库里的梗就放进 meme 槽并记日志；让路的轮次不看库', () => {
        const logs: string[] = [];
        let reads = 0;
        const module = memesModule(() => { reads++; return [entry]; }, line => logs.push(line));
        const pieces = module.contribute!(boyfriend) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'meme');
        assert.ok(pieces[0]!.text.includes('「尊嘟假嘟」：“真的假的”的卖萌说法'));
        assert.deepEqual(logs, ['[1] 网络热梗：这一轮提示词里放了梗的意思（日志不记内容）']);
        assert.equal(reads, 1);
        for (const yielding of [
            { ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' as const } },
            { ...boyfriend, initiate: { note: '', topic: '' } },
            { ...boyfriend, facts: { grievance: {} as never } },
            { ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } },
        ]) assert.deepEqual(module.contribute!(yielding), []);
        assert.equal(reads, 1);
        assert.deepEqual(memesModule(() => [], () => {}).contribute!(boyfriend), []);
    });
});
