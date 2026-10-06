import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/config.ts';
import { loadTierCard } from '../src/contact.ts';
import { dropLines, inspectReply, reviewReply, rewriteNote } from '../src/exit-check.ts';
import type { OpenAIMessage } from '../src/prompt.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const promises = (text: string) => inspectReply(text, []).map(i => i.match);

describe('出口检查：做不到的事（ADR 0006 取证里的原句）', () => {
    test('答应发、像是已经发了照片，主动给人看', () => {
        assert.deepEqual(promises('刚下课回来，晚上去喂土豆了，拍了张照片给你看'), ['拍了张']);
        assert.deepEqual(promises('而且我手机里全是土豆的照片，你确定要看的话我给你翻两张'), ['给你翻']);
        assert.deepEqual(promises('那你晚上干嘛，又熬夜不睡？我下去喂土豆，你要看不'), ['要看不']);
        assert.deepEqual(promises('刚拍的，丑是丑了点，但它是我的'), ['刚拍的']);
        assert.deepEqual(promises('要不要看的，回去了发你'), ['发你']);
        assert.deepEqual(promises('土豆今天又抢我鞋带 拍了好几张 明天给你看'), ['拍了好几张']);
        assert.deepEqual(promises('拍是拍了，但懒得翻相册给你找，等哪天它好好坐着不动我再拍了发你'), ['发你']);
        assert.deepEqual(promises('你要是真想听，等哪天打电话的时候说给你听'), ['打电话']);
    });
    test('语音、电话、视频、红包', () => {
        assert.deepEqual(promises('晚上给你打个电话'), ['打个电话']);
        assert.deepEqual(promises('等会开视频'), ['开视频']);
        assert.deepEqual(promises('我给你发条语音'), ['给你发']);
        assert.deepEqual(promises('发个红包给你'), ['发个红包']);
    });
    test('拒绝、否定的说法不算', () => {
        for (const line of ['照片就不发了，想得挺美', '不给，我不发照片', '自拍就算了 我手机里全是土豆的照片 没我',
            '不给你看', '才不想给你看', '别想我发你', '照片在我手机里存了一堆，懒得翻给你看', '哦对，我发不了照片', '我不打电话的', '你拍的照片挺好看',
            '打电话不行，我这边不方便说话', '发不了照片啊，我又没开相册给你看', '开视频算了吧']) {
            assert.deepEqual(promises(line), [], line);
        }
    });
    test('禁用词按行查，一行可以有几处', () => {
        const issues = inspectReply('在呢\n我青岛的，山青的\n就这样', ['青岛', '山青', '宝宝']);
        assert.deepEqual(issues.map(i => [i.line, i.kind, i.match]), [[1, 'banned', '青岛'], [1, 'banned', '山青']]);
    });
    test('删行、重写说明', () => {
        const reply = '在喂土豆\n刚拍的，丑是丑了点\n你呢';
        const issues = inspectReply(reply, ['土豆']);
        assert.equal(dropLines(reply, issues), '你呢');
        const note = rewriteNote(reply, issues, '鸽鸽');
        assert.match(note, /^\[上一版回复没有发出去：/);
        assert.match(note, /「在喂土豆」提到了「土豆」，这是不该对鸽鸽说的/);
        assert.match(note, /「刚拍的，丑是丑了点」答应或者像是已经给对方发照片.*，可你只能打字聊天。/);
        assert.match(note, /意思不变，重写这次的回复，只输出要发的消息。\]$/);
    });
});

describe('出口检查：重写一次，还不行删掉那几行', () => {
    const run = async (first: string, rewrites: (string | Error)[], banned: string[] = []) => {
        const notes: string[] = [];
        const logs: string[] = [];
        const reply = await reviewReply(first, {
            banned,
            userName: '阿明',
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
        const r = await run('土豆在楼下\n拍给你看', ['土豆在楼下晒太阳']);
        assert.equal(r.reply, '土豆在楼下晒太阳');
        assert.equal(r.notes.length, 1);
        assert.deepEqual(r.logs, ['出口检查：第 2 行做不到的事「拍给你」，带说明重写一次', '出口检查：重写后通过']);
    });
    test('重写后仍命中，删掉命中的行；删空了就是空的（不发）', async () => {
        assert.equal((await run('我青岛的', ['青岛的啊\n你呢'], ['青岛'])).reply, '你呢');
        const r = await run('我青岛的', ['青岛'], ['青岛']);
        assert.equal(r.reply, '');
        assert.match(r.logs[1]!, /重写后仍有第 1 行禁用词「青岛」，删掉这几行/);
    });
    test('重写请求失败，用第一版、删掉命中的行', async () => {
        const r = await run('在呢\n晚上给你打个电话', [new Error('连接超时')]);
        assert.equal(r.reply, '在呢');
        assert.match(r.logs[1]!, /重写失败（连接超时），用第一版、删掉命中的行/);
    });
});

describe('出口检查接在流水线里（模拟器，假模型）', () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'classmate');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
        promptPostProcessing: '', extraBody: {},
    };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };

    test('括号先被卡上的正则删掉；命中禁用词时带说明重写，说明在提示词最后，不进聊天记录', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'exit-'));
        const calls: OpenAIMessage[][] = [];
        const replies = ['（想了想）\n我青岛的\n你呢', '不告诉你\n你呢'];
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
            assert.match(calls[1]!.at(-1)!.content as string, /「我青岛的」提到了「青岛」，这是不该对鸽鸽说的/);
            assert.ok(say.logs.some(l => l.includes('出口检查：第 1 行禁用词「青岛」，带说明重写一次')));
            assert.deepEqual(say.generations[0]!.rewrites, ['不告诉你\n你呢']);
            assert.deepEqual(result.steps[1]!.checks, [{ ok: true, text: '出口检查干净' }]);
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
        const r = await run('在呢\n你回青岛舒服了吧，我一个人蹲宿舍', ['在呢\n宿舍今天就我一个，好安静，你那边热闹吗']);
        assert.equal(r.reply, '在呢\n宿舍今天就我一个，好安静，你那边热闹吗');
        assert.match(r.notes[0]!, /在拿阿明和你自己比着说委屈；说你这边的事就说你这边的，阿明那边的事顺着问问/);
        assert.match(r.logs[0]!, /^出口检查：第 2 行对照的酸话「你回青岛舒服」，带说明重写一次$/);
    });
    test('重写后还在：删掉那一行；只剩那一行就照发', async () => {
        assert.equal((await run('醒啦？\n这会儿才想起来回我', ['醒啦\n你终于想起来找我了'])).reply, '醒啦');
        const r = await run('你回青岛了也不说一声', ['你回青岛也不说一声']);
        assert.equal(r.reply, '你回青岛也不说一声');
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
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
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
