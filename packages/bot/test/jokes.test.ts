import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    JOKE_COOLDOWN_MS, JOKE_TURN_SHARE, JOKES_MIN_MESSAGES, JOKES_MIN_NEW, JOKES_REFRESH_MS, jokeLine, jokeStore, parseJokes, refreshJokes, type Joke,
} from '../src/language/jokes.ts';

// ADR 0114：小梗回头提。梗必须是聊天里原样出现过至少两次的词 / 短句，编的丢掉
const DAY = 86_400_000;
const now = new Date(2026, 10, 20, 22, 0).getTime();
type Said = { role: 'user' | 'assistant'; content: string; time: string };
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const chat = (lines: [('user' | 'assistant'), string, number][]): Said[] => lines.map(([role, content, h]) => ({ role, content, time: at(h) }));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-jokes-')); dirs.push(d); return d; };

const history = chat([
    ['user', '你又去喂大肘子了吧', 60], ['assistant', '什么大肘子，那是土豆', 59.9],
    ['user', '大肘子本肘', 40], ['assistant', '哈哈哈哈', 39.9],
    ['user', '今天吃了啥', 20], ['assistant', '食堂的黄焖鸡', 19.9],
]);

describe('从模型回复里挑梗：硬校验', () => {
    test('原样出现至少两条不同消息的才留；编的 / 只出现一次的 / 太短太长 / 来历空的 / 手机号一样的数字都丢', () => {
        const reply = JSON.stringify([
            { 梗: '大肘子', 来历: '他把土豆叫成大肘子' },
            { 梗: '黄焖鸡', 来历: '她每天吃' },
            { 梗: '芝麻酥', 来历: '编出来的' },
            { 梗: '肘', 来历: '太短' },
            { 梗: '大肘子', 来历: '重复的' },
            { 梗: '本肘', 来历: '' },
        ]);
        const jokes = parseJokes(reply, history);
        assert.deepEqual(jokes, [{ phrase: '大肘子', origin: '他把土豆叫成大肘子' }]);
        assert.deepEqual(parseJokes('这里没有 JSON', history), []);
        assert.deepEqual(parseJokes('[坏的', history), []);
        assert.deepEqual(parseJokes('```json\n[{"梗":"大肘子","来历":"他把土豆叫成大肘子"}]\n```', history).length, 1, '带 markdown 围栏也认');
        assert.deepEqual(parseJokes(JSON.stringify([{ 梗: '13800138000', 来历: '号码' }]), chat([['user', '13800138000', 1], ['assistant', '13800138000', 1]])), []);
    });

    test('最多留 3 个', () => {
        const rich = chat(['甲甲', '乙乙', '丙丙', '丁丁'].flatMap((w, i): [('user' | 'assistant'), string, number][] => [['user', `${w}${w}`, 50 - i], ['assistant', `${w}`, 49 - i]]));
        const reply = JSON.stringify(['甲甲', '乙乙', '丙丙', '丁丁'].map(w => ({ 梗: w, 来历: '来历' })));
        assert.equal(parseJokes(reply, rich).length, 3);
    });
});

