import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import { EPISODE_GAP_MS, episodeTranscript, localIso, splitEpisodes } from '../src/memory/episodes.ts';
import { mentalModelUpdateBody, retainBody, type HindsightApi, type MemoryItem, type MentalModel, type RecallRequest, type RecallResult } from '../src/memory/hindsight.ts';
import { BANK_MISSIONS, formatRecalled, LongTermMemory, MAX_RECALLED, OPEN_EPISODE_STEP, recallQuery, RELATIONSHIP_MODEL } from '../src/memory/long-term.ts';

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
        assert.deepEqual(check({ name: '林梦瑶 × 阿明', ...BANK_MISSIONS }, root('bank')), []);
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

    test('召回', async () => {
        const { memory, calls, cleanup } = setup();
        try {
            await memory.sync(A, names, [msg(0, 'user', '我明天下午面试')]);
            await memory.recall(A, [{ role: 'user', content: '过了！', time: new Date().toISOString() }], new Date());
            assert.equal(calls.recall.length, 1);
            assert.deepEqual(check(calls.recall[0], root('recall')), []);
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

    test('原文带说话人、QQ 消息 id 和本地时区的时间', () => {
        const [episode] = splitEpisodes([msg(0, 'user', '我明天下午面试', 101), msg(1, 'assistant', '好呀 等你消息', 102)]);
        const lines = episodeTranscript(episode!, names).split('\n');
        assert.equal(lines[0], `阿明 [message_id=101] (${localIso(new Date(T0))}): 我明天下午面试`);
        assert.match(lines[1]!, /^林梦瑶 \[message_id=102\] \(2026-10-01T20:01:00[+-]\d\d:\d\d\): 好呀 等你消息$/);
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
    });

    test('召回结果带日期、去掉当前片段的、最多 MAX_RECALLED 条；没有结果不注入', () => {
        const text = formatRecalled([
            { id: '1', text: '阿明说周五有面试', occurred_start: '2026-10-01T12:00:00Z', document_id: 'ep-1' },
            { id: '2', text: '没有日期的事 | Involving: 阿明' },
        ]);
        assert.match(text!, /^\[你们以前聊过的事/);
        assert.match(text!, /\n- 10月1日：阿明说周五有面试\n- 没有日期的事$/);
        assert.equal(formatRecalled([]), undefined);
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
