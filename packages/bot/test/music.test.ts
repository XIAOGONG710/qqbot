import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { inspectReply } from '../src/exit-check.ts';
import type { StoredMessage } from '../src/history.ts';
import {
    describeMusic, loadMusic, lyricLines, markShared, MUSIC_GAP_DAYS, MUSIC_KEEP_SHARED_DAYS, MUSIC_PICKS, MUSIC_REFRESH_MS, mostlyChinese, parseChart, pickLyric,
    readyPick, refreshMusic, saveMusic, shareMusicCard, usableTrack, type MusicPick, type MusicState, type Track,
} from '../src/music.ts';
import {
    blockReason, candidatesOn, DEFAULT_NEWS_KINDS, newsKindsOf, occasionNote, untoldNews, withMusic,
    type Candidate, type NewsItem, type ProactiveInput,
} from '../src/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive-planner.ts';
import { createResponder, type InitiateOutcome, type InitiateRequest, type ResponderDeps } from '../src/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { MUSIC_SHARE_CHANCE, worldNews, type WorldNow } from '../src/world.ts';

// ADR 0139：听到一首歌分享给他（歌曲卡片 + 一两句话）。歌名、歌词都是测试里编的
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-11T21:40:00+08:00');
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-music-')); dirs.push(d); return d; };
let planner: Planner | undefined;
afterEach(() => { planner?.stop(); planner = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const track = (patch: Partial<Track> = {}): Track => ({ id: 1, name: '晚风小站', artists: ['阿夏'], duration: 210_000, playable: true, ...patch });
const pick = (id: number, patch: Partial<MusicPick> = {}): MusicPick => ({ id, title: `歌${id}`, artist: '阿夏', chart: '飙升榜', lyric: ['晚风吹过楼顶的灯', '你的名字在耳边亮着'], ...patch });
const state = (picks: MusicPick[], shared: Record<string, string> = {}): MusicState => ({ version: 1, picks, shared });

const LRC = [
    '[00:00.00] 作词 : 阿夏', '[00:01.00] 作曲 : 阿夏', '[00:02.00] 编曲 : 小林', '[00:03.00]词：阿夏',
    '[00:10.00]晚风吹过楼顶的灯', '[00:14.00]你的名字在耳边亮着', '[00:18.00]我把夏天折成一只纸船',
    '[00:30.00]verse 2', '[00:32.00]走过空荡荡的操场', '[00:36.00]风吹过楼顶的灯一直亮着',
    '[00:50.00]我把夏天折成一只纸船', '[00:54.00]漂向你家那条街', '[01:10.00]我把夏天折成一只纸船', '[01:14.00]漂向你家那条街',
].join('\n');

describe('榜单和曲目', () => {
    test('parseChart：认得出的结构取出 id / 歌名 / 歌手 / 时长 / 能不能播；坏结构返回空', () => {
        const raw = { result: { tracks: [{ id: 5, name: ' 歌 ', artists: [{ name: '甲' }, { name: '乙' }], duration: 200000, status: 0 }, { id: 'x' }, { id: 6, name: '歌2', artists: [], duration: 1, status: -1 }] } };
        assert.deepEqual(parseChart(raw), [
            { id: 5, name: '歌', artists: ['甲', '乙'], duration: 200000, playable: true },
            { id: 6, name: '歌2', artists: [], duration: 1, playable: false },
        ]);
        for (const bad of [null, {}, { result: {} }, { result: { tracks: 'x' } }, 'x']) assert.deepEqual(parseChart(bad), []);
    });

    test('usableTrack：能播、有歌手、时长合适、不是 DJ / 伴奏 / 翻唱 / 变速 / 现场', () => {
        assert.equal(usableTrack(track()), true);
        for (const patch of [{ playable: false }, { artists: [] }, { duration: 60_000 }, { duration: 9 * 60_000 }, { artists: ['群星'] }]) assert.equal(usableTrack(track(patch)), false, JSON.stringify(patch));
        for (const name of ['晚风 (DJ版)', '晚风 伴奏', '晚风 Remix', '晚风 (Live)', '晚风 0.8x', '晚风 (翻唱)', '晚风 女声版', '晚风 纯音乐']) assert.equal(usableTrack(track({ name })), false, name);
    });
});

describe('歌词', () => {
    test('lyricLines：去掉时间标签、署名行、段落标记', () => {
        const lines = lyricLines(LRC);
        assert.ok(lines.includes('晚风吹过楼顶的灯'));
        assert.ok(!lines.some(l => /作词|作曲|编曲|^词：|verse/i.test(l)), lines.join('|'));
    });

    test('pickLyric：重复最多的那句（副歌）加它后面的一句；整首里有脏话 / 危机相关的词就不要这首；太短的不要', () => {
        assert.deepEqual(pickLyric(LRC), ['我把夏天折成一只纸船', '漂向你家那条街']);
        assert.deepEqual(pickLyric(`${LRC}\n[01:20.00]他妈的这一句`), []);
        assert.deepEqual(pickLyric(`${LRC}\n[01:20.00]我真的不想活了`), []);
        assert.deepEqual(pickLyric('[00:01.00]一句\n[00:02.00]两句'), []);
        const noChorus = Array.from({ length: 10 }, (_, i) => `[00:${String(10 + i).padStart(2, '0')}.00]第${i}句不重复的歌词在这里`).join('\n');
        assert.equal(pickLyric(noChorus).length, 2);
    });

    test('mostlyChinese：中文歌词为主才要（俄语 / 日语 / 全英文的不要）', () => {
        assert.equal(mostlyChinese(['晚风吹过楼顶的灯', '你的名字在耳边亮着']), true);
        assert.equal(mostlyChinese(["I'm making my life right", "I'm living my life right"]), false);
        assert.equal(mostlyChinese(['Секретики, наши X File’ы']), false);
        assert.equal(mostlyChinese([]), false);
    });
});

describe('候选和发过的记录', () => {
    test('readyPick：没发过的第一首；上一首发出去不到 MUSIC_GAP_DAYS 天就没有；发过的歌不再发', () => {
        const picks = [pick(1), pick(2), pick(3)];
        assert.equal(readyPick(state(picks), NOW)?.id, 1);
        const shared = { '1': new Date(NOW - 1 * DAY).toISOString() };
        assert.equal(readyPick(state(picks, shared), NOW), undefined, '昨天刚发过');
        assert.equal(readyPick(state(picks, shared), NOW + (MUSIC_GAP_DAYS) * DAY)?.id, 2, '隔够了：下一首，不是 1');
        assert.equal(readyPick(state([], {}), NOW), undefined);
        assert.equal(MUSIC_GAP_DAYS, 3);
    });

    test('markShared：记下来，90 天之前的忘掉', () => {
        const old = { '9': new Date(NOW - (MUSIC_KEEP_SHARED_DAYS + 1) * DAY).toISOString(), '8': new Date(NOW - 10 * DAY).toISOString() };
        const next = markShared(state([pick(1)], old), 1, NOW);
        assert.deepEqual(Object.keys(next.shared).sort(), ['1', '8']);
        assert.equal(next.shared['1'], new Date(NOW).toISOString());
    });

    test('describeMusic：歌名、歌手、哪个榜、歌词；写明歌的故事 / 听了多少遍不编，歌词最多引一句', () => {
        const text = describeMusic(pick(7, { title: '晚风小站', artist: '阿夏', chart: '热歌榜' }));
        assert.ok(text.includes('《晚风小站》') && text.includes('阿夏') && text.includes('网易云热歌榜') && text.includes('「晚风吹过楼顶的灯」'));
        assert.match(text, /都别编/);
        assert.match(text, /最多一句/);
        assert.ok(!describeMusic(pick(7, { lyric: [] })).includes('歌词里有'));
    });

    test('存取：存了读得回；文件坏了当作没有、原文件不动', () => {
        const d = dir();
        const path = join(d, 'music', 'music.json');
        saveMusic(path, state([pick(1)], { '2': new Date(NOW).toISOString() }));
        assert.equal(loadMusic(path).picks[0]!.id, 1);
        const bad = join(d, 'bad.json');
        writeFileSync(bad, '{坏了');
        const logs: string[] = [];
        assert.deepEqual(loadMusic(bad, m => logs.push(m)).picks, []);
        assert.ok(logs.some(l => l.includes('读不了')));
        assert.equal(readFileSync(bad, 'utf8'), '{坏了');
        assert.deepEqual(loadMusic(join(d, 'none.json')), { version: 1, picks: [], shared: {} });
    });
});

describe('出口检查：卡片真发出去了，「发你」不算做不到的承诺', () => {
    const issues = (text: string, cardShared: boolean) => inspectReply(text, [], undefined, undefined, undefined, false, false, cardShared).map(i => i.kind);
    test('开着：这首发你了 / 发你听听 放行；发你照片 / 视频 / 语音 / 红包 还是拦；没发卡片的轮次照旧拦', () => {
        for (const text of ['这首发你了', '发你听听', '给你发了首歌', '发给你的这首最近老想听']) {
            assert.deepEqual(issues(text, true), [], text);
            assert.deepEqual(issues(text, false), ['promise'], `${text}：没发卡片就拦`);
        }
        for (const text of ['发你照片', '给你发张图', '发你视频', '给你发语音', '发个红包给你']) assert.deepEqual(issues(text, true), ['promise'], text);
    });
});

describe('出口检查：分享歌曲这一轮不编听歌经历', () => {
    test('单曲循环 / 循环了好几遍 / 听了一晚上 / 听了三遍：拦（只在发了卡片的轮次）；说听着的感觉不拦', () => {
        const kinds = (text: string, cardShared: boolean) => inspectReply(text, [], undefined, undefined, undefined, false, false, cardShared).map(i => i.kind);
        for (const text of ['我听了一遍就单曲循环了', '循环了好几遍', '这首我循环一晚上了', '听了三遍了', '听了又听', '前奏一起我就想发你了', '她的嗓音太绝了', '编曲很舒服']) {
            assert.deepEqual(kinds(text, true), ['made-up'], text);
            assert.ok(!kinds(text, false).includes('made-up'), `${text}：不是分享歌曲的轮次不管`);
        }
        for (const text of ['这句听着心里软了一下', '副歌那句有点戳我', '听着挺舒服的', '我听了你说的就笑了']) assert.deepEqual(kinds(text, true), [], text);
    });
});

describe('shareMusicCard：发卡片，发不出去改发文字链接', () => {
    const make = (sendMusic?: (userId: number, id: number) => Promise<number>) => {
        const sent: string[] = [];
        const logs: string[] = [];
        return { sent, logs, deps: { ...(sendMusic ? { sendMusic } : {}), sendText: async (_u: number, text: string) => { sent.push(text); return 77; }, log: (m: string) => logs.push(m) } };
    };

    test('发得出去：只发卡片；没有 sendMusic：发文字链接；出错：改发文字链接并记一行；超时：不重发', async () => {
        const ok = make(async () => 55);
        assert.equal(await shareMusicCard(ok.deps, 1, pick(42)), 55);
        assert.deepEqual(ok.sent, []);

        const none = make();
        assert.equal(await shareMusicCard(none.deps, 1, pick(42)), 77);
        assert.equal(none.sent[0], '歌42 - 阿夏\nhttps://music.163.com/song?id=42');

        const broken = make(async () => { throw new Error('OneBot 调用失败 retcode 100'); });
        assert.equal(await shareMusicCard(broken.deps, 1, pick(42)), 77);
        assert.equal(broken.sent.length, 1);
        assert.ok(broken.logs.some(l => l.includes('歌曲卡片没发出去') && l.includes('retcode 100')));

        const slow = make(async () => { throw new Error('OneBot 调用 send_private_msg 超时'); });
        await assert.rejects(shareMusicCard(slow.deps, 1, pick(42)), /超时/);
        assert.deepEqual(slow.sent, [], '超时可能已经发出去了：不再发链接');
    });
});

describe('refreshMusic：刷候选', () => {
    const chartOf = (ids: number[], extra: Record<string, unknown> = {}) => ({ result: { tracks: ids.map(id => ({ id, name: `歌${id}`, artists: [{ name: '阿夏' }], duration: 200_000, status: 0, ...extra })) } });
    const fakeGet = (calls: string[], overrides: Record<string, unknown> = {}) => async (url: string): Promise<unknown> => {
        calls.push(url);
        const chart = /playlist\/detail\?id=(\d+)/.exec(url);
        if (chart) return overrides[chart[1]!] ?? chartOf(chart[1] === '19723756' ? [1, 2, 3, 4, 5, 6, 7, 8] : chart[1] === '3779629' ? [9, 10, 11, 12, 13, 14, 15] : []);
        const id = /lyric\?id=(\d+)/.exec(url)![1]!;
        // 偶数 id 的歌是俄语的，11 没有歌词
        if (id === '11') return { lrc: { lyric: '' } };
        return { lrc: { lyric: Number(id) % 2 === 0 ? '[00:10.00]Секретики наши\n[00:12.00]Секретики наши\n[00:14.00]привет привет\n[00:16.00]ещё одна строка' : LRC } };
    };

    test('每个榜读一次，歌词挨个读，最多 MUSIC_PICKS 首；不是中文的、没歌词的跳过；存下来；日志不记歌名', async () => {
        const d = dir();
        const path = join(d, 'music.json');
        const calls: string[] = [];
        const logs: string[] = [];
        const n = await refreshMusic({ path, now: () => NOW, log: m => logs.push(m), get: fakeGet(calls), sleep: async () => undefined });
        assert.ok(n! > 0 && n! <= MUSIC_PICKS, `${n}`);
        const saved = loadMusic(path);
        assert.equal(saved.picks.length, n);
        assert.ok(saved.picks.every(p => p.id % 2 === 1 && p.id !== 11), saved.picks.map(p => p.id).join(','));
        assert.ok(saved.picks.every(p => p.lyric.length === 2 && p.artist === '阿夏'));
        assert.equal(calls.filter(c => c.includes('playlist/detail')).length, 4);
        assert.ok(logs.every(l => !l.includes('歌1')));
    });

    test('20 小时之内不再刷；发过的歌不进候选；一个榜失败不影响别的；一首都没有就不动', async () => {
        const d = dir();
        const path = join(d, 'music.json');
        const calls: string[] = [];
        await refreshMusic({ path, now: () => NOW, log: () => undefined, get: fakeGet(calls), sleep: async () => undefined });
        const before = calls.length;
        assert.equal(await refreshMusic({ path, now: () => NOW + MUSIC_REFRESH_MS - 1000, log: () => undefined, get: fakeGet(calls), sleep: async () => undefined }), undefined);
        assert.equal(calls.length, before, '没到间隔：一个请求都不发');

        const saved = loadMusic(path);
        saveMusic(path, markShared(saved, saved.picks[0]!.id, NOW));
        const logs: string[] = [];
        const get = fakeGet([], { '19723756': 'boom' });
        const failing = async (url: string): Promise<unknown> => { if (url.includes('id=19723756')) throw new Error('HTTP 500'); return get(url); };
        const n = await refreshMusic({ path, now: () => NOW + MUSIC_REFRESH_MS + 1000, log: m => logs.push(m), get: failing, sleep: async () => undefined });
        assert.ok(n! > 0);
        assert.ok(logs.some(l => l.includes('读飙升榜失败')));
        assert.ok(!loadMusic(path).picks.some(p => p.id === saved.picks[0]!.id), '发过的歌不进候选');

        const empty = join(d, 'empty.json');
        assert.equal(await refreshMusic({ path: empty, now: () => NOW, log: () => undefined, get: async () => ({}), sleep: async () => undefined }), undefined);
    });
});

const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const dayText = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const worldOf = (d: Date): WorldNow => ({ day: dayText(d), atSchool: true, parcels: [], homework: [], events: [] } as unknown as WorldNow);

describe('世界账：听到一首歌', () => {
    test('约 MUSIC_SHARE_CHANCE 的天有；时间在 20:30–22:30；同一天每次一样；没开这一类就没有', () => {
        const days = Array.from({ length: 300 }, (_, i) => new Date(2026, 9, 1 + i));
        const hits = days.flatMap(d => worldNews(worldOf(d), ['music_share']).map(n => ({ d, n })));
        assert.ok(hits.length > 300 * MUSIC_SHARE_CHANCE * 0.6 && hits.length < 300 * MUSIC_SHARE_CHANCE * 1.4, `300 天里 ${hits.length} 天`);
        for (const { d, n } of hits) {
            assert.equal(n.kind, 'music_share');
            assert.equal(n.id, `music_share:${dayText(d)}`);
            const minutes = n.at.getHours() * 60 + n.at.getMinutes();
            assert.ok(minutes >= 20 * 60 + 30 && minutes <= 22 * 60 + 30, `${n.at.toTimeString()}`);
            assert.equal(dayText(n.at), dayText(d));
        }
        assert.deepEqual(worldNews(worldOf(hits[0]!.d), ['music_share']), worldNews(worldOf(hits[0]!.d), ['music_share']));
        assert.equal(worldNews(worldOf(hits[0]!.d), DEFAULT_NEWS_KINDS).length, 0);
    });
});

describe('主动：听到一首歌', () => {
    test('withMusic：加上 news 时机和 music_share 这一类，卡上原来的不动；重复加不叠', () => {
        const base = boyfriend.proactive!;
        const on = withMusic(base);
        assert.ok(on.occasions.includes('news'));
        assert.ok(newsKindsOf(on).includes('music_share'));
        for (const kind of newsKindsOf(base)) assert.ok(newsKindsOf(on).includes(kind));
        assert.ok(!newsKindsOf(base).includes('music_share'));
        assert.deepEqual(withMusic(on), on);
    });

    const item = (day: string): NewsItem => ({ id: `music_share:${day}`, kind: 'music_share', day, at: t(10, 24, 21, 5), what: '听到一首歌' });
    const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
        qq: 10001, schedule, settings: withMusic(boyfriend.proactive!), dates: [], history: [], records: [], mode: 'on', news: [item('2026-10-24')], ...patch,
    });
    const candidate = (): Candidate => candidatesOn(new Date(2026, 9, 24), input()).find(c => c.occasion === 'news' && c.news?.kind === 'music_share')!;

    test('说明：卡片已经先发了，她只说一两句，不编往事、不问好听吗；没有候选歌 / 那之后聊过也不发', () => {
        const c = candidate();
        assert.ok(c, '有候选');
        const note = occasionNote(c, '宝宝');
        assert.ok(note.includes('歌曲卡片已经先发') && note.includes('听了几遍、听了多久都没写') && note.includes('这一条只说这首歌') && note.includes('「好听吗」') && note.includes('开头别老是同一种'), note);
        assert.equal(blockReason(c, c.at, input({ musicReady: () => true })), undefined);
        assert.match(blockReason(c, c.at, input())!, /没有可分享的歌/, '没给 musicReady = 不发');
        assert.match(blockReason(c, c.at, input({ musicReady: () => false }))!, /没有可分享的歌/);
        const chatted: StoredMessage[] = [{ time: new Date(t(10, 24, 21, 6)).toISOString(), role: 'user', content: '在吗' }, { time: new Date(t(10, 24, 21, 7)).toISOString(), role: 'assistant', content: '在' }];
        assert.ok(blockReason(c, t(10, 24, 22, 30), input({ musicReady: () => true, history: chatted })), '那之后聊过了');
    });

    test('“没说成的事”不会把这一类带进别的主动里', () => {
        const c: Candidate = { id: '2026-10-24:bedtime', occasion: 'bedtime', day: '2026-10-24', at: t(10, 24, 23, 30), reason: 'x' };
        assert.deepEqual(untoldNews(c, t(10, 24, 23, 30), { news: [item('2026-10-24')], records: [], history: [] }), []);
    });

    test('计划器：发这一条时 initiate 带 music，发出去之后记成发过（试运行不记）', async () => {
        for (const mode of ['on', 'dryRun'] as const) {
            const d = dir();
            const clock = new VirtualClock(new Date(t(10, 24, 20, 30)));
            const requests: InitiateRequest[] = [];
            const used: [number, number][] = [];
            const history = [
                { time: new Date(t(10, 24, 14, 0)).toISOString(), role: 'user' as const, content: '我先去忙了' },
                { time: new Date(t(10, 24, 14, 1)).toISOString(), role: 'assistant' as const, content: '好，晚点聊' },
            ];
            planner = createProactivePlanner({
                contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
                schedule, settings: { occasions: ['news'], newsKinds: ['music_share'], dailyMax: 3, unansweredMax: 2 }, dates: [], mode,
                history: { load: () => history },
                responder: {
                    initiate: async (request: InitiateRequest): Promise<InitiateOutcome> => {
                        requests.push(request);
                        request.commit(['这首最近老想听']);
                        return mode === 'on' ? { result: 'sent', parts: ['这首最近老想听'], messageIds: [1, 2] } : { result: 'dryRun', parts: ['这首最近老想听'] };
                    },
                },
                dir: d, log: () => {}, now: clock.now, waitUntil: clock.waitUntil,
                names: { user: '阿明', char: '林梦瑶' },
                news: () => [item('2026-10-24')],
                music: { ready: () => pick(42), used: (id, at) => { used.push([id, at]); } },
            });
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 30));
                const next = clock.nextTimer();
                if (next === undefined || next > t(10, 24, 22, 0)) break;
                clock.advanceTo(next);
            }
            await new Promise(r => setTimeout(r, 30));
            assert.equal(requests.length, 1, mode);
            assert.equal(requests[0]!.music?.id, 42);
            assert.ok(requests[0]!.note.includes('歌曲卡片已经先发'));
            assert.equal(used.length, mode === 'on' ? 1 : 0, `${mode}：发出去才记`);
            if (mode === 'on') assert.equal(used[0]![0], 42);
            planner.stop();
            planner = undefined;
        }
    });
});

