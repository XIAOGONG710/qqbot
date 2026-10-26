import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { SEARCH_KEYWORDS, type BiliVideo } from '../src/bilibili.ts';
import { themesFor, thinkNote, THOUGHT_THEMES, validInnerState, WATCH_THEME } from '../src/inner.ts';
import {
    keywordsFor, loadWatched, trimWatched, WATCH_FROM_HOUR, WATCH_KEYWORD_TRIES, WATCH_VIDEO_TRIES, watchDue, watchedFacts, watchedLine, watchOne, WATCHED_KEEP_DAYS, WATCHED_MAX,
    type Watched,
} from '../src/watching.ts';

// ADR 0130：她自己在 B 站看东西、形成看法
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-watching-')); dirs.push(d); return join(d, 'watched.json'); };
const at = (h: number, day = 12) => new Date(2026, 10, day, h, 0);
const video = (bvid: string, title = `视频${bvid}`, patch: Partial<BiliVideo> = {}): BiliVideo => ({ bvid, aid: 100, title, desc: '', owner: '某UP', category: '日常', views: 50000, likes: 500, duration: 180, link: `https://www.bilibili.com/video/${bvid}`, ...patch });
const watched = (day: string, patch: Partial<Watched> = {}): Watched => ({ bvid: `BV${day}`, title: `标题${day}`, owner: 'UP', tname: '日常', excerpt: '字幕大意：今天去了食堂，发现新窗口开了', hot: ['热评一', '热评二'], day, ...patch });

describe('存取、过期', () => {
    test('读：坏文件当空的；不合格的条目忽略；过期的去掉、最多留 WATCHED_MAX 条', () => {
        const path = tmp();
        writeFileSync(path, '{坏了');
        assert.deepEqual(loadWatched(path).entries, []);
        writeFileSync(path, JSON.stringify({ version: 1, entries: [watched('2026-11-12'), { title: '缺字段' }, { ...watched('2026-11-11'), excerpt: '  ' }] }));
        assert.equal(loadWatched(path).entries.length, 1);
        const old = watched('2026-09-01');
        assert.deepEqual(trimWatched([old, watched('2026-11-12')], at(20)).map(e => e.day), ['2026-11-12']);
        const edge = new Date(2026, 10, 12 - WATCHED_KEEP_DAYS);
        const edgeDay = `${edge.getFullYear()}-${String(edge.getMonth() + 1).padStart(2, '0')}-${String(edge.getDate()).padStart(2, '0')}`;
        assert.equal(trimWatched([watched(edgeDay)], at(20)).length, 1);
        const many = Array.from({ length: WATCHED_MAX + 5 }, (_, i) => watched('2026-11-12', { bvid: `BV${i}` }));
        assert.equal(trimWatched(many, at(20)).length, WATCHED_MAX);
    });

    test('watchDue：14 点以后、今天还没看过才该看', () => {
        assert.equal(watchDue([], at(WATCH_FROM_HOUR - 1)), false);
        assert.equal(watchDue([], at(WATCH_FROM_HOUR)), true);
        assert.equal(watchDue([watched('2026-11-12')], at(20)), false);
        assert.equal(watchDue([watched('2026-11-11')], at(20)), true);
    });

    test('关键词：当天的那个，再往后两个；同一天每次一样', () => {
        const words = keywordsFor('2026-11-12');
        assert.equal(words.length, WATCH_KEYWORD_TRIES);
        assert.equal(new Set(words).size, WATCH_KEYWORD_TRIES);
        assert.ok(words.every(w => SEARCH_KEYWORDS.includes(w)));
        assert.deepEqual(words, keywordsFor('2026-11-12'));
    });
});

