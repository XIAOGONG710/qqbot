import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { parseAppConfig, type BotConfig, type Contact } from '../src/config.ts';
import { loadTierCard } from '../src/contact.ts';
import type { MemoryItem } from '../src/memory/hindsight.ts';
import { askedDay, COMMON_LINGER_MS, commonCue, describePerson, knowsPeople, MAX_MENTIONED, mentionedPeople, stillInMind } from '../src/people.ts';
import type { OpenAIMessage } from '../src/prompt.ts';
import { runChecks, runScenario, type SimHindsight } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 名单是虚构的
const me: Contact = { qq: 10001, name: '宝宝', tier: 'boyfriend' };
const gege: Contact = { qq: 10002, name: '鸽鸽', tier: 'classmate', intro: '网上认识的朋友，网络运维的大神，比较熟' };
const xiaoli: Contact = { qq: 10003, name: '小李', tier: 'known', intro: '社团里的学姐' };
const nointro: Contact = { qq: 10004, name: '老王', tier: 'classmate' };
const contacts = [me, gege, xiaoli, nointro];
const he = (content: string) => ({ role: 'user' as const, content });
const she = (content: string) => ({ role: 'assistant' as const, content });

describe('她认识的人（ADR 0016）', () => {
    test('他的话里提到名单里写了介绍的人；没写介绍的、自己都不算', () => {
        assert.deepEqual(mentionedPeople([he('鸽鸽最近在忙啥')], me, contacts), [gege]);
        assert.deepEqual(mentionedPeople([he('老王今天找我了')], me, contacts), []);
        // 鸽鸽自己说「鸽鸽」不算提起别人
        assert.deepEqual(mentionedPeople([he('鸽鸽来了')], gege, contacts), []);
        assert.deepEqual(mentionedPeople([he('在干嘛')], me, contacts), []);
    });

    test('窗口：他最后 3 条、她最后 2 次回复（连发算一次）；最近提到的在前，最多 2 个', () => {
        const history = [he('鸽鸽说他明天上班'), she('是吗'), he('嗯'), he('对'), he('好吧')];
        assert.deepEqual(mentionedPeople(history, me, contacts), [], '他第 4 条之前说的已经出窗口');
        assert.deepEqual(mentionedPeople([he('你认识鸽鸽吗'), she('认识啊'), she('小李也认识'), he('哦')], me, contacts), [xiaoli, gege]);
        assert.deepEqual(mentionedPeople([he('小李和鸽鸽')], me, contacts), [gege, xiaoli], '同一句里靠后的算最近');
        const many = [...contacts, { qq: 10005, name: '阿强', tier: 'known' as const, intro: '高中同学' }];
        assert.equal(mentionedPeople([he('小李、鸽鸽、阿强都在')], me, many).length, MAX_MENTIONED);
    });

    test('陌生人档、名单外提起时不给；单字称呼不算', () => {
        assert.equal(knowsPeople('stranger'), false);
        assert.equal(knowsPeople('unlisted'), false);
        assert.equal(knowsPeople('classmate'), true);
        assert.deepEqual(mentionedPeople([he('鸽鸽是谁')], { qq: 10009, name: '路人', tier: 'stranger' }, contacts), []);
        assert.deepEqual(mentionedPeople([he('鸽鸽是谁')], { qq: 10009, name: '路人', tier: 'unlisted' }, contacts), []);
        const single: Contact = { qq: 10006, name: '鸽', tier: 'classmate', intro: '同学' };
        assert.deepEqual(mentionedPeople([he('鸽子飞了')], me, [me, single]), []);
    });

    test('介绍：称呼、介绍，召回到的接在后面', () => {
        assert.equal(describePerson(gege), '[你认识的人：鸽鸽]\n鸽鸽：网上认识的朋友，网络运维的大神，比较熟');
        assert.equal(describePerson(gege, '[你和鸽鸽聊过的事]\n- 10月5日：鸽鸽说他在值班'),
            '[你认识的人：鸽鸽]\n鸽鸽：网上认识的朋友，网络运维的大神，比较熟\n[你和鸽鸽聊过的事]\n- 10月5日：鸽鸽说他在值班');
    });

    test('配置：intro 可选，去掉首尾空白，空的当没写；不是字符串报错', () => {
        const repoRoot = resolve(import.meta.dirname, '../../..');
        const base = { llm: { baseUrl: 'https://api.deepseek.com', model: 'm' }, characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json' };
        const env = { QQBOT_LLM_API_KEY: 'k' };
        const parsed = parseAppConfig({ ...base, contacts: [{ qq: 1, name: '鸽鸽', tier: 'classmate', intro: '  比较熟 ' }, { qq: 2, name: '阿明', tier: 'boyfriend', intro: ' ' }] }, repoRoot, env);
        assert.equal(parsed.contacts[0]!.intro, '比较熟');
        assert.equal('intro' in parsed.contacts[1]!, false);
        assert.throws(() => parseAppConfig({ ...base, contacts: [{ qq: 1, name: 'x', tier: 'classmate', intro: 3 }] }, repoRoot, env), /contacts\[0\]\.intro 应为字符串/);
    });
});

describe('模拟器里名单的其他人（ADR 0016，假模型、假 Hindsight）', () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {},
    };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
    const scenario = (extra: Record<string, unknown> = {}) => parseScenario({
        name: 'x', tier: 'boyfriend', user: '宝宝', start: '2026-10-06T20:00:00+08:00', schedule: false,
        others: [{
            name: '鸽鸽', tier: 'classmate', intro: '网上认识的朋友，网络运维的大神，比较熟',
            history: [
                { time: '2026-10-05T21:00:00+08:00', role: 'user', content: '今晚机房值班' },
                { time: '2026-10-05T21:01:00+08:00', role: 'assistant', content: '辛苦了' },
            ],
        }],
        steps: [{ say: '在干嘛' }, { say: '鸽鸽最近在忙啥' }],
        ...extra,
    });

    test('事先的聊天写进鸽鸽的 bank 和公共库；提起鸽鸽时有介绍和他的记忆，没提时没有；跑完删掉三个 bank', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'people-sim-'));
        const retained: { bank: string; item: MemoryItem }[] = [];
        const recalled: string[] = [];
        const deleted: string[] = [];
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async (bank, item) => { retained.push({ bank, item }); },
            recall: async bank => { recalled.push(bank); return [{ id: '1', text: '鸽鸽说他 10 月 5 日晚上在机房值班', document_id: 'other:ep-1' }]; },
            getMentalModel: async () => undefined,
            createMentalModel: async () => {},
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            deleteBank: async bank => { deleted.push(bank); },
        };
        const prompts: OpenAIMessage[][] = [];
        try {
            const result = await runScenario(scenario(), {
                runId: 't', dataDir: dir, card, llm, prompt, hindsight, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => { prompts.push(messages); return '在呢'; },
            });
            const gegeBank = retained[0]!.bank;
            assert.deepEqual(retained.map(r => r.bank), [gegeBank, 'sim-t-common']);
            assert.match(retained[1]!.item.content, /^和鸽鸽的私聊\n/);

            const text = (messages: OpenAIMessage[]) => messages.map(m => m.content).join('\n');
            assert.doesNotMatch(text(prompts[0]!), /你认识的人/);
            assert.match(text(prompts[1]!), /\[你认识的人：鸽鸽\]\n鸽鸽：网上认识的朋友，网络运维的大神，比较熟\n\[你和鸽鸽聊过的事（[^\]]*\]\n- 鸽鸽说他 10 月 5 日晚上在机房值班/);
            assert.ok(recalled.includes(gegeBank), '查了鸽鸽的 bank');
            const say = result.steps.filter(step => step.kind === 'say')[1]!;
            assert.ok(say.logs.some(line => line === '提起了 鸽鸽：介绍 + 召回 1 条'));
            assert.ok(say.logs.some(line => line === '召回公共记忆 1 条（线索：鸽鸽）'));
            const first = result.steps.filter(step => step.kind === 'say')[0]!;
            assert.ok(!first.logs.some(line => line.startsWith('召回公共记忆')), '「在干嘛」没有线索，不查公共记忆（ADR 0017）');
            assert.deepEqual([first, say].map(step => runChecks({ noCommon: true }, step)[0]!.ok), [true, false], '检查项 noCommon');
            assert.deepEqual(deleted.sort(), [result.bankId!, gegeBank, 'sim-t-common'].sort());
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('公共库的实体名转发到模拟器：他说起杭州时想起公共记忆（ADR 0017）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'people-sim-'));
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async () => {},
            recall: async () => [{ id: '1', text: '鸽鸽 10 月 13 日去杭州出差', document_id: 'other:ep-1' }],
            getMentalModel: async () => undefined,
            createMentalModel: async () => {},
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            listEntities: async () => ['杭州'],
            deleteBank: async () => {},
        };
        try {
            const result = await runScenario(scenario({ steps: [{ say: '我下周去杭州玩' }] }), {
                runId: 't', dataDir: dir, card, llm, prompt, hindsight, settle: { quietMs: 10, maxMs: 50 },
                generate: async () => '好呀',
            });
            const say = result.steps.find(step => step.kind === 'say')!;
            assert.ok(say.logs.includes('召回公共记忆 1 条（线索：杭州）'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('刚想起来的公共记忆，接下来两轮没有线索也沿用（ADR 0017）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'people-sim-'));
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async () => {},
            recall: async () => [{ id: '1', text: '鸽鸽 10 月 13 日去杭州出差', document_id: 'other:ep-1' }],
            getMentalModel: async () => undefined,
            createMentalModel: async () => {},
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            listEntities: async () => ['杭州'],
            deleteBank: async () => {},
        };
        try {
            const result = await runScenario(scenario({ steps: [{ say: '我下周去杭州玩' }, { say: '然后呢' }, { say: '真的假的' }, { say: '那你呢' }] }), {
                runId: 't', dataDir: dir, card, llm, prompt, hindsight, settle: { quietMs: 10, maxMs: 50 },
                generate: async () => '好呀\n你呢',
            });
            const says = result.steps.filter(step => step.kind === 'say');
            assert.deepEqual(says.map(step => step.logs.find(line => line.includes('公共记忆'))), [
                '召回公共记忆 1 条（线索：杭州）', '公共记忆沿用刚才想起的 1 条', '公共记忆沿用刚才想起的 1 条', undefined,
            ]);
            assert.deepEqual(says.map(step => Boolean(step.generations.at(-1)?.common)), [true, true, true, false]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('场景校验：事先的聊天要早于起点 45 分钟以上，档位要是名单里的', () => {
        const late = { name: '鸽鸽', tier: 'classmate', history: [{ time: '2026-10-06T19:30:00+08:00', role: 'user', content: '在吗' }] };
        assert.throws(() => scenario({ others: [late] }), /要早于起点 45 分钟以上/);
        assert.throws(() => scenario({ others: [{ name: '鸽鸽', tier: 'unlisted' }] }), /others\[0\]\.tier/);
        assert.deepEqual(scenario({ others: undefined }).others, []);
    });
});

describe('公共记忆的线索（ADR 0017）', () => {
    const entities = ['鸽鸽', '林梦瑶', '宝宝', '流浪地球3', '杭州', '猫'];
    const cue = (...said: string[]) => commonCue(said.map(he), me, entities, '林梦瑶');

    test('他这次的话里有公共库里的人和事：最长的那个；她自己、他自己的名字和单字不算', () => {
        assert.equal(cue('你看过流浪地球3吗'), '流浪地球3');
        assert.equal(cue('杭州好玩吗'), '杭州');
        assert.equal(cue('宝宝来了'), undefined, '他自己的称呼');
        assert.equal(cue('林梦瑶在吗'), undefined);
        assert.equal(cue('我家的猫'), undefined, '单字');
        // 只看她上次回复之后的
        assert.equal(commonCue([he('杭州好玩吗'), she('还行'), he('嗯')], me, entities, '林梦瑶'), undefined);
    });

    test('问她过去的事：时间 + 经历，问的是她', () => {
        assert.equal(cue('你今天下午干嘛去了'), '问她过去的事');
        assert.equal(cue('昨天干啥了'), '问她过去的事');
        assert.equal(cue('最近在忙什么呢？'), '问她过去的事');
        assert.equal(cue('我今天去爬山了'), undefined, '说的是他自己');
        assert.equal(cue('在干嘛呢'), undefined, '没有时间');
        assert.equal(cue('今天好累'), undefined, '没有经历');
        assert.equal(cue('你昨天都上了什么课'), '问她过去的事');
        assert.equal(cue('昨天考试怎么样'), '问她过去的事');
        // 接着问另一天：只有时间
        assert.equal(cue('那前天呢'), '问她过去的事');
        assert.equal(cue('你昨天呢？'), '问她过去的事');
        assert.equal(cue('昨天呢我也是'), undefined);
        assert.equal(cue('明天呢'), undefined, '不是过去');
    });

    test('问的是哪一天：他这次最后一句带日子的；「最近」、将来的不算', () => {
        const now = new Date(2026, 9, 8, 21, 0);
        const day = (...said: string[]) => askedDay(said.map(he), now)?.toDateString();
        assert.equal(day('你昨天都干嘛了'), new Date(2026, 9, 7).toDateString());
        assert.equal(day('那前天呢'), new Date(2026, 9, 6).toDateString());
        assert.equal(day('你今天下午干嘛去了'), new Date(2026, 9, 8).toDateString());
        assert.equal(day('昨天晚上吃的啥'), new Date(2026, 9, 7).toDateString(), '「昨天」比「晚上」先');
        assert.equal(day('最近在忙什么'), undefined);
        assert.equal(day('明天早上干嘛'), undefined);
        assert.equal(day('昨天干嘛了', '算了，今天呢'), new Date(2026, 9, 8).toDateString(), '看最后一句');
        // 只看她上次回复之后的
        assert.equal(askedDay([he('昨天干嘛了'), she('写作业'), he('哦')], now), undefined);
    });

    test('刚想起来的还在不在：之后她回了两次以内（连发算一次）、10 分钟以内', () => {
        const t0 = Date.parse('2026-10-08T21:00:00+08:00');
        const msg = (role: 'user' | 'assistant', minutes: number) => ({ role, time: new Date(t0 + minutes * 60_000).toISOString() });
        const before = [msg('user', -1), msg('assistant', -0.5), msg('user', 0)];
        const once = [...before, msg('assistant', 1), msg('assistant', 1), msg('user', 2)];
        const twice = [...once, msg('assistant', 3), msg('user', 4)];
        const thrice = [...twice, msg('assistant', 5), msg('user', 6)];
        assert.equal(stillInMind(once, t0, t0 + 2 * 60_000), true);
        assert.equal(stillInMind(twice, t0, t0 + 4 * 60_000), true);
        assert.equal(stillInMind(thrice, t0, t0 + 6 * 60_000), false);
        assert.equal(stillInMind(once, t0, t0 + COMMON_LINGER_MS), false, '过了 10 分钟');
    });

    test('陌生人档、名单外没有线索', () => {
        assert.equal(commonCue([he('你今天干嘛了')], { qq: 9, name: '路人', tier: 'stranger' }, entities, '林梦瑶'), undefined);
        assert.equal(commonCue([he('你今天干嘛了')], { qq: 9, name: '路人', tier: 'unlisted' }, entities, '林梦瑶'), undefined);
    });
});
