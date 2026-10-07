import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import { EPISODE_GAP_MS, episodeTranscript, localIso, splitEpisodes } from '../src/memory/episodes.ts';
import { HindsightClient, mentalModelUpdateBody, retainBody, type HindsightApi, type MemoryItem, type MentalModel, type RecallRequest, type RecallResult } from '../src/memory/hindsight.ts';
import {
    bankMissions, commonBankMissions, formatRecalled, initiateQuery, LongTermMemory, MAX_QUERY_CHARS, MAX_RECALLED, OPEN_EPISODE_STEP, recallQuery,
    RELATIONSHIP_MODEL, SHARED_RECALLED, TODAY_OTHERS, DAY_RECALL_TOKENS, RECALL_TOKENS, secondPerson,
} from '../src/memory/long-term.ts';

const names = { user: '阿明', char: '林梦瑶' };
const A = { qq: 1, tier: 'boyfriend' };
const MIN = 60_000;
const T0 = new Date('2026-10-01T20:00:00').getTime();
const msg = (minute: number, role: 'user' | 'assistant', content: string, messageId = minute): StoredMessage =>
    ({ time: new Date(T0 + minute * MIN).toISOString(), role, content, messageId });

// ---------- 对照 hindsight-api 0.10.2 的 OpenAPI 核对请求体 ----------

type Schema = { $ref?: string; anyOf?: Schema[]; type?: string; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; additionalProperties?: unknown };
const openapi = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/hindsight-openapi-0.10.2.json'), 'utf8')) as {
    roots: Record<'bank' | 'retain' | 'recall' | 'mentalModel' | 'mentalModelUpdate', string>;
    schemas: Record<string, Schema>;
};

/** 请求体里每个字段都要是 schema 里有的，必填的不能少，枚举值要合法，类型要对；返回不符合的地方 */
function check(value: unknown, schema: Schema, path = '$'): string[] {
    if (schema.$ref) return check(value, openapi.schemas[schema.$ref.split('/').pop()!]!, path);
    if (schema.anyOf) {
        const errors = schema.anyOf.map(s => check(value, s, path));
        return errors.some(e => e.length === 0) ? [] : errors[0]!;
    }
    if (schema.enum && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} 不在 ${JSON.stringify(schema.enum)} 里`];
    switch (schema.type) {
        case 'null': return value === null ? [] : [`${path}: 应为 null`];
        case 'string': return typeof value === 'string' ? [] : [`${path}: 应为字符串`];
        case 'integer': return Number.isInteger(value) ? [] : [`${path}: 应为整数`];
        case 'number': return typeof value === 'number' ? [] : [`${path}: 应为数字`];
        case 'boolean': return typeof value === 'boolean' ? [] : [`${path}: 应为布尔`];
        case 'array':
            if (!Array.isArray(value)) return [`${path}: 应为数组`];
            return value.flatMap((v, i) => (schema.items ? check(v, schema.items, `${path}[${i}]`) : []));
    }
    if (schema.properties) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: 应为对象`];
        const obj = value as Record<string, unknown>;
        const unknown = Object.keys(obj).filter(k => !(k in schema.properties!)).map(k => `${path}.${k}: schema 里没有这个字段`);
        const missing = (schema.required ?? []).filter(k => !(k in obj)).map(k => `${path}.${k}: 缺少必填字段`);
        const nested = Object.entries(obj).flatMap(([k, v]) => (schema.properties![k] ? check(v, schema.properties![k]!, `${path}.${k}`) : []));
        return [...unknown, ...missing, ...nested];
    }
    return [];
}
const root = (name: keyof typeof openapi.roots): Schema => ({ $ref: `#/components/schemas/${openapi.roots[name]}` });

/** 假的 Hindsight：记下请求，可以让某次调用失败 */
function fakeApi(options: { failRetain?: number; recall?: RecallResult[] | Error; mentalModel?: MentalModel } = {}) {
    const calls = { banks: [] as string[], putBank: [] as unknown[], retain: [] as MemoryItem[], recall: [] as RecallRequest[], createMentalModel: [] as unknown[], updateMentalModel: [] as unknown[], refreshMentalModel: 0, getMentalModel: 0 };
    let retains = 0;
    const api: HindsightApi = {
        putBank: async (_bank, config) => { calls.putBank.push(config); },
        retain: async (bank, item) => {
            calls.banks.push(`retain ${bank}`);
            retains++;
            if (retains === options.failRetain) throw new Error('Hindsight 返回 500');
            calls.retain.push(item);
        },
        recall: async (bank, request) => {
            calls.banks.push(`recall ${bank}`);
            calls.recall.push(request);
            if (options.recall instanceof Error) throw options.recall;
            return options.recall ?? [];
        },
        getMentalModel: async () => { calls.getMentalModel++; return options.mentalModel; },
        createMentalModel: async (_bank, request) => { calls.createMentalModel.push(request); },
        updateMentalModel: async (_bank, _id, request) => { calls.updateMentalModel.push(request); },
        refreshMentalModel: async () => { calls.refreshMentalModel++; return 'op-1'; },
    };
    return { api, calls };
}