describe('她看一个', () => {
    const make = (options: { search?: (k: string) => BiliVideo[]; subtitle?: (v: BiliVideo) => { status: 'ok'; lan: string; lines: string[] } | { status: 'none' }; failSearch?: boolean; view?: (v: BiliVideo) => { cid?: number; chapters: { from: number; title: string }[] } | undefined; danmaku?: readonly { at: number; text: string }[]; storyboard?: readonly string[]; describeImage?: (url: string) => string | undefined } = {}) => {
        const path = tmp();
        const logs: string[] = [];
        const searched: string[] = [];
        let subtitles = 0;
        const deps = {
            path, now: () => at(20), log: (m: string) => logs.push(m),
            search: async (k: string) => { searched.push(k); if (options.failSearch) throw new Error('断网'); return options.search ? options.search(k) : [video('BV1aaaaaaaaa'), video('BV1bbbbbbbbb')]; },
            subtitle: async (v: BiliVideo) => { subtitles++; return options.subtitle ? options.subtitle(v) : { status: 'ok' as const, lan: 'zh', lines: [`${v.title}的第一句`, '第二句', '第三句'] }; },
            hotComments: async () => ['热评甲甲甲甲甲甲', '热评乙乙乙乙乙乙', '热评丙丙丙丙丙丙'],
            ...(options.view ? { view: async (v: BiliVideo) => options.view!(v) } : {}),
            ...(options.danmaku ? { danmaku: async () => options.danmaku! } : {}),
            ...(options.storyboard ? { storyboard: async () => options.storyboard! } : {}),
            ...(options.describeImage ? { describeImage: async (url: string) => options.describeImage!(url) } : {}),
            sleep: async () => undefined,
        };
        return { deps, path, logs, searched, subtitles: () => subtitles };
    };

    test('搜 → 有字幕的就是它 → 存摘要和两条热评；今天只看一个', async () => {
        const { deps, path } = make();
        assert.equal(await watchOne(deps), 'watched');
        const entries = loadWatched(path).entries;
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.day, '2026-11-12');
        assert.ok(entries[0]!.excerpt.length > 0 && [...entries[0]!.excerpt].length <= 230);
        assert.equal(entries[0]!.hot.length, 2);
        assert.equal(await watchOne(deps), 'done', '今天看过了');
        assert.equal(loadWatched(path).entries.length, 1);
    });

    test('看的时候多拿章节和弹幕高能（ADR 0168）；读不到就不写', async () => {
        const rich = make({
            view: () => ({ cid: 42, chapters: [{ from: 0, title: '开场' }, { from: 60, title: '正题' }] }),
            danmaku: [{ at: 65, text: '哈哈哈哈' }, { at: 66, text: '笑死' }, { at: 67, text: '前面高能' }],
        });
        assert.equal(await watchOne(rich.deps), 'watched');
        const entry = loadWatched(rich.path).entries[0]!;
        assert.deepEqual(entry.chapters, [{ from: 0, title: '开场' }, { from: 60, title: '正题' }]);
        assert.equal(entry.peaks?.[0]?.at, 60);
        assert.ok((entry.peaks?.[0]?.count ?? 0) >= 3);
        const facts = watchedFacts([entry], at(20))!.text;
        assert.match(facts, /分段：0:00 开场、1:00 正题/);
        assert.match(facts, /观众反应最强烈/);

        const bare = make();
        assert.equal(await watchOne(bare.deps), 'watched');
        const plain = loadWatched(bare.path).entries[0]!;
        assert.equal(plain.chapters, undefined);
        assert.equal(plain.peaks, undefined);
    });

    test('画面总览：雪碧图交给看图模型写了一两句（ADR 0168）；看不成图就不写', async () => {
        const seen: string[] = [];
        const rich = make({
            view: () => ({ cid: 7, chapters: [] }),
            storyboard: ['https://i0.hdslb.com/bfs/story/s1.jpg', 'https://i0.hdslb.com/bfs/story/s2.jpg'],
            describeImage: url => { seen.push(url); return url.endsWith('s1.jpg') ? '画面是傍晚的街道，几个路人站在路边' : undefined; },
        });
        assert.equal(await watchOne(rich.deps), 'watched');
        const entry = loadWatched(rich.path).entries[0]!;
        assert.equal(entry.frames, '画面是傍晚的街道，几个路人站在路边');
        assert.deepEqual(seen, ['https://i0.hdslb.com/bfs/story/s1.jpg']);
        assert.match(watchedFacts([entry], at(20))!.text, /画面总览：画面是傍晚的街道/);

        const none = make({ view: () => ({ cid: 7, chapters: [] }), storyboard: [], describeImage: () => '不该被用' });
        assert.equal(await watchOne(none.deps), 'watched');
        assert.equal(loadWatched(none.path).entries[0]!.frames, undefined);
    });

    test('目录还不存在（线上第一次）：先建目录再存，不抛', async () => {
        const { deps, path } = make();
        const nested = join(path, '..', 'not-yet', 'watching', 'watched.json');
        assert.equal(await watchOne({ ...deps, path: nested }), 'watched');
        assert.equal(loadWatched(nested).entries.length, 1);
    });

    test('没有字幕的跳过去看下一个；一个关键词没有就换下一个词；都没有就记一行、不存', async () => {
        const none = make({ subtitle: () => ({ status: 'none' }) });
        assert.equal(await watchOne(none.deps), 'none');
        assert.equal(none.searched.length, WATCH_KEYWORD_TRIES, '换了几个词');
        assert.ok(none.subtitles() <= WATCH_KEYWORD_TRIES * WATCH_VIDEO_TRIES);
        assert.deepEqual(loadWatched(none.path).entries, []);
        assert.ok(none.logs.some(l => l.includes('今天没找到合适的')));
        let n = 0;
        const second = make({ subtitle: v => (++n === 1 ? { status: 'none' } : { status: 'ok', lan: 'zh', lines: [`${v.title}大意`] }) });
        assert.equal(await watchOne(second.deps), 'watched');
        assert.equal(second.searched.length, 1, '同一个词里第二个视频有字幕就不换词');
    });

    test('不合口味的视频（分区、广告、太长）不看；看过的不再看；搜索失败记日志不抛', async () => {
        const bad = make({ search: () => [video('BV1cccccccc1', '某某广告', {}), video('BV1cccccccc2', '正常', { category: '新闻综合' }), video('BV1cccccccc3', '太长', { duration: 3600 })] });
        assert.equal(await watchOne(bad.deps), 'none');
        assert.equal(bad.subtitles(), 0);
        const path = tmp();
        writeFileSync(path, JSON.stringify({ version: 1, entries: [watched('2026-11-11', { bvid: 'BV1aaaaaaaaa' })] }));
        const seen = make();
        seen.deps.path = path;
        assert.equal(await watchOne(seen.deps), 'watched');
        assert.ok(loadWatched(path).entries.some(e => e.bvid === 'BV1bbbbbbbbb') && loadWatched(path).entries.filter(e => e.bvid === 'BV1aaaaaaaaa').length === 1);
        const failing = make({ failSearch: true });
        assert.equal(await watchOne(failing.deps), 'none');
        assert.ok(failing.logs.some(l => l.includes('搜') && l.includes('断网')));
    });
});

