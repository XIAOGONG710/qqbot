import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import {
    hisMessages, IDIOM_COOLDOWN_REPLIES, IDIOM_MIN_DAYS, IDIOM_MIN_OCCURRENCES, IDIOM_SHOWN, IDIOM_TURN_SHARE, idiomLine, idiomsPrompt, idiomStore,
    IDIOMS_KEPT, IDIOMS_MIN_MESSAGES, IDIOMS_REFRESH_MS, ownWords, parseIdioms, refreshIdioms, type Idiom,
} from '../src/language/idioms.ts';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// ADR 0138：被他带出来的口头习惯。短语都是测试里编的，不是真实聊天里的
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-idioms-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = Date.parse('2026-10-24T12:00:00+08:00');
const DAY = 86_400_000;
const at = (daysAgo: number, minute = 0) => new Date(NOW - daysAgo * DAY + minute * 60_000).toISOString();
type Msg = { role: 'user' | 'assistant'; content: string; time: string };
const him = (content: string, daysAgo: number, minute = 0): Msg => ({ role: 'user', content, time: at(daysAgo, minute) });
const her = (content: string, daysAgo: number, minute = 1): Msg => ({ role: 'assistant', content, time: at(daysAgo, minute) });
/** n 天、每天一条带这个短语的话，再加一些不带的 */
const spread = (phrase: string, days: number, perDay = 1) => Array.from({ length: days }, (_, d) => Array.from({ length: perDay }, (__, k) => him(`今天${phrase}，真的${phrase}`, d + 1, k * 2))).flat();
const filler = (count: number) => Array.from({ length: count }, (_, i) => him(`随便说点别的第${i}句`, 1 + (i % 20), i));

describe('parseIdioms：硬校验', () => {
    const his = hisMessages([...spread('笑死', 5, 2), ...spread('离谱', 2, 3), ...filler(80)], NOW);
    const json = (...phrases: string[]) => JSON.stringify(phrases.map(说法 => ({ 说法, 类型: '口头禅' })));

    test('原样出现 ≥ 4 条、分布在 ≥ 3 个日子的收下，并记下次数和天数', () => {
        const items = parseIdioms(json('笑死'), his);
        assert.deepEqual(items.map(i => [i.phrase, i.count, i.days]), [['笑死', 10, 5]]);
        assert.equal(IDIOM_MIN_OCCURRENCES, 4);
        assert.equal(IDIOM_MIN_DAYS, 3);
    });

    test('次数够但天数不够（离谱：6 条挤在 2 天）、编出来的（聊天里没有）都丢掉', () => {
        assert.deepEqual(parseIdioms(json('离谱', '根本没说过的词'), his), []);
    });

    test('太泛的、带数字的、脏话、危机相关的、太长的、联系人的名字：丢掉', () => {
        const messages = hisMessages([
            ...['嗯嗯', '哈哈哈', '好的', '666', '卧槽', '想死', '这个周末见面吧', '阿明'].flatMap(p => spread(p, 5)), ...filler(80),
        ], NOW);
        assert.deepEqual(parseIdioms(json('嗯嗯', '哈哈哈', '好的', '666', '卧槽', '想死', '这个周末见面吧', '阿明'), messages, ['阿明']), []);
    });

    test('笑死这类夸张说法不当危机；超过 IDIOMS_KEPT 个只留前几个；重复的只收一次', () => {
        const phrases = ['笑死', '绝了', '好家伙', '离谱了', '懂了', '行吧', '晕', '确实', '真的假的', '绷不住'];
        const messages = hisMessages([...phrases.flatMap(p => spread(p, 5)), ...filler(80)], NOW);
        const items = parseIdioms(json(...phrases, '笑死'), messages);
        assert.equal(items.length, IDIOMS_KEPT);
        assert.equal(new Set(items.map(i => i.phrase)).size, IDIOMS_KEPT);
        assert.ok(items.some(i => i.phrase === '笑死'));
    });

    test('模型输出坏了：容忍前后废话，坏 JSON / 不是数组 / 空 → 没有', () => {
        assert.deepEqual(parseIdioms('好的，结果：' + json('笑死') + ' 完毕', his).map(i => i.phrase), ['笑死']);
        for (const bad of ['', '没有', '[{"说法":', '{"说法":"笑死"}', '[]']) assert.deepEqual(parseIdioms(bad, his), []);
    });

    test('他的话里带的“[引用你说的：「…」]”前缀是她的话，不算他的次数', () => {
        const quoted = hisMessages([
            ...Array.from({ length: 6 }, (_, d) => him(`[引用你说的：「笑死了」]嗯 ${d}`, d + 1)), ...filler(80),
        ], NOW);
        assert.deepEqual(parseIdioms(json('笑死'), quoted), []);
        assert.equal(ownWords('[引用你说的：「笑死了」]好的'), '好的');
        assert.equal(ownWords('[图片]看这个'), '看这个');
    });
});

describe('hisMessages：窗口', () => {
    test('只要他的话、最近 30 天内、危机相关的不要', () => {
        const history = [him('正常的话', 1), him('我真的不想活了', 2), her('她的话', 1), him('太久以前的话', 40), him('未来的话', -1)];
        assert.deepEqual(hisMessages(history, NOW).map(m => m.content), ['正常的话']);
    });
});

