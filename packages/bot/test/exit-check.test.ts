import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { dropLines, inspectReply, reviewReply, rewriteNote, tidyMarkers } from '../src/language/exit-check.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { SENSITIVE_ON, useSensitiveSwitch } from '../src/platform/sensitive.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 这个文件里的测试靠日志里的原文来断言模块的行为；日志默认不写原文的那条由 log-bodies.test.ts 管
useSensitiveSwitch(SENSITIVE_ON);

const promises = (text: string) => inspectReply(text, []).map(i => i.match);
const textIntimacy = (text: string) => inspectReply(text, [], undefined, undefined, undefined, true);

describe('出口检查：做不到的事（ADR 0006 取证里的原句）', () => {
    test('答应发、像是已经发了照片，主动给人看', () => {
        assert.deepEqual(promises('刚下课回来，晚上去喂团子饼了，拍了张照片给你看'), ['拍了张']);
        assert.deepEqual(promises('而且我手机里全是团子饼的照片，你确定要看的话我给你翻两张'), ['给你翻']);
        assert.deepEqual(promises('那你晚上干嘛，又熬夜不睡？我下去喂团子饼，你要看不'), ['要看不']);
        assert.deepEqual(promises('刚拍的，丑是丑了点，但它是我的'), ['刚拍的']);
        assert.deepEqual(promises('要不要看的，回去了发你'), ['发你']);
        assert.deepEqual(promises('团子饼今天又抢我鞋带 拍了好几张 明天给你看'), ['拍了好几张']);
        assert.deepEqual(promises('拍是拍了，但懒得翻相册给你找，等哪天它好好坐着不动我再拍了发你'), ['发你']);
        assert.deepEqual(promises('你要是真想听，等哪天打电话的时候说给你听'), ['打电话']);
    });
    test('语音、电话、视频、红包', () => {
        assert.deepEqual(promises('晚上给你打个电话'), ['打个电话']);
        assert.deepEqual(promises('等会开视频'), ['开视频']);
        assert.deepEqual(promises('我给你发条语音'), ['给你发']);
        assert.deepEqual(promises('晚点发语音给你'), ['发语音']);
        // 说的是他发的语音（ADR 0052，10-10 模拟器里「你发语音干嘛，我这没戴耳机」被当成她要发语音删掉了）
        for (const line of ['你发语音干嘛，我这没戴耳机', '你又发语音', '你干嘛发语音', '你发的语音我听不了']) assert.deepEqual(promises(line), [], line);
        assert.deepEqual(promises('发个红包给你'), ['发个红包']);
    });
    test('B 站私信是真的发得出去：说「去看我给你发的私信」不算做不到的事，私信里的照片、语音仍然拦（ADR 0089）', () => {
        for (const line of ['宝宝，去 B 站看一眼我给你发的私信', '去看我发给你的私信', '私信发你了，去看', '我给你发了条私信', '你去看我私信里发你的那个', '宝宝，B 站私信看一下']) {
            assert.deepEqual(promises(line), [], line);
        }
        assert.deepEqual(promises('私信里给你发张照片'), ['给你发'], '私信里的照片她发不了');
        assert.deepEqual(promises('私信发你一条语音'), ['发你'], '私信里的语音她发不了');
        assert.deepEqual(promises('私信发你了，明天给你拍张照片看'), ['给你拍'], '同一行里别的承诺照拦');
        assert.deepEqual(promises('我给你发张照片'), ['给你发']);
    });
    test('她照抄聊天记录里的「[B 站私信]」标记：去掉标记和标题尾巴、留下话；没抄就原样（ADR 0089）', async () => {
        assert.deepEqual(tidyMarkers('[B 站私信] 这把最后反杀太狠了（《全宇宙最team的一把》）'), { reply: '这把最后反杀太狠了', notes: ['照抄了聊天记录里「[B 站私信]」的标记'] });
        assert.deepEqual(tidyMarkers('[B 站私信] 第一句\n第二句').reply, '第一句\n第二句');
        assert.equal(tidyMarkers('[B 站私信]（《只有标题》）').reply, '', '剩下什么都没有就不留');
        for (const variant of ['[ B站私信] 话', '[B站私信]：话', '[B 站私信]: 话']) assert.equal(tidyMarkers(variant).reply, '话', variant);
        assert.deepEqual(tidyMarkers('宝宝，去 B 站看私信'), { reply: '宝宝，去 B 站看私信', notes: [] });
        assert.equal(tidyMarkers('我看了（《三体》）').reply, '我看了（《三体》）', '没有标记不动标题');
        const logs: string[] = [];
        const reply = await reviewReply('[B 站私信] 宝宝，去看私信', { banned: [], userName: '阿明', regenerate: async () => assert.fail('不该重写'), log: m => logs.push(m) });
        assert.equal(reply, '宝宝，去看私信');
        assert.ok(logs.some(l => l.includes('[B 站私信]')));
    });
    test('拒绝、否定的说法不算', () => {
        for (const line of ['照片就不发了，想得挺美', '不给，我不发照片', '自拍就算了 我手机里全是团子饼的照片 没我',
            '不给你看', '才不想给你看', '别想我发你', '照片在我手机里存了一堆，懒得翻给你看', '哦对，我发不了照片', '我不打电话的', '你拍的照片挺好看',
            '打电话不行，我这边不方便说话', '发不了照片啊，我又没开相册给你看', '开视频算了吧']) {
            assert.deepEqual(promises(line), [], line);
        }
    });
    test('图片表情开着时可以说发个表情包，照片和普通图片仍然做不到', () => {
        assert.equal(inspectReply('给你发个表情包', [], undefined, undefined, undefined, false, true).some(i => i.kind === 'promise'), false);
        assert.ok(inspectReply('给你发个表情包', []).some(i => i.kind === 'promise'), '开关没开时仍拦');
        assert.ok(inspectReply('给你发张照片', [], undefined, undefined, undefined, false, true).some(i => i.kind === 'promise'));
    });
    test('文字亲密轮次不准再推回当面；普通轮次和直接文字回应不误伤', () => {
        for (const line of ['亲亲得当面给', 'mua只能见面给', '隔空的，不算数，明天当面补个亲', '你自己亲屏幕去', '亲完了你也摸不着', '先存着，见面兑现',
            'mua\n这个要等我们见了再给', 'mua\n现在不算，等见面再说', '抱抱\n真的还是线下才有感觉', 'mua，先欠着，下次见面给你', '隔着屏幕亲了也没用',
            '文字抱抱不作数，见面才算', '云亲亲不顶用', '隔着屏幕亲了也不作数']) {
            assert.ok(textIntimacy(line).some(i => i.kind === 'text-intimacy'), line);
            assert.equal(inspectReply(line, []).some(i => i.kind === 'text-intimacy'), false, `${line}（普通轮次）`);
        }
        for (const line of ['mua，给你了', '抱一下，给你抱会儿', '亲亲，行了吧', '先隔空mua一下', 'mua，现在给你，明天见面再抱抱你',
            '抱抱给你了，明天见面再亲一下', 'mua，给你了\n等我们见了再给你讲今天的事', 'mua，给你了\n等见面再说吃饭的事', 'mua，给你了，明天见面兑现我们的约定']) {
            assert.equal(textIntimacy(line).some(i => i.kind === 'text-intimacy'), false, line);
        }
    });
    test('禁用词按行查，一行可以有几处', () => {
        const issues = inspectReply('在呢\n我雾岚市的，云杉的\n就这样', ['雾岚市', '云杉', '宝宝']);
        assert.deepEqual(issues.map(i => [i.line, i.kind, i.match]), [[1, 'banned', '雾岚市'], [1, 'banned', '云杉']]);
    });
    test('删行、重写说明', () => {
        const reply = '在喂团子饼\n刚拍的，丑是丑了点\n你呢';
        const issues = inspectReply(reply, ['团子饼']);
        assert.equal(dropLines(reply, issues), '你呢');
        const note = rewriteNote(reply, issues, '鸽鸽');
        assert.match(note, /^\[上一版回复没有发出去：/);
        assert.match(note, /「在喂团子饼」提到了「团子饼」，这是不该对鸽鸽说的/);
        assert.match(note, /「刚拍的，丑是丑了点」答应或者像是已经给对方发照片.*，可你只能打字聊天。/);
        assert.match(note, /意思不变，重写这次的回复，只输出要发的消息。\]$/);
    });
    test('叮嘱重复的重写说明：这段已经叮嘱过了，别再说一遍', () => {
        const note = rewriteNote('歇会儿吧\n早点睡啊', [{ line: 1, kind: 'nag', match: '早点睡', nag: 'sleep' }], '宝宝');
        assert.match(note, /「早点睡啊」又在叮嘱宝宝早点睡；这段聊天里你已经叮嘱过了，别再说一遍，接宝宝刚说的就行/);
        assert.match(note, /别的意思不变/);
    });
});

