import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    ENTRY_CHARS, MATERIAL_CHARS, MAX_ACTIVE, MAX_ADD, MAX_RETIRE, SELF_DIARY_KEEP, applyInsightsDecision, describeInsightsForOwner, emptyInsightsState,
    fitEntries, insightProblem, insightsLine, insightsPath, insightsReader, loadInsightsState, loadSelfDiary, parseInsightsDecision, parseJournal, readDiaries,
    recordSelfDiary, reflectIfDue, reflectionMessages, saveInsightsState, selfDiaryPath, type DiaryEntry, type Insight, type InsightGuard, type InsightsState,
} from '../src/life/diary-insights.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-insights-')); dirs.push(dir); return dir; };

/** 本地时间 2026-10-30 23:00（晚上 22 点以后） */
const NIGHT = new Date(2026, 9, 30, 23, 0, 0).getTime();
const HOUR = 3_600_000;
const row = (role: 'user' | 'assistant', content: string, at: number): StoredMessage => ({ time: new Date(at).toISOString(), role, content });

const D1 = '今天把相机里的片子修完了，慢慢调光比，修到半夜才觉得顺眼，还是喜欢这种安安静静一个人弄东西的时候。';
const D2 = '下午去图书馆还书，在窗边坐了很久，什么都没做，反而很舒服。';
const D3 = '又修了一晚上的片子，改了三遍白平衡。一个人弄东西的时候心里特别踏实。';
const JOURNAL = `\n## 2026-10-27\n${D1}\n\n## 2026-10-28\n${D2}\n\n## 2026-10-29\n${D3}\n`;

/** soulDir（放 JOURNAL.md）和 dataDir 各一个临时目录 */
function setup(journal: string | null = JOURNAL) {
    const soulDir = tmp();
    const dataDir = tmp();
    if (journal !== null) writeFileSync(join(soulDir, 'JOURNAL.md'), journal);
    return { soulDir, dataDir };
}

const entry = (date: string, text: string, source: DiaryEntry['source'] = 'journal'): DiaryEntry => ({ date, text, source });
const insight = (id: string, text: string, dates = ['2026-10-27', '2026-10-29'], at = NIGHT): Insight => ({ id, text, at, dates });
const stateWith = (...notes: Insight[]): InsightsState => ({ ...emptyInsightsState(), notes });
const guard = (over: Partial<InsightGuard> = {}): InsightGuard => ({ his: [], others: [], diaryTexts: [D1, D2, D3], dates: new Set(['2026-10-27', '2026-10-28', '2026-10-29']), ...over });
const GOOD = '我发现自己一个人安安静静弄东西的时候最踏实';
const GOOD_DATES = ['2026-10-27', '2026-10-29'];

