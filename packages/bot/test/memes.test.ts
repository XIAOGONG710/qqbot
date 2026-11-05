import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { BiliVideo } from '../src/bilibili/bilibili.ts';
import {
    candidatePrompt, EVIDENCE_VIDEOS, explainPrompt, fetchLists, gatherEvidence, loadMemes, MEME_EXPLAIN_PER_RUN, MEME_KEEP_DAYS, MEME_MAX, MEME_TURN_SHARE,
    isUsableMeme, memeLine, memeUsed, parseBaidu, parseBiliHot, parseCandidates, parseExplain, parsePopular, parseWeibo, refreshDue, refreshMemes, trimMemes,
    type MemeEntry, type MemeLists,
} from '../src/language/memes.ts';

// ADR 0129：她知道网上现在流行的梗
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-memes-')); dirs.push(d); return join(d, 'memes.json'); };
const now = new Date(2026, 10, 12, 20, 0);
const entry = (term: string, patch: Partial<MemeEntry> = {}): MemeEntry => ({
    term, meaning: `${term}是一个网络梗，常用来调侃`, example: `这也太${term}了`, confidence: 'mid',
    why: '把一个普通的场面说成了不得的事，反差好笑', avoid: '他认真说事的时候别用',
    firstSeen: '2026-11-10', lastSeen: '2026-11-12', seen: 2, ...patch,
});
const video = (title: string, aid = 1, desc = ''): BiliVideo => ({ bvid: 'BV1xx411c7mD', aid, title, desc, owner: 'x', category: '搞笑', views: 100000, likes: 1000, duration: 120, link: 'https://www.bilibili.com/video/BV1xx411c7mD' });

describe('读热榜', () => {
    test('四个榜的返回格式（真实的形状）→ 词表；缺字段 / 空的不出错', () => {
        assert.deepEqual(parsePopular({ data: { list: [{ title: '哈基米vs马尔福大小姐！', tname: '影视剪辑' }, { title: '' }, {}] } }), [{ title: '哈基米vs马尔福大小姐！', tname: '影视剪辑' }]);
        assert.deepEqual(parseBiliHot({ list: [{ show_name: '大类魂理论' }, { show_name: '' }] }), ['大类魂理论']);
        assert.deepEqual(parseWeibo({ data: { realtime: [{ word: '人一旦在有地铁的城市待久了' }, {}] } }), ['人一旦在有地铁的城市待久了']);
        assert.deepEqual(parseBaidu({ data: { cards: [{ content: [{ content: [{ word: '研究生毕业 不用写论文' }] }] }] } }), ['研究生毕业 不用写论文']);
        assert.deepEqual(parseBaidu({ data: { cards: [{ content: [{ word: '直接一层' }] }] } }), ['直接一层']);
        for (const parse of [parsePopular, parseBiliHot, parseWeibo, parseBaidu]) assert.deepEqual(parse(undefined), []);
    });

    test('fetchLists：哪个榜读不了就空着、记一行日志，别的照常', async () => {
        const logs: string[] = [];
        const doFetch = async (url: string) => {
            if (url.includes('weibo')) throw new Error('断网');
            if (url.includes('baidu')) return { ok: false, status: 403, json: async () => ({}) };
            const body = url.includes('popular') ? { data: { list: [{ title: '舒服了', tname: '单机游戏' }] } } : { list: [{ show_name: '热搜词' }] };
            return { ok: true, status: 200, json: async () => body };
        };
        const lists = await fetchLists(doFetch, m => logs.push(m));
        assert.equal(lists.popular.length, 3, '三页');
        assert.deepEqual(lists.hot, ['热搜词']);
        assert.deepEqual([lists.weibo, lists.baidu], [[], []]);
        assert.ok(logs.some(l => l.includes('微博热搜') && l.includes('断网')) && logs.some(l => l.includes('百度热榜') && l.includes('403')));
    });
});