function setup(options: Parameters<typeof fakeApi>[0] = {}, now = T0 + 24 * 60 * MIN) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
    const logs: string[] = [];
    const { api, calls } = fakeApi(options);
    let clock = now;
    const memory = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: m => logs.push(m), now: () => clock });
    return { memory, calls, logs, dir, setNow: (t: number) => { clock = t; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('长期记忆：请求体对照 Hindsight 0.10.2 的 OpenAPI', () => {
    test('建库（mission 与 disposition）', () => {
        assert.deepEqual(check({ name: '林梦瑶 × 阿明', ...bankMissions(names) }, root('bank')), []);
    });

    test('写入：一个片段一项，异步处理；字段名放错层级会被查出来', () => {
        const item: MemoryItem = {
            content: '阿明 (2026-10-01T20:00:00+08:00): 在吗', timestamp: '2026-10-01T12:00:00.000Z', context: 'QQ 私聊',
            document_id: 'ep-1', tags: ['qq-private'], metadata: { source: 'qq' },
        };
        assert.deepEqual(check(retainBody(item), root('retain')), []);
        // 探索分支的写法：retain_async、tags 放在顶层
        assert.notDeepEqual(check({ items: [item], retain_async: true, tags: ['x'] }, root('retain')), []);
    });

    test('召回（含主动找他时的时间窗）', async () => {
        const { memory, calls, cleanup } = setup();
        try {
            await memory.sync(A, names, [msg(0, 'user', '我明天下午面试')]);
            await memory.recall(A, [{ role: 'user', content: '过了！', time: new Date().toISOString() }], new Date());
            await memory.recall(A, [], new Date(T0), { query: '阿明最近在忙什么', window: { start: new Date(T0 - 3 * 86_400_000), end: new Date(T0 + 2 * 86_400_000) } });
            assert.equal(calls.recall.length, 2);
            assert.deepEqual(check(calls.recall[0], root('recall')), []);
            assert.deepEqual(check(calls.recall[1], root('recall')), []);
            assert.equal(calls.recall[0]!.temporal_window, undefined);
            assert.deepEqual(calls.recall[1]!.temporal_window, { start: localIso(new Date(T0 - 3 * 86_400_000)), end: localIso(new Date(T0 + 2 * 86_400_000)) });
            // 带本机时区（ADR 0012 决策 1 第 2 条）
            assert.equal(calls.recall[1]!.query_timestamp, localIso(new Date(T0)));
        } finally {
            cleanup();
        }
    });

    test('关系概况（Mental Model）：新建和改设定', () => {
        assert.deepEqual(check(RELATIONSHIP_MODEL, root('mentalModel')), []);
        assert.deepEqual(check(mentalModelUpdateBody(RELATIONSHIP_MODEL), root('mentalModelUpdate')), []);
        // 改设定的请求体里没有 id 这个字段
        assert.notDeepEqual(check(RELATIONSHIP_MODEL, root('mentalModelUpdate')), []);
    });
});

describe('长期记忆：片段', () => {
    test('隔 45 分钟以上切成新片段；片段 id 由第一条的时间决定', () => {
        const history = [msg(0, 'user', 'a'), msg(10, 'assistant', 'b'), msg(54, 'user', 'c'), msg(100, 'user', 'd')];
        const episodes = splitEpisodes(history);
        assert.deepEqual(episodes.map(e => e.messages.map(m => m.content).join('')), ['abc', 'd']);
        assert.equal(episodes[0]!.id, `ep-${T0}`);
        assert.equal(100 * MIN - 54 * MIN >= EPISODE_GAP_MS, true);
    });

    test('原文：开头和换天时一行日期，每行「名字 (HH:MM): 内容」，消息里的换行换成「／」，不带 QQ 消息 id（ADR 0012）', () => {
        // T0 是 10-01 20:00（本地），片段跨过午夜
        const [episode] = splitEpisodes([
            msg(0, 'user', '我明天下午面试', 101), msg(1, 'assistant', '好呀\n 等你消息', 102), msg(40, 'user', '紧张'), msg(80, 'user', '睡不着', 103),
            msg(120, 'assistant', '快睡'), msg(160, 'user', '嗯'), msg(200, 'user', '十二点了', 104), msg(240, 'assistant', '睡吧'),
        ]);
        const lines = episodeTranscript(episode!, names).split('\n');
        assert.deepEqual(lines.slice(0, 3), ['—— 2026年10月1日 星期四 ——', '阿明 (20:00): 我明天下午面试', '林梦瑶 (20:01): 好呀／等你消息']);
        assert.deepEqual(lines.slice(-3), ['阿明 (23:20): 十二点了', '—— 2026年10月2日 星期五 ——', '林梦瑶 (00:00): 睡吧']);
        assert.ok(!lines.join('\n').includes('message_id'));
    });
});

describe('长期记忆：写入', () => {
    test('结束了的片段写入，进行中的片段攒够条数才写；建库和关系概况只做一次', async () => {
        const history = [msg(0, 'user', '在吗'), msg(1, 'assistant', '在'), msg(120, 'user', '刚下课')];
        const { memory, calls, logs, cleanup } = setup({}, T0 + 125 * MIN);
        try {
            await memory.sync(A, names, history);
            assert.deepEqual(calls.retain.map(r => r.document_id), [`ep-${T0}`], '第二段还在进行，只有 1 条，不写');
            assert.equal(calls.putBank.length, 1);
            assert.equal(calls.createMentalModel.length, 1);
            assert.ok(logs.some(l => l.includes('已提交')));

            await memory.sync(A, names, history);
            assert.equal(calls.retain.length, 1, '没有变化就不重复写');
            assert.equal(calls.putBank.length, 1);

            const busy = [...history, ...Array.from({ length: OPEN_EPISODE_STEP }, (_, i) => msg(121 + i / 10, 'user', `第${i}条`, 1000 + i))];
            await memory.sync(A, names, busy);
            assert.equal(calls.retain.at(-1)!.document_id, `ep-${T0 + 120 * MIN}`, '进行中的片段攒够条数，整段写一次');
            assert.equal(calls.retain.at(-1)!.metadata.messages, String(OPEN_EPISODE_STEP + 1));
        } finally {
            cleanup();
        }
    });

    test('关系概况的设定改了：已有的那个改设定、刷新一次，之后不再重复', async () => {
        const { memory, calls, logs, dir, cleanup } = setup({ mentalModel: { id: 'relationship', content: '旧的长报告' } });
        try {
            // 旧版本的状态文件：relationshipModel 是 true
            writeFileSync(join(dir, '1-boyfriend.json'), JSON.stringify({ bankId: memory.bankId(A), bankConfigured: 'x', relationshipModel: true, retained: {} }));
            await memory.sync(A, names, [msg(0, 'user', '在吗')]);
            assert.equal(calls.createMentalModel.length, 0, '已经有了，不再新建');
            assert.deepEqual(calls.updateMentalModel, [RELATIONSHIP_MODEL]);
            assert.equal(calls.refreshMentalModel, 1);
            assert.ok(logs.some(l => l.includes('关系概况的设定改了')));

            await memory.sync(A, names, [msg(0, 'user', '在吗'), msg(1, 'user', '人呢')]);
            assert.equal(calls.updateMentalModel.length, 1, '版本记下了，不再改');
            assert.equal(calls.refreshMentalModel, 1);
        } finally {
            cleanup();
        }
    });

    test('写入失败记日志、不打成功日志，下次再写；状态存在文件里', async () => {
        const history = [msg(0, 'user', '在吗'), msg(100, 'user', '人呢')];
        const { memory, calls, logs, dir, cleanup } = setup({ failRetain: 2 });
        try {
            await memory.sync(A, names, history);
            assert.equal(calls.retain.length, 1);
            assert.ok(logs.some(l => l.includes('记忆写入失败：Hindsight 返回 500')));
            assert.equal(logs.filter(l => l.includes('已提交')).length, 1);

            await memory.sync(A, names, history);
            assert.deepEqual(calls.retain.map(r => r.document_id), [`ep-${T0}`, `ep-${T0 + 100 * MIN}`]);
            const state = JSON.parse(readFileSync(join(dir, '1-boyfriend.json'), 'utf8'));
            assert.equal(state.bankId, memory.bankId(A));
            assert.deepEqual(state.retained, { [`ep-${T0}`]: 1, [`ep-${T0 + 100 * MIN}`]: 1 });
        } finally {
            cleanup();
        }
    });

    test('换档位用另一个 bank 和状态文件：降档后不召回、不接着用原档位的写入进度', async () => {
        const { memory, calls, dir, cleanup } = setup({ recall: [{ id: '1', text: '男朋友档时的事', document_id: 'ep-old' }] });
        try {
            const classmate = { qq: 1, tier: 'classmate' };
            assert.notEqual(memory.bankId(A), memory.bankId(classmate));
            const history = [msg(0, 'user', '在吗')];
            const chat = [{ role: 'user' as const, content: '还记得吗', time: new Date().toISOString() }];
            await memory.sync(A, names, history);
            assert.match((await memory.recall(A, chat, new Date()))!, /男朋友档时的事/);

            assert.equal(await memory.recall(classmate, chat, new Date()), undefined, '同学档的 bank 还没写过，不查');
            assert.equal(memory.relationship(classmate), undefined);
            await memory.sync(classmate, names, history);
            await memory.recall(classmate, chat, new Date());
            assert.deepEqual(calls.banks, [
                `retain ${memory.bankId(A)}`, `recall ${memory.bankId(A)}`,
                `retain ${memory.bankId(classmate)}`, `recall ${memory.bankId(classmate)}`,
            ]);
            assert.match((calls.putBank[1] as { name: string }).name, /（classmate）$/);
            assert.ok(existsSync(join(dir, '1-boyfriend.json')) && existsSync(join(dir, '1-classmate.json')));
        } finally {
            cleanup();
        }
    });

    test('写入：context 只一句、时间带本机时区；mission 写着名字和抽取规则（ADR 0012）', async () => {
        const { memory, calls, cleanup } = setup();
        try {
            await memory.sync(A, names, [msg(0, 'user', '在吗')]);
            assert.equal(calls.retain[0]!.context, 'QQ 私聊：林梦瑶（AI 扮演）和阿明');
            assert.equal(calls.retain[0]!.timestamp, localIso(new Date(T0)));
            const mission = (calls.putBank[0] as { retain_mission: string }).retain_mission;
            for (const rule of ['林梦瑶是 AI 扮演的虚拟角色', '不能记成阿明的事', '写成绝对日期', '铁锅（阿明的组长）', '否定', '不写「用户」', '开头加「【重要】」', '开头加「【长期】」']) {
                assert.ok(mission.includes(rule), rule);
            }
        } finally {
            cleanup();
        }
    });

    test('换了 bank 前缀：进度文件是旧 bank 的，新 bank 重新写 mission 和全部片段', async () => {
        const { memory, calls, dir, cleanup } = setup();
        try {
            const history = [msg(0, 'user', '在吗'), msg(100, 'user', '人呢')];
            await memory.sync(A, names, history);
            const { api, calls: next } = fakeApi();
            const fresh = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao-1006', recallTimeoutMs: 3000, log: () => {}, now: () => T0 + 24 * 60 * MIN });
            assert.notEqual(fresh.bankId(A), memory.bankId(A));
            await fresh.sync(A, names, history);
            assert.equal(next.putBank.length, 1, '新 bank 写 mission');
            assert.equal(next.retain.length, 2, '两个片段都重新写');
            assert.equal(calls.retain.length, 2);
            assert.equal(JSON.parse(readFileSync(join(dir, '1-boyfriend.json'), 'utf8')).bankId, fresh.bankId(A));
        } finally {
            cleanup();
        }
    });

    test('同一联系人的写入串行；bank ID 不含 QQ 号', async () => {
        const { memory, calls, cleanup } = setup();
        try {
            const big = { qq: 123456789, tier: 'boyfriend' };
            const history = [msg(0, 'user', '在吗')];
            await Promise.all([memory.sync(big, names, history), memory.sync(big, names, history)]);
            assert.equal(calls.retain.length, 1, '第二次排在第一次之后，看到已经写过');
            assert.match(memory.bankId(big), /^linmengyao-[0-9a-f]{16}$/);
            assert.ok(!memory.bankId(big).includes('123456789'));
        } finally {
            cleanup();
        }
    });
});

describe('长期记忆：召回与关系概况', () => {
    test('查询是她上一句加对方这次发的几条', () => {
        const chat = [
            { role: 'user' as const, content: '我明天面试' },
            { role: 'assistant' as const, content: '加油 结束了告诉我' },
            { role: 'user' as const, content: '过了！' },
            { role: 'user' as const, content: '你猜是哪家' },
        ];
        assert.equal(recallQuery(chat), '她：加油 结束了告诉我\n对方：过了！\n对方：你猜是哪家');
        assert.equal(recallQuery(chat.slice(0, 2)), '');
        assert.equal(recallQuery([{ role: 'user', content: '啊'.repeat(500) }]).length, MAX_QUERY_CHARS);
    });

    test('主动找他时的查询：先写想知道什么，再带最后两句；截到 MAX_QUERY_CHARS 字时留开头', () => {
        const chat = [
            { role: 'user' as const, content: '我明天下午面试' },
            { role: 'assistant' as const, content: '加油' },
            { role: 'user' as const, content: '晚安' },
        ];
        assert.equal(initiateQuery(chat, '阿明最近在忙什么'), '阿明最近在忙什么\n她：加油\n对方：晚安');
        assert.equal(initiateQuery([], '阿明最近在忙什么'), '阿明最近在忙什么');
        assert.ok(initiateQuery([{ role: 'user', content: '啊'.repeat(500) }], '想知道的').startsWith('想知道的\n'));
    });

    test('召回结果带日期、去掉当前片段的、最多 MAX_RECALLED 条；没有结果不注入', () => {
        const text = formatRecalled([
            { id: '1', text: '阿明说周五有面试', occurred_start: '2026-10-01T12:00:00Z', document_id: 'ep-1' },
            { id: '2', text: '没有日期的事 | Involving: 阿明' },
        ]);
        assert.match(text!, /^\[你们以前聊过的事/);
        assert.match(text!, /\n- 10月1日：阿明说周五有面试\n- 没有日期的事$/);
        assert.equal(formatRecalled([]), undefined);
        // 观察的日期用最近一次被提到的（occurred_start 是来源里最早的）
        assert.match(formatRecalled([{ id: '3', text: '阿明现在不吃甜的了', type: 'observation', occurred_start: '2026-09-01T12:00:00+08:00', mentioned_at: '2026-10-03T12:00:00+08:00' }])!, /- 10月3日：阿明现在不吃甜的了/);
        const many = formatRecalled(Array.from({ length: MAX_RECALLED + 4 }, (_, i) => ({ id: String(i), text: `事${i}` })));
        assert.equal(many!.split('\n').length - 1, MAX_RECALLED);
    });

    test('召回出错只记日志，不注入；还没写过记忆时不查', async () => {
        const { memory, calls, logs, cleanup } = setup({ recall: new Error('超时（3000 ms）') });
        try {
            const chat = [{ role: 'user' as const, content: '在吗', time: new Date().toISOString() }];
            assert.equal(await memory.recall(A, chat, new Date()), undefined);
            assert.equal(calls.recall.length, 0, '还没有 bank');
            await memory.sync(A, names, [msg(0, 'user', '在吗')]);
            assert.equal(await memory.recall(A, chat, new Date()), undefined);
            assert.ok(logs.some(l => l.includes('记忆召回失败，这次不带记忆：超时')));
        } finally {
            cleanup();
        }
    });

    test('当前片段里的事不再注入（原文已经在上下文里）', async () => {
        const now = T0 + 30 * MIN;
        const results: RecallResult[] = [
            { id: '1', text: '旧事', document_id: 'ep-old' },
            { id: '2', text: '刚才说的', document_id: `ep-${T0}` },
        ];
        const { memory, cleanup } = setup({ recall: results }, now);
        try {
            await memory.sync(A, names, [msg(-200, 'user', '很久以前')]);
            const chat = [msg(0, 'user', '刚才说的'), msg(29, 'user', '还有')];
            const text = await memory.recall(A, chat, new Date(now));
            assert.match(text!, /旧事/);
            assert.doesNotMatch(text!, /刚才说的/);
        } finally {
            cleanup();
        }
    });

    test('记忆变淡（ADR 0018）：请求带实体名和背后的事实、多取一些；他这次的话里有实体名就想起，名单里的称呼不算', async () => {
        const now = T0 + 24 * 60 * MIN;
        const old = new Date(now - 45 * 24 * 60 * MIN).toISOString();
        const results: RecallResult[] = [
            { id: '1', text: '阿明去了海底捞', occurred_start: old, entities: ['阿明', '海底捞'] },
            { id: '2', text: '阿明感冒了', occurred_start: old, entities: ['阿明'] },
        ];
        const { memory, calls, cleanup } = setup({ recall: results }, now);
        try {
            await memory.sync(A, names, [msg(-200, 'user', '很久以前')]);
            let stats;
            const chat = [msg(0, 'assistant', '在呢'), msg(1, 'user', '阿明今天又想吃海底捞了')];
            const text = await memory.recall(A, chat, new Date(now), { ignore: ['林梦瑶', '阿明'], onFade: s => { stats = s; } });
            assert.match(text!, /（他一提才想起来，记不太清了）：阿明去了海底捞/);
            assert.doesNotMatch(text!, /感冒/);
            assert.deepEqual(stats, { vague: 0, recognized: 1, forgotten: 1 });
            assert.deepEqual(calls.recall[0]!.include, { entities: { max_tokens: 1 }, source_facts: { max_tokens: 4000 } });
            assert.equal(calls.recall[0]!.max_tokens, RECALL_TOKENS);
            assert.deepEqual(check(calls.recall[0], root('recall')), []);
            // 她上次回复之前说的不算
            const before = [msg(0, 'user', '海底捞'), msg(1, 'assistant', '嗯'), msg(2, 'user', '在吗')];
            assert.equal(await memory.recall(A, before, new Date(now), { ignore: [] }), undefined);
        } finally {
            cleanup();
        }
    });

    test('Hindsight 客户端：观察背后的事实按 id 对上原文', async () => {
        const original = globalThis.fetch;
        globalThis.fetch = (async () => new Response(JSON.stringify({
            results: [
                { id: 'o1', text: '阿明在准备面试', type: 'observation', source_fact_ids: ['f1', 'f2', 'f9'] },
                { id: 'w1', text: '阿明不吃香菜', type: 'world' },
            ],
            source_facts: { f1: { id: 'f1', text: '【重要】阿明 10月9日面试字节' }, f2: { id: 'f2', text: '阿明在刷题' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
        try {
            const results = await new HindsightClient('http://127.0.0.1:1', 1000).recall('b', {} as RecallRequest);
            assert.deepEqual(results.map(r => r.sources), [['【重要】阿明 10月9日面试字节', '阿明在刷题'], undefined], '对不上的 id 跳过');
        } finally {
            globalThis.fetch = original;
        }
    });

    test('关系概况：第一次在后台读，读到之后放进提示；内容为空时不放', async () => {
        const { memory, calls, cleanup } = setup({ mentalModel: { id: 'relationship', content: '两人关系稳定，阿明在等面试结果。' } });
        try {
            assert.equal(memory.relationship(A), undefined, '还没有 bank');
            await memory.sync(A, names, [msg(0, 'user', '在吗')]);
            assert.equal(memory.relationship(A), undefined, '第一次只是开始读');
            await new Promise(r => setImmediate(r));
            assert.match(memory.relationship(A)!, /两人关系稳定/);
            assert.equal(calls.getMentalModel, 2, '建库时查过一次，后台读一次；没过期不再读');
        } finally {
            cleanup();
        }
    });
});

describe('长期记忆：公共记忆库、提起别人时查他的 bank（ADR 0016）', () => {
    const B = { qq: 2, tier: 'classmate' };
    const S = { qq: 3, tier: 'stranger' };
    const gege = { user: '鸽鸽', char: '林梦瑶' };
    const history = [msg(0, 'user', '今天加班'), msg(1, 'assistant', '辛苦')];
    const now = T0 + 24 * 60 * MIN;

    function setupCommon(options: Parameters<typeof fakeApi>[0] = {}, common = true, dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'))) {
        const logs: string[] = [];
        const { api, calls } = fakeApi(options);
        const memory = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: m => logs.push(m), now: () => now, common });
        return { memory, calls, logs, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
    const hashOf = (memory: LongTermMemory, contact: { qq: number; tier: string }) => memory.bankId(contact).slice('linmengyao-'.length);

    test('写入：自己的 bank 之后再写一份进公共库；document_id 是哈希不带 QQ 号，原文开头写和谁的私聊；mission 只写一次', async () => {
        const { memory, calls, logs, cleanup } = setupCommon();
        try {
            await memory.sync(B, gege, history);
            assert.deepEqual(calls.banks, [`retain ${memory.bankId(B)}`, 'retain linmengyao-common']);
            const item = calls.retain[1]!;
            assert.equal(item.document_id, `${hashOf(memory, B)}:ep-${T0}`);
            assert.match(item.content, /^和鸽鸽的私聊\n/);
            assert.equal(item.context, 'QQ 私聊：林梦瑶（AI 扮演）和鸽鸽');
            assert.deepEqual(item.entities, [{ text: '鸽鸽', type: 'PERSON' }, { text: '林梦瑶', type: 'PERSON' }], '聊天对象和她的名字钉成人（ADR 0017）');
            assert.deepEqual(check(retainBody(item), root('retain')), []);
            assert.deepEqual(check(commonBankMissions('林梦瑶'), root('bank')), []);
            assert.match((calls.putBank[1] as { retain_mission: string }).retain_mission, /每条写清是在和谁的私聊里/);
            assert.match((calls.putBank[1] as { retain_mission: string }).retain_mission, /开头加「【重要】」/, '重要度（ADR 0018）');
            assert.match((calls.putBank[1] as { retain_mission: string }).retain_mission, /开头加「【长期】」.*日记、周记、总结里的事都按那段时间记|日记、周记、总结里的事都按那段时间记.*开头加「【长期】」/s,
                '长期知道的，日记里的除外（ADR 0018 实现时的调整 11）');
            assert.ok(logs.some(l => l.includes('记忆：公共记忆库 linmengyao-common 已写入 mission')));
            assert.ok(logs.some(l => l.includes(`记忆（公共）：片段 ep-${T0}`)));

            await memory.sync(B, gege, history);
            assert.equal(calls.retain.length, 2, '写过就不再写');
            await memory.sync(A, names, history);
            assert.equal(calls.retain.length, 4);
            assert.equal(calls.putBank.length, 3, '公共库的 mission 只写一次，另两次是两人各自的 bank');
        } finally {
            cleanup();
        }
    });

    test('陌生人档、没开公共库：不写进公共库', async () => {
        const on = setupCommon();
        const off = setupCommon({}, false);
        try {
            await on.memory.sync(S, gege, history);
            await off.memory.sync(B, gege, history);
            assert.deepEqual([...on.calls.banks, ...off.calls.banks].filter(b => b.includes('common')), []);
        } finally {
            on.cleanup();
            off.cleanup();
        }
    });

    test('旧的进度文件（只写过自己的 bank）：补写进公共库，自己的不重写', async () => {
        const before = setupCommon({}, false);
        try {
            await before.memory.sync(B, gege, history);
            const after = setupCommon({}, true, before.dir);
            await after.memory.sync(B, gege, history);
            assert.deepEqual(after.calls.banks, ['retain linmengyao-common']);
        } finally {
            before.cleanup();
        }
    });

    test('公共库写入失败：单独记日志，自己的 bank 照常记进度，下次只补公共库', async () => {
        const { memory, calls, logs, dir, cleanup } = setupCommon({ failRetain: 2 });
        try {
            await memory.sync(B, gege, history);
            assert.ok(logs.some(l => l.includes('[2] 记忆（公共）写入失败：Hindsight 返回 500')));
            assert.equal(memory.status().lastWrite?.ok, false);
            const again = setupCommon({}, true, dir);
            await again.memory.sync(B, gege, history);
            assert.deepEqual(again.calls.banks, ['retain linmengyao-common']);
            assert.equal(calls.retain.length, 1);
        } finally {
            cleanup();
        }
    });

    test('公共记忆召回：去掉他自己的片段，只要事实，最多 SHARED_RECALLED 条，标题写不是和他聊的；陌生人档、还没建库不查', async () => {
        const probe = setupCommon();
        const own = `${hashOf(probe.memory, A)}:ep-1`;
        const other = (i: number): RecallResult => ({ id: `b${i}`, text: `鸽鸽说的第${i}件事`, document_id: `${hashOf(probe.memory, B)}:ep-${i}` });
        probe.cleanup();
        const { memory, calls, cleanup } = setupCommon({ recall: [{ id: 'a', text: '阿明自己说的', document_id: own }, ...Array.from({ length: SHARED_RECALLED + 2 }, (_, i) => other(i))] });
        try {
            const chat = [{ role: 'user' as const, content: '鸽鸽最近忙啥', time: new Date(now).toISOString() }];
            assert.equal(await memory.recallCommon({ ...A, name: '阿明' }, chat, new Date(now), [{ ...A, name: '阿明' }, { ...B, name: '鸽鸽' }]), undefined);
            assert.equal(calls.recall.length, 0, '公共库还没建');

            await memory.sync(B, gege, history);
            const text = await memory.recallCommon({ ...A, name: '阿明' }, chat, new Date(now), [{ ...A, name: '阿明' }, { ...B, name: '鸽鸽' }]);
            assert.match(text!, /^\[你和名单里别的人聊天时说过、听过的事（[^\]]*不是和阿明聊的/);
            assert.doesNotMatch(text!, /阿明自己说的/);
            assert.match(text!, /\n- （可明说·和鸽鸽聊的）：鸽鸽说的第0件事\n/, '标出出处和披露上限（ADR 0020）');
            assert.equal(text!.split('\n').length - 1, SHARED_RECALLED);
            assert.deepEqual(calls.recall[0]!.types, ['world', 'experience']);
            assert.equal(calls.recall[0]!.prefer_observations, false);
            assert.deepEqual(check(calls.recall[0], root('recall')), []);
            assert.equal(calls.banks.at(-1), 'recall linmengyao-common');

            assert.equal(await memory.recallCommon({ ...S, name: '路人' }, chat, new Date(now), []), undefined);
            assert.equal(calls.recall.length, 1, '陌生人档不查');
        } finally {
            cleanup();
        }
    });

    test('公共记忆的线索是人和事时：带着它的排在前面（ADR 0018 第一批，说起杭州）', async () => {
        const probe = setupCommon();
        const gegeDoc = `${hashOf(probe.memory, B)}:ep-9`;
        probe.cleanup();
        const diaries = Array.from({ length: SHARED_RECALLED }, (_, i): RecallResult => ({ id: `d${i}`, text: `第${i}篇日记里的事`, document_id: `diary:2026-10-0${i + 1}` }));
        const { memory, cleanup } = setupCommon({
            recall: [...diaries, { id: 'h', text: '鸽鸽 10月13日去出差装设备', document_id: gegeDoc, entities: ['鸽鸽', '杭州'] }],
        });
        try {
            await memory.sync(B, gege, history);
            const chat = [{ role: 'user' as const, content: '我下周可能要去杭州玩两天', time: new Date(now).toISOString() }];
            const people = [{ ...A, name: '阿明' }, { ...B, name: '鸽鸽' }];
            const focused = await memory.recallCommon({ ...A, name: '阿明' }, chat, new Date(now), people, undefined, {}, ['杭州']);
            assert.match(focused!.split('\n')[1]!, /鸽鸽 10月13日去出差装设备/, '实体对上的排第一');
            const plain = await memory.recallCommon({ ...A, name: '阿明' }, chat, new Date(now), people);
            assert.doesNotMatch(plain!, /出差/, '不给线索时照 Hindsight 的顺序，第 7 条排在外面');
        } finally {
            cleanup();
        }
    });

    test('低档位听众：普通来源只能含糊，亲密来源和未知来源都封口且不暴露是谁（ADR 0020）', async () => {
        const known = { qq: 4, tier: 'known', name: '小李' };
        const probe = setupCommon();
        const closeDoc = `${hashOf(probe.memory, A)}:ep-1`;
        const knownDoc = `${hashOf(probe.memory, known)}:ep-2`;
        probe.cleanup();
        const { memory, cleanup } = setupCommon({ recall: [
            { id: 'close', text: '亲密来源的事', document_id: closeDoc },
            { id: 'known', text: '普通来源的事', document_id: knownDoc },
            { id: 'unknown', text: '来源对不上的事', document_id: 'legacy:ep-3' },
        ] });
        try {
            await memory.sync(A, names, history);
            const listener = { ...B, name: '同学' };
            const text = await memory.recallCommon(listener, [{ role: 'user', content: '你听说什么了' }], new Date(now), [
                { ...A, name: '宝宝' }, listener, known,
            ]);
            assert.match(text!, /（不能说·私下聊的）：亲密来源的事/);
            assert.doesNotMatch(text!, /宝宝聊的/);
            assert.match(text!, /（只能含糊·和小李聊的）：普通来源的事/);
            assert.match(text!, /（不能说·来源不明）：来源对不上的事/);
        } finally {
            cleanup();
        }
    });

    test('今天和别人聊过的：只取今天产生的其他联系人片段、最多三条，并带披露标签', async () => {
        const probe = setupCommon();
        const self = hashOf(probe.memory, A);
        const other = hashOf(probe.memory, B);
        probe.cleanup();
        const at = (iso: string) => new Date(`${iso}+08:00`).toISOString();
        const results: RecallResult[] = [
            { id: 'self', text: '阿明自己说的', document_id: `${self}:ep-1`, mentioned_at: at('2026-10-02T10:00:00') },
            { id: 'old', text: '鸽鸽昨天说的', document_id: `${other}:ep-2`, mentioned_at: at('2026-10-01T23:00:00') },
            { id: 'plan', text: '鸽鸽今天说下周要去杭州', document_id: `${other}:ep-3`, mentioned_at: at('2026-10-02T09:00:00'), occurred_start: at('2026-10-12T09:00:00') },
            ...Array.from({ length: TODAY_OTHERS + 1 }, (_, i): RecallResult => ({
                id: `today-${i}`, text: `鸽鸽今天说的第${i}件`, document_id: `${other}:ep-${4 + i}`, mentioned_at: at(`2026-10-02T1${i}:00:00`),
            })),
            { id: 'diary', text: '日记里的事', document_id: 'diary:2026-10-02', mentioned_at: at('2026-10-02T12:00:00') },
        ];
        const { memory, calls, cleanup } = setupCommon({ recall: results });
        try {
            await memory.sync(B, gege, history);
            const listener = { ...A, name: '阿明' };
            const people = [listener, { ...B, name: '鸽鸽' }];
            const text = await memory.othersToday(listener, new Date(at('2026-10-02T20:00:00')), people, new Date('2026-10-02T02:00:00+08:00'));
            assert.match(text!, /^\[你今天和别人聊过的事/);
            assert.doesNotMatch(text!, /阿明自己|昨天|日记/);
            assert.match(text!, /鸽鸽今天说下周要去杭州/, '按说起时间算今天，未来计划也能想起');
            assert.match(text!, /（可明说·和鸽鸽聊的，打算 10月12日）/);
            assert.equal(text!.split('\n').length - 1, TODAY_OTHERS);
            assert.deepEqual(calls.recall.at(-1)!.types, ['world', 'experience']);
            assert.equal(calls.recall.at(-1)!.prefer_observations, false);
            assert.deepEqual(calls.recall.at(-1)!.temporal_window, { start: '2026-10-02T02:00:00+08:00', end: '2026-10-02T20:01:00+08:00' });
        } finally {
            cleanup();
        }
    });

    test('公共记忆问到某一天：带那天的时间窗、多取一些，只留那天的（发生的时间，没有就用说起的时间）', async () => {
        const at = (iso: string) => new Date(`${iso}+08:00`).toISOString();
        const { memory, calls, cleanup } = setupCommon({
            recall: [
                { id: '1', text: '10-04 的日记', document_id: 'diary:2026-10-04', occurred_start: at('2026-10-04T22:00:00') },
                { id: '2', text: '10-05 中午吃了麻辣烫', document_id: 'diary:2026-10-05', occurred_start: at('2026-10-05T12:00:00') },
                { id: '3', text: '10-05 晚上说的', document_id: 'x:ep-1', mentioned_at: at('2026-10-05T23:59:00') },
                { id: '4', text: '没有时间的', document_id: 'x:ep-2' },
            ],
        });
        try {
            await memory.sync(B, gege, history);
            const chat = [{ role: 'user' as const, content: '你昨天干嘛了', time: new Date(now).toISOString() }];
            const day = { start: new Date(2026, 9, 5), end: new Date(2026, 9, 6) };
            const text = await memory.recallCommon({ ...A, name: '阿明' }, chat, new Date(now), [{ ...A, name: '阿明' }], day);
            assert.deepEqual(text!.split('\n').slice(1).map(line => line.replace(/^- [^：]*：/, '')), ['10-05 中午吃了麻辣烫', '10-05 晚上说的']);
            assert.deepEqual(calls.recall[0]!.temporal_window, { start: '2026-10-05T00:00:00+08:00', end: '2026-10-06T00:00:00+08:00' });
            assert.equal(calls.recall[0]!.max_tokens, DAY_RECALL_TOKENS);
            assert.deepEqual(check(calls.recall[0], root('recall')), []);
            // 那天什么都没有：不带公共记忆
            assert.equal(await memory.recallCommon({ ...A, name: '阿明' }, chat, new Date(now), [], { start: new Date(2026, 9, 1), end: new Date(2026, 9, 2) }), undefined);
        } finally {
            cleanup();
        }
    });

    test('问某一天、那天正好是假期最后一天：那天的日记排前面，总结只留那天发生的（ADR 0018 第二批）', async () => {
        const at = (iso: string) => new Date(`${iso}+08:00`).toISOString();
        const summary = (i: number, day: string): RecallResult => ({ id: `s${i}`, text: `总结里的第${i}件`, document_id: 'phase:国庆节:2026-10-07', occurred_start: at(`${day}T12:00:00`) });
        const { memory, cleanup } = setupCommon({
            recall: [
                ...Array.from({ length: SHARED_RECALLED }, (_, i) => summary(i, '2026-10-01')),
                summary(9, '2026-10-07'),
                { id: 'd', text: '和室友去后街吃了麻辣烫', document_id: 'diary:2026-10-07', occurred_start: at('2026-10-07T12:00:00') },
            ],
        });
        try {
            await memory.sync(B, gege, history);
            const chat = [{ role: 'user' as const, content: '你昨天都干嘛了', time: new Date(now).toISOString() }];
            const text = await memory.recallCommon({ ...A, name: '阿明' }, chat, new Date(now), [{ ...A, name: '阿明' }], { start: new Date(2026, 9, 7), end: new Date(2026, 9, 8, 2) });
            const lines = text!.split('\n').slice(1);
            assert.match(lines[0]!, /（可明说·你的日记[^）]*）：和室友去后街吃了麻辣烫$/);
            assert.deepEqual(lines.slice(1).map(line => line.replace(/^- [^：]*：/, '')), ['总结里的第9件'], '总结里不是那天的不留');
        } finally {
            cleanup();
        }
    });

    test('提起别人时查他的 bank：标题和条数照传', async () => {
        const results = Array.from({ length: 5 }, (_, i): RecallResult => ({ id: String(i), text: `鸽鸽说的第${i}件事` }));
        const { memory, calls, cleanup } = setupCommon({ recall: results });
        try {
            await memory.sync(B, gege, history);
            const chat = [{ role: 'user' as const, content: '鸽鸽最近忙啥', time: new Date(now).toISOString() }];
            const text = await memory.recall(B, chat, new Date(now), { header: '[你和鸽鸽聊过的事]', limit: 2 });
            assert.equal(text, '[你和鸽鸽聊过的事]\n- 鸽鸽说的第0件事\n- 鸽鸽说的第1件事');
            assert.equal(calls.banks.at(-1), `recall ${memory.bankId(B)}`);
        } finally {
            cleanup();
        }
    });
});

describe('长期记忆：召回的写法（ADR 0017）', () => {
    test('发生在现在之后的事标「打算」，日期写说起的那天；出处和计划写在同一个括号里', () => {
        const now = new Date('2026-10-06T21:00:00+08:00');
        const text = formatRecalled([
            { id: '1', text: '鸽鸽下周要去杭州出差装设备', type: 'world', occurred_start: '2026-10-12T09:00:00+08:00', mentioned_at: '2026-10-05T22:05:00+08:00', document_id: 'h:ep-1' },
            { id: '2', text: '鸽鸽在机房值夜班', type: 'world', occurred_start: '2026-10-05T22:00:00+08:00', document_id: 'h:ep-1' },
            { id: '3', text: '没说起日期的计划', type: 'world', occurred_start: '2026-10-20T09:00:00+08:00', document_id: 'diary:2026-10-05' },
        ], { now, source: r => (r.document_id?.startsWith('diary:') ? '你的日记' : '和鸽鸽聊的') });
        assert.equal(text!.split('\n').slice(1).join('\n'), [
            '- 10月5日（和鸽鸽聊的，打算 10月12日）：鸽鸽下周要去杭州出差装设备',
            '- 10月5日（和鸽鸽聊的）：鸽鸽在机房值夜班',
            '- （你的日记，打算 10月20日）：没说起日期的计划',
        ].join('\n'));
        // 不传 now 照旧（自己的记忆以前的写法）
        assert.match(formatRecalled([{ id: '1', text: '周五面试', occurred_start: '2026-10-12T09:00:00+08:00' }])!, /\n- 10月12日：周五面试$/);
    });

    test('她的名字写成「你」（ADR 0018 决策 4）', () => {
        assert.equal(secondPerson('- 10月5日：林梦瑶的日记里写林梦瑶和鸽鸽聊了杭州', '林梦瑶'), '- 10月5日：你的日记里写你和鸽鸽聊了杭州');
        assert.equal(secondPerson('鸽鸽去杭州', '林梦瑶'), '鸽鸽去杭州');
        assert.equal(secondPerson('林梦瑶', ''), '林梦瑶', '名字是空的不换');
    });
});

describe('长期记忆：公共库的实体名（ADR 0017 的线索）', () => {
    test('10 分钟内用缓存，公共库写入之后重读；公共库还没建（404）不记日志，别的错用上一次的', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
        const logs: string[] = [];
        let clock = T0 + 24 * 60 * MIN;
        let lists = 0;
        let fail: Error | undefined;
        const { api } = fakeApi();
        api.listEntities = async bank => {
            lists++;
            if (fail) throw fail;
            assert.equal(bank, 'linmengyao-common');
            return ['鸽鸽', '杭州'];
        };
        const memory = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: m => logs.push(m), now: () => clock, common: true });
        try {
            fail = Object.assign(new Error('GET … 返回 404：not found'), { status: 404 });
            assert.deepEqual(await memory.commonEntities(), []);
            assert.equal(logs.length, 0, '公共库还没建不记日志');
            fail = undefined;
            clock += 10 * MIN;
            assert.deepEqual(await memory.commonEntities(), ['鸽鸽', '杭州']);
            assert.deepEqual(await memory.commonEntities(), ['鸽鸽', '杭州']);
            assert.equal(lists, 2, '第二次用缓存');

            await memory.sync({ qq: 2, tier: 'classmate' }, { user: '鸽鸽', char: '林梦瑶' }, [msg(0, 'user', '在吗')]);
            await memory.commonEntities();
            assert.equal(lists, 3, '公共库写入之后重读');

            fail = new Error('超时（3000 ms）');
            clock += 10 * MIN;
            assert.deepEqual(await memory.commonEntities(), ['鸽鸽', '杭州'], '读不到用上一次的');
            assert.ok(logs.some(l => l.includes('读取公共记忆的实体失败，用上一次的：超时')));

            const off = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: () => {} });
            assert.deepEqual(await off.commonEntities(), [], '没开公共库');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('长期记忆：她眼中的某个人（ADR 0017）', () => {
    test('写进公共库时建「她眼中的鸽鸽」（只建一次，点名他）；读到之后放进印象，陌生人档、没建过的没有', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
        const { api, calls } = fakeApi();
        const logs: string[] = [];
        const memory = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: m => logs.push(m), now: () => T0 + 24 * 60 * MIN, common: true });
        const B = { qq: 2, tier: 'classmate', name: '鸽鸽' };
        try {
            assert.equal(memory.impression(B), undefined, '还没建');
            await memory.sync(B, { user: '鸽鸽', char: '林梦瑶' }, [msg(0, 'user', '在吗')]);
            const models = calls.createMentalModel as { id: string; name: string; source_query: string }[];
            const person = models.find(m => m.name === '她眼中的鸽鸽')!;
            assert.match(person.id, /^person-[0-9a-f]{16}$/);
            assert.match(person.source_query, /林梦瑶眼中的鸽鸽/);
            assert.match(person.source_query, /各个聊天里提到鸽鸽的都算/);
            assert.deepEqual(check(person, root('mentalModel')), []);
            assert.ok(logs.some(l => l.includes('「她眼中的鸽鸽」已建好')));
            await memory.sync(B, { user: '鸽鸽', char: '林梦瑶' }, [msg(0, 'user', '在吗'), msg(100, 'user', '在吗')]);
            assert.equal(models.filter(m => m.name === '她眼中的鸽鸽').length, 1, '只建一次');

            api.getMentalModel = async (bank, id) => (bank === 'linmengyao-common' && id === person.id ? { id, content: '鸽鸽是做网络运维的，10月中旬去杭州出差。' } : undefined);
            assert.equal(memory.impression(B), undefined, '第一次在后台读');
            await new Promise(r => setTimeout(r, 0));
            assert.equal(memory.impression(B), '[你心里对鸽鸽的印象（从你和大家的聊天里整理的，只作参考，不要原样说出来）：里面的事实可以按披露规则使用；'
                + '你对鸽鸽的看法是你自己的念头，不主动说，被问起时按说别人的事的分寸]\n鸽鸽是做网络运维的，10月中旬去杭州出差。');
            assert.equal(memory.impression({ qq: 3, tier: 'stranger', name: '路人' }), undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('聊天早就都写进公共库的人（ADR 0017 之前写的）：没有新片段也建「她眼中的他」', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
        const { api, calls } = fakeApi();
        const memory = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: () => {}, now: () => T0 + 24 * 60 * MIN, common: true });
        const B = { qq: 2, tier: 'classmate', name: '鸽鸽' };
        const names = { user: '鸽鸽', char: '林梦瑶' };
        try {
            await memory.sync(B, names, [msg(0, 'user', '在吗')]);
            // 当时还没有印象：去掉状态文件里建过的记号
            const file = readdirSync(dir).find(name => name.endsWith('.json') && name !== 'common.json')!;
            const state = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            delete state.personModel;
            writeFileSync(join(dir, file), JSON.stringify(state));
            const retained = calls.retain.length;

            await memory.sync(B, names, [msg(0, 'user', '在吗')]);
            assert.equal(calls.retain.length, retained, '没有新片段');
            assert.equal((calls.createMentalModel as { name: string }[]).filter(m => m.name === '她眼中的鸽鸽').length, 2);
            assert.ok(JSON.parse(readFileSync(join(dir, file), 'utf8')).personModel);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('长期记忆：日记写进公共库（ADR 0017）', () => {
    test('document_id 是 diary:<日期>，标签多 diary，时间是那天晚上；没开公共库、写入失败返回 false', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
        const logs: string[] = [];
        const ok = fakeApi();
        const bad = fakeApi({ failRetain: 1 });
        const make = (api: HindsightApi, common: boolean) => new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: m => logs.push(m), common });
        try {
            assert.equal(await make(ok.api, true).retainDiary('2026-10-06', new Date(2026, 9, 6), '今天去看了电影。', '林梦瑶'), true);
            const item = ok.calls.retain[0]!;
            assert.equal(ok.calls.banks[0], 'retain linmengyao-common');
            assert.equal(item.document_id, 'diary:2026-10-06');
            assert.deepEqual(item.tags, ['qq-private', 'diary']);
            assert.equal(item.content, '林梦瑶的日记（2026-10-06）\n今天去看了电影。');
            assert.match(item.timestamp, /^2026-10-06T22:00:00[+-]\d{2}:\d{2}$/);
            assert.deepEqual(check(retainBody(item), root('retain')), []);
            assert.match((ok.calls.putBank[0] as { retain_mission: string }).retain_mission, /也有林梦瑶自己写的日记/);

            assert.equal(await make(ok.api, false).retainDiary('2026-10-06', new Date(2026, 9, 6), 'x', '林梦瑶'), false);
            assert.equal(await make(bad.api, true).retainDiary('2026-10-07', new Date(2026, 9, 7), 'x', '林梦瑶'), false);
            assert.ok(logs.some(l => l.startsWith('她的日记：2026-10-07 写进公共记忆失败，下次再写：Hindsight 返回 500')));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('周记、阶段总结（ADR 0018）：document_id、标签、时间是最后那天晚上；mission 写了怎么记', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
        const { api, calls } = fakeApi();
        const memory = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: () => {}, common: true });
        try {
            assert.equal(await memory.retainSummary('week:2026-09-28', new Date(2026, 9, 4), '林梦瑶的周记（9月28日–10月4日）', '这周……', '林梦瑶', 'week'), true);
            assert.equal(await memory.retainSummary('phase:国庆节:2026-10-07', new Date(2026, 9, 7), '林梦瑶的国庆节总结（10月1日–10月7日）', '国庆……', '林梦瑶', 'phase'), true);
            const [week, phase] = calls.retain;
            assert.equal(week!.document_id, 'week:2026-09-28');
            assert.deepEqual(week!.tags, ['qq-private', 'week']);
            assert.equal(week!.content, '林梦瑶的周记（9月28日–10月4日）\n这周……');
            assert.equal(week!.context, '林梦瑶自己写的周记');
            assert.match(week!.timestamp, /^2026-10-04T22:00:00/);
            assert.deepEqual(phase!.tags, ['qq-private', 'phase']);
            assert.match(phase!.timestamp, /^2026-10-07T22:00:00/);
            assert.deepEqual(check(retainBody(week!), root('retain')), []);
            assert.match((calls.putBank[0] as { retain_mission: string }).retain_mission, /还有林梦瑶的周记、假期总结/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('读回以前的日记（ADR 0018 写周记用）：去掉标题行；没有这篇、没开公共库、接口没有这个方法是 undefined', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
        const { api } = fakeApi();
        const asked: string[] = [];
        const withDocs: HindsightApi = {
            ...api,
            getDocument: async (bank, id) => { asked.push(`${bank} ${id}`); return id === 'diary:2026-10-04' ? { original_text: '林梦瑶的日记（2026-10-04）\n今天去看了电影。' } : undefined; },
        };
        const make = (a: HindsightApi, common = true) => new LongTermMemory({ api: a, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: () => {}, common });
        try {
            assert.equal(await make(withDocs).readDiary('2026-10-04'), '今天去看了电影。');
            assert.deepEqual(asked, ['linmengyao-common diary:2026-10-04']);
            assert.equal(await make(withDocs).readDiary('2026-10-05'), undefined);
            assert.equal(await make(withDocs, false).readDiary('2026-10-04'), undefined);
            assert.equal(await make(api).readDiary('2026-10-04'), undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('Hindsight 客户端读文档：404 是 undefined', async () => {
        const original = globalThis.fetch;
        const urls: string[] = [];
        globalThis.fetch = (async (url: string) => {
            urls.push(url);
            return url.endsWith('diary%3A2026-10-04')
                ? new Response(JSON.stringify({ id: 'diary:2026-10-04', original_text: '正文' }), { status: 200, headers: { 'content-type': 'application/json' } })
                : new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        try {
            const client = new HindsightClient('http://127.0.0.1:1', 1000);
            assert.deepEqual(await client.getDocument('b', 'diary:2026-10-04'), { id: 'diary:2026-10-04', original_text: '正文' });
            assert.equal(await client.getDocument('b', 'diary:2026-10-05'), undefined);
            assert.equal(urls[0], 'http://127.0.0.1:1/v1/default/banks/b/documents/diary%3A2026-10-04');
        } finally {
            globalThis.fetch = original;
        }
    });
});

describe('长期记忆：问到某段时间（ADR 0018 决策 3）', () => {
    test('周记、阶段总结排前面、标出来；按那篇的日子算在不在这段时间里', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
        const at = (iso: string) => new Date(`${iso}+08:00`).toISOString();
        const now = Date.parse('2026-10-14T21:00:00+08:00');
        const { api, calls } = fakeApi({
            recall: [
                { id: '1', text: '林梦瑶 10月3日去拍了银杏', document_id: 'diary:2026-10-03', occurred_start: at('2026-10-03T15:00:00') },
                { id: '2', text: '林梦瑶国庆一个人在学校，挺自在', document_id: 'phase:国庆节:2026-10-07', occurred_start: at('2026-09-30T12:00:00') },
                { id: '3', text: '林梦瑶这周追完了一部剧', document_id: 'week:2026-09-28', occurred_start: at('2026-10-04T22:00:00') },
                { id: '4', text: '林梦瑶 10月9日上了机房课', document_id: 'diary:2026-10-09', occurred_start: at('2026-10-09T09:00:00') },
            ],
        });
        const memory = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: () => {}, now: () => now, common: true });
        try {
            await memory.retainDiary('2026-10-03', new Date(2026, 9, 3), 'x', '林梦瑶');
            const chat = [{ role: 'user' as const, content: '国庆过得怎么样', time: new Date(now).toISOString() }];
            const text = await memory.recallCommon({ ...A, name: '阿明' }, chat, new Date(now), [{ ...A, name: '阿明' }],
                { start: new Date(2026, 9, 1), end: new Date(2026, 9, 8, 2), period: 'holiday' });
            assert.deepEqual(text!.split('\n').slice(1).map(line => line.replace(/^- [^（]*（([^，）]*)[^：]*：/, '$1｜')), [
                '可明说·你国庆节的总结｜林梦瑶国庆一个人在学校，挺自在',
                '可明说·你的周记｜林梦瑶这周追完了一部剧',
                '可明说·你的日记｜林梦瑶 10月3日去拍了银杏',
            ], '阶段总结的事实标在 9-30，按那篇的日子（10-07）还算国庆');
            // 问假期：阶段总结按标签单独再召回一次（ADR 0026），合并时去重
            assert.equal(calls.recall.length, 2);
            assert.deepEqual(calls.recall[1]!.tags, [...calls.recall[0]!.tags, 'phase']);
            assert.equal(calls.recall[1]!.tags_match, 'all_strict');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