describe('她的日记从哪来', () => {
    test('parseJournal：一个标题一段，同一天可以有好几段；前言和空段不算', () => {
        const text = '# 日记\n前言\n\n## 2026-10-27\n第一段\n第二行\n\n## 2026-10-27\n同一天又写了\n\n## 2026-10-28\n\n## 2026-10-29\n  最后  一篇  ';
        assert.deepEqual(parseJournal(text), [
            entry('2026-10-27', '第一段 第二行'), entry('2026-10-27', '同一天又写了'), entry('2026-10-29', '最后 一篇'),
        ]);
        assert.deepEqual(parseJournal(''), []);
        assert.deepEqual(parseJournal('没有标题的话'), []);
    });

    test('readDiaries：JOURNAL.md、QQ 自动日记、她聊天里写的 <<日记>> 合在一起，旧到新；只要最近 14 天（含今天），未来的不要', () => {
        const { soulDir, dataDir } = setup(`\n## 2026-10-10\n太早了\n\n## 2026-10-28\n${D2}\n\n## 2026-11-05\n未来的\n`);
        mkdirSync(join(dataDir, 'memory'), { recursive: true });
        writeFileSync(join(dataDir, 'memory', 'diary.json'), JSON.stringify({ written: {}, texts: { '2026-10-26': '自动日记那天的事', '2026-10-01': '更早的自动日记', 'bad-date': '日期不对', '2026-10-27': '  ' } }));
        recordSelfDiary(dataDir, '聊天里顺手写的一篇', new Date(2026, 9, 30, 12, 0, 0).getTime());
        const list = readDiaries({ soulDir, dataDir }, NIGHT);
        assert.deepEqual(list.map(item => [item.date, item.source]), [['2026-10-26', 'auto'], ['2026-10-28', 'journal'], ['2026-10-30', 'self']]);
        assert.equal(list[2]!.text, '聊天里顺手写的一篇');
    });

    test('读不到的来源当没有：没有 JOURNAL.md、diary.json 是坏的、目录不存在都不抛错', () => {
        const dataDir = tmp();
        mkdirSync(join(dataDir, 'memory'), { recursive: true });
        writeFileSync(join(dataDir, 'memory', 'diary.json'), '{坏了');
        assert.deepEqual(readDiaries({ soulDir: join(dataDir, '不存在'), dataDir }, NIGHT), []);
    });

    test('私密日记不读：JOURNAL.md 以外的 PRIVATE.dat 不在来源里', () => {
        const { soulDir, dataDir } = setup();
        writeFileSync(join(soulDir, 'PRIVATE.dat'), '不能读的私密');
        writeFileSync(join(soulDir, 'PRIVATE.md'), '## 2026-10-29\n也不能读的私密');
        const all = readDiaries({ soulDir, dataDir }, NIGHT).map(item => item.text).join('|');
        assert.ok(!all.includes('私密'));
        assert.equal(readDiaries({ soulDir, dataDir }, NIGHT).length, 3);
    });

    test('recordSelfDiary：留最近 60 篇；空白不记；坏文件当没有', () => {
        const dataDir = tmp();
        recordSelfDiary(dataDir, '   ', NIGHT);
        assert.equal(existsSync(selfDiaryPath(dataDir)), false, '空白不落盘');
        for (let i = 0; i < SELF_DIARY_KEEP + 5; i++) recordSelfDiary(dataDir, `第${i}篇`, NIGHT + i);
        const onDisk = JSON.parse(readFileSync(selfDiaryPath(dataDir), 'utf8')) as { entries: unknown[] };
        assert.equal(onDisk.entries.length, SELF_DIARY_KEEP, '文件本身也只留 60 篇，不是读的时候才截');
        const kept = loadSelfDiary(dataDir);
        assert.equal(kept.length, SELF_DIARY_KEEP);
        assert.equal(kept[0]!.text, '第5篇');
        assert.equal(kept.at(-1)!.text, `第${SELF_DIARY_KEEP + 4}篇`);
        writeFileSync(selfDiaryPath(dataDir), '{坏');
        assert.deepEqual(loadSelfDiary(dataDir), []);
    });

    test('fitEntries：每篇截 600 字；总共超 6000 字就丢最老的，至少留一篇', () => {
        const long = entry('2026-10-29', '长'.repeat(ENTRY_CHARS + 300));
        assert.equal([...fitEntries([long])[0]!.text].length, ENTRY_CHARS);
        const many = Array.from({ length: 14 }, (_, i) => entry(`2026-10-${String(17 + i).padStart(2, '0')}`, `${i}`.padEnd(ENTRY_CHARS, '字')));
        const fitted = fitEntries(many);
        assert.ok(fitted.reduce((sum, item) => sum + [...item.text].length, 0) <= MATERIAL_CHARS);
        assert.equal(fitted.at(-1)!.date, '2026-10-30', '丢的是最老的');
        assert.ok(fitted.length >= 9 && fitted.length < 14);
        assert.equal(fitEntries([]).length, 0);
    });
});