describe('让模型挑词、写解释：规则在代码里', () => {
    test('候选：去掉带 X 的句式、太短太长、带书名号引号、敏感词、重复；最多 12 个', () => {
        const reply = ['哈基米', '最X的一集', '梗', '这是一个特别特别特别长的整句视频标题', '《某部电影》', '地震救援', '哈基米', '抽象', '世一上归位', '随便说说']
            .map(w => JSON.stringify({ 词: w, 来源: '榜' })).join('\n') + '\n不是 JSON 的一行\n{坏了';
        assert.deepEqual(parseCandidates(reply), ['哈基米', '抽象', '世一上归位', '随便说说']);
        const many = Array.from({ length: 30 }, (_, i) => JSON.stringify({ 词: `梗词${String.fromCharCode(0x4e00 + i)}` })).join('\n');
        assert.equal(parseCandidates(many).length, 12);
    });

    test('提示词里有各个榜、要求只摘原词', () => {
        const lists: MemeLists = { popular: [{ title: '你还是下去通透吧', tname: '日常' }], hot: ['大类魂理论'], weibo: ['人一旦在有地铁的城市待久了'], baidu: ['研究生毕业 不用写论文'] };
        const prompt = candidatePrompt(lists);
        for (const text of ['你还是下去通透吧', '大类魂理论', '人一旦在有地铁的城市待久了', '研究生毕业 不用写论文', '原样摘自标题', '不要：新闻、政治、灾害']) assert.ok(prompt.includes(text), text);
    });

    const good = { 是梗: true, 意思: '调侃某上单选手重回世界第一上单的状态，多用于英雄联盟赛事圈', 例句: '世一上归位，今天真猛', 为什么好笑: '把选手自称的世界第一当真了，反差好笑', 什么时候别用: '他认真说比赛的时候别用来打岔', 把握: '高', 适合聊天: true };
    test('解释：是梗、把握中 / 高、适合聊天才收；意思 6–60 字、例句 ≤ 24 字、不碰敏感词', () => {
        const ok = parseExplain('世一上归位', JSON.stringify(good))!;
        assert.equal(ok.confidence, 'high');
        assert.equal(ok.term, '世一上归位');
        assert.equal(parseExplain('x', JSON.stringify({ ...good, 把握: '中' }))?.confidence, 'mid');
        for (const patch of [{ 是梗: false }, { 把握: '低' }, { 把握: undefined }, { 适合聊天: false }, { 适合聊天: undefined }, { 意思: '太短' }, { 意思: '长'.repeat(61) }, { 例句: '长'.repeat(25) }, { 意思: '用来骂人的黑话，带着侮辱的意思' }, { 例句: '去死吧你' }]) {
            assert.equal(parseExplain('x', JSON.stringify({ ...good, ...patch })), undefined, JSON.stringify(patch));
        }
        assert.equal(parseExplain('x', '不是 JSON'), undefined);
        assert.equal(parseExplain('x', '{"是梗":false}'), undefined);
    });

    test('解释的提示词：只根据证据、写明哪些情形不适合', () => {
        const prompt = explainPrompt('抽象', ['视频《什么是抽象》字幕：……']);
        for (const text of ['只根据上面的文字', '视频《什么是抽象》', '政治、灾难、案件、低俗、地域或性别攻击', '只能猜就是低']) assert.ok(prompt.includes(text), text);
    });
});

describe('找证据', () => {
    test('标题带这个词、又像在解释的视频排前面；读字幕、简介、热评；最多 EVIDENCE_VIDEOS 条', async () => {
        const searched: string[] = [];
        const videos = [video('无关的视频', 1), video('抽象到底是什么意思？一期讲明白', 2, '科普'), video('抽象 合集', 3), video('今日份快乐', 4), video('抽象是什么梗', 5)];
        const evidence = await gatherEvidence('抽象', {
            search: async k => { searched.push(k); return videos; },
            subtitle: async v => ({ status: 'ok', lan: 'zh', lines: [`${v.title}的字幕第一句`, '第二句'] }),
            hotComments: async aid => [`热评${aid}`],
            sleep: async () => undefined,
        });
        assert.deepEqual(searched, ['抽象 什么梗']);
        assert.equal(evidence.length, EVIDENCE_VIDEOS);
        assert.ok(evidence[0]!.includes('抽象到底是什么意思') && evidence[1]!.includes('抽象是什么梗'), evidence.join('\n'));
        assert.ok(evidence[0]!.includes('字幕：') && evidence[0]!.includes('热评：热评2'));
        assert.ok(!evidence.some(e => e.includes('无关的视频')));
    });

    test('字幕 / 热评读不到不影响别的', async () => {
        const evidence = await gatherEvidence('抽象', {
            search: async () => [video('抽象是什么梗', 1, '简介里有解释')],
            subtitle: async () => { throw new Error('需要登录'); },
            hotComments: async () => { throw new Error('限流'); },
            sleep: async () => undefined,
        });
        assert.equal(evidence.length, 1);
        assert.ok(evidence[0]!.includes('简介：简介里有解释') && !evidence[0]!.includes('字幕：'));
    });
});

