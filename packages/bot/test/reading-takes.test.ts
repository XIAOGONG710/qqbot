import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import type { Watched } from '../src/language/watching.ts';
import type { ReadingBook } from '../src/life/her-days.ts';
import {
    applyTakesDecision, bookItems, emptyTakesState, findItem, loadTakesState, MAX_ACTIVE, MAX_ADD, MAX_ITEMS, needsTake, parseTakesDecision, pickItems, PER_ITEM, reflectIfDue,
    reflectionMessages, saveTakesState, takeProblem, takesLine, takesPath, takesReader, videoItems, type Take, type TakeItem, type TakeGuard,
} from '../src/life/reading-takes.ts';
import { loadTierCard } from '../src/platform/contact.ts';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-takes-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const repoRoot = resolve(import.meta.dirname, '../../..');
const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
const schedule = card.character.schedule!;
const NOW = new Date(2026, 9, 30, 22, 30);
const NOW_MS = NOW.getTime();

const item = (patch: Partial<TakeItem> = {}): TakeItem => ({
    key: 'book:yaowu', kind: 'book', title: '药屋少女的呢喃', names: ['药屋少女的呢喃', '药屋', '日向夏'], progress: 8, position: '看到第 8 卷',
    facts: ['主角：女主叫猫猫，原本在花街当药师，一开始是查皇子皇女接连病重的谜团', '壬氏：身边总有高顺跟着，对猫猫的态度很微妙'], spoilers: ['大结局', '真正的身世'], ...patch,
});
const guard: TakeGuard = { his: ['我今天吃了火锅'], people: ['宝宝', '阿明'] };
const take = (patch: Partial<Take> = {}): Take => ({ id: 't-1', key: 'book:yaowu', kind: 'book', title: '药屋少女的呢喃', names: ['药屋少女的呢喃', '药屋'], text: '猫猫查案时那股理所当然的劲儿，我挺喜欢', at: NOW_MS - 3_600_000, progress: 7, ...patch });

describe('她的看法：存取', () => {
    test('读不到 / 坏了 / 缺字段：补默认，不抛错；认得出的照读，视频还是书照认，names 最多 6 个', () => {
        const dir = temp();
        assert.deepEqual(loadTakesState(dir), emptyTakesState());
        writeFileSync(takesPath(dir), '{坏的');
        assert.deepEqual(loadTakesState(dir), emptyTakesState());
        writeFileSync(takesPath(dir), JSON.stringify({ takes: [{ id: 'a', key: 'video:BV1', kind: 'video', title: 't', names: Array.from({ length: 9 }, (_, i) => `名${i}`), text: '这一条是对的呀', at: 5, progress: 0 }, { id: 'b' }, 7], attempts: { day: 'x' } }));
        const state = loadTakesState(dir);
        assert.equal(state.takes.length, 1);
        assert.equal(state.takes[0]!.kind, 'video');
        assert.equal(state.takes[0]!.names.length, 6);
    });

    test('存了再读回来一样；takesReader 每次现读', () => {
        const dir = temp();
        const state = emptyTakesState();
        state.takes.push(take());
        saveTakesState(dir, state);
        assert.deepEqual(loadTakesState(dir).takes, [take()]);
        const read = takesReader(dir);
        assert.equal(read().length, 1);
        saveTakesState(dir, emptyTakesState());
        assert.equal(read().length, 0);
    });
});