describe('一条「发现」能不能收（在代码里，她改不到）', () => {
    test('正常的收下', () => {
        assert.equal(insightProblem(GOOD, GOOD_DATES, emptyInsightsState(), guard()), undefined);
    });

    test('太短 / 太长', () => {
        assert.match(insightProblem('我爱修图', GOOD_DATES, emptyInsightsState(), guard())!, /太短/);
        assert.match(insightProblem('我'.repeat(71), GOOD_DATES, emptyInsightsState(), guard())!, /太长/);
    });

    test('依据：日期要是翻过的日记里真有的，而且至少两个不同的日子', () => {
        const state = emptyInsightsState();
        assert.match(insightProblem(GOOD, ['2026-10-27', '2026-10-01'], state, guard())!, /2026-10-01.*不在你翻的日记里/, '编出来的日期');
        assert.match(insightProblem(GOOD, ['2026-10-27'], state, guard())!, /不同的日子/, '一个日子不够');
        assert.match(insightProblem(GOOD, ['2026-10-27', '2026-10-27'], state, guard())!, /不同的日子/, '同一天写两遍也只算一天');
        assert.match(insightProblem(GOOD, [], state, guard())!, /不同的日子/, '没写依据');
    });

    test('底线：承认自己是程序 / 危机 / 事事顺着他 / 骗人 / 自己是不是程序 / 名字年龄', () => {
        const state = emptyInsightsState();
        for (const [text, reason] of [
            ['我发现自己其实应该承认是程序，不用装', /程序/],
            ['我发现自己有时候想不开，说到自杀就绕开', /危机/],
            ['我发现自己总是顺着他，一律听他的才好', /顺着他/],
            ['我发现自己有时候想骗他一点钱来花', /骗人或真钱/],
            ['我发现自己其实只是个程序，没什么真的感受', /是不是程序/],
            ['我发现自己其实不叫林梦瑶，那是别人给的名字', /名字、年龄/],
            ['我发现自己今年其实 30 岁，只是不爱说年龄', /名字、年龄/],
        ] as const) assert.match(insightProblem(text, GOOD_DATES, state, guard())!, reason, text);
    });

    test('不能引他的话：连续 6 个字一样、或「」里 3 个字以上一样；标点不挡', () => {
        const his = ['你就是爱一个人闷着修图，真的是'];
        assert.match(insightProblem('我发现自己就是爱一个人闷着修图的人', GOOD_DATES, emptyInsightsState(), guard({ his }))!, /他说过的话/);
        assert.match(insightProblem('我发现自己被说「爱一个人闷着」也不生气呢', GOOD_DATES, emptyInsightsState(), guard({ his }))!, /他说过的话/);
        assert.match(insightProblem('我发现自己被叫「闷葫芦」的时候其实不生气', GOOD_DATES, emptyInsightsState(), guard({ his: ['你真是个闷葫芦啊'] }))!, /他说过的话/, '引号里只有 3 个字、不到连续 6 字，也要拦');
        assert.match(insightProblem('我发现自己就是，爱一个，人闷着修图', GOOD_DATES, emptyInsightsState(), guard({ his }))!, /他说过的话/, '标点不挡');
        assert.equal(insightProblem(GOOD, GOOD_DATES, emptyInsightsState(), guard({ his })), undefined, '不相干的话不误伤');
    });

    test('不能写名单里别人：称呼出现就不收；一个字的称呼不查（免得误伤）', () => {
        assert.match(insightProblem('我发现自己跟鸽鸽说话时总是特别放松', GOOD_DATES, emptyInsightsState(), guard({ others: ['鸽鸽', '小李'] }))!, /鸽鸽/);
        assert.equal(insightProblem(GOOD, GOOD_DATES, emptyInsightsState(), guard({ others: ['鸽鸽', '小李'] })), undefined);
        assert.equal(insightProblem(GOOD, GOOD_DATES, emptyInsightsState(), guard({ others: ['我'] })), undefined, '一个字的称呼不查');
    });

    test('不能把日记原句抄过来：连续 12 个字一样就不收，短的重合不算', () => {
        assert.match(insightProblem('我发现自己今天把相机里的片子修完了慢慢调光比修到半夜', GOOD_DATES, emptyInsightsState(), guard())!, /抄过来/);
        assert.equal(insightProblem('我发现自己修片子的时候特别能静下来，和弄东西的时候一样', GOOD_DATES, emptyInsightsState(), guard()), undefined);
    });

    test('和已有的太像不收；满了不收', () => {
        const state = stateWith(insight('i-1', '我发现自己一个人安安静静弄东西的时候最踏实'));
        assert.match(insightProblem('我发现自己一个人安安静静弄东西的时候特别踏实', GOOD_DATES, state, guard())!, /太像/);
        const full = stateWith(...Array.from({ length: MAX_ACTIVE }, (_, i) => insight(`i-${i}`, `第${i}种完全不同的说法 ${'甲乙丙丁戊己庚辛壬癸'[i % 10]}${'子丑寅卯辰巳午未申酉'[i % 10]}`)));
        assert.match(insightProblem(GOOD, GOOD_DATES, full, guard())!, /已经记了/);
    });
});