describe('刷新', () => {
    const lists: MemeLists = { popular: [{ title: '标题', tname: '日常' }], hot: ['热搜'], weibo: [], baidu: [] };
    const jsonLine = (词: string) => JSON.stringify({ 词 });
    const explainReply = (meaning: string) => JSON.stringify({ 是梗: true, 意思: meaning, 例句: '例句来一个', 为什么好笑: '反差和夸张，梗的底子是同一个玩笑', 什么时候别用: '他认真说事的时候别用', 把握: '中', 适合聊天: true });
    const make = (options: { lists?: MemeLists; terms?: string[]; evidence?: (term: string) => string[]; explain?: (term: string) => string } = {}) => {
        const path = tmp();
        const logs: string[] = [];
        const asked: string[] = [];
        const deps = {
            path, now: () => now, log: (m: string) => logs.push(m),
            fetchLists: async () => options.lists ?? lists,
            ask: async (prompt: string) => {
                asked.push(prompt);
                if (prompt.startsWith('下面是今天几个榜单')) return (options.terms ?? ['哈基米', '抽象']).map(jsonLine).join('\n');
                const term = /词：「(.+?)」/.exec(prompt)![1]!;
                return options.explain ? options.explain(term) : explainReply(`${term}是个流行的网络梗，用来调侃`);
            },
            gather: async (term: string) => (options.evidence ? options.evidence(term) : [`证据 ${term}`]),
        };
        return { deps, path, logs, asked };
    };

    test('新词：找证据、写解释、存下来；老词：又出现了就记一笔；存盘有刷新时间', async () => {
        const { deps, path } = make();
        const first = await refreshMemes(deps);
        assert.deepEqual([first.added, first.bumped], [2, 0]);
        const file = loadMemes(path);
        assert.deepEqual(file.entries.map(e => e.term).sort(), ['哈基米', '抽象']);
        assert.equal(file.refreshedAt, now.toISOString());
        assert.equal(file.entries[0]!.firstSeen, '2026-11-12');
        const second = await refreshMemes({ ...deps, now: () => new Date(2026, 10, 14, 9, 0) });
        assert.deepEqual([second.added, second.bumped], [0, 2]);
        const again = loadMemes(path).entries.find(e => e.term === '抽象')!;
        assert.deepEqual([again.seen, again.firstSeen, again.lastSeen], [2, '2026-11-12', '2026-11-14']);
    });

    test('没有证据的、模型不收的（不是梗 / 把握低）不进库；一次最多给 MEME_EXPLAIN_PER_RUN 个新词找证据', async () => {
        const terms = Array.from({ length: 12 }, (_, i) => `梗词${String.fromCharCode(0x4e00 + i)}`);
        const { deps, path } = make({ terms, evidence: t => (t.endsWith('一') ? [] : [`证据 ${t}`]), explain: t => (t.endsWith('丁') ? '{"是梗":false}' : explainReply(`${t}是个流行的网络梗，用来调侃`)) });
        const result = await refreshMemes(deps);
        assert.equal(result.tried, MEME_EXPLAIN_PER_RUN);
        const kept = loadMemes(path).entries.map(e => e.term);
        assert.ok(!kept.includes('梗词一') && !kept.includes('梗词丁'));
        assert.ok(kept.length <= MEME_EXPLAIN_PER_RUN - 2 && kept.length >= 4, `${kept.length}`);
    });

    test('四个榜都没读到：不动库、不调模型；挑词失败：不动；某个词出错不影响别的', async () => {
        const empty = make({ lists: { popular: [], hot: [], weibo: [], baidu: [] } });
        assert.equal((await refreshMemes(empty.deps)).skipped, '没读到榜');
        assert.equal(empty.asked.length, 0);
        const failing = make();
        failing.deps.ask = async () => { throw new Error('模型挂了'); };
        assert.equal((await refreshMemes(failing.deps)).skipped, '挑词失败');
        assert.ok(failing.logs.some(l => l.includes('挑词失败')));
        const partial = make({ evidence: t => { if (t === '哈基米') throw new Error('搜索被限流'); return [`证据 ${t}`]; } });
        const result = await refreshMemes(partial.deps);
        assert.equal(result.added, 1);
        assert.ok(partial.logs.some(l => l.includes('「哈基米」没弄成')));
    });

    test('过期的去掉、最多留 MEME_MAX 个；refreshDue：没刷过 / 满 12 小时才该刷', () => {
        const old = entry('旧梗', { lastSeen: '2026-09-01' });
        const fresh = entry('新梗');
        assert.deepEqual(trimMemes([old, fresh], now).map(e => e.term), ['新梗']);
        const edgeDay = new Date(2026, 10, 12 - MEME_KEEP_DAYS);
        const edge = entry('刚好', { lastSeen: `${edgeDay.getFullYear()}-${String(edgeDay.getMonth() + 1).padStart(2, '0')}-${String(edgeDay.getDate()).padStart(2, '0')}` });
        assert.equal(trimMemes([edge], now).length, 1, `${MEME_KEEP_DAYS} 天整还算`);
        const many = Array.from({ length: MEME_MAX + 10 }, (_, i) => entry(`梗${i}`, { lastSeen: i % 2 ? '2026-11-12' : '2026-11-11' }));
        assert.equal(trimMemes(many, now).length, MEME_MAX);
        assert.equal(refreshDue({ version: 1, entries: [] }, now), true);
        assert.equal(refreshDue({ version: 1, refreshedAt: new Date(now.getTime() - 3 * 3_600_000).toISOString(), entries: [] }, now), false);
        assert.equal(refreshDue({ version: 1, refreshedAt: new Date(now.getTime() - 13 * 3_600_000).toISOString(), entries: [] }, now), true);
    });

    test('库所在的目录还不存在（线上第一次）：先建目录再存，不抛', async () => {
        const { deps, path } = make();
        const nested = join(path, '..', 'not-yet', 'memes', 'memes.json');
        const result = await refreshMemes({ ...deps, path: nested });
        assert.equal(result.added, 2);
        assert.equal(loadMemes(nested).entries.length, 2);
    });

    test('库文件坏了 / 有不合格的条目：保原拒读，不把作者意图猜为空白', () => {
        const path = tmp();
        writeFileSync(path, '{坏了');
        assert.throws(() => loadMemes(path));
        assert.equal(readFileSync(path, 'utf8'), '{坏了');
        writeFileSync(path, JSON.stringify({ version: 1, entries: [entry('好的'), { term: '缺字段' }, { ...entry('把握不对'), confidence: 'low' }] }));
        const before = readFileSync(path, 'utf8');
        assert.throws(() => loadMemes(path));
        assert.equal(readFileSync(path, 'utf8'), before);
    });
});

