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