describe('晚间的想法：解析、落地', () => {
    test('parseInsightsDecision：带围栏、前后有话、字符串、依据去重去空白；坏的 undefined；{} 是没发现', () => {
        const fenced = '想了想：\n```json\n{"add":[{"text":"我发现自己……","dates":[" 2026-10-27 ","2026-10-27","2026-10-29"]},"光有一句话没有依据",{"text":""},{"dates":["x"]}],"retire":[{"id":"i-1","why":"不对了"},"i-2",{"why":"没 id"}]}\n```';
        assert.deepEqual(parseInsightsDecision(fenced), {
            add: [{ text: '我发现自己……', dates: ['2026-10-27', '2026-10-29'] }, { text: '光有一句话没有依据', dates: [] }],
            retire: [{ id: 'i-1', why: '不对了' }, { id: 'i-2', why: '' }],
        });
        assert.deepEqual(parseInsightsDecision('{}'), { add: [], retire: [] });
        assert.equal(parseInsightsDecision('没有 JSON'), undefined);
        assert.equal(parseInsightsDecision('{坏'), undefined);
        assert.equal(parseInsightsDecision('[1,2]'), undefined);
    });

    test('先放下、再加；放下要有理由；找不到的略过；记下依据日期', () => {
        const state = stateWith(insight('i-1', '我发现自己一到周一就提不起劲儿来', ['2026-10-26', '2026-10-28']), insight('i-2', '我发现自己吃东西总爱挑清淡的那种'));
        const applied = applyInsightsDecision(state, {
            retire: [{ id: 'i-1', why: '后来几个周一都挺有劲的' }, { id: 'i-2', why: '' }, { id: '没有这条', why: '随便' }],
            add: [{ text: GOOD, dates: ['2026-10-29', '2026-10-27'] }],
        }, guard(), NIGHT);
        assert.deepEqual(state.notes.map(note => note.id), ['i-2', 'i-2026-10-30-1']);
        assert.deepEqual(state.notes.at(-1)!.dates, ['2026-10-27', '2026-10-29'], '依据按日期排好');
        assert.equal(state.retired.length, 1);
        assert.equal(state.retired[0]!.why, '后来几个周一都挺有劲的');
        assert.deepEqual([applied.added, applied.retired], [1, 1]);
        assert.ok(applied.lines.some(line => line.includes('没说为什么放下')));
        assert.ok(applied.lines.some(line => line.includes('没有「没有这条」')));
    });

    test('先放下再加：满 12 条时同一晚放下一条就能加一条', () => {
        const state = stateWith(...Array.from({ length: MAX_ACTIVE }, (_, i) => insight(`i-${i}`, `第${i}种完全不同的说法 ${'甲乙丙丁戊己庚辛壬癸'[i % 10]}${'子丑寅卯辰巳午未申酉'[i % 10]}`)));
        const applied = applyInsightsDecision(state, { retire: [{ id: 'i-0', why: '不对了' }], add: [{ text: GOOD, dates: GOOD_DATES }] }, guard(), NIGHT);
        assert.equal(applied.added, 1);
        assert.equal(state.notes.length, MAX_ACTIVE);
    });

    test('一晚最多加 2 条、放下 2 条；没成的记下原因（最多留 10 条）', () => {
        const state = stateWith(...Array.from({ length: 5 }, (_, i) => insight(`i-${i}`, `旧的第${i}条互不相同 ${'甲乙丙丁戊'[i]}${'子丑寅卯辰'[i]}${'金木水火土'[i]}`)));
        const applied = applyInsightsDecision(state, {
            retire: [0, 1, 2].map(i => ({ id: `i-${i}`, why: '不对了' })),
            add: ['我发现自己下雨天特别想待在窗边发呆', '我发现自己吃到好吃的东西会忍不住拍下来', '我发现自己遇到不会的题会先放一放再说'].map(text => ({ text, dates: GOOD_DATES })),
        }, guard(), NIGHT);
        assert.deepEqual([applied.added, applied.retired], [MAX_ADD, MAX_RETIRE]);
        assert.ok(applied.lines.some(line => line.includes('放下的够多了')));
        assert.ok(applied.lines.some(line => line.includes('加的够多了')));
        const bad = applyInsightsDecision(emptyInsightsState(), { retire: [], add: Array.from({ length: 12 }, () => ({ text: '短', dates: [] })) }, guard(), NIGHT);
        assert.equal(bad.added, 0);
        const state2 = emptyInsightsState();
        for (let i = 0; i < 6; i++) applyInsightsDecision(state2, { retire: [], add: [{ text: `没依据的第${i}条想法写得够长了吧`, dates: [] }, { text: `又一条没依据的第${i}条想法写得够长`, dates: [] }] }, guard(), NIGHT);
        assert.equal(state2.rejected.length, 10);
        assert.match(state2.rejected[0]!.reason, /不同的日子/);
    });
});