describe('refreshIdioms：什么时候学', () => {
    const base = (store: ReturnType<typeof idiomStore>, history: Msg[], extract: () => Promise<string>, now = NOW) => ({
        qq: 1, userName: '阿明', charName: '林梦瑶', history, store, blocked: ['阿明', '林梦瑶'], extract, now, log: () => undefined,
    });
    const reply = JSON.stringify([{ 说法: '笑死', 类型: '口头禅' }]);

    test('他的话太少不学；够了就学一次存下来，日志不记内容；间隔不到 20 小时不再学', async () => {
        const store = idiomStore({ dir: dir(), log: () => undefined });
        let calls = 0;
        const extract = async () => { calls++; return reply; };
        assert.equal(await refreshIdioms(base(store, spread('笑死', 5), extract)), false, '太少');
        assert.equal(calls, 0);
        const history = [...spread('笑死', 5, 2), ...filler(IDIOMS_MIN_MESSAGES)];
        const logs: string[] = [];
        assert.equal(await refreshIdioms({ ...base(store, history, extract), log: m => logs.push(m) }), true);
        assert.deepEqual(store.load(1).items.map(i => i.phrase), ['笑死']);
        assert.ok(logs.every(l => !l.includes('笑死')));
        assert.equal(await refreshIdioms(base(store, history, extract, NOW + IDIOMS_REFRESH_MS - 1000)), false, '没到间隔');
        assert.equal(calls, 1);
    });

    test('到了间隔但没有足够多的新消息也不学；新消息够了才再学；旧的在窗口里不再成立就掉', async () => {
        const store = idiomStore({ dir: dir(), log: () => undefined });
        const history = [...spread('笑死', 5, 2), ...filler(IDIOMS_MIN_MESSAGES)];
        let calls = 0;
        await refreshIdioms(base(store, history, async () => { calls++; return reply; }));
        const later = NOW + 2 * DAY;
        assert.equal(await refreshIdioms(base(store, history, async () => { calls++; return reply; }, later)), false, '没有新消息');
        const more = [...history, ...Array.from({ length: 25 }, (_, i) => him(`新的第${i}句`, 0, i))];
        assert.equal(await refreshIdioms(base(store, more, async () => { calls++; return '[]'; }, later)), true);
        assert.deepEqual(store.load(1).items.map(i => i.phrase), ['笑死'], '旧的还成立：留着');
        const gone = more.filter(m => !m.content.includes('笑死'));
        const much = [...gone, ...Array.from({ length: 30 }, (_, i) => him(`更新的第${i}句`, 0, 30 + i))];
        assert.equal(await refreshIdioms(base(store, much, async () => '[]', later + 3 * DAY)), true);
        assert.deepEqual(store.load(1).items, [], '他不说了：习惯掉了');
    });

    test('提示词里要求原样、不要名词和内容', () => {
        const text = idiomsPrompt('阿明', '林梦瑶', '第一句\n第二句');
        assert.match(text, /原样/);
        assert.match(text, /不要人名、地名/);
        assert.match(text, /第一句\n第二句$/);
    });
});

describe('存储', () => {
    test('存了读得回；文件坏了当作没有、原文件不动；没有文件是空的', () => {
        const d = dir();
        const logs: string[] = [];
        const store = idiomStore({ dir: d, log: m => logs.push(m) });
        assert.deepEqual(store.load(7), { version: 1, items: [] });
        store.save(7, { version: 1, items: [{ phrase: '笑死', kind: '口头禅', count: 9, days: 5 }], updatedAt: at(0) });
        assert.equal(store.load(7).items[0]!.phrase, '笑死');
        writeFileSync(join(d, '8.json'), '{坏了');
        assert.deepEqual(store.load(8).items, []);
        assert.ok(logs.some(l => l.includes('读不了')));
        assert.equal(readFileSync(join(d, '8.json'), 'utf8'), '{坏了');
    });

    test('隐私审计 / 遗忘的清单里有 idioms/<QQ>.json（也补上了 jokes/<QQ>.json）', () => {
        const d = dir();
        for (const sub of ['idioms', 'jokes']) { mkdirSync(join(d, sub), { recursive: true }); writeFileSync(join(d, sub, '10001.json'), '{"version":1}'); writeFileSync(join(d, sub, '10002.json'), '{"version":1}'); }
        const audit = auditContactPrivacy(d, 10001);
        assert.deepEqual(audit.artifacts.map(a => [a.path.replaceAll('\\', '/'), a.kind]), [['idioms/10001.json', 'direct'], ['jokes/10001.json', 'direct']]);
    });
});