describe('隔一阵抽一次', () => {
    const many = (n: number, withJoke = true): Said[] => Array.from({ length: n }, (_, i) => ({
        role: i % 2 ? 'assistant' as const : 'user' as const,
        content: withJoke && i % 9 === 0 ? '大肘子又出来了' : `第 ${i} 句`,
        time: new Date(now - (n - i) * 600_000).toISOString(),
    }));
    const ask = async (messages: Said[], extra: Partial<Parameters<typeof refreshJokes>[0]> = {}) => {
        const store = jokeStore({ dir: tmp(), log: () => {} });
        let calls = 0;
        const out = await refreshJokes({
            qq: 1, userName: '阿明', charName: '林梦瑶', history: messages, store, now, log: () => {},
            extract: async () => { calls++; return JSON.stringify([{ 梗: '大肘子', 来历: '他把土豆叫成大肘子' }]); }, ...extra,
        });
        return { out, calls, store };
    };

    test('聊天太少不抽；够了才抽，存下来；日志不含内容', async () => {
        assert.equal((await ask(many(JOKES_MIN_MESSAGES - 1))).calls, 0);
        const logs: string[] = [];
        const { out, calls, store } = await ask(many(80), { log: m => logs.push(m) });
        assert.equal(out, true);
        assert.equal(calls, 1);
        assert.deepEqual(store.load(1).jokes, [{ phrase: '大肘子', origin: '他把土豆叫成大肘子' }]);
        assert.ok(logs.every(m => !m.includes('大肘子')));
    });

    test('20 小时内抽过不再抽；新消息不够多不再抽；够了再抽，旧的还成立的留着', async () => {
        const store = jokeStore({ dir: tmp(), log: () => {} });
        const messages = many(80);
        let calls = 0;
        const run = (h: Said[], when: number) => refreshJokes({
            qq: 1, userName: '阿明', charName: '林梦瑶', history: h, store, now: when, log: () => {},
            extract: async () => { calls++; return JSON.stringify([{ 梗: '大肘子', 来历: '他把土豆叫成大肘子' }]); },
        });
        assert.equal(await run(messages, now), true);
        assert.equal(await run(messages, now + JOKES_REFRESH_MS - 1000), false, '20 小时内');
        const later = now + JOKES_REFRESH_MS + 60_000;
        assert.equal(await run(messages, later), false, '没有新消息');
        const more = [...messages, ...many(JOKES_MIN_NEW + 2).map((m, i) => ({ ...m, time: new Date(now + 3_600_000 + i * 60_000).toISOString() }))];
        assert.equal(await run(more, later), true);
        assert.equal(calls, 2);
        assert.equal(store.load(1).jokes.length, 1, '同一个梗不重复');
    });

    test('文件坏了当作没有，不崩；原文件不动', () => {
        const dir = tmp();
        writeFileSync(join(dir, '1.json'), '{坏的');
        const logs: string[] = [];
        assert.deepEqual(jokeStore({ dir, log: m => logs.push(m) }).load(1), { version: 1, jokes: [] });
        assert.ok(logs.some(m => m.includes('读不了')));
    });
});

describe('这一轮给不给她看梗', () => {
    const jokes: Joke[] = [{ phrase: '大肘子', origin: '他把土豆叫成大肘子' }];
    const turn = (n: number): Said[] => [...history.filter(m => !(m.role === 'assistant' && m.content.includes('大肘子'))), { role: 'user' as const, content: `第 ${n} 句闲话`, time: new Date(now - 1000 + n).toISOString() }];

    test('约 JOKE_TURN_SHARE 的轮次给；同一句每次一样；给的那一行写明“接得上才提、别解释、别每次都提”', () => {
        const shown = Array.from({ length: 400 }, (_, i) => jokeLine(jokes, turn(i), now)).filter(Boolean);
        assert.ok(shown.length > 400 * JOKE_TURN_SHARE * 0.6 && shown.length < 400 * JOKE_TURN_SHARE * 1.5, `400 轮里 ${shown.length}`);
        assert.equal(jokeLine(jokes, turn(7), now), jokeLine(jokes, turn(7), now));
        const line = shown[0]!;
        assert.ok(line.includes('「大肘子」') && line.includes('来历：他把土豆叫成大肘子') && line.includes('接不上就别提') && line.includes('别解释这个梗'), line);
    });

    test('她 72 小时内自己说过的梗不再给；过了冷却又给；没有梗就没有', () => {
        const used: Said[] = [{ role: 'assistant', content: '又是大肘子', time: at(10) }];
        const show = (h: Said[]) => Array.from({ length: 200 }, (_, i) => jokeLine(jokes, [...h, { role: 'user' as const, content: `第 ${i} 句闲话`, time: at(0.1) }], now)).filter(Boolean).length;
        assert.equal(show(used), 0);
        assert.ok(show([{ role: 'assistant', content: '又是大肘子', time: new Date(now - JOKE_COOLDOWN_MS - 3_600_000).toISOString() }]) > 0);
        assert.equal(jokeLine([], turn(1), now), undefined);
    });

    test('常量合理', () => { assert.ok(JOKES_REFRESH_MS >= DAY * 0.5); });
});