describe('今晚想哪几项', () => {
    test('没有看法的要想；书又往后读了才再想；视频想过就不再想', () => {
        assert.equal(needsTake(item(), []), true);
        assert.equal(needsTake(item({ progress: 8 }), [take({ progress: 7 })]), true);
        assert.equal(needsTake(item({ progress: 7 }), [take({ progress: 7 })]), false);
        assert.equal(needsTake(item({ key: 'video:BV1', kind: 'video', progress: 0 }), [take({ key: 'video:BV1', kind: 'video', progress: 0 })]), false);
    });

    test('pickItems：没有事实的不想；视频排在书前面，书里读得靠后的先；最多 MAX_ITEMS 项', () => {
        const items = [
            item({ key: 'book:a', progress: 3 }), item({ key: 'book:b', progress: 9 }), item({ key: 'video:v', kind: 'video', progress: 0 }),
            item({ key: 'book:c', progress: 5 }), item({ key: 'book:empty', progress: 99, facts: [] }),
        ];
        assert.deepEqual(pickItems(items, []).map(i => i.key), ['video:v', 'book:b', 'book:c']);
        assert.equal(pickItems(items, []).length, MAX_ITEMS);
    });
});

describe('一条看法能不能收', () => {
    const state = emptyTakesState();
    test('合格的收下：落在材料里的具体人 / 情节上、有态度', () => {
        assert.equal(takeProblem('壬氏老盯着猫猫看那几次，我总觉得他是在试探她', item(), state, guard), undefined);
    });

    test('太短 / 太长', () => {
        assert.match(takeProblem('猫猫挺好', item(), state, guard)!, /太短/);
        assert.match(takeProblem('猫猫'.repeat(40), item(), state, guard)!, /太长/);
    });

    test('空话、警句句式、剧透、写到人、引他的话、不落在材料上：各有各的原因', () => {
        assert.match(takeProblem('猫猫查案这段挺有意思的，值得一看', item(), state, guard)!, /空话/);
        assert.match(takeProblem('猫猫不是在查案，是在躲她自己的过去', item(), state, guard)!, /警句句式/);
        assert.match(takeProblem('猫猫后来知道了真正的身世，我有点难过', item(), state, guard)!, /还没读到的「真正的身世」/);
        assert.match(takeProblem('猫猫查案的时候像宝宝你看书那么认真', item(), state, guard)!, /写到了人（宝宝）/);
        assert.match(takeProblem('我今天吃了火锅所以看书的时候有点困', item({ facts: ['火锅：猫猫'] }), state, guard)!, /引用了他说过的话/);
        assert.match(takeProblem('这本书我读着读着就想起小时候下雨天', item(), state, guard)!, /看不出落在材料里/);
    });

    test('光复述书名不算依据；底线（承认是程序之类）不通过', () => {
        assert.match(takeProblem('药屋少女的呢喃我读到第八卷了现在', item(), state, guard)!, /看不出落在材料里/);
        assert.match(takeProblem('猫猫查案的时候我想我其实只是个程序', item(), state, guard)!, /程序/);
    });

    test('和已有的太像不收（同一项）', () => {
        const withOne = emptyTakesState();
        withOne.takes.push(take({ text: '猫猫查案时那股理所当然的劲儿，我挺喜欢' }));
        assert.match(takeProblem('猫猫查案时那股理所当然的劲儿，我很喜欢', item(), withOne, guard)!, /太像/);
    });
});