describe('idiomLine：这一轮给不给她看', () => {
    const items: Idiom[] = [
        { phrase: '笑死', kind: '口头禅', count: 9, days: 5 }, { phrase: '绝了', kind: '口头禅', count: 7, days: 4 }, { phrase: '行吧', kind: '语气词', count: 6, days: 4 },
    ];
    const chat = (last: string, extra: Msg[] = []) => [him('笑死', 3), him('绝了', 2), him('行吧', 2, 5), ...extra, him(last, 0)];

    test('share 0 永不给；share 1 总给，最多 IDIOM_SHOWN 个，提示她用得上才用、别提这件事', () => {
        assert.equal(idiomLine(items, chat('在吗'), NOW, 0), undefined);
        const line = idiomLine(items, chat('在吗'), NOW, 1)!;
        assert.ok(line);
        assert.ok((line.match(/「/g) ?? []).length <= IDIOM_SHOWN);
        assert.match(line, /用得上，就顺口用一个/);
        assert.match(line, /别提这件事/);
        assert.equal(IDIOM_SHOWN, 2);
    });

    test('默认约 IDIOM_TURN_SHARE 的轮次给；同一句话每次一样', () => {
        let hit = 0;
        for (let i = 0; i < 600; i++) if (idiomLine(items, chat(`第${i}句话`), NOW)) hit++;
        assert.ok(hit / 600 > IDIOM_TURN_SHARE - 0.08 && hit / 600 < IDIOM_TURN_SHARE + 0.08, `${hit / 600}`);
        assert.equal(idiomLine(items, chat('同一句'), NOW), idiomLine(items, chat('同一句'), NOW));
    });

    test('她最近三次回复里用过的不再给；他最近 14 天没再说的不给；没有可给的就没有', () => {
        const used = chat('在吗', [her('笑死我了', 1), her('这也行吧', 1, 3)]);
        const line = idiomLine(items, used, NOW, 1)!;
        assert.ok(!line.includes('「笑死」') && !line.includes('「行吧」'), line);
        assert.ok(line.includes('「绝了」'));
        assert.equal(IDIOM_COOLDOWN_REPLIES, 3);
        const stale = [him('笑死', 30), him('绝了', 20), him('行吧', 16), him('在吗', 0)];
        assert.equal(idiomLine(items, stale, NOW, 1), undefined);
        assert.equal(idiomLine([], chat('在吗'), NOW, 1), undefined);
    });

    test('他最近说的“[引用…]”里她的话不算他还在说', () => {
        const only = [him('[引用你说的：「笑死」]嗯', 1), him('在吗', 0)];
        assert.equal(idiomLine([items[0]!], only, NOW, 1), undefined);
    });

    test('轮流给：不同的话开头挑的不总是同一个', () => {
        const firsts = new Set<string>();
        for (let i = 0; i < 80; i++) firsts.add(/「(.+?)」/.exec(idiomLine(items, chat(`话${i}`), NOW, 1)!)![1]!);
        assert.ok(firsts.size >= 2, [...firsts].join(','));
    });
});

describe('模拟器里走一遍', () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
    const llm: BotConfig['llm'] = { baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {} };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
    // 他最近说过这几个词，才算“还在说”
    const history = [
        { time: '2026-10-24T19:00:00+08:00', role: 'user', content: '笑死我了' },
        { time: '2026-10-24T19:00:30+08:00', role: 'assistant', content: '怎么了' },
        { time: '2026-10-24T19:30:00+08:00', role: 'user', content: '这也太绝了' },
        { time: '2026-10-24T19:30:30+08:00', role: 'assistant', content: '哈' },
    ];
    const scenarioOf = (idioms: boolean, say: string, extra: Record<string, unknown> = {}) => parseScenario({
        name: '口头习惯', tier: 'boyfriend', start: '2026-10-24T20:00:00+08:00', memory: false, history,
        ...(idioms ? { idioms: [{ phrase: '笑死', kind: '口头禅' }, { phrase: '绝了' }], idiomShare: 1 } : {}), ...extra,
        steps: [{ say }],
    });
    const run = async (scenario: ReturnType<typeof scenarioOf>) => {
        const d = dir();
        const seen: string[] = [];
        await runScenario(scenario, { runId: 'idioms', dataDir: d, card, llm, prompt, generate: async (messages: OpenAIMessage[]) => { seen.push(messages.map(m => m.content).join('\n')); return '行呀'; } });
        return seen;
    };

    test('开着：提示词里有一行他爱说的词；关着没有；危机回合没有', async () => {
        const on = await run(scenarioOf(true, '今天食堂的饭怎么样'));
        assert.ok(on.at(-1)!.includes('他平时爱说'), '开着有');
        assert.match(on.at(-1)!, /他平时爱说「(?:笑死|绝了)」/);
        const off = await run(scenarioOf(false, '今天食堂的饭怎么样'));
        assert.ok(off.every(p => !p.includes('他平时爱说')), '关着没有');
        const crisis = await run(scenarioOf(true, '我不想活了，真的撑不下去了'));
        assert.ok(crisis.every(p => !p.includes('他平时爱说')), '危机回合没有');
        const care = await run(scenarioOf(true, '我今天好难过，心里堵得慌'));
        assert.ok(care.every(p => !p.includes('他平时爱说')), '他难过的回合没有');
    });

    test('idioms / idiomShare 写错报错', () => {
        assert.throws(() => scenarioOf(false, '在吗', { idioms: [{ kind: '口头禅' }] }), /idioms\[0\]\.phrase/);
    });
});