describe('放进提示词', () => {
    const chat = (...texts: string[]) => texts.map((content, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content, time: new Date(now.getTime() - (texts.length - i) * 60_000).toISOString() }));

    test('他用到库里的梗：给意思让她接，别说没听懂、别解释、别拆梗；最长的词优先', () => {
        const entries = [entry('通透'), entry('你还是下去通透吧', { meaning: '劝人想开的抽象说法，用来调侃' })];
        const used = memeUsed(entries, chat('在吗', '在呢', '你还是下去通透吧')) ;
        assert.equal(used?.term, '你还是下去通透吧');
        const line = memeLine(entries, chat('在吗', '在呢', '你还是下去通透吧'), now.getTime())!;
        for (const text of ['你还是下去通透吧', '劝人想开的抽象说法', '别说「没听懂」', '别解释梗、别拆梗']) assert.ok(line.includes(text), text);
        assert.equal(memeUsed(entries, chat('你还是下去通透吧', '哈哈', '今天好累')), undefined, '她回复过以后他说的才算');
    });

    test('没用到梗：约 MEME_TURN_SHARE 的轮次给最近的 3 个；同一句每次一样；话赶话才用、别硬用、难过时不用', () => {
        const entries = ['哈基米', '抽象', '世一上归位', '老六', '电子榨菜'].map(t => entry(t));
        const hits = Array.from({ length: 400 }, (_, i) => memeLine(entries, chat('在吗', '在呢', `今天吃了拉面${i}`), now.getTime())).filter(Boolean);
        assert.ok(hits.length > 400 * MEME_TURN_SHARE * 0.7 && hits.length < 400 * MEME_TURN_SHARE * 1.3, `400 轮里 ${hits.length}`);
        const sample = hits[0]!;
        for (const text of ['先判断这场合合不合用', '不解释、不点破', '别硬塞', '他难过或认真说事的时候一律不用', '为什么好笑', '什么时候别用']) assert.ok(sample.includes(text), text);
        assert.equal((sample.match(/「/g) ?? []).length, 3);
        const same = chat('在吗', '在呢', '今天吃了拉面0');
        assert.equal(memeLine(entries, same, now.getTime()), memeLine(entries, same, now.getTime()));
    });

    test('她最近说过的梗不再放；过期（30 天没在榜上）的不放；没有梗就没有这一行', () => {
        const one = [entry('哈基米')];
        const find = (history: ReturnType<typeof chat>, entries: MemeEntry[]) => { for (let i = 0; i < 60; i++) { const h = [...history.slice(0, -1), { ...history.at(-1)!, content: `吃了拉面${i}` }]; const line = memeLine(entries, h, now.getTime()); if (line) return line; } return undefined; };
        assert.ok(find(chat('在吗', '在呢', 'x'), one));
        assert.equal(find(chat('在吗', '又是哈基米', 'x'), one), undefined, '她刚说过');
        assert.equal(find(chat('在吗', '在呢', 'x'), [entry('老梗', { lastSeen: '2026-09-20' })]), undefined, '太久没在榜上');
        assert.equal(memeLine([], chat('在吗'), now.getTime()), undefined);
    });
});