describe('回复器：卡片先发，文字后发', () => {
    function setup(overrides: Partial<ResponderDeps> = {}) {
        const stored: StoredMessage[] = [];
        const events: string[] = [];
        const deps: ResponderDeps = {
            userId: 1,
            history: { load: () => [...stored], append: (_id, m) => { stored.push(m); } },
            buildPrompt: chat => ({ messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [] }),
            generate: async () => '这首最近老想听\n副歌那句绝了',
            clean: reply => reply.trim(),
            send: async (_id, text) => { events.push(`文字:${text}`); return 100 + events.length; },
            log: () => undefined,
            sleep: async () => undefined,
            ...overrides,
        };
        return { responder: createResponder(deps), stored, events };
    }
    const request = (patch: Partial<InitiateRequest> = {}): InitiateRequest => ({ label: '随口说件事', note: 'n', topic: 't', maxBubbles: 2, dryRun: false, commit: () => undefined, music: pick(42, { title: '晚风小站' }), ...patch });

    test('先发卡片（聊天记录写成「[音乐卡片：《歌名》- 歌手]」），再发文字；outcome 的消息 id 里有卡片', async () => {
        const { responder, stored, events } = setup({ sendMusic: async (_id, p) => { events.push(`卡片:${p.id}`); return 900; } });
        const outcome = await responder.initiate(request());
        assert.deepEqual(events, ['卡片:42', '文字:这首最近老想听', '文字:副歌那句绝了']);
        assert.equal(outcome.result, 'sent');
        if (outcome.result === 'sent') assert.deepEqual(outcome.messageIds, [900, 102, 103]);
        assert.deepEqual(stored.map(m => m.content), ['[音乐卡片：《晚风小站》- 阿夏]', '这首最近老想听', '副歌那句绝了']);
    });

    test('试运行不发卡片；卡片发不出去算这次发送失败（文字不发）；没有 sendMusic 只发文字', async () => {
        const dry = setup({ sendMusic: async () => { throw new Error('不该调用'); } });
        assert.equal((await dry.responder.initiate(request({ dryRun: true }))).result, 'dryRun');
        assert.deepEqual(dry.events, []);

        const broken = setup({ sendMusic: async () => { throw new Error('NapCat 不认'); } });
        const outcome = await broken.responder.initiate(request());
        assert.equal(outcome.result, 'failed');
        assert.match(outcome.result === 'failed' ? outcome.reason : '', /发歌曲卡片失败：NapCat 不认/);
        assert.deepEqual(broken.events, []);

        const plain = setup();
        assert.equal((await plain.responder.initiate(request())).result, 'sent');
        assert.deepEqual(plain.events, ['文字:这首最近老想听', '文字:副歌那句绝了']);
    });
});