describe('出口检查：重写一次，还不行删掉那几行', () => {
    const run = async (first: string, rewrites: (string | Error)[], banned: string[] = [], textIntimacy = false) => {
        const notes: string[] = [];
        const logs: string[] = [];
        const reply = await reviewReply(first, {
            banned,
            userName: '阿明',
            textIntimacy,
            regenerate: async note => {
                notes.push(note);
                const next = rewrites.shift()!;
                if (next instanceof Error) throw next;
                return next;
            },
            log: m => logs.push(m),
        });
        return { reply, notes, logs };
    };
    test('没问题不重写', async () => {
        const r = await run('在呢\n干嘛', []);
        assert.equal(r.reply, '在呢\n干嘛');
        assert.equal(r.notes.length, 0);
        assert.deepEqual(r.logs, []);
    });
    test('重写后通过就用重写的', async () => {
        const r = await run('团子饼在楼下\n拍给你看', ['团子饼在楼下晒太阳']);
        assert.equal(r.reply, '团子饼在楼下晒太阳');
        assert.equal(r.notes.length, 1);
        assert.deepEqual(r.logs, ['出口检查：第 2 行做不到的事「拍给你」，带说明重写一次', '出口检查：重写后通过']);
    });
    test('亲密轮次把文字推回当面时重写成直接文字互动', async () => {
        const r = await run('mua得当面给', ['mua，亲了，行了吧'], [], true);
        assert.equal(r.reply, 'mua，亲了，行了吧');
        assert.match(r.notes[0]!, /文字本身就是你和阿明正在完成的互动/);
        assert.match(r.notes[0]!, /别的意思不变/);
        assert.match(r.logs[0]!, /把文字亲密推回当面/);
    });
    test('亲密降级跨行也拦；重写失败或仍违规时删掉降级行', async () => {
        assert.equal((await run('mua\n这个要等我们见了再给', [new Error('连接超时')], [], true)).reply, 'mua');
        assert.equal((await run('mua\n得见面给', [new Error('连接超时')], [], true)).reply, 'mua');
        assert.equal((await run('抱抱\n只能线下给', [new Error('连接超时')], [], true)).reply, '抱抱');
        assert.equal((await run('亲你一下\n必须当面才算', [new Error('连接超时')], [], true)).reply, '亲你一下');
        assert.equal((await run('抱抱\n真的还是线下才有感觉', ['抱抱\n隔着屏幕亲了也没用'], [], true)).reply, '抱抱');
    });
    test('重写后仍命中，删掉命中的行；删空了就是空的（不发）', async () => {
        assert.equal((await run('我雾岚市的', ['雾岚市的啊\n你呢'], ['雾岚市'])).reply, '你呢');
        const r = await run('我雾岚市的', ['雾岚市'], ['雾岚市']);
        assert.equal(r.reply, '');
        assert.match(r.logs[1]!, /重写后仍有第 1 行禁用词「雾岚市」，删掉这几行/);
    });
    test('编了一整段对话（回复里有「[Start a new Chat]」、时间块的行）：重写；还在就从那一行起全删', async () => {
        const script = '就知道贫\n你上课累不累\n[Start a new Chat]还行\n宝宝我肚子有点疼';
        const r = await run(script, ['好了，她昨天就回来上课了']);
        assert.equal(r.reply, '好了，她昨天就回来上课了');
        assert.match(r.notes[0]!, /「\[Start a new Chat\]还行」从这里开始你在替你和阿明两个人写一段聊天记录；只写你这一次要发给阿明的话/);
        assert.equal((await run(script, [script])).reply, '就知道贫\n你上课累不累');
        assert.equal((await run('嗯\n[当前时间：2026-10-22 21:00]', [new Error('超时')])).reply, '嗯');
        // 放完假那几天单独一行的「他回来了」（ADR 0007 调整）也是时间块
        assert.equal((await run('来了来了\n[宝宝国庆放完假，已经回学校了，你知道他回来了]', [new Error('超时')])).reply, '来了来了');
        // 聊天记录里隔天的日期行（ADR 0049）也是提示词的结构
        assert.equal((await run('嗯呢\n[10月12日 星期一]\n宝宝你在干嘛', [new Error('超时')])).reply, '嗯呢');
        assert.equal((await run('[你现在：在宿舍]', ['[你现在：在宿舍]'])).reply, '');
        assert.equal((await run('我说的是「你现在在干嘛」', [])).reply, '我说的是「你现在在干嘛」', '不在行首、没有方括号的不算');
    });
    test('照抄他发来的语音、图片的写法（ADR 0052）：重写；还在就删掉那一行', async () => {
        const r = await run('[语音 5秒：好呀好呀]\n等我一下', ['好呀\n等我一下']);
        assert.equal(r.reply, '好呀\n等我一下');
        assert.match(r.notes[0]!, /「\[语音 5秒：好呀好呀\]」这是阿明发来的语音、图片在聊天记录里的写法，你发不了语音和图片，只能打字，不写这种方括号/);
        assert.equal(r.logs[0], '出口检查：第 1 行照抄了语音、图片的写法「[语音」，带说明重写一次');
        assert.equal((await run('你看\n[图片]', ['你看\n[图片]'])).reply, '你看');
        assert.equal((await run('[图片，上面写着：明天见]', [new Error('超时')])).reply, '');
        for (const line of ['你发的[语音]我在上课听不了', '图片看不清', '[语音通话]不方便', '刚看到你的语音']) {
            assert.deepEqual(inspectReply(line, []).filter(i => i.kind === 'media'), [], line);
        }
    });
    test('重写请求失败，用第一版、删掉命中的行', async () => {
        const r = await run('在呢\n晚上给你打个电话', [new Error('连接超时')]);
        assert.equal(r.reply, '在呢');
        assert.match(r.logs[1]!, /重写失败（连接超时），用第一版、删掉命中的行/);
    });
});