// 2026-10-29：库里 14 个梗，她一条都没用过——大部分不是梗（查询残留、人名产品、新闻、通用词）
test('当梗用不起来的词被挡掉，真梗留着', () => {
    assert.equal(isUsableMeme('蓝色大肥鱼是什么梗'), false, '查询残留');
    assert.equal(isUsableMeme('iphone duo'), false, '产品名');
    assert.equal(isUsableMeme('发哥'), false, '人名');
    assert.equal(isUsableMeme('代码'), false, '通用词');
    assert.equal(isUsableMeme('信了贵州辣卤不辣'), false, '新闻');
    assert.equal(isUsableMeme('启动！'), true);
    assert.equal(isUsableMeme('省流'), true);
    assert.equal(isUsableMeme('三年之期已到'), true);
});

test('挑梗时把不能用的滤掉：库里只剩真梗才进提示词', () => {
    const entries = [entry('蓝色大肥鱼是什么梗'), entry('发哥'), entry('启动！')];
    // 约 20% 的轮次才给这一行，多试几句直到抽中
    let line: string | undefined;
    for (let i = 0; i < 60 && !line; i++) {
        line = memeLine(entries, [{ role: 'user', content: `今天好累${i}`, time: '2026-11-12T20:00:00+08:00' }], now.getTime());
    }
    assert.ok(line?.includes('启动！'), line ?? '空');
    assert.ok(!line?.includes('发哥'), line ?? '空');
    assert.ok(!line?.includes('什么梗'), line ?? '空');
});

// 2026-10-29：她要理解「为什么有这个梗」「什么时候不该用」，说不出来就不收
test('解释里没有笑点/失效条件的不收', () => {
    const base = { 是梗: true, 意思: '调侃某个场面的话，多用于熟人之间', 例句: '这也太离谱了', 把握: '高', 适合聊天: true };
    assert.equal(parseExplain('x', JSON.stringify(base)), undefined, '缺为什么好笑');
    assert.ok(parseExplain('x', JSON.stringify({ ...base, 为什么好笑: '把小事说得很夸张，反差好笑' })), '有笑点就收（失效条件可以缺）');
    const entry = parseExplain('x', JSON.stringify({ ...base, 为什么好笑: '把小事说得很夸张，反差好笑', 什么时候别用: '他家里出事的时候别用' }));
    assert.equal(entry?.avoid, '他家里出事的时候别用');
});