describe('放进提示词', () => {
    test('watchedFacts：只放最近 3 天里最新的一条，写明是哪天看的、字幕大意、热评；没有就没有', () => {
        const entries = [watched('2026-11-12'), watched('2026-11-11'), watched('2026-11-01')];
        const found = watchedFacts(entries, at(21))!;
        const facts = found.text;
        assert.equal(found.id, 'BV2026-11-12');
        assert.ok(facts.includes('今天看的《标题2026-11-12》') && facts.includes('字幕大意') && facts.includes('热评里有人说：热评一 / 热评二'));
        assert.ok(!facts.includes('标题2026-11-11'));
        assert.equal(watchedFacts([watched('2026-11-01')], at(21)), undefined);
        assert.ok(watchedFacts([watched('2026-11-10')], at(21))!.text.includes('11-10看的'));
    });

    test('watchedLine：他问到“最近看了什么 / 刷到什么 / B 站”才放，给最近的两条；没问就没有', () => {
        const entries = [watched('2026-11-12'), watched('2026-11-11'), watched('2026-11-10')];
        const chat = (text: string) => [{ role: 'assistant' as const, content: '在呢' }, { role: 'user' as const, content: text }];
        for (const text of ['你最近在看什么', '最近刷到什么好玩的了吗', '你都看了啥', '你是不是又在刷B站', '最近有什么好看的视频']) assert.ok(watchedLine(entries, chat(text), at(21)), text);
        for (const text of ['在干嘛', '今天累不累', '晚上吃什么']) assert.equal(watchedLine(entries, chat(text), at(21)), undefined, text);
        const line = watchedLine(entries, chat('你最近在看什么'), at(21))!;
        assert.ok(line.includes('标题2026-11-12') && line.includes('标题2026-11-11') && !line.includes('标题2026-11-10'));
        for (const phrase of ['真看过', '细节别编', '别照着念字幕']) assert.ok(line.includes(phrase), phrase);
        assert.equal(watchedLine([], chat('你最近在看什么'), at(21)), undefined);
    });
});