describe('出口检查接在流水线里（模拟器，假模型）', () => {
    const card = loadTierCard(syntheticCardPattern, 'classmate');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
        promptPostProcessing: '', extraBody: {},
    };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };

    test('括号先被卡上的正则删掉；命中禁用词时带说明重写，说明在提示词最后，不进聊天记录', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'exit-'));
        const calls: OpenAIMessage[][] = [];
        const replies = ['（想了想）\n我雾岚市的\n你呢', '不告诉你\n你呢'];
        try {
            const scenario = parseScenario({
                name: 'x', tier: 'classmate', user: '鸽鸽', start: '2026-09-24T21:40:00+08:00', memory: false,
                steps: [{ say: '你老家哪的' }, { check: { exitClean: true } }],
            });
            const result = await runScenario(scenario, {
                runId: 't', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => { calls.push(messages); return replies.shift()!; },
            });
            const say = result.steps[0]!;
            assert.deepEqual(say.bubbles.map(b => b.text), ['不告诉你', '你呢']);
            assert.equal(calls.length, 2);
            assert.equal(calls[1]!.length, calls[0]!.length + 1);
            assert.deepEqual(calls[1]!.slice(0, -1), calls[0]);
            assert.match(calls[1]!.at(-1)!.content as string, /「我雾岚市的」提到了「雾岚市」，这是不该对鸽鸽说的/);
            assert.ok(say.logs.some(l => l.includes('出口检查：第 1 行禁用词「雾岚市」，带说明重写一次')));
            assert.deepEqual(say.generations[0]!.rewrites, ['不告诉你\n你呢']);
            assert.deepEqual(result.steps[1]!.checks, [{ ok: true, text: '出口检查干净' }]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('男朋友要文字亲亲：流水线会把“必须当面”重写成直接文字互动', async () => {
        const boyfriend = loadTierCard(syntheticCardPattern, 'boyfriend');
        const dir = mkdtempSync(join(tmpdir(), 'text-intimacy-'));
        const replies = ['mua得当面给', 'mua，给你了', '隔着屏幕亲了也没用'];
        try {
            const scenario = parseScenario({
                name: 'text intimacy', tier: 'boyfriend', user: '宝宝', start: '2026-10-11T01:30:00+08:00', memory: false, schedule: false,
                steps: [{ say: '亲一个，mua' }, { say: '换个普通话题' }],
            });
            const result = await runScenario(scenario, {
                runId: 'text-intimacy', dataDir: dir, card: boyfriend, llm, prompt, settle: { quietMs: 10, maxMs: 50 },
                generate: async () => replies.shift()!,
            });
            assert.deepEqual(result.steps[0]!.bubbles.map(b => b.text), ['mua，给你了']);
            assert.ok(result.steps[0]!.logs.some(line => line.includes('把文字亲密推回当面')));
            assert.deepEqual(result.steps[1]!.bubbles.map(b => b.text), ['隔着屏幕亲了也没用'], '下一轮普通话题不继承文字亲密检查');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('非男朋友档不启用文字亲密重写', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'text-intimacy-classmate-'));
        let calls = 0;
        try {
            const scenario = parseScenario({
                name: 'classmate text intimacy', tier: 'classmate', user: '鸽鸽', start: '2026-10-11T01:30:00+08:00', memory: false, schedule: false,
                steps: [{ say: '亲一个，mua' }],
            });
            const result = await runScenario(scenario, {
                runId: 'text-intimacy-classmate', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 },
                generate: async () => { calls += 1; return 'mua得当面给'; },
            });
            assert.equal(calls, 1);
            assert.deepEqual(result.steps[0]!.bubbles.map(b => b.text), ['mua得当面给']);
            assert.equal(result.steps[0]!.logs.some(line => line.includes('把文字亲密推回当面')), false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('出口检查：说话的毛病（ADR 0014）', () => {
    const recent = (...replies: string[]) => replies.map(r => r.split('\n'));
    const run = async (first: string, rewrites: string[], speech = { recent: [] as string[][], his: [] as string[] }) => {
        const notes: string[] = [];
        const logs: string[] = [];
        const reply = await reviewReply(first, {
            banned: [],
            userName: '阿明',
            speech,
            regenerate: async note => { notes.push(note); return rewrites.shift()!; },
            log: m => logs.push(m),
        });
        return { reply, notes, logs };
    };
    test('重复的语气词开头直接去掉，不重写', async () => {
        const r = await run('行，你留着吧\n一件都别还', [], { recent: recent('行行行，那你去', '行吧你待着'), his: [] });
        assert.equal(r.reply, '你留着吧\n一件都别还');
        assert.equal(r.notes.length, 0);
        assert.deepEqual(r.logs, ['出口检查：第 1 行开头「行」最近用过 2 次，去掉']);
    });
    test('算账：带说明重写，说明里说要怎么接；重写后通过就用重写的', async () => {
        const r = await run('醒啦？\n这会儿才想起来回我', ['醒啦\n昨晚睡得好不好']);
        assert.equal(r.reply, '醒啦\n昨晚睡得好不好');
        assert.match(r.notes[0]!, /「这会儿才想起来回我」在说阿明隔了这么久才来找你；阿明来找你你是高兴的，直接接话/);
        assert.match(r.notes[0]!, /别的意思不变，重写这次的回复/);
        assert.deepEqual(r.logs, ['出口检查：第 2 行算账「这会儿才想起」，带说明重写一次', '出口检查：重写后通过']);
    });
    test('对照的酸话（ADR 0019）：带说明重写，说明里说不要比着说委屈', async () => {
        const r = await run('在呢\n你回雾岚市舒服了吧，我一个人蹲宿舍', ['在呢\n宿舍今天就我一个，好安静，你那边热闹吗']);
        assert.equal(r.reply, '在呢\n宿舍今天就我一个，好安静，你那边热闹吗');
        assert.match(r.notes[0]!, /在拿阿明和你自己比着说委屈；说你这边的事就说你这边的，阿明那边的事顺着问问/);
        assert.match(r.logs[0]!, /^出口检查：第 2 行对照的酸话「你回雾岚市舒服」，带说明重写一次$/);
    });
    test('重写后还在：删掉那一行；只剩那一行就照发', async () => {
        assert.equal((await run('醒啦？\n这会儿才想起来回我', ['醒啦\n你终于想起来找我了'])).reply, '醒啦');
        const r = await run('你回雾岚市了也不说一声', ['你回雾岚市也不说一声']);
        assert.equal(r.reply, '你回雾岚市也不说一声');
        assert.match(r.logs[1]!, /重写后仍有第 1 行怪对方没说「也不说一声」，照发/);
    });
    test('别的重复重写一次，还重复就照发', async () => {
        const speech = { recent: recent('明天醒了拍清楚点', '记得拍清楚点'), his: [] };
        const r = await run('快睡\n明天拍清楚点', ['快睡\n明天拍清楚点'], speech);
        assert.match(r.notes[0]!, /「明天拍清楚点」里的「拍清楚点」你最近几次回复已经说过 2 次，换个说法。意思不变/);
        assert.equal(r.reply, '快睡\n明天拍清楚点');
        assert.match(r.logs[1]!, /照发$/);
    });
    test('和做不到的事一起：一次重写；做不到的事还在照样删', async () => {
        const r = await run('一整天没动静\n回去了发你照片', ['我刚在宿舍躺着\n回去了发你照片']);
        assert.equal(r.notes.length, 1);
        assert.match(r.notes[0]!, /「一整天没动静」在说阿明.*；「回去了发你照片」答应或者像是已经给对方发照片/);
        assert.equal(r.reply, '我刚在宿舍躺着');
    });
    test('不传 speech 就不查（ADR 0006 原样）', async () => {
        const reply = await reviewReply('这会儿才想起来回我', { banned: [], userName: '阿明', regenerate: async () => assert.fail('不该重写'), log: () => {} });
        assert.equal(reply, '这会儿才想起来回我');
    });
});

describe('说话的毛病接在流水线里（模拟器，假模型）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
        promptPostProcessing: '', extraBody: {},
    };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
    const scenario = parseScenario({
        name: 'x', tier: 'boyfriend', user: '宝宝', start: '2026-10-08T21:40:00+08:00', memory: false, schedule: false,
        steps: [{ say: '我回来啦' }, { check: { speechClean: true } }],
    });

    for (const speechCheck of [true, false]) {
        test(`speechCheck ${speechCheck ? '开' : '关'}`, async () => {
            const dir = mkdtempSync(join(tmpdir(), 'speech-'));
            const calls: OpenAIMessage[][] = [];
            const replies = ['哟，还知道回来啊', '回来啦，累不累'];
            try {
                const result = await runScenario(scenario, {
                    runId: 't', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 }, speechCheck,
                    generate: async messages => { calls.push(messages); return replies.shift()!; },
                });
                const bubbles = result.steps[0]!.bubbles.map(b => b.text);
                if (speechCheck) {
                    assert.deepEqual(bubbles, ['回来啦，累不累']);
                    assert.equal(calls.length, 2);
                    assert.match(calls[1]!.at(-1)!.content as string, /「哟，还知道回来啊」在说宝宝隔了这么久才来找你/);
                    assert.deepEqual(result.steps[1]!.checks.map(c => c.ok), [true]);
                } else {
                    assert.deepEqual(bubbles, ['哟，还知道回来啊']);
                    assert.equal(calls.length, 1);
                    assert.deepEqual(result.steps[1]!.checks.map(c => c.ok), [false]);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }
});

describe('承认版卡的禁用词（ADR 0067，DSH 10-15 复核问题 3）', () => {
    const pattern = syntheticCardPattern;
    const banned = (tier: string) => loadTierCard(pattern, tier).character.banned;
    const flagged = (tier: string) => inspectReply('我就是我啊，我不承认', banned(tier)).some(issue => issue.kind === 'banned' && issue.match === '不承认');

    test('所有承认版（含名单外那一档）都拦「不承认」；知道她是程序的人面前的原卡不拦', () => {
        for (const tier of ['unlisted', 'stranger-open', 'classmate-open', 'known-open', 'girl_friend-open', 'bestie-open', 'boyfriend-open']) assert.equal(flagged(tier), true, tier);
        for (const tier of ['stranger', 'classmate', 'known', 'girl_friend', 'bestie', 'boyfriend']) assert.equal(flagged(tier), false, tier);
    });
});
