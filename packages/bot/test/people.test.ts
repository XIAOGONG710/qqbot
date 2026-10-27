import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { canGiveFeedback, parseAppConfig, type BotConfig, type Contact } from '../src/platform/config.ts';
import type { Schedule } from '../src/life/schedule.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import type { MemoryItem } from '../src/memory/hindsight.ts';
import {
    askedDay, askedWindow, asksPast, COMMON_LINGER_MS, commonCue, describePerson, holidayWords, knowsPeople, MAX_MENTIONED, mentionedPeople, stillInMind,
} from '../src/life/people.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { runChecks, runScenario, type SimHindsight } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

/** 抽她答应的事的请求（ADR 0018）：假模型单独回，不算进聊天的生成 */
const isPromises = (messages: OpenAIMessage[]) => messages[0]?.role === 'system' && messages[0].content.includes('答应过的事」');

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

    test('配置：feedback 可选（ADR 0073），true 才记；写 false 等于没写；不是布尔值就拒绝启动', () => {
        const repoRoot = resolve(import.meta.dirname, '../../..');
        const base = { llm: { baseUrl: 'https://api.deepseek.com', model: 'm' }, characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json' };
        const env = { QQBOT_LLM_API_KEY: 'k' };
        const parse = (feedback: unknown) => parseAppConfig({ ...base, contacts: [{ qq: 1, name: '鸽鸽', tier: 'classmate', feedback }] }, repoRoot, env);
        assert.equal(parse(true).contacts[0]!.feedback, true);
        assert.equal('feedback' in parse(false).contacts[0]!, false);
        assert.equal('feedback' in parse(undefined).contacts[0]!, false);
        assert.throws(() => parse('yes'), /contacts\[0\]\.feedback 应为 true 或 false/);
        assert.equal(canGiveFeedback({ tier: 'boyfriend' }), true);
        assert.equal(canGiveFeedback({ tier: 'classmate' }), false);
        assert.equal(canGiveFeedback({ tier: 'classmate', feedback: true }), true);
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
                generate: async messages => { if (isPromises(messages)) return '{"add":[],"resolved":[]}'; prompts.push(messages); return '在呢'; },
            });
            const gegeBank = retained[0]!.bank;
            assert.deepEqual(retained.map(r => r.bank), [gegeBank, 'sim-t-common']);
            assert.match(retained[1]!.item.content, /^和鸽鸽的私聊\n/);

            const text = (messages: OpenAIMessage[]) => messages.map(m => m.content).join('\n');
            assert.doesNotMatch(text(prompts[0]!), /你认识的人/);
            assert.match(text(prompts[1]!), /\[你认识的人：鸽鸽\]\n鸽鸽：网上认识的朋友，网络运维的大神，比较熟\n\[关于鸽鸽的旧事（可明说·和鸽鸽聊的；[^\]]*\]\n- 鸽鸽说他 10 月 5 日晚上在机房值班/);
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
                generate: async messages => (isPromises(messages) ? '{"add":[],"resolved":[]}' : '好呀'),
            });
            const say = result.steps.find(step => step.kind === 'say')!;
            assert.ok(say.logs.includes('召回公共记忆 1 条（线索：杭州）'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('亲密联系人开启新一段时会想起今天和别人聊过的；同一段后续不重复塞（ADR 0020）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'people-sim-'));
        let otherDocument = '';
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async (bank, item) => { if (bank === 'sim-t-common') otherDocument = item.document_id; },
            recall: async bank => bank === 'sim-t-common' ? [{
                id: 'today', text: '鸽鸽今晚在机房值班', document_id: otherDocument,
                mentioned_at: '2026-10-06T19:01:00+08:00', occurred_start: '2026-10-06T19:01:00+08:00',
            }] : [],
            getMentalModel: async () => undefined,
            createMentalModel: async () => {},
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            listEntities: async () => [],
            deleteBank: async () => {},
        };
        const prompts: OpenAIMessage[][] = [];
        try {
            const result = await runScenario(scenario({
                others: [{
                    name: '鸽鸽', tier: 'classmate', intro: '网上认识的朋友',
                    history: [
                        { time: '2026-10-06T19:00:00+08:00', role: 'user', content: '今晚机房值班' },
                        { time: '2026-10-06T19:01:00+08:00', role: 'assistant', content: '辛苦了' },
                    ],
                }],
                steps: [{ say: '在干嘛' }, { say: '吃饭了吗' }],
            }), {
                runId: 't', dataDir: dir, card, llm, prompt, hindsight, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => { if (isPromises(messages)) return '{"add":[],"resolved":[]}'; prompts.push(messages); return '在呢'; },
            });
            const first = prompts[0]!.map(message => message.content).join('\n');
            const second = prompts[1]!.map(message => message.content).join('\n');
            assert.match(first, /\[你今天和别人聊过的事/);
            assert.match(first, /可明说·和鸽鸽聊的/);
            assert.match(first, /主动向宝宝提别人时比标签再保守一级/);
            assert.doesNotMatch(second, /\[你今天和别人聊过的事/);
            const says = result.steps.filter(step => step.kind === 'say');
            assert.match(says[0]!.generations[0]!.todayOthers!, /鸽鸽今晚在机房值班/);
            assert.equal(says[1]!.generations[0]!.todayOthers, undefined);
            assert.ok(says[0]!.logs.some(line => line.startsWith('今天和别人聊过的 1 条')));
            assert.ok(!says[1]!.logs.some(line => line.startsWith('今天和别人聊过的')));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('放进提示词的记忆里她的名字写成「你」（ADR 0018 决策 4）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'people-sim-'));
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async () => {},
            recall: async () => [{ id: '1', text: `${card.character.name}说她也想去杭州`, document_id: 'other:ep-1' }],
            getMentalModel: async () => undefined,
            createMentalModel: async () => {},
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            listEntities: async () => ['杭州'],
            deleteBank: async () => {},
        };
        const prompts: OpenAIMessage[][] = [];
        try {
            await runScenario(scenario({ steps: [{ say: '鸽鸽下周去杭州' }] }), {
                runId: 't', dataDir: dir, card, llm, prompt, hindsight, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => { if (isPromises(messages)) return '{"add":[],"resolved":[]}'; prompts.push(messages); return '好呀'; },
            });
            const text = prompts[0]!.map(m => m.content).join('\n');
            // 公共记忆、鸽鸽的记忆两段都换了（他自己的 bank 还没写过，场景里没有他以前的聊天）
            // 带她名字的那一行里的「她」也是她（ADR 0018 调整 16）
            assert.equal(text.match(/- (?:（[^）]+）：)?你说你也想去杭州/g)?.length, 2);
            assert.doesNotMatch(text, new RegExp(`${card.character.name}说她也想去杭州`));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('聊天原文只放最近 7 天的（ADR 0018 实现时的调整 12）：隔了很久再来放上一次那段，更早的不放，日志写不放几条', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'people-sim-'));
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async () => {},
            recall: async () => [],
            getMentalModel: async () => undefined,
            createMentalModel: async () => {},
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            listEntities: async () => [],
            deleteBank: async () => {},
        };
        const prompts: OpenAIMessage[][] = [];
        try {
            await runScenario(scenario({
                others: [],
                history: [
                    { time: '2026-08-27T20:00:00+08:00', role: 'user', content: '后街那家老灶火锅巨好吃' },
                    { time: '2026-08-27T20:01:00+08:00', role: 'assistant', content: '下次带我去' },
                    { time: '2026-09-16T21:00:00+08:00', role: 'user', content: '最近在学吉他' },
                ],
                steps: [{ say: '在吗' }],
            }), {
                runId: 't', dataDir: dir, card, llm, prompt, hindsight, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => { if (isPromises(messages)) return '{"add":[],"resolved":[]}'; prompts.push(messages); return '在呢'; },
            });
            const text = prompts[0]!.map(m => m.content).join('\n');
            assert.match(text, /最近在学吉他/, '上一次那段（20 天前）还放');
            assert.doesNotMatch(text, /老灶/, '更早的不放');
            assert.match(readFileSync(join(dir, 'sim.log'), 'utf8'), /较早的聊天原文 2 条不放（事实靠长期记忆）/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('公共记忆会变淡（ADR 0018）：日志写各几条，提示词里标「记不太清了」', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'people-sim-'));
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async () => {},
            recall: async () => [
                { id: '1', text: '鸽鸽去杭州出差', document_id: 'other:ep-1', occurred_start: '2026-08-27T12:00:00+08:00', entities: ['鸽鸽', '杭州'] },
                { id: '2', text: '鸽鸽换了工作', document_id: 'other:ep-2', occurred_start: '2026-08-20T12:00:00+08:00', entities: ['鸽鸽'] },
                { id: '3', text: '鸽鸽去看了演唱会', document_id: 'other:ep-3', occurred_start: '2026-09-25T12:00:00+08:00' },
            ],
            getMentalModel: async () => undefined,
            createMentalModel: async () => {},
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            listEntities: async () => ['杭州'],
            deleteBank: async () => {},
        };
        const prompts: OpenAIMessage[][] = [];
        try {
            const result = await runScenario(scenario({ steps: [{ say: '我下周去杭州玩' }] }), {
                runId: 't', dataDir: dir, card, llm, prompt, hindsight, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => { if (isPromises(messages)) return '{"add":[],"resolved":[]}'; prompts.push(messages); return '好呀'; },
            });
            const say = result.steps.find(step => step.kind === 'say')!;
            assert.ok(say.logs.includes('召回公共记忆 2 条（线索：杭州；记个大概 1，一提想起 1，想不起来 1）'), say.logs.join('\n'));
            const text = prompts[0]!.map(m => m.content).join('\n');
            assert.match(text, /- 8月27日（不能说·来源不明，他一提才想起来，记不太清了）：鸽鸽去杭州出差/);
            assert.match(text, /- 9月25日（不能说·来源不明，记不太清了）：鸽鸽去看了演唱会/);
            assert.doesNotMatch(text, /换了工作/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    for (const [entities, label] of [[[], '问她过去的事'], [['国庆'], '国庆']] as const) test(`问「国庆过得怎么样」（ADR 0018）：卡上作息的假期名算线索，召回带那个假期的时间窗（公共库的实体 ${JSON.stringify(entities)}）`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'people-sim-'));
        const requests: { temporal_window?: { start: string; end: string } }[] = [];
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async () => {},
            recall: async (_bank, request) => { requests.push(request); return []; },
            getMentalModel: async () => undefined,
            createMentalModel: async () => {},
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            listEntities: async () => [...entities],
            deleteBank: async () => {},
        };
        try {
            const result = await runScenario(scenario({ steps: [{ say: '国庆过得怎么样' }] }), {
                runId: 't', dataDir: dir, card, llm, prompt, hindsight, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => (isPromises(messages) ? '{"add":[],"resolved":[]}' : '还行'),
            });
            const say = result.steps.find(step => step.kind === 'say')!;
            assert.ok(say.logs.includes(`公共记忆没想起什么（线索：${label}）`), say.logs.join('\n'));
            assert.deepEqual(requests.find(r => r.temporal_window)?.temporal_window, { start: '2026-10-01T00:00:00+08:00', end: '2026-10-08T02:00:00+08:00' },
                '线索是假期名本身（「国庆」也是公共库的实体）时同样带假期的时间窗');
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
                generate: async messages => (isPromises(messages) ? '{"add":[],"resolved":[]}' : '好呀\n你呢'),
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

    test('线索是公共库里的事、同时在问她过去的某天：asksPast 也认（ADR 0032：「周一你那快递拿了没」的线索是「快递」）', () => {
        const withParcel = [...entities, '快递', '下雨'];
        assert.equal(commonCue([he('周一你那快递拿了没')], me, withParcel, '林梦瑶'), '快递');
        assert.equal(asksPast([he('周一你那快递拿了没')]), true);
        assert.equal(asksPast([he('昨天下雨了吗')]), true);
        assert.equal(asksPast([he('快递到了吗')]), false, '没有时间词');
        assert.equal(asksPast([he('我昨天去杭州了')]), false, '说的是他自己');
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
        // 问她今天跟谁聊了（ADR 0020 第二批：开场之外他问起时，今天和别人聊过的也要想得起来）
        assert.equal(cue('你今天都跟谁聊天了'), '问她过去的事');
        assert.equal(cue('今天和谁出去的'), '问她过去的事');
        assert.equal(cue('我今天跟同事聊天了'), undefined, '说的是他自己');
        // 接着问另一天：只有时间
        assert.equal(cue('那前天呢'), '问她过去的事');
        assert.equal(cue('你昨天呢？'), '问她过去的事');
        assert.equal(cue('昨天呢我也是'), undefined);
        assert.equal(cue('明天呢'), undefined, '不是过去');
    });

    test('问周几、几号（72 小时基线）：算问她过去的事，时间窗是最近过去的那一天', () => {
        assert.equal(cue('周一你那快递拿了没'), '问她过去的事');
        assert.equal(cue('礼拜三你干嘛去了'), '问她过去的事');
        assert.equal(cue('12号你做了什么'), '问她过去的事');
        assert.equal(cue('我周一拿了快递'), undefined, '说的是他自己');
        assert.equal(cue('昨天下雨了吗'), '问她过去的事', '问那天的天气也算（ADR 0032）');
        const thursday = new Date(2026, 9, 15, 21, 0);
        const day = (said: string) => askedDay([he(said)], thursday)?.start.toDateString();
        assert.equal(day('周一你那快递拿了没'), new Date(2026, 9, 12).toDateString());
        assert.equal(day('星期四你干嘛了'), new Date(2026, 9, 15).toDateString(), '今天就是周四');
        assert.equal(day('上周三干嘛了'), new Date(2026, 9, 7).toDateString());
        assert.equal(day('礼拜天呢'), new Date(2026, 9, 11).toDateString());
        assert.equal(day('周一晚上干嘛了'), new Date(2026, 9, 12).toDateString(), '「晚上」不把它变成今天');
        assert.equal(day('12号你在干嘛'), new Date(2026, 9, 12).toDateString());
        assert.equal(day('20号你干嘛了'), new Date(2026, 8, 20).toDateString(), '还没到就是上个月的');
        assert.equal(day('周五要考试'), new Date(2026, 9, 9).toDateString(), '这里不判断将来（commonCue 要有经历词才算问过去）');
    });

    test('问的是哪一天：他这次最后一句带日子的；「最近」、将来的不算', () => {
        const now = new Date(2026, 9, 8, 21, 0);
        const day = (...said: string[]) => askedDay(said.map(he), now)?.start.toDateString();
        assert.equal(day('你昨天都干嘛了'), new Date(2026, 9, 7).toDateString());
        assert.equal(day('那前天呢'), new Date(2026, 9, 6).toDateString());
        assert.equal(day('你今天下午干嘛去了'), new Date(2026, 9, 8).toDateString());
        assert.equal(day('昨天晚上吃的啥'), new Date(2026, 9, 7).toDateString(), '「昨天」比「晚上」先');
        assert.equal(day('最近在忙什么'), undefined);
        assert.equal(day('明天早上干嘛'), undefined);
        assert.equal(day('昨天干嘛了', '算了，今天呢'), new Date(2026, 9, 8).toDateString(), '看最后一句');
        // 只看她上次回复之后的
        assert.equal(askedDay([he('昨天干嘛了'), she('写作业'), he('哦')], now), undefined);
        // 没有作息：时间窗是那个日历日
        assert.deepEqual(askedDay([he('你昨天干嘛了')], now), { start: new Date(2026, 9, 7), end: new Date(2026, 9, 8) });
    });

    test('有作息时「今天」按她的一天算（ADR 0018 决策 4）：凌晨 2 点前问的是刚过去的那天，时间窗到第二天 02:00', () => {
        const schedule = { sleep: '02:00' } as Schedule;
        const late = new Date(2026, 9, 9, 1, 30);
        assert.deepEqual(askedDay([he('你今天干嘛了')], late, schedule), { start: new Date(2026, 9, 8), end: new Date(2026, 9, 9, 2) });
        assert.deepEqual(askedDay([he('那昨天呢')], late, schedule), { start: new Date(2026, 9, 7), end: new Date(2026, 9, 8, 2) });
        // 过了 02:00 就是新的一天
        assert.deepEqual(askedDay([he('你今天干嘛了')], new Date(2026, 9, 9, 9), schedule), { start: new Date(2026, 9, 9), end: new Date(2026, 9, 10, 2) });
    });

    test('问的是哪段时间（ADR 0018 决策 3）：上周、这周、上个月、作息里的假期；某一天优先，将来的不算', () => {
        const schedule = {
            sleep: '02:00',
            holidays: [{ name: '中秋节', start: '2026-09-25', end: '2026-09-27' }, { name: '国庆节', start: '2026-10-01', end: '2026-10-07' }],
        } as Schedule;
        const now = new Date(2026, 9, 14, 21); // 周三
        const window = (...said: string[]) => {
            const w = askedWindow(said.map(he), now, schedule);
            return w && [w.start.toDateString(), w.end.toLocaleString('zh-CN'), w.period];
        };
        const end = (y: number, m: number, d: number) => new Date(y, m, d, 2).toLocaleString('zh-CN');
        assert.deepEqual(window('你上周忙啥了'), [new Date(2026, 9, 5).toDateString(), end(2026, 9, 12), 'week']);
        assert.deepEqual(window('这周过得怎么样'), [new Date(2026, 9, 12).toDateString(), end(2026, 9, 19), 'week']);
        assert.deepEqual(window('上个月都干嘛了'), [new Date(2026, 8, 1).toDateString(), end(2026, 9, 1), 'month']);
        assert.deepEqual(window('国庆过得怎么样'), [new Date(2026, 9, 1).toDateString(), end(2026, 9, 8), 'holiday']);
        assert.deepEqual(window('中秋节干嘛了'), [new Date(2026, 8, 25).toDateString(), end(2026, 8, 28), 'holiday']);
        assert.deepEqual(window('放假的时候你去哪了'), [new Date(2026, 9, 1).toDateString(), end(2026, 9, 8), 'holiday'], '只说放假：最近开始的那个');
        assert.deepEqual(window('你昨天干嘛了'), [new Date(2026, 9, 13).toDateString(), end(2026, 9, 14), undefined]);
        assert.equal(window('下周打算干嘛'), undefined);
        assert.equal(window('最近在忙什么'), undefined);
        assert.deepEqual(window('上周忙啥', '算了，昨天呢'), [new Date(2026, 9, 13).toDateString(), end(2026, 9, 14), undefined], '看最后一句');
        // askedDay 只认某一天
        assert.equal(askedDay([he('你上周忙啥了')], now, schedule), undefined);
    });

    test('假期的名字也算问她过去的事（ADR 0018 决策 3）', () => {
        const schedule = { holidays: [{ name: '国庆节', start: '2026-10-01', end: '2026-10-07' }] } as unknown as Schedule;
        assert.deepEqual(holidayWords(schedule), ['国庆节', '国庆']);
        assert.deepEqual(holidayWords(undefined), []);
        assert.equal(commonCue([he('国庆过得怎么样')], me, entities, '林梦瑶'), undefined, '没给假期名');
        assert.equal(commonCue([he('国庆过得怎么样')], me, entities, '林梦瑶', holidayWords(schedule)), '问她过去的事');
        assert.equal(commonCue([he('那国庆呢')], me, entities, '林梦瑶', holidayWords(schedule)), '问她过去的事');
        assert.equal(commonCue([he('你上周忙啥了')], me, entities, '林梦瑶'), '问她过去的事');
        assert.equal(commonCue([he('这周过得怎么样')], me, entities, '林梦瑶'), '问她过去的事');
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
