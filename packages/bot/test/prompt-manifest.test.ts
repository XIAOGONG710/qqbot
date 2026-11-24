// 提示词指纹清单（platform/prompt-manifest.ts；研究 docs/research/2026-11-22-private-companion-v2.md 五、建议 1）：
// 段落带模块（解释器 contributeTurn 标）、真正放进去的段落（slots.ts 的 placedPieces）、算清单、联系人流水线每次生成交一份
// （含审稿重写、挑候选）、群里开口交一份、按天写 / 删旧的、私人文件名单。
// 只用合成角色和编的段落（ADR 0333）。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { contributeTurn, type Module, type Turn } from '../src/interpreter/interpreter.ts';
import { assemblePrompt, placedPieces, type Piece, type PlacedPiece } from '../src/interpreter/slots.ts';
import { useFewerRules } from '../src/language/fewer-rules.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { realFiles } from '../src/executor/executor.ts';
import type { AppConfig } from '../src/platform/config.ts';
import { createContactResponder, loadTierCard } from '../src/platform/contact.ts';
import { createPromptManifestLog, expiredManifests, MANIFEST_KEEP_DAYS, MANIFEST_VERSION, manifestFileName, promptManifest, type PromptManifest } from '../src/platform/prompt-manifest.ts';
import { groupLog } from '../src/social/group-chat.ts';
import { groupRoom, type GroupRoomDeps } from '../src/social/group-room.ts';
import { isPrivateFile } from '../src/platform/private-space.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';
import { compareSelf, describe as describeDiff, latestManifest } from '../../../scripts/prompt-manifest-diff.mjs';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const dirs: string[] = [];
afterEach(() => {
    useFewerRules(false);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-manifest-')); dirs.push(dir); return dir; };

// 编的段落：三个模块，一个是异步的；同一个槽（people）两个模块都放
const ALPHA: Piece[] = [{ slot: 'state', text: '[你现在：在宿舍看书]' }, { slot: 'recalled', text: '[你记得：他说过喜欢猫]' }, { slot: 'people', text: '[小周：她室友]' }];
const BETA: Piece[] = [{ slot: 'time', text: '[现在是晚上九点零三分]' }, { slot: 'relationship', text: '[你们在一起两个月了]' }, { slot: 'length', text: '[这一轮回句短的]' }];
const GAMMA: Piece[] = [{ slot: 'inner', text: '[你最近心里在想的：想吃火锅]' }, { slot: 'people', text: '[阿杰：他同学]' }];
const modules = (async = false): Module[] => [
    { id: 'alpha', contribute: () => ALPHA },
    { id: 'beta', contribute: () => BETA },
    { id: 'gamma', contribute: async ? async () => GAMMA : () => GAMMA },
    { id: 'quiet' }, // 不放段落的模块不出现在清单里
];
const turnOf = (crisis = false): Turn => ({ contact: { qq: 10001, name: '阿明', tier: 'boyfriend' }, at: new Date(0), history: [], thinking: false, facts: crisis ? { crisis: { level: 'high' } as never } : {} });
/** 期望的先后：main → 聊天记录之后（按 AFTER_HISTORY_SLOTS）→「此刻」块（按 NOW_SLOTS） */
const EXPECTED = [
    ['main', 'relationship', 'beta'], ['history', 'recalled', 'alpha'], ['history', 'people', 'alpha'], ['history', 'people', 'gamma'],
    ['now', 'time', 'beta'], ['now', 'state', 'alpha'], ['now', 'length', 'beta'], ['now', 'inner', 'gamma'],
];

describe('段落带模块（contributeTurn）和真正放进去的段落（placedPieces）', () => {
    for (const async of [false, true]) {
        test(`${async ? '异步' : '同步'}：每段标上产出它的模块；交出来的先后和 assemblePrompt 一样；拼出来的字不变（模块名不进提示词）`, async () => {
            let placed: PlacedPiece[] | undefined;
            const ran = contributeTurn(modules(async), turnOf(), list => { placed = list; });
            assert.equal(ran instanceof Promise, async, '同步的照旧同步返回');
            const assembled = ran instanceof Promise ? await ran : ran;
            assert.deepEqual(placed!.map(({ list, piece }) => [list, piece.slot, piece.module]), EXPECTED);
            assert.deepEqual(assembled, assemblePrompt([...ALPHA, ...BETA, ...GAMMA]), '标了模块，拼出来的还是原来那份');
            for (const { piece } of placed!) assert.ok(!assembled.afterMain.concat(assembled.afterHistory).some(text => text.includes(piece.module!)), '模块名不进提示词');
        });
    }

    test('不给 onPlaced 时照旧（返回值只有 afterMain / afterHistory）', () => {
        assert.deepEqual(Object.keys(contributeTurn(modules(), turnOf()) as object).sort(), ['afterHistory', 'afterMain']);
    });

    test('少规矩开着：RULE_SLOTS 的段不在提示词里，也不在清单里；危机回合照放、清单也有', () => {
        useFewerRules(true);
        let placed: PlacedPiece[] = [];
        contributeTurn(modules(), turnOf(), list => { placed = list; });
        assert.ok(!placed.some(({ piece }) => piece.slot === 'length'));
        contributeTurn(modules(), turnOf(true), list => { placed = list; });
        assert.ok(placed.some(({ piece }) => piece.slot === 'length'));
        assert.deepEqual(placedPieces([...ALPHA, ...BETA], { crisis: false }).map(({ piece }) => piece.slot), ['relationship', 'recalled', 'people', 'time', 'state']);
    });
});

describe('算清单（promptManifest）', () => {
    const placed = (): PlacedPiece[] => {
        let out: PlacedPiece[] = [];
        contributeTurn(modules(), turnOf(), list => { out = list; });
        return out;
    };
    const messages: OpenAIMessage[] = [{ role: 'system', content: '合成的卡' }, { role: 'user', content: '在吗在吗' }, { role: 'system', content: '[现在是晚上九点零三分]\n[你现在：在宿舍看书]' }];

    test('每段：槽、模块、表、字数、正文的 sha256；最终消息：条数、每条的、整份的；时刻是 ISO', () => {
        const manifest = promptManifest({ qq: 10001, at: new Date('2026-11-22T21:03:00+08:00'), kind: 'reply', placed: placed(), messages });
        assert.equal(manifest.v, MANIFEST_VERSION);
        assert.equal(MANIFEST_VERSION, 2);
        assert.equal(manifest.qq, 10001);
        assert.equal(manifest.at, '2026-11-22T13:03:00.000Z');
        assert.equal(manifest.kind, 'reply');
        const texts = new Map([...ALPHA, ...BETA, ...GAMMA].map(piece => [piece.text, piece]));
        const byHash = new Map([...texts.keys()].map(text => [hash(text), text]));
        assert.deepEqual(manifest.pieces.map(piece => [piece.list, piece.slot, piece.module]), EXPECTED);
        for (const piece of manifest.pieces) {
            const text = byHash.get(piece.sha256);
            assert.ok(text, `${piece.slot} 的哈希不是哪一段正文的`);
            assert.equal(texts.get(text)!.slot, piece.slot);
            assert.equal(piece.chars, text.length);
            assert.equal(piece.omitted, undefined);
        }
        assert.deepEqual(manifest.messages.list, messages.map(m => ({ role: m.role, chars: m.content.length, sha256: hash(m.content) })));
        assert.equal(manifest.messages.count, 3);
        assert.equal(manifest.chars, messages.reduce((sum, m) => sum + m.content.length, 0));
        assert.equal(manifest.messages.sha256, hash(JSON.stringify(messages.map(m => [m.role, m.content]))));
        assert.equal(manifest.fallback, undefined);
    });

    test('没有正文：清单里找不到任何一段、任何一条消息的字', () => {
        const json = JSON.stringify(promptManifest({ qq: 10001, at: new Date(0), kind: 'reply', placed: placed(), messages }));
        for (const text of [...ALPHA, ...BETA, ...GAMMA].map(piece => piece.text).concat(messages.map(m => m.content))) {
            assert.ok(!json.includes(text), `清单里有正文：${text}`);
            // 去掉括号的那几个字也不在
            assert.ok(!json.includes(text.replace(/^\[|\]$/g, '').slice(-6)), `清单里有正文片段：${text}`);
        }
    });

    test('预算挤掉的：从「聊天记录之后」最前面数 omittedAfterHistory 段标 omitted；连「此刻」块都挤掉时它的每一行都标', () => {
        const one = promptManifest({ qq: 1, at: new Date(0), kind: 'reply', placed: placed(), messages, omittedAfterHistory: 1 });
        assert.deepEqual(one.pieces.filter(piece => piece.omitted).map(piece => [piece.slot, piece.module]), [['recalled', 'alpha']]);
        assert.equal(one.omittedAfterHistory, 1);
        const all = promptManifest({ qq: 1, at: new Date(0), kind: 'reply', placed: placed(), messages, omittedAfterHistory: 4 });
        assert.deepEqual(all.pieces.filter(piece => !piece.omitted).map(piece => piece.slot), ['relationship'], 'main 的不会被挤掉');
    });
});

describe('联系人流水线：每次生成交一份清单', () => {
    const NOW = Date.parse('2026-11-22T21:03:00+08:00');
    const run = async (withManifest: boolean, extra: Module[] = []) => {
        const rows: StoredMessage[] = [];
        const prompts: OpenAIMessage[][] = [];
        /** 每次真调模型时的消息（挑候选、审稿重写都在这里） */
        const calls: OpenAIMessage[][] = [];
        const manifests: PromptManifest[] = [];
        // 记下每个模块这一轮真给了什么（清单里的哈希要对得上它们）
        const given: { module: string; piece: Piece }[] = [];
        const spied = [...modules(), ...extra].map(module => (module.contribute ? { ...module, contribute: (turn: Turn) => {
            const list = module.contribute!(turn) as readonly Piece[];
            given.push(...list.map(piece => ({ module: module.id, piece })));
            return list;
        } } : module));
        const responder = createContactResponder({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend', knowsBot: true },
            card: loadTierCard(syntheticCardPattern, 'boyfriend'),
            llm: { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' },
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            turnModules: spied,
            send: async () => 101,
            generate: async messages => { calls.push(messages); return '在呢'; },
            onPrompt: prompt => { prompts.push(prompt.messages); },
            ...(withManifest ? { onManifest: (manifest: PromptManifest) => { manifests.push(manifest); } } : {}),
        });
        try { responder.receive('在吗', 1, new Date(NOW)); await responder.whenIdle(); }
        finally { responder.stop(); }
        return { prompts, manifests, given, rows, calls };
    };

    test('一次回复一份：联系人、时刻、回他；每段的槽 / 模块 / 哈希对得上模块真给的；最终消息的哈希对得上 onPrompt 拿到的那份', async () => {
        const { prompts, manifests, given } = await run(true);
        assert.equal(prompts.length, 1);
        assert.equal(manifests.length, 1);
        const [manifest] = manifests as [PromptManifest];
        assert.equal(manifest.qq, 10001);
        assert.equal(manifest.at, new Date(NOW).toISOString());
        assert.equal(manifest.kind, 'reply');
        // 模块真给的，按放进提示词的先后（同 EXPECTED）：槽、模块、sha256 一一对上
        const expected = EXPECTED.map(([list, slot, module]) => {
            const text = given.find(item => item.module === module && item.piece.slot === slot)!.piece.text;
            return { list, slot, module, chars: text.length, sha256: hash(text) };
        });
        assert.deepEqual(manifest.pieces, expected);
        // 段落真在这份提示词里（不是另拼一份）
        const all = prompts[0]!.map(m => m.content).join('\n');
        for (const { piece } of given) assert.ok(all.includes(piece.text), piece.text);
        assert.deepEqual(manifest.messages.list, prompts[0]!.map(m => ({ role: m.role, chars: m.content.length, sha256: hash(m.content) })));
        assert.equal(manifest.messages.count, prompts[0]!.length);
        const json = JSON.stringify(manifest);
        for (const content of prompts[0]!.map(m => m.content)) assert.ok(!json.includes(content), '清单里没有消息正文');
        assert.ok(!json.includes('在吗'), '清单里没有他的话');
    });

    test('给不给清单，提示词和回复都一样（不改她的言行）', async () => {
        const off = await run(false);
        const on = await run(true);
        assert.deepEqual(on.prompts, off.prompts);
        assert.deepEqual(on.rows.map(row => [row.role, row.content]), off.rows.map(row => [row.role, row.content]));
        assert.equal(off.manifests.length, 0);
    });

    // 挑候选（ADR 0041）：同一份提示词生成三个、挑第二个；审稿在 pull 那一步要一次重写（末尾加一条说明）并采用
    const NOTE = '[合成的重写说明：再短一点，别用感叹号]';
    const pickAndRewrite = (): Module[] => [
        { id: 'pick', candidates: () => ({ count: 3, choose: () => 1 }) },
        { id: 'rewriter', reviewAt: { pull: async (_text, _turn, ctx) => { const again = await ctx.regenerate(NOTE); ctx.accept(); return again; } } },
    ];

    test('挑候选一行 candidate、审稿重写一行 review：没有段落，只有真发给模型的那份消息的条数 / 字数 / sha256', async () => {
        const { manifests, calls, prompts } = await run(true, pickAndRewrite());
        assert.deepEqual(manifests.map(m => m.kind), ['reply', 'candidate', 'review']);
        assert.equal(calls.length, 4, '三个候选 + 一次重写');
        const [reply, candidate, review] = manifests as [PromptManifest, PromptManifest, PromptManifest];
        // 挑候选：同一份消息（整份哈希和回他那行一样）、生成了几个；时刻是这一轮的
        assert.deepEqual(candidate.pieces, []);
        assert.equal(candidate.calls, 3);
        assert.equal(candidate.at, reply.at);
        assert.equal(candidate.messages.sha256, reply.messages.sha256);
        assert.deepEqual(candidate.messages.list, calls[0]!.map(m => ({ role: m.role, chars: m.content.length, sha256: hash(m.content) })));
        // 审稿重写：哪一步要的、真发出去的那份（多了末尾那条说明）
        assert.deepEqual(review.pieces, []);
        assert.equal(review.stage, 'pull');
        assert.equal(review.at, reply.at);
        assert.deepEqual(review.messages.list, calls[3]!.map(m => ({ role: m.role, chars: m.content.length, sha256: hash(m.content) })));
        assert.equal(review.messages.count, prompts[0]!.length + 1);
        assert.equal(review.messages.list.at(-1)!.sha256, hash(NOTE));
        assert.equal(review.chars, calls[3]!.reduce((sum, m) => sum + m.content.length, 0));
        for (const m of [reply, candidate]) assert.equal(m.stage, undefined);
        // 没有正文
        const json = JSON.stringify(manifests);
        for (const content of calls.flat().map(m => m.content)) assert.ok(!json.includes(content), '清单里没有消息正文');
        for (const secret of ['在吗', '再短一点', '感叹号']) assert.ok(!json.includes(secret), secret);
    });

    test('挑候选、审稿重写时给不给清单，提示词、每次调模型的消息、发出去的都一样', async () => {
        const off = await run(false, pickAndRewrite());
        const on = await run(true, pickAndRewrite());
        assert.deepEqual(on.prompts, off.prompts);
        assert.deepEqual(on.calls, off.calls);
        assert.deepEqual(on.rows.map(row => [row.role, row.content]), off.rows.map(row => [row.role, row.content]));
    });
});

describe('群里开口：每次交一份（kind group）', () => {
    const card = loadTierCard(syntheticCardPattern, 'classmate-open');
    const AT = Date.parse('2026-11-20T16:00:00+08:00');
    async function speak(withManifest: boolean) {
        const dataDir = tmp();
        const calls: OpenAIMessage[][] = [];
        const sent: string[] = [];
        const manifests: PromptManifest[] = [];
        const config = {
            dataDir, schedule: false, herDays: false, herFeelings: false, pokeOut: false, profileLikes: false,
            groupChat: 'on', groupOwn: 'off', groups: [{ id: 555, name: '合成宿舍群' }], contacts: [], llm: { temperature: 1 },
        } as unknown as AppConfig;
        const deps = {
            config, log: () => {}, worldNow: () => AT, reading: undefined, dormancy: undefined,
            exec: { files: realFiles, llm: async (request: { messages: OpenAIMessage[] }) => { calls.push(request.messages); return '在上课呢'; } },
            transport: { sendGroupText: async (_g: number, text: string) => { sent.push(text); return 9000 + sent.length; } },
            cardFor: () => card, sendOwnedNotice: async () => {}, sing: async () => ({}), repoRoot: dataDir,
            groupsOn: true, groupLogs: groupLog(dataDir), groupPeopleBook: undefined, groupFeel: undefined, groupSongRequests: new Map(), songRequestLifetime: 0,
            stopped: () => false, selfId: () => 20000, lastFeelings: () => undefined, plainTextOf: () => undefined, singBusyLine: () => '',
            ...(withManifest ? { promptManifest: (m: PromptManifest) => { manifests.push(m); } } : {}),
        } as unknown as GroupRoomDeps;
        groupRoom(deps).receive({
            post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 20000, user_id: 30001, group_id: 555, message_id: 7777,
            time: Math.floor(AT / 1000), message: [{ type: 'at', data: { qq: '20000' } }, { type: 'text', data: { text: ' 你在干嘛呀合成问题' } }], raw_message: '',
            sender: { user_id: 30001, card: '老王', nickname: '老王' },
        } as never);
        const deadline = Date.now() + 5000;
        while (!sent.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        return { calls, sent, manifests };
    }

    test('群号、为什么开口、真发给模型的消息（条数 / 字数 / sha256），没有段落、没有正文', async () => {
        const { calls, manifests } = await speak(true);
        assert.equal(calls.length, 1);
        assert.equal(manifests.length, 1);
        const [m] = manifests as [PromptManifest];
        assert.equal(m.kind, 'group');
        assert.equal(m.qq, 555);
        assert.equal(m.reason, 'mentioned');
        assert.equal(m.at, new Date(AT).toISOString());
        assert.deepEqual(m.pieces, []);
        assert.deepEqual(m.messages.list, calls[0]!.map(x => ({ role: x.role, chars: x.content.length, sha256: hash(x.content) })));
        const json = JSON.stringify(m);
        for (const content of calls[0]!.map(x => x.content)) assert.ok(!json.includes(content));
        for (const secret of ['合成问题', '老王', '合成宿舍群', card.character.name]) assert.ok(!json.includes(secret), secret);
    });

    test('给不给清单，群里的提示词和发出去的一样', async () => {
        const off = await speak(false);
        const on = await speak(true);
        assert.deepEqual(on.calls, off.calls);
        assert.deepEqual(on.sent, off.sent);
        assert.equal(off.manifests.length, 0);
    });
});

describe('按天写（createPromptManifestLog）', () => {
    const entry = (qq: number): PromptManifest => promptManifest({ qq, at: new Date(0), kind: 'reply', placed: [], messages: [] });

    test('一次一行、按本地日期分文件；过了零点写进新的一天', () => {
        const dir = tmp();
        let now = new Date(2026, 10, 22, 23, 59);
        const write = createPromptManifestLog(dir, { now: () => now });
        write(entry(1));
        write(entry(2));
        now = new Date(2026, 10, 23, 0, 1);
        write(entry(3));
        const read = (day: string) => readFileSync(join(dir, manifestFileName(day)), 'utf8').trim().split('\n').map(line => (JSON.parse(line) as PromptManifest).qq);
        assert.deepEqual(read('2026-11-22'), [1, 2]);
        assert.deepEqual(read('2026-11-23'), [3]);
    });

    test(`保留 ${MANIFEST_KEEP_DAYS} 天（含今天）：每天第一次写时删更早的清单；别的文件（按天日志）不碰`, () => {
        const dir = tmp();
        for (const name of [manifestFileName('2026-11-08'), manifestFileName('2026-11-09'), manifestFileName('2026-11-10'), '2026-11-01.log', 'prompt-manifest-note.txt']) writeFileSync(join(dir, name), 'x\n');
        let now = new Date(2026, 10, 22, 8);
        const write = createPromptManifestLog(dir, { now: () => now });
        write(entry(1));
        assert.deepEqual(readdirSync(dir).sort(), ['2026-11-01.log', manifestFileName('2026-11-09'), manifestFileName('2026-11-10'), manifestFileName('2026-11-22'), 'prompt-manifest-note.txt']);
        // 同一天再写不再扫；第二天第一次写再删一天
        now = new Date(2026, 10, 23, 8);
        write(entry(2));
        assert.ok(!existsSync(join(dir, manifestFileName('2026-11-09'))));
        assert.ok(existsSync(join(dir, manifestFileName('2026-11-10'))));
        assert.deepEqual(expiredManifests([manifestFileName('2026-11-09'), manifestFileName('2026-11-10'), 'x.log'], new Date(2026, 10, 23), 14), [manifestFileName('2026-11-09')]);
    });

    test('写不进去只记一句、不抛；又能写了记一句', () => {
        const dir = tmp();
        const blocked = join(dir, 'logs');
        writeFileSync(blocked, '这是个文件，不是目录');
        const logs: string[] = [];
        const write = createPromptManifestLog(blocked, { log: line => logs.push(line) });
        write(entry(1));
        write(entry(2));
        assert.equal(logs.length, 1);
        assert.match(logs[0]!, /提示词指纹清单：没写进去.*不影响回复/);
        rmSync(blocked);
        write(entry(3));
        assert.equal(logs.at(-1), '提示词指纹清单：又能写了');
    });
});

describe('私人文件（哈希也算私人的：短行能穷举）', () => {
    test('清单文件名在私人名单里（迁移 / 存档不带）；名字不像的不算', () => {
        assert.equal(isPrivateFile(manifestFileName('2026-11-22')), true);
        assert.equal(isPrivateFile('prompt-manifest.jsonl'), false);
        assert.equal(isPrivateFile('2026-11-22.log'), false);
    });
});

describe('scripts/prompt-manifest-diff.mjs：SELF.json 逐行比清单的哈希', () => {
    const SELF_SLOTS = ['state', 'feeling', 'inner'];
    const writeManifests = (dir: string, entries: object[], day = '2026-11-22') => writeFileSync(join(dir, manifestFileName(day)), `${entries.map(e => JSON.stringify(e)).join('\n')}\n坏的一行\n`);
    const piece = (slot: string, text: string, module = 'her-now') => ({ slot, module, list: 'now', chars: text.length, sha256: hash(text) });

    test('取最近一份（给了 QQ 只看他的；只认回他 / 主动，想一想、审稿重写、挑候选、群里的不算）；按槽比：一致 / 不一致 / 只在 SELF / 只在提示词；只输出槽名和状态，不输出正文', () => {
        const dir = tmp();
        writeManifests(dir, [{ v: 1, qq: 10001, at: 'old', kind: 'reply', pieces: [] }], '2026-11-21');
        writeManifests(dir, [
            { v: 1, qq: 10001, at: '2026-11-22T13:00:00.000Z', kind: 'reply', pieces: [piece('time', '[九点]', 'time-block'), piece('state', '[你现在：在宿舍]'), piece('feeling', '[心境：有点闷]', 'feelings'), piece('inner', '[想吃火锅]', 'inner')] },
            { v: 1, qq: 10002, at: '2026-11-22T13:01:00.000Z', kind: 'reply', pieces: [] },
            { v: 1, qq: 10001, at: '2026-11-22T13:02:00.000Z', kind: 'think', pieces: [] },
            // v2 的几种没有「此刻」块的段落，也不算
            { v: 2, qq: 10001, at: '2026-11-22T13:03:00.000Z', kind: 'review', stage: 'shape', pieces: [] },
            { v: 2, qq: 10001, at: '2026-11-22T13:03:00.000Z', kind: 'candidate', calls: 3, pieces: [] },
            { v: 2, qq: 10001, at: '2026-11-22T13:04:00.000Z', kind: 'group', reason: 'mentioned', pieces: [] },
        ]);
        const manifest = latestManifest(dir, { qq: 10001 });
        assert.equal(manifest?.at, '2026-11-22T13:00:00.000Z');
        assert.equal(latestManifest(dir)?.qq, 10002);
        assert.equal(latestManifest(join(dir, 'nope')), undefined);
        const self = { at: '2026-11-22T13:03:00.000Z', lines: [{ slot: 'state', text: '[你现在：在宿舍]' }, { slot: 'feeling', text: '[心境：还行]' }, { slot: 'dreams', text: '[昨晚梦见考试]' }] };
        const result = compareSelf(self, manifest, SELF_SLOTS);
        assert.deepEqual(result.rows.map((row: { slot: string; status: string }) => [row.slot, row.status]), [['state', 'match'], ['feeling', 'mismatch'], ['inner', 'only-prompt'], ['dreams', 'only-self']]);
        const text = describeDiff(result);
        assert.match(text, /一致.*state（her-now）/);
        assert.match(text, /不一致.*feeling（feelings）/);
        assert.match(text, /只在提示词.*inner/);
        assert.match(text, /只在 SELF.*dreams/);
        assert.match(text, /合计：一致 1，不一致 1，只在 SELF 1，只在提示词 1/);
        for (const secret of ['宿舍', '心境', '还行', '火锅', '考试', '有点闷']) assert.ok(!text.includes(secret), `输出了正文：${secret}`);
    });

    test('被预算挤掉的单独标出来；同一个槽有几段时按先后逐段比', () => {
        const manifest = { qq: 1, at: 'x', kind: 'reply', pieces: [{ ...piece('state', 'A'), omitted: true }, piece('inner', 'B'), piece('inner', 'C')] };
        const result = compareSelf({ lines: [{ slot: 'state', text: 'A' }, { slot: 'inner', text: 'B' }, { slot: 'inner', text: 'X' }] }, manifest, SELF_SLOTS);
        assert.deepEqual(result.rows.map((row: { slot: string; index: number; status: string }) => [row.slot, row.index, row.status]), [['state', 0, 'omitted'], ['inner', 0, 'match'], ['inner', 1, 'mismatch']]);
        assert.match(describeDiff(result), /inner #2/);
    });
});