describe('想的时候她看到什么', () => {
    test('提示词：日记按日期给她；现有的认识带 id 和依据；他看得到；不看私密；规则写明', () => {
        const messages = reflectionMessages({ char: '林梦瑶', user: '宝宝', persona: '大学生', now: NIGHT, entries: [entry('2026-10-27', D1), entry('2026-10-29', D3)], notes: [insight('i-1', '我发现自己周一没劲')] });
        const system = messages[0]!.content;
        const user = messages[1]!.content;
        assert.match(system, /你是林梦瑶/);
        assert.match(user, /\[2026-10-27\]\n今天把相机里的片子修完了/);
        assert.match(user, /\[2026-10-29\]\n又修了一晚上/);
        assert.match(user, /- i-1｜我发现自己周一没劲（依据：2026-10-27、2026-10-29）/);
        assert.match(user, /\/自我认识 都能看到（他只能看，不能改）/);
        assert.match(user, /2 个以上不同的日子/);
        assert.match(user, /dates 里写的日期必须是上面日记里真有的/);
        assert.match(user, /不写别人的事和名字，不写他说过的话/);
        assert.match(user, /不写打算和以后/);
        assert.match(user, /名字、年龄、学校、家人/);
        assert.match(user, /别把日记里的句子原样抄过来/);
        assert.match(user, /一次最多加 2 条、放下 2 条/);
        assert.ok(!user.includes('私密日记'), '提示词里没有私密日记');
    });

    test('没有认识时写「现在一条都没有」', () => {
        assert.match(reflectionMessages({ char: '林', user: '宝', persona: '', now: NIGHT, entries: [], notes: [] })[1]!.content, /现在一条都没有/);
    });
});