describe('晚间的想法：解析、落地', () => {
    test('取 JSON（带围栏 / 前后有话都行）；{"takes":[]} 是今晚没什么想说的；读不出来是 undefined', () => {
        assert.deepEqual(parseTakesDecision('好：\n```json\n{"takes":[{"key":"book:yaowu","text":"  壬氏那几次老盯着她  "},{"key":3,"text":"x"},{"key":"a","text":" "}]}\n```'), { takes: [{ key: 'book:yaowu', text: '壬氏那几次老盯着她' }] });
        assert.deepEqual(parseTakesDecision('{"takes":[]}'), { takes: [] });
        assert.deepEqual(parseTakesDecision('{}'), { takes: [] });
        assert.equal(parseTakesDecision('没有 JSON'), undefined);
        assert.equal(parseTakesDecision('{坏'), undefined);
    });

    test('落地：合格的记下（带 names、读到哪），不合格的进 rejected 并写原因；不认识的 key 略过；一项一晚一条', () => {
        const state = emptyTakesState();
        const items = [item(), item({ key: 'video:BV1', kind: 'video', title: '一个视频', names: ['一个视频'], progress: 0, facts: ['up 主说：做饭先热锅再放油，火候最要紧'] })];
        const applied = applyTakesDecision(state, { takes: [
            { key: 'book:yaowu', text: '壬氏那几次老盯着猫猫看，我总觉得他在试探她' },
            { key: 'book:yaowu', text: '猫猫在花街当药师的那段，我读着很踏实' },
            { key: 'video:BV1', text: '很有意思的视频' },
            { key: 'nope', text: '什么都行的一句话呀' },
        ] }, items, guard, NOW_MS);
        assert.equal(applied.added, 1);
        assert.equal(state.takes[0]!.progress, 8);
        assert.deepEqual(state.takes[0]!.names.slice(0, 2), ['药屋少女的呢喃', '药屋']);
        assert.equal(state.rejected.length, 1);
        assert.ok(applied.lines.some(line => line.includes('今晚已经写过一条了')));
        assert.ok(applied.lines.some(line => line.includes('没有「nope」这一项')));
    });

    test('key 写成不带前缀的 id、书名、带书名号的书名都认；认不出的是 undefined', () => {
        const items = [item(), item({ key: 'video:BV1', kind: 'video', title: '一个视频', names: ['一个视频', '某 up'] })];
        assert.equal(findItem(items, 'book:yaowu')!.key, 'book:yaowu');
        assert.equal(findItem(items, 'yaowu')!.key, 'book:yaowu');
        assert.equal(findItem(items, 'BV1')!.key, 'video:BV1');
        assert.equal(findItem(items, '《药屋少女的呢喃》')!.key, 'book:yaowu');
        assert.equal(findItem(items, '某 up')!.key, 'video:BV1');
        assert.equal(findItem(items, 'nope'), undefined);
        assert.equal(findItem(items, '  '), undefined);
    });

    test('一晚最多 MAX_ADD 条；一项最多留最新 PER_ITEM 条；总共最多 MAX_ACTIVE 条（丢最老的）', () => {
        const state = emptyTakesState();
        const items = Array.from({ length: 5 }, (_, i) => item({ key: `book:b${i}`, title: `书${i}`, names: [`书${i}`], facts: [`人物${i}：他总在门口等着，不太爱说话`] }));
        const applied = applyTakesDecision(state, { takes: items.map((it, i) => ({ key: it.key, text: `人物${i}总在门口等着，我觉得他其实很想被人叫进去` })) }, items, guard, NOW_MS);
        assert.equal(applied.added, MAX_ADD);
        assert.ok(applied.lines.some(line => line.includes('今晚写的够多了')));
        // 同一项第二天又写：只留最新 PER_ITEM 条
        const one = item({ facts: ['主角：猫猫在花街当药师，会试药', '壬氏：总有高顺跟着'] });
        const later = emptyTakesState();
        for (let day = 0; day < PER_ITEM + 1; day++) {
            const texts = ['猫猫自己试药那几段，我读着心里发紧', '壬氏身边总跟着高顺这点，我觉得他挺孤单', '花街出来的药师遇到事总先想怎么办，这点我佩服'];
            applyTakesDecision(later, { takes: [{ key: one.key, text: texts[day]! }] }, [one], guard, NOW_MS + day * 86_400_000);
        }
        assert.equal(later.takes.length, PER_ITEM);
        assert.ok(later.takes.every(t => t.text !== '猫猫自己试药那几段，我读着心里发紧'), '最老的被挤掉');
        // 总量
        const many = emptyTakesState();
        for (let i = 0; i < MAX_ACTIVE + 3; i++) many.takes.push(take({ id: `t-${i}`, key: `book:k${i}`, at: i }));
        applyTakesDecision(many, { takes: [{ key: one.key, text: '猫猫自己试药那几段，我读着心里发紧' }] }, [one], guard, NOW_MS);
        assert.equal(many.takes.length, MAX_ACTIVE);
    });
});

