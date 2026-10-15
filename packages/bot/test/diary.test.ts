import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { Contact } from '../src/config.ts';
import { DIARY_BACKFILL_DAYS, DIARY_CHAT_CHARS, diaryMaterial, diaryMessages, diaryWriter, type DiarySources } from '../src/diary.ts';
import type { StoredMessage } from '../src/history.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import type { WrittenSources } from '../src/memory/provenance.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const sources: DiarySources = { charName: card.name, schedule: card.schedule!, moods: card.moods, books: card.books };
const at = (iso: string, role: 'user' | 'assistant', content: string): StoredMessage => ({ time: new Date(iso).toISOString(), role, content });

describe('她的日记（ADR 0017）', () => {
    test('承诺计划来源失败不当成空计划继续写，不产生未处理拒绝', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-plans-invalid-')); const logs: string[] = [];
        const writer = diaryWriter({ sources, dir, contacts: [], memory: {} as LongTermMemory,
            history: { load: () => [] }, log: line => logs.push(line),
            plans: () => { throw new Error('PRIVATE_PLAN_STATE'); }, generate: async () => assert.fail('不应生成日记') });
        try {
            await writer.catchUp(new Date('2026-10-08T12:00:00+08:00'));
            assert.ok(logs.some(line => line.includes('未知计划当成空白')));
            assert.ok(logs.every(line => !line.includes('PRIVATE_PLAN_STATE')));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('公共迁移状态读取失败只暂停本轮，不生成新日记或产生未处理拒绝', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-common-invalid-'));
        const logs: string[] = [];
        const memory = { writtenNeedsReshare: () => { throw new Error('PRIVATE_BAD_STATE'); } } as unknown as LongTermMemory;
        const writer = diaryWriter({ sources, dir, contacts: [], memory, log: line => logs.push(line),
            history: { load: () => assert.fail('不应读聊天') }, generate: async () => assert.fail('不应生成') });
        try {
            await writer.catchUp(new Date('2026-10-08T12:00:00+08:00'));
            assert.ok(logs.some(line => line.includes('公共记忆迁移状态读取失败')));
            assert.ok(logs.every(line => !line.includes('PRIVATE_BAD_STATE')));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('遗忘状态损坏只暂停日记，不产生未处理拒绝、不重建文件或调用外部服务', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-invalid-'));
        const path = join(dir, 'diary.json');
        const original = JSON.stringify({ texts: { '2026-10-06': '不能写进错误日志的正文' }, forgotten: { '2026-10-06': 'true' } });
        writeFileSync(path, original);
        const logs: string[] = [];
        let calls = 0;
        const unexpected = async () => { calls++; throw new Error('不应调用'); };
        const writer = diaryWriter({
            sources, dir, log: message => logs.push(message), contacts: [],
            history: { load: () => { calls++; return []; } }, generate: unexpected,
            memory: { retainDiary: unexpected, retainSummary: unexpected, readDiary: unexpected } as unknown as LongTermMemory,
        });
        try {
            await writer.catchUp(new Date('2026-10-08T12:00:00+08:00'));
            await writer.catchUp(new Date('2026-10-08T12:00:00+08:00'));
            assert.equal(calls, 0);
            assert.equal(readFileSync(path, 'utf8'), original);
            assert.equal(logs.length, 2);
            assert.ok(logs.every(line => line.includes('本轮停止') && !line.includes('不能写进错误日志的正文')));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('来源取实际材料的联系人，汇总带父日记 id；遗忘日期不再读回或参与生成', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-origin-'));
        writeFileSync(join(dir, 'diary.json'), JSON.stringify({ written: { '2026-10-06': 5 }, forgotten: { '2026-10-06': true } }));
        const origins: { id: string; sources: WrittenSources }[] = [];
        const memory = {
            retainDiary: async (date: string, _day: Date, _text: string, _char: string, source: WrittenSources) => { origins.push({ id: `diary:${date}`, sources: source }); return 'shared'; },
            retainSummary: async (id: string, _day: Date, _title: string, _text: string, _char: string, _kind: string, source: WrittenSources) => { origins.push({ id, sources: source }); return 'shared'; },
            readDiary: async (date: string) => { assert.notEqual(date, '2026-10-06'); return undefined; },
        } as unknown as LongTermMemory;
        const writer = diaryWriter({
            sources, dir, memory, log: () => {}, generate: async () => '今天读了书',
            contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }, { qq: 10002, name: '路人', tier: 'stranger' }],
            history: { load: () => [at('2026-10-07T20:00:00+08:00', 'user', '今天聊天')] },
        });
        try {
            await writer.catchUp(new Date('2026-10-08T12:00:00+08:00'));
            assert.equal(origins.some(e => e.id === 'diary:2026-10-06'), false);
            assert.deepEqual(origins.find(e => e.id === 'diary:2026-10-07')!.sources.contacts, [10001]);
            assert.ok(origins.filter(e => e.id.startsWith('phase:')).every(e => !e.sources.parents.includes('diary:2026-10-06')));
            assert.equal(JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8')).forgotten['2026-10-06'], true);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('材料：几点起、课（只写课型，不写课名和教室）、空闲活动、心情、书；不写在哪；没聊天的日子写明', () => {
        const text = diaryMaterial(sources, new Date(2026, 9, 9), []);
        assert.match(text, /^日期：10月9日 周五\n几点起：07:40\n课：08:20–09:40 机房课；09:55–11:15 机房课；13:40–15:00 机房课\n/);
        assert.match(text, /\n空闲时：.*晚上/);
        assert.match(text, /\n心情：安静（今天有早八，起得太早了）/);
        assert.match(text, /\n在读：《药屋少女的呢喃》看到第 8 卷、《惹金枝》看到第 520 章\n/, '放下的书不写');
        assert.match(text, /\n今天没和名单里的人聊天。$/);
        assert.doesNotMatch(text, /在哪|知行楼|济南|Python|概率论/);
        assert.match(diaryMaterial(sources, new Date(2026, 9, 6), []), /^日期：10月6日 周二（国庆节放假）\n/);
    });

    test('材料：她那边今天发生的事和身体（ADR 0026）——按同学档的卡，宿舍、闺蜜、相机、课名、生理期都不进；提示词要她挑一两件写', () => {
        const classmate = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-classmate.json'));
        const withWorld: DiarySources = { ...sources, world: classmate.herWorld! };
        const text = diaryMaterial(withWorld, new Date(2026, 9, 11), []);
        assert.match(text, /\n你那边今天：熬夜写完了 2 份作业；点了一杯奶茶外卖\n/, '天天一样的（没下雨、照常喂猫、还没写的作业）不写');
        assert.match(diaryMaterial(withWorld, new Date(2026, 9, 9), []), /\n你那边今天：下雨了；下雨没下楼喂土豆；去驿站取了快递（发圈）\n/);
        // 进公共库的那份按线上的调法（app.ts 传同学档的作息 worldSchedule）：空闲活动看不到的是 cover。
        // 不传作息时用的是男朋友档的，10-11 晚上抽到「研究新相机的设置」——以前只是那天碰巧没抽到修片（10-10 加了买相机以后的活动才发现）
        assert.doesNotMatch(diaryMaterial({ ...withWorld, worldSchedule: classmate.schedule! }, new Date(2026, 9, 11), []), /宿舍|室友|陈佳宁|苏雨桐|相机|视频|Linux|MySQL/, '同学档看不到的不进公共库');
        const cramps = diaryMaterial(withWorld, new Date(2026, 11, 21), []);
        assert.match(cramps, /\n身体：身上不太舒服，躺了大半天/);
        assert.doesNotMatch(cramps, /生理期|痛经/);
        assert.match(diaryMaterial(withWorld, new Date(2026, 10, 16), []), /\n身体：有点感冒，嗓子疼/);
        assert.doesNotMatch(diaryMaterial(sources, new Date(2026, 9, 11), []), /你那边今天|身体：/, '没传世界就没有');
        // 空闲时按同学档的作息（ADR 0034）：修片是 cover，改了的打算里没有课名
        const shown: DiarySources = { ...withWorld, worldSchedule: classmate.schedule! };
        // 10-18 下午男朋友档抽到修片（10-12 原来是，10-12 起加了新相机的新鲜期，那天换了）
        assert.match(diaryMaterial(withWorld, new Date(2026, 9, 18), []), /下午修昨天拍的片子/, '最亲那一档的作息里有');
        assert.doesNotMatch(diaryMaterial(shown, new Date(2026, 9, 18), []), /拍的片子|相机/, '同学档那天是 cover');
        const oct12 = diaryMaterial(shown, new Date(2026, 9, 12), []);
        assert.match(oct12, /\n空闲时：上午去图书馆占座；下午窝着刷手机；晚上本来打算打独立游戏，作业明天要交，先赶作业\n/);
        assert.doesNotMatch(oct12, /拍的片子|摄影|计算机网络/);
        assert.match(diaryMessages('林梦瑶', new Date(2026, 9, 11), text)[0]!.content, /「你那边今天」是今天真发生的事，最多挑一件，一句话带过，和材料一致；聊天里说过的事比它要紧，先写。身体不舒服的写一句/);
    });

    test('材料：每个人那天的聊天，「我」是她；太长的留最后的', () => {
        const long = 'x'.repeat(DIARY_CHAT_CHARS);
        const text = diaryMaterial({ ...sources, moods: [], books: [] }, new Date(2026, 9, 6), [
            { name: '鸽鸽', messages: [at('2026-10-06T18:30:00+08:00', 'user', '今天干啥了'), at('2026-10-06T18:31:00+08:00', 'assistant', '下午去看了电影\n刚回来')] },
            { name: '宝宝', messages: [at('2026-10-06T20:00:00+08:00', 'user', long), at('2026-10-06T20:01:00+08:00', 'assistant', '最后一句')] },
            { name: '阿明', messages: [] },
        ]);
        assert.match(text, /\n\[和鸽鸽\]\n18:30 鸽鸽：今天干啥了\n18:31 我：下午去看了电影／刚回来\n/);
        assert.match(text, /\n\[和宝宝\]\n……x+\n20:01 我：最后一句$/);
        assert.doesNotMatch(text, /阿明|心情|在读/);
    });

    test('材料：之前说过那天打算做的事（ADR 0018 决策 2）；提示词说没变卦就写做了', () => {
        assert.match(diaryMaterial(sources, new Date(2026, 9, 10), [], ['去拍银杏', '看完那本书']), /\n之前说过今天打算：去拍银杏；看完那本书\n/);
        assert.doesNotMatch(diaryMaterial(sources, new Date(2026, 9, 10), []), /打算/);
        assert.match(diaryMessages('林梦瑶', new Date(2026, 9, 10), '材料')[0]!.content as string, /之前说过今天打算做的事，聊天里没说变卦，就写做了/);
    });

    test('提示词只写怎么写，日期对', () => {
        const [system, user] = diaryMessages('林梦瑶', new Date(2026, 9, 6), '材料');
        assert.match(system!.content as string, /^你是林梦瑶，在读的女大学生，睡前在写今天（10月6日）的日记。/);
        assert.match(system!.content as string, /聊天里你说过自己做了什么.*照写/);
        assert.equal(user!.content, '材料');
    });

    test('补写：她这一天之前的 3 天，从早到晚；写过的不再写；那天的聊天按她的一天（到 02:00）算；陌生人档不算', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-'));
        const retained: { date: string; text: string }[] = [];
        const summaries: { id: string; title: string; text: string }[] = [];
        const memory = {
            retainDiary: async (date: string, _day: Date, text: string) => { retained.push({ date, text }); return true; },
            retainSummary: async (id: string, _day: Date, title: string, text: string) => { summaries.push({ id, title, text }); return true; },
            readDiary: async () => undefined,
        } as unknown as LongTermMemory;
        const materials: string[] = [];
        const logs: string[] = [];
        const contacts: Contact[] = [{ qq: 1, name: '宝宝', tier: 'boyfriend' }, { qq: 2, name: '路人', tier: 'stranger' }];
        const chats: Record<number, StoredMessage[]> = {
            1: [at('2026-10-06T01:30:00+08:00', 'user', '还没睡'), at('2026-10-06T21:00:00+08:00', 'user', '今天去哪了')],
            2: [at('2026-10-06T21:00:00+08:00', 'user', '在吗')],
        };
        const writer = diaryWriter({
            sources, contacts, memory, dir, log: m => logs.push(m),
            history: { load: qq => chats[qq] ?? [] },
            generate: async messages => { materials.push(messages[1]!.content as string); return ` 第${materials.length}篇 `; },
        });
        try {
            // 10-08 01:00 还算 10-07 这一天：补 10-04、10-05、10-06
            await writer.catchUp(new Date('2026-10-08T01:00:00+08:00'));
            assert.deepEqual(retained.map(r => r.date), ['2026-10-04', '2026-10-05', '2026-10-06']);
            assert.equal(retained[0]!.text, '第1篇');
            assert.match(materials[1]!, /01:30 宝宝：还没睡/, '10-06 01:30 算 10-05 这一天');
            assert.match(materials[2]!, /21:00 宝宝：今天去哪了/);
            assert.doesNotMatch(materials.join('\n'), /路人/);
            assert.ok(logs.some(l => l === '她的日记：2026-10-06 已写（3 字，聊过天的 1 人），存进公共记忆'));
            assert.equal(DIARY_BACKFILL_DAYS, 3);
            // 上周（9-28 到 10-04）有 10-04 这一篇：写周记（ADR 0018），9-21 那周一篇都没有，不写
            assert.deepEqual(summaries, [{ id: 'week:2026-09-28', title: '林梦瑶的周记（9月28日–10月4日）', text: '第4篇' }]);
            assert.equal(materials[3], '[10月4日 周日]\n第1篇');

            await writer.catchUp(new Date('2026-10-08T03:00:00+08:00'));
            assert.deepEqual(retained.map(r => r.date).slice(3), ['2026-10-07'], '写过的不再写');
            assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8')).written), ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('周记、阶段总结（ADR 0018）：本地没有原文的从公共记忆读回，读不到下次再写；国庆结束后写总结；原文本地存一份', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-'));
        // 以前（ADR 0018 之前）写过 10-03、10-04，本地只记了字数
        writeFileSync(join(dir, 'diary.json'), JSON.stringify({ written: { '2026-10-03': 3, '2026-10-04': 3, '2026-10-05': 3, '2026-10-06': 3 } }));
        let readFails = true;
        const read: string[] = [];
        const summaries: { id: string; title: string }[] = [];
        const memory = {
            retainDiary: async () => true,
            retainSummary: async (id: string, _day: Date, title: string) => { summaries.push({ id, title }); return true; },
            readDiary: async (date: string) => {
                read.push(date);
                if (readFails) throw new Error('fetch failed');
                return `${date} 的日记`;
            },
        } as unknown as LongTermMemory;
        const prompts: string[] = [];
        const logs: string[] = [];
        const writer = diaryWriter({
            sources, contacts: [], memory, dir, log: m => logs.push(m), history: { load: () => [] },
            generate: async messages => { prompts.push(messages[1]!.content as string); return '写好了'; },
        });
        try {
            // 10-08 中午：补写 10-07 的日记；上周（9-28 到 10-04）的周记要读回 10-03、10-04，读不到这次就停下
            await writer.catchUp(new Date('2026-10-08T12:00:00+08:00'));
            assert.ok(logs.some(l => l.includes('从公共记忆读 2026-10-03 的日记失败，周记下次再写')));
            assert.deepEqual(summaries, []);
            readFails = false;
            await writer.catchUp(new Date('2026-10-08T12:00:00+08:00'));
            assert.deepEqual(summaries, [
                { id: 'week:2026-09-28', title: '林梦瑶的周记（9月28日–10月4日）' },
                { id: 'phase:国庆节:2026-10-07', title: '林梦瑶的国庆节总结（10月1日–10月7日）' },
            ]);
            assert.equal(prompts.at(-2), '[10月3日 周六]\n2026-10-03 的日记\n\n[10月4日 周日]\n2026-10-04 的日记');
            // 国庆总结：10-03、10-04 读回过，本地存着；10-05、10-06 也是以前写的，读回；10-07 是这次写的
            assert.match(prompts.at(-1)!, /^\[10月3日 周六\]\n2026-10-03 的日记\n\n.*\n\n\[10月7日 周三\]\n写好了$/s);
            const state = JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8'));
            assert.deepEqual(state.weeks, { '2026-09-21': 0, '2026-09-28': 3 });
            assert.deepEqual(state.phases, { '中秋节:2026-09-27': 0, '国庆节:2026-10-07': 3 }, '中秋那几天没有日记，不写');
            assert.equal(state.texts['2026-10-07'], '写好了');
            assert.ok(logs.includes('她的周记：2026-09-28 那周已写（3 字，用了 2 篇日记），存进公共记忆'));
            assert.ok(logs.includes('她的国庆节总结已写（3 字，用了 5 篇日记），存进公共记忆'));
            // 写过的不再写，也不再读
            const before = read.length;
            await writer.catchUp(new Date('2026-10-08T18:00:00+08:00'));
            assert.equal(summaries.length, 2);
            assert.equal(read.length, before);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('模型出错、回空的、写进记忆失败：这次停下，不记成写过，下次再写；同一时间只跑一次', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-'));
        let fail: 'model' | 'empty' | 'memory' | undefined = 'model';
        let calls = 0;
        const memory = { retainDiary: async () => fail !== 'memory', retainSummary: async () => true, readDiary: async () => undefined } as unknown as LongTermMemory;
        const logs: string[] = [];
        const writer = diaryWriter({
            sources, contacts: [], memory, dir, log: m => logs.push(m), history: { load: () => [] },
            generate: async () => {
                calls++;
                await new Promise(r => setTimeout(r, 5));
                if (fail === 'model') throw new Error('模型接口返回 401');
                return fail === 'empty' ? ' ' : '日记';
            },
        });
        const now = new Date('2026-10-08T12:00:00+08:00');
        try {
            await writer.catchUp(now);
            assert.ok(logs.some(l => l.includes('2026-10-05 没写成（模型接口返回 401），下次再写')));
            fail = 'empty';
            await writer.catchUp(now);
            assert.ok(logs.some(l => l === '她的日记：2026-10-05 模型回了空的，下次再写'));
            fail = 'memory';
            await writer.catchUp(now);
            fail = undefined;
            calls = 0;
            await Promise.all([writer.catchUp(now), writer.catchUp(now)]);
            assert.equal(calls, 4, '两次一起调只跑一次：补 3 天日记，再写刚结束的国庆节总结（ADR 0018）');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('旧日记补写进 v2 标签（ADR 0070 第 2 项的迁移）', () => {
    const setup = (opts: { failOn?: string; missingOn?: string; markFails?: boolean } = {}) => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-reshare-'));
        // 以前写过：10-03 的日记（本地没存原文）、10-05 的日记（本地有原文）、10-04 的日记含高敏、一周周记；10-02 被她要求遗忘
        writeFileSync(join(dir, 'diary.json'), JSON.stringify({
            version: 1,
            written: { '2026-10-02': 3, '2026-10-03': 3, '2026-10-04': 3, '2026-10-05': 3 },
            texts: { '2026-10-05': '本地有的第五天' },
            weeks: { '2026-09-21': 5, '2026-09-14': 0 },
            phases: {},
            forgotten: { '2026-10-02': true },
        }));
        const retained: { date: string; text: string }[] = [];
        const summaries: { id: string; text: string }[] = [];
        const reads: string[] = [];
        let marked = 0;
        const memory = {
            writtenNeedsReshare: () => marked === 0,
            markWrittenReshared: () => { if (opts.markFails) throw new Error('disk write failed'); marked++; },
            readWritten: async (id: string) => { reads.push(id); return id === opts.missingOn ? undefined : `旧正文 ${id}`; },
            retainDiary: async (date: string, _day: Date, text: string, _char: string, sources: WrittenSources) => {
                assert.deepEqual(sources, { contacts: [], parents: [], complete: false }, '旧日记不知道是谁的聊天，标成来源不完整');
                if (opts.failOn === date) return false;
                retained.push({ date, text });
                return date === '2026-10-04' ? 'local-only' : 'shared';
            },
            retainSummary: async (id: string, _day: Date, _title: string, text: string) => { summaries.push({ id, text }); return 'shared'; },
        } as unknown as LongTermMemory;
        const logs: string[] = [];
        const writer = diaryWriter({
            sources, contacts: [], memory, dir, log: message => logs.push(message), history: { load: () => [] },
            generate: async () => { throw new Error('补写旧日记时不该生成新日记'); },
        });
        return { dir, writer, retained, summaries, reads, logs, marked: () => marked };
    };

    test('每篇旧日记和周记按同一个 id 重新写一遍：本地有原文用本地的，没有的按 id 读回；遗忘的和 0 字的不写；写完标记一次', async () => {
        const { dir, writer, retained, summaries, reads, logs, marked } = setup();
        try {
            await writer.catchUp(new Date('2026-10-06T12:00:00+08:00'));
            assert.deepEqual(retained, [
                { date: '2026-10-03', text: '旧正文 diary:2026-10-03' },
                { date: '2026-10-04', text: '旧正文 diary:2026-10-04' },
                { date: '2026-10-05', text: '本地有的第五天' },
            ]);
            assert.deepEqual(summaries, [{ id: 'week:2026-09-21', text: '旧正文 week:2026-09-21' }]);
            assert.ok(!reads.includes('diary:2026-10-02'), '遗忘的不读也不写');
            assert.ok(!reads.includes('diary:2026-10-05'), '本地有原文不读');
            assert.ok(!reads.includes('week:2026-09-14'), '0 字的周（没有日记）不写');
            assert.equal(marked(), 1);
            assert.ok(logs.some(line => line.includes('（3 篇共享，1 篇含高敏、只留本地）')), logs.join(' | '));
            // 标记以后不再补写
            await writer.catchUp(new Date('2026-10-06T13:00:00+08:00'));
            assert.equal(retained.length, 3);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('任何一篇写失败就停、不标记，下一轮整轮重来', async () => {
        const { dir, writer, retained, marked } = setup({ failOn: '2026-10-04' });
        try {
            await writer.catchUp(new Date('2026-10-06T12:00:00+08:00'));
            assert.deepEqual(retained.map(item => item.date), ['2026-10-03']);
            assert.equal(marked(), 0, '没写完不标记');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('日记、周记或阶段总结暂无正文时不标迁移完成；下次读到后可补写', async () => {
        for (const missingOn of ['diary:2026-10-03', 'week:2026-09-21', 'phase:国庆节:2026-10-07']) {
            const opts: { missingOn?: string } = { missingOn };
            const { dir, writer, marked, logs } = setup(opts);
            const path = join(dir, 'diary.json');
            const state = JSON.parse(readFileSync(path, 'utf8'));
            if (missingOn.startsWith('phase:')) {
                state.phases['国庆节:2026-10-07'] = 5;
                state.forgotten = {};
                writeFileSync(path, JSON.stringify(state));
            }
            try {
                await writer.catchUp(new Date('2026-10-06T12:00:00+08:00'));
                assert.equal(marked(), 0);
                assert.ok(logs.some(line => line.includes('暂无可用正文')));
                opts.missingOn = undefined;
                await writer.catchUp(new Date('2026-10-06T13:00:00+08:00'));
                assert.equal(marked(), 1);
            } finally { rmSync(dir, { recursive: true, force: true }); }
        }
    });

    test('旧周记和阶段总结涉及遗忘日期时整篇不读不重放，无关周记保留', async () => {
        const { dir, writer, marked, reads, summaries, logs } = setup();
        const path = join(dir, 'diary.json');
        const state = JSON.parse(readFileSync(path, 'utf8'));
        state.weeks['2026-09-28'] = 5;
        state.phases['国庆节:2026-10-07'] = 5;
        writeFileSync(path, JSON.stringify(state));
        try {
            await writer.catchUp(new Date('2026-10-06T12:00:00+08:00'));
            assert.equal(marked(), 1);
            assert.ok(!reads.includes('week:2026-09-28'));
            assert.ok(!reads.includes('phase:国庆节:2026-10-07'));
            assert.deepEqual(summaries.map(item => item.id), ['week:2026-09-21']);
            assert.ok(logs.some(line => line.includes('2 篇旧总结涉及遗忘日期')));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('完成标记写盘失败只暂停迁移，下一轮仍可重试', async () => {
        const opts = { markFails: true };
        const { dir, writer, marked, logs } = setup(opts);
        try {
            await writer.catchUp(new Date('2026-10-06T12:00:00+08:00'));
            assert.equal(marked(), 0);
            assert.ok(logs.some(line => line.includes('disk write failed')));
            opts.markFails = false;
            await writer.catchUp(new Date('2026-10-06T13:00:00+08:00'));
            assert.equal(marked(), 1);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