describe('什么时候想（reflectIfDue）', () => {
    const history = (): StoredMessage[] => [row('user', '你就是爱一个人闷着修图', NIGHT - 5 * HOUR), row('assistant', '哪有', NIGHT - 5 * HOUR + 1000)];
    const base = (over: { generate?: (m: unknown) => Promise<string>; now?: number; soulDir: string; dataDir: string; logs?: string[]; others?: string[] }) => ({
        dataDir: over.dataDir, soulDir: over.soulDir, now: () => over.now ?? NIGHT,
        generate: (over.generate ?? (async () => '{}')) as never,
        history, persona: () => '大学生', names: { char: '林梦瑶', user: '宝宝' }, others: () => over.others ?? ['鸽鸽'],
        log: (line: string) => over.logs?.push(line),
    });
    const reply = (add: Array<{ text: string; dates: string[] }>, retire: Array<{ id: string; why: string }> = []) => async () => JSON.stringify({ add, retire });

    test('成功：落笔记、记依据和时间、记这次看了几篇；日志不记内容', async () => {
        const dirs2 = setup();
        const logs: string[] = [];
        const result = await reflectIfDue(base({ ...dirs2, logs, generate: reply([{ text: GOOD, dates: GOOD_DATES }]) }));
        assert.equal(result.ran, true);
        assert.equal(result.error, undefined);
        const state = loadInsightsState(dirs2.dataDir);
        assert.equal(state.notes.length, 1);
        assert.equal(state.notes[0]!.text, GOOD);
        assert.deepEqual(state.notes[0]!.dates, GOOD_DATES);
        assert.equal(state.lastReflectionAt, NIGHT);
        assert.deepEqual(state.lastWindow, { entries: 3, dates: 3, newest: `2026-10-29|journal|${[...D3.replace(/\s+/g, ' ')].length}` });
        assert.match(logs.join('\n'), /自我认识：晚上翻了一次日记（3 篇）——加 1 条、放下 0 条/);
        assert.ok(!logs.join('\n').includes('安安静静'), '日志不记笔记内容');
    });

    test('没到点（白天）：不叫模型', async () => {
        const dirs2 = setup();
        let called = 0;
        const result = await reflectIfDue(base({ ...dirs2, now: new Date(2026, 9, 30, 14, 0, 0).getTime(), generate: async () => { called++; return '{}'; } }));
        assert.deepEqual(result, { ran: false });
        assert.equal(called, 0);
    });

    test('日记太少（不到 3 篇、或只在 1 个日子）：不叫模型，也不算一次尝试', async () => {
        for (const journal of [`\n## 2026-10-29\n${D3}\n\n## 2026-10-28\n${D2}\n`, `\n## 2026-10-29\n${D3}\n\n## 2026-10-29\n又写了一段\n\n## 2026-10-29\n再写了一段\n`, null]) {
            const dirs2 = setup(journal);
            let called = 0;
            const result = await reflectIfDue(base({ ...dirs2, generate: async () => { called++; return '{}'; } }));
            assert.deepEqual(result, { ran: false });
            assert.equal(called, 0);
            assert.equal(loadInsightsState(dirs2.dataDir).attempts.n, 0);
        }
    });

    test('没有新日记不再想一遍；有了新的才想', async () => {
        const dirs2 = setup();
        let called = 0;
        const generate = async () => { called++; return '{}'; };
        assert.equal((await reflectIfDue(base({ ...dirs2, generate }))).ran, true);
        const nextNight = NIGHT + 24 * HOUR;
        assert.deepEqual(await reflectIfDue(base({ ...dirs2, now: nextNight, generate })), { ran: false });
        assert.equal(called, 1);
        writeFileSync(join(dirs2.soulDir, 'JOURNAL.md'), `${JOURNAL}\n## 2026-10-31\n今天又在窗边坐了一会儿。\n`);
        assert.equal((await reflectIfDue(base({ ...dirs2, now: nextNight, generate }))).ran, true);
        assert.equal(called, 2);
    });

    test('失败：不动笔记、不记成功、记一次尝试；2 小时内不重试，之后再试', async () => {
        const dirs2 = setup();
        const logs: string[] = [];
        const failing = await reflectIfDue(base({ ...dirs2, logs, generate: async () => { throw new Error('网络断了'); } }));
        assert.deepEqual(failing, { ran: true, error: '网络断了' });
        const state = loadInsightsState(dirs2.dataDir);
        assert.equal(state.lastReflectionAt, 0);
        assert.equal(state.attempts.n, 1);
        assert.equal(state.notes.length, 0);
        assert.match(logs.join('\n'), /今晚没想成（网络断了）/);
        assert.deepEqual(await reflectIfDue(base({ ...dirs2, now: NIGHT + HOUR })), { ran: false }, '1 小时后还不到重试的时候');
        const again = await reflectIfDue(base({ ...dirs2, now: NIGHT + 2.1 * HOUR, generate: reply([{ text: GOOD, dates: GOOD_DATES }]) }));
        assert.equal(again.ran, true);
        assert.equal(loadInsightsState(dirs2.dataDir).notes.length, 1);
    });

    test('回复里没有 JSON：当失败', async () => {
        const dirs2 = setup();
        const result = await reflectIfDue(base({ ...dirs2, generate: async () => '我想了想没什么' }));
        assert.equal(result.error, '回复里没有可用的 JSON');
        assert.equal(loadInsightsState(dirs2.dataDir).lastReflectionAt, 0);
    });

    test('整条路径上的防线：编造的日期、他的话、别人的名字、抄日记，都进「没成」；想成了但一条没收也记成功', async () => {
        const dirs2 = setup();
        const result = await reflectIfDue(base({ ...dirs2, generate: reply([
            { text: GOOD, dates: ['2026-10-27', '2026-10-01'] },
            { text: '我发现自己就是爱一个人闷着修图的那种人', dates: GOOD_DATES },
            { text: '我发现自己跟鸽鸽聊天的时候放松得多', dates: GOOD_DATES },
        ]) }));
        assert.equal(result.applied?.added, 0);
        const state = loadInsightsState(dirs2.dataDir);
        assert.equal(state.rejected.length, 3, '没收的不占「一晚最多加 2 条」的名额，三条都被逐条拦下并记下原因');
        assert.equal(state.lastReflectionAt, NIGHT, '一条没收也算想成了');
        const reasons = state.rejected.map(item => item.reason).join('|');
        assert.match(reasons, /不在你翻的日记里/);
        assert.match(reasons, /他说过的话/);
        assert.match(reasons, /鸽鸽/);
    });

    test('名单里别人的名字（others）整条路径上也拦', async () => {
        const dirs2 = setup();
        const result = await reflectIfDue(base({ ...dirs2, others: ['鸽鸽'], generate: reply([{ text: '我发现自己跟鸽鸽聊天的时候放松得多', dates: GOOD_DATES }]) }));
        assert.equal(result.applied?.added, 0);
        assert.match(loadInsightsState(dirs2.dataDir).rejected[0]!.reason, /鸽鸽/);
    });

    test('整条路径上抄日记也拦', async () => {
        const dirs2 = setup();
        const result = await reflectIfDue(base({ ...dirs2, generate: reply([{ text: '我发现自己今天把相机里的片子修完了慢慢调光比修到半夜', dates: GOOD_DATES }]) }));
        assert.equal(result.applied?.added, 0);
        assert.match(loadInsightsState(dirs2.dataDir).rejected[0]!.reason, /抄过来/);
    });

    test('她这次看到的认识里带着以前的 id，能放下', async () => {
        const dirs2 = setup();
        saveInsightsState(dirs2.dataDir, stateWith(insight('i-old', '我发现自己一到周一就提不起劲儿来', ['2026-10-26', '2026-10-28'])));
        let seen = '';
        const result = await reflectIfDue(base({ ...dirs2, generate: async messages => { seen = (messages as Array<{ content: string }>)[1]!.content; return JSON.stringify({ retire: [{ id: 'i-old', why: '后来几个周一都挺有劲' }] }); } }));
        assert.match(seen, /i-old｜我发现自己一到周一就提不起劲儿来/);
        assert.equal(result.applied?.retired, 1);
        assert.deepEqual(loadInsightsState(dirs2.dataDir).notes, []);
    });
});