describe('想事情时多一个题目', () => {
    test('themesFor：没看过东西时和原来一样；看过时多出 WATCH_THEME 这一个题目', () => {
        for (let i = 0; i < 12; i++) {
            const [a, b] = themesFor(i);
            assert.ok(THOUGHT_THEMES.includes(a as never) && THOUGHT_THEMES.includes(b as never));
        }
        const seen = Array.from({ length: 12 }, (_, i) => themesFor(i, true)).flat();
        assert.ok(seen.includes(WATCH_THEME));
        assert.ok(seen.filter(t => t === WATCH_THEME).length >= 4, '不是偶尔才有');
    });

    test('thinkNote：有看过的就写事实（真的看过、想法自己定、不编）；没有就没有这一段，也不会挑到这个题目', () => {
        const facts = '今天看的《标题》（UP 主「某」，日常）：字幕大意——今天去了食堂';
        const note = thinkNote([], '他', 0, false, facts);
        for (const phrase of ['你最近在 B 站看过（真的看过，读了字幕', '想法由你自己定', '不编里面没有的情节', '今天去了食堂']) assert.ok(note.includes(phrase), phrase);
        for (let i = 0; i < 12; i++) assert.ok(!thinkNote([], '他', i).includes(WATCH_THEME) && !thinkNote([], '他', i).includes('你最近在 B 站看过（'), `没看过时第 ${i} 个`);
        assert.ok(Array.from({ length: 12 }, (_, i) => thinkNote([], '他', i, false, facts)).some(n => n.includes(WATCH_THEME)));
    });
    test('forceWatch：这一次就想这一件，不再二选一；没有看过的事实时不生效', () => {
        const facts = '今天看的《标题》（UP 主「某」，日常）：字幕大意——今天去了食堂';
        const forced = thinkNote([], '他', 0, false, facts, true);
        assert.ok(forced.includes('这一次就想这一件：') && forced.includes(WATCH_THEME) && !forced.includes('这一次从这两样里挑一样想'));
        const optional = thinkNote([], '他', 0, false, facts, false);
        assert.ok(optional.includes('这一次从这两样里挑一样想') && !optional.includes('这一次就想这一件'));
        const none = thinkNote([], '他', 0, false, undefined, true);
        assert.ok(none.includes('这一次从这两样里挑一样想') && !none.includes(WATCH_THEME));
    });

    test('念头状态里的 reflected（想过的视频编号）：认得、存得下；不是字符串数组就不合格', () => {
        assert.equal(validInnerState({ thoughts: [], reflected: ['BV1xx'] }), true);
        assert.equal(validInnerState({ thoughts: [] }), true);
        assert.equal(validInnerState({ thoughts: [], reflected: [1] }), false);
        assert.equal(validInnerState({ thoughts: [], reflected: 'BV1xx' }), false);
    });
});