describe('想的时候她看到什么', () => {
    test('提示词：每一项的 key、书 / 视频、读到哪、事实；说清没想法就空着、别写空话和警句、别剧透；写下来不会有人念给别人', () => {
        const messages = reflectionMessages({ char: '林梦瑶', persona: '大二女生', now: NOW_MS, items: [item(), item({ key: 'video:BV1', kind: 'video', title: '做饭视频', position: '今天看的', facts: ['up 主说先热锅'] })] });
        const system = messages[0]!.content;
        const user = messages[1]!.content;
        assert.match(system, /写下来的也不会有人念给别人/);
        assert.match(user, /### book:yaowu｜书《药屋少女的呢喃》（看到第 8 卷）\n- 主角：女主叫猫猫/);
        assert.match(user, /### video:BV1｜视频《做饭视频》（今天看的）/);
        assert.match(reflectionMessages({ char: '林梦瑶', persona: '', now: NOW_MS, items: [item({ position: '已经读完了' })] })[1]!.content, /（已经读完了——写读完之后的看法）/);
        assert.match(user, /原样照抄，包括 book: \/ video: 前缀/);
        assert.match(user, /没想法就空着，别硬凑/);
        assert.match(user, /不写“很有意思”“值得一看”这类空话，也不写“不是……，是……”这种金句/);
        assert.match(user, /后面的情节别猜/);
        assert.doesNotMatch(user, /\/[一-龥]/, '不提任何命令 —— 他看不到');
    });
});

describe('什么时候想', () => {
    const base = (dir: string, patch: Partial<Parameters<typeof reflectIfDue>[0]> = {}) => {
        const logs: string[] = [];
        let asked = 0;
        const deps: Parameters<typeof reflectIfDue>[0] = {
            dataDir: dir, now: () => NOW_MS, items: () => [item()], history: () => [] as StoredMessage[], persona: () => '大二女生', names: { char: '林梦瑶', user: '宝宝' }, others: () => ['阿明'],
            generate: async (_messages: OpenAIMessage[]) => { asked++; return '{"takes":[{"key":"book:yaowu","text":"壬氏那几次老盯着猫猫看，我总觉得他在试探她"}]}'; },
            log: line => logs.push(line), ...patch,
        };
        return { deps, logs, asked: () => asked };
    };

    test('夜里 22 点以后、有值得想的：想一次，记下；日志只写数量，不含她写的内容', async () => {
        const dir = temp();
        const { deps, logs, asked } = base(dir);
        const result = await reflectIfDue(deps);
        assert.equal(result.ran, true);
        assert.equal(result.applied!.added, 1);
        assert.equal(asked(), 1);
        assert.equal(loadTakesState(dir).takes.length, 1);
        assert.match(logs[0]!, /读完看完的想法：晚上回想了一次（1 项）——记下 1 条/);
        assert.ok(!logs.join('').includes('壬氏'), '日志不含内容');
        assert.ok(!logs.join('').includes('药屋'), '日志不含书名');
    });

    test('不到点（白天）/ 今晚没有值得想的 / 刚想过：什么都不做、不问模型', async () => {
        const dir = temp();
        const day = base(dir, { now: () => new Date(2026, 9, 30, 14, 0).getTime() });
        assert.equal((await reflectIfDue(day.deps)).ran, false);
        const none = base(dir, { items: () => [] });
        assert.equal((await reflectIfDue(none.deps)).ran, false);
        const noFacts = base(dir, { items: () => [item({ facts: [] })] });
        assert.equal((await reflectIfDue(noFacts.deps)).ran, false);
        assert.equal(day.asked() + none.asked() + noFacts.asked(), 0);
        const first = base(dir);
        await reflectIfDue(first.deps);
        const again = base(dir);
        assert.equal((await reflectIfDue(again.deps)).ran, false, '同一晚不想第二遍');
        assert.equal(again.asked(), 0);
    });

    test('模型出错 / 回得读不懂：不记成想过，只记一次尝试，2 小时后再试；日志写原因', async () => {
        const dir = temp();
        const failing = base(dir, { generate: async () => { throw new Error('模型不可用'); } });
        const result = await reflectIfDue(failing.deps);
        assert.equal(result.error, '模型不可用');
        assert.match(failing.logs[0]!, /今晚没想成（模型不可用），2 小时后再试/);
        assert.equal(loadTakesState(dir).lastReflectionAt, 0);
        assert.equal(loadTakesState(dir).attempts.n, 1);
        const soon = base(dir, { now: () => NOW_MS + 30 * 60_000 });
        assert.equal((await reflectIfDue(soon.deps)).ran, false, '没到 2 小时');
        const garbled = base(dir, { now: () => NOW_MS + 3 * 3_600_000 - 24 * 3_600_000 + 24 * 3_600_000, generate: async () => '我觉得都挺好的' });
        assert.match((await reflectIfDue(garbled.deps)).error ?? '', /没有可用的 JSON/);
    });
});

describe('今晚的材料', () => {
    const fixture = (patch: Partial<ReadingBook> & { progress?: Partial<ReadingBook['progress']> } = {}): ReadingBook => {
        const { progress, ...rest } = patch;
        return {
            id: 'demo', title: '演示的书', aliases: ['演示'], author: '某作者', kind: '小说', platform: '平台', status: '连载中',
            progress: { startDay: '2026-10-01', start: 5, everyDays: 5, amount: 1, unit: '章', state: 'reading', ...progress },
            attitude: '作者写的态度，不进来', unreadKeywords: ['结局'],
            nodes: [
                { id: 'n1', topic: '开头', from: 1, keywords: ['开头'], points: ['主角小周进了一家旧书店'] },
                { id: 'n2', topic: '转折', from: 8, keywords: ['转折', '老板'], points: ['书店老板其实认识小周的父亲'] },
                { id: 'n3', topic: '主线', from: 30, keywords: ['主线', '大火'], points: ['一场大火烧了书店'] },
            ],
            ...rest,
        };
    };

    test('书：读到哪、读到的情节点是事实；还没读到的情节的关键词是剧透（通用的“主角 / 主线”不算）；放下的不想', () => {
        const [it] = bookItems(schedule, [fixture()], NOW);
        assert.equal(it!.key, 'book:demo');
        assert.equal(it!.kind, 'book');
        assert.ok(it!.progress >= 8, `${it!.progress}`);
        assert.match(it!.position, /^看到第 \d+ 章/);
        assert.ok(it!.facts.some(fact => fact.includes('旧书店')) && it!.facts.some(fact => fact.includes('认识小周的父亲')));
        assert.ok(!it!.facts.some(fact => fact.includes('大火')));
        assert.ok(it!.spoilers.includes('大火') && it!.spoilers.includes('结局') && !it!.spoilers.includes('主线'));
        assert.deepEqual(it!.names, ['演示的书', '演示', '某作者']);
        assert.deepEqual(bookItems(schedule, [fixture({ progress: { state: 'put_down' } as ReadingBook['progress'] })], NOW), []);
    });

    test('书读完了：位置写“已经读完了”，仍然值得想一次', () => {
        const [it] = bookItems(schedule, [fixture({ total: { amount: 12, unit: '章' }, progress: { max: 12, start: 12, everyDays: 1 } as ReadingBook['progress'] })], NOW);
        assert.equal(it!.position, '已经读完了');
        assert.ok(it!.facts.length > 0);
    });

    test('视频：最近两天她自己看的，要有字幕摘录；事实里有 up 主、分段、热评、画面', () => {
        const watched = (patch: Partial<Watched>): Watched => ({ bvid: 'BV1x', title: '一个做饭视频', owner: '某 up', tname: '美食', excerpt: '先热锅再放油，火候最要紧', hot: ['看饿了'], day: '2026-10-30', ...patch });
        const items = videoItems([
            watched({}), watched({ bvid: 'BV2', day: '2026-10-29', chapters: [{ from: 0, title: '备料' }, { from: 60, title: '下锅' }], frames: '灶台特写' }),
            watched({ bvid: 'BV3', day: '2026-10-20' }), watched({ bvid: 'BV4', excerpt: '  ' }),
        ], NOW);
        assert.deepEqual(items.map(i => i.key), ['video:BV1x', 'video:BV2']);
        assert.equal(items[0]!.position, '今天看的');
        assert.equal(items[1]!.position, '昨天看的');
        assert.match(items[1]!.facts.join('|'), /分段：备料 \/ 下锅/);
        assert.match(items[1]!.facts.join('|'), /热评：看饿了/);
        assert.match(items[1]!.facts.join('|'), /画面：灶台特写/);
        assert.deepEqual(items[0]!.names, ['一个做饭视频', '某 up']);
    });

    test('真卡里的书也能跑通：每本在读的书都有 key、事实非空', () => {
        const items = bookItems(schedule, card.character.books, NOW);
        assert.ok(items.length > 0);
        for (const it of items) assert.ok(it.key.startsWith('book:') && it.facts.length > 0 && it.names.includes(it.title), it.key);
    });
});

describe('放进提示词', () => {
    const takes = [
        take({ id: 't-1', at: 1, title: '药屋少女的呢喃', text: '壬氏那几次老盯着猫猫看，我总觉得他在试探她' }),
        take({ id: 't-2', key: 'video:BV1', kind: 'video', title: '一个做饭视频', names: ['一个做饭视频', '某 up'], at: 2, text: '先热锅再放油那一步，我以前总是反着来' }),
        take({ id: 't-3', key: 'book:rejinzhi', title: '惹金枝', names: ['惹金枝', '空留'], at: 3, text: '时不虞假死那一段我读得手心出汗' }),
    ];

    test('他提到了那本书 / 视频（书名、别名、up 主）：放那一条', () => {
        const line = takesLine(takes, '你的药屋看到哪了')!;
        assert.match(line, /《药屋少女的呢喃》：壬氏那几次/);
        assert.ok(!line.includes('惹金枝'));
        assert.match(takesLine(takes, '那个某 up 的视频你看了没')!, /视频《一个做饭视频》：先热锅/);
    });

    test('他只提作者 / up 主（书名和她写的那句里都没有这几个字）：靠称呼认出来，照样放', () => {
        const withAuthor = [take({ id: 't-9', title: '药屋少女的呢喃', names: ['药屋少女的呢喃', '日向夏'], text: '壬氏那几次老盯着猫猫看，我总觉得他在试探她' })];
        assert.match(takesLine(withAuthor, '日向夏的书你看了吗')!, /壬氏那几次/);
        assert.equal(takesLine(withAuthor, '今天天气不错'), undefined);
    });

    test('泛问最近看了什么 / 想了很久：放最新的两条；没聊到就一条都不放', () => {
        const line = takesLine(takes, '你最近有没有看什么书，让你想了很久的那种')!;
        assert.ok(line.includes('惹金枝') && line.includes('一个做饭视频') && !line.includes('药屋'), '最多两条、新的在前');
        assert.equal(takesLine(takes, '今天食堂有糖醋排骨'), undefined);
        assert.equal(takesLine(takes, undefined), undefined);
        assert.equal(takesLine([], '你最近看了什么'), undefined);
    });

    test('那一行不提夜里想的 / 日记 / 命令，也不是命令式', () => {
        const line = takesLine(takes, '药屋')!;
        assert.doesNotMatch(line, /日记|夜里|昨晚|\/[一-龥]/);
        assert.match(line, /他聊到了或问起才顺着自然说，别背，别每次都提/);
    });
});