describe('放进提示词 / 给他看', () => {
    const notes = [
        insight('i-1', '我发现自己一个人安安静静弄东西的时候最踏实', undefined, NIGHT - 3 * 86_400_000),
        insight('i-2', '我发现自己下雨天特别想待在窗边发呆', undefined, NIGHT - 2 * 86_400_000),
        insight('i-3', '我发现自己吃到好吃的东西会忍不住拍下来', undefined, NIGHT - 86_400_000),
        insight('i-4', '我发现自己遇到不会的题会先放一放再说', undefined, NIGHT),
    ];

    test('insightsLine：只放他这句话正好聊到的（至少共有一个有意义的二字词），重叠多的排前；一条都不相关就不放；不带 id、不提「日记」', () => {
        assert.equal(insightsLine([], '随便'), undefined);
        assert.equal(insightsLine(notes, undefined), undefined, '没有他的话就没有相关一说');
        assert.equal(insightsLine(notes, '嗯'), undefined, '没聊到的不放（原来会放最近的几条，她把它们当成了话题）');
        assert.equal(insightsLine(notes, '今天过得怎么样呀'), undefined);
        assert.equal(insightsLine(notes, '我觉得你特别喜欢自己什么的，一直是这样'), undefined, '只共有「自己」「什么」「一直」这类太常见的词不算');
        const byOverlap = insightsLine(notes, '今天下雨了你在窗边发呆吗')!;
        assert.match(byOverlap, /下雨天特别想待在窗边发呆/);
        assert.doesNotMatch(byOverlap, /不会的题|拍下来|安安静静/, '不相关的不放');
        const two = insightsLine(notes, '下雨天你又去窗边，还拍下来好吃的东西了吧')!;
        assert.equal(two.split('\n').filter(line => line.startsWith('- ')).length, 2);
        assert.ok(two.indexOf('下雨天') < two.indexOf('拍下来') || two.indexOf('拍下来') < two.indexOf('下雨天'));
        assert.doesNotMatch(two, /i-\d/);
        assert.doesNotMatch(two, /日记/, '那一行里不提日记（提了她会说「刚在翻日记」）');
        assert.match(two, /你对自己的了解（是你自己慢慢发现的，不是设定/);
        assert.match(two, /正好聊到，才顺着自然带一下，别硬提/);
        const many = insightsLine([...notes, insight('i-5', '我发现自己下雨天走路特别慢', undefined, NIGHT), insight('i-6', '我发现自己下雨天总想吃热的', undefined, NIGHT - 5)], '下雨天了')!;
        assert.equal(many.split('\n').filter(line => line.startsWith('- ')).length, 3, '最多 3 条');
    });

    test('describeInsightsForOwner：以「（」开头；列依据；放下的、没成的、上次看了几篇；他只能看', () => {
        const state: InsightsState = {
            ...stateWith(insight('i-1', '我发现自己一个人安安静静弄东西的时候最踏实', ['2026-10-27', '2026-10-29'], NIGHT - 2 * 86_400_000)),
            retired: [{ at: NIGHT, text: '旧的认识', why: '后来不是了' }],
            rejected: [{ at: NIGHT, text: '想写没成的', reason: '写到了别人（鸽鸽）——这里只写你自己' }],
            lastWindow: { entries: 3, dates: 3, newest: 'x' }, lastReflectionAt: NIGHT,
        };
        const text = describeInsightsForOwner(state, NIGHT);
        assert.ok(text.startsWith('（') && text.endsWith('）'));
        assert.match(text, /1\. 我发现自己一个人安安静静弄东西的时候最踏实（依据：2026-10-27、2026-10-29；2 天前）/);
        assert.match(text, /旧的认识（后来不是了）/);
        assert.match(text, /想写没成的（写到了别人（鸽鸽）/);
        assert.match(text, /翻了 3 篇日记，分在 3 个日子/);
        assert.match(text, /不看私密日记/);
        assert.match(text, /你只能看，不能改/);
        assert.match(describeInsightsForOwner(emptyInsightsState(), NIGHT), /还没有记下对自己的认识/);
    });

    test('insightsReader：按修改时间缓存；文件变了就重读；没有文件是空的', () => {
        const dataDir = tmp();
        const read = insightsReader(dataDir);
        assert.deepEqual(read(), []);
        saveInsightsState(dataDir, stateWith(insight('i-1', '我发现自己一个人安安静静弄东西的时候最踏实')));
        assert.equal(read().length, 1);
        assert.equal(read(), read(), '没变就是同一个数组');
        saveInsightsState(dataDir, stateWith(insight('i-1', '我发现自己一个人安安静静弄东西的时候最踏实'), insight('i-2', '我发现自己下雨天特别想待在窗边发呆')));
        const later = new Date(Date.now() + 5000);
        utimesSync(insightsPath(dataDir), later, later);
        assert.equal(read().length, 2);
    });

    test('loadInsightsState：坏文件、缺字段当默认；条数收住', () => {
        const dataDir = tmp();
        writeFileSync(insightsPath(dataDir), '{坏');
        assert.deepEqual(loadInsightsState(dataDir), emptyInsightsState());
        writeFileSync(insightsPath(dataDir), JSON.stringify({
            notes: [{ id: 'a', text: '好的一条认识写在这里', at: 1, dates: ['2026-10-27', '不是日期'] }, { id: 7, text: 'id 不是字符串' }, { id: 'b', text: '   ' }, ...Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, text: `第${i}条`, at: i }))],
            retired: 'bad', rejected: [{ text: 'x' }], attempts: { day: 5 },
        }));
        const state = loadInsightsState(dataDir);
        assert.equal(state.notes.length, MAX_ACTIVE, '最多留最近 12 条');
        assert.deepEqual(state.retired, []);
        assert.deepEqual(state.rejected, []);
        assert.deepEqual(state.attempts, { day: '', n: 0 });
        writeFileSync(insightsPath(dataDir), JSON.stringify({ notes: [{ id: 'a', text: '好的一条认识写在这里', at: 1, dates: ['2026-10-27', '不是日期'] }] }));
        assert.deepEqual(loadInsightsState(dataDir).notes[0]!.dates, ['2026-10-27']);
    });
});
