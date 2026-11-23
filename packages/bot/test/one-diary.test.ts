// 一本日记（ADR 0347 第 3 层，开关 oneDiary）：统一读法、「电脑上」那一行、抄一份当天日记进 JOURNAL.md。
// 只用合成角色和临时目录，不碰 characters/ 和 runtime/。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { selfThread, selfThreadFromDiaries, journalOn, journalOnDiaries } from '../src/language/self-thread.ts';
import { wakeBackfill } from '../src/memory/wake-backfill.ts';
import { appendDayDiary, desktopDiaryLine, diaryTail, hasDayDiary, latestDiary, oneDiaryEntries, windowFor } from '../src/life/one-diary.ts';
import { DESKTOP_DIARY_NOTE, diaryMaterial, diaryMessages, diaryWriter, type DiarySources } from '../src/life/diary.ts';
import { dreamJobs } from '../src/life/dream-jobs.ts';
import { formatDate, herDay } from '../src/life/schedule.ts';
import type { Contact } from '../src/platform/config.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

const card = loadCharacterCard(syntheticCardPath('boyfriend'));
const sources: DiarySources = { charName: card.name, schedule: card.schedule!, moods: card.moods, books: card.books };
const T = (iso: string) => Date.parse(iso);

function dirs() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-one-diary-'));
    const soulDir = join(root, 'soul'), dataDir = join(root, 'data');
    mkdirSync(soulDir, { recursive: true }); mkdirSync(join(dataDir, 'memory'), { recursive: true });
    return { root, soulDir, dataDir };
}

const AUTO_21 = '今天上午两节课，下午在宿舍把作业写完了，晚上和宝宝聊到很晚。';
const HAND_21 = '在电脑上陪他弄了一下午表格，眼睛有点酸。';
const AUTO_20 = '没课的一天，睡到自然醒，下午去图书馆还书。';

function seed(d: ReturnType<typeof dirs>) {
    // JOURNAL.md：11-20 她手写一段；11-21 她在桌面上手写一段，加 QQ 抄过去的那份当天日记
    writeFileSync(join(d.soulDir, 'JOURNAL.md'), `# 日记\n\n## 2026-11-20\n手写的那天。\n\n## 2026-11-21\n${HAND_21}\n\n## 2026-11-21（当天）\n${AUTO_21}\n`);
    writeFileSync(join(d.dataDir, 'memory', 'diary.json'), JSON.stringify({ written: { '2026-11-20': 10, '2026-11-21': 10 }, texts: { '2026-11-20': AUTO_20, '2026-11-21': AUTO_21 } }));
    writeFileSync(join(d.dataDir, 'self-diary.json'), JSON.stringify({ entries: [{ at: T('2026-11-20T21:00:00+08:00'), text: '聊天里写的一句。' }] }));
}

describe('一本日记：读', () => {
    test('三份合成一本：抄过去的「（当天）」不重复，同一天当天日记 > 手写 > <<日记>>', () => {
        const d = dirs();
        try {
            seed(d);
            const entries = oneDiaryEntries(d, T('2026-11-22T10:00:00+08:00'));
            assert.deepEqual(entries.map(e => `${e.date}:${e.source}`), ['2026-11-20:auto', '2026-11-20:journal', '2026-11-20:self', '2026-11-21:auto', '2026-11-21:journal']);
            assert.equal(entries.filter(e => e.text === AUTO_21).length, 1, 'JOURNAL.md 里抄过去的那份不再算一篇');
            assert.deepEqual(latestDiary(entries), { date: '2026-11-21', text: AUTO_21 });
            // selfThread / 首轮铺底：一本日记取当天日记；原来的读法（只读 JOURNAL.md 最后一段）不变
            assert.ok(selfThreadFromDiaries(entries)!.text.startsWith('今天上午两节课'));
            assert.equal(selfThreadFromDiaries([]), undefined);
            const journal = readFileSync(join(d.soulDir, 'JOURNAL.md'), 'utf8');
            assert.equal(selfThread(journal)!.date, '2026-11-21');
            const now = T('2026-11-22T10:00:00+08:00'), lastAt = new Date(now - 10 * 3_600_000).toISOString();
            assert.match(wakeBackfill({ lastAt, now, journal: '', diaries: entries })!, /今天上午两节课/);
            const only = '## 2026-11-21\n只在 JOURNAL 里的那段。\n';
            assert.match(wakeBackfill({ lastAt, now, journal: only })!, /只在 JOURNAL 里的那段/, '不给 diaries 就照旧读 journal');
            assert.doesNotMatch(wakeBackfill({ lastAt, now, journal: only, diaries: entries })!, /只在 JOURNAL/);
            assert.equal(wakeBackfill({ lastAt, now, journal: '', diaries: [] }), undefined);
            // journalOn：当天日记排前面；原来的 journalOn 不读 diary.json
            assert.equal(journalOnDiaries(entries, '2026-11-20'), `${AUTO_20} ／ 手写的那天。 ／ 聊天里写的一句。`);
            assert.equal(journalOnDiaries(entries, '2026-11-19'), undefined);
            assert.ok(!journalOn(journal, [], '2026-11-20')!.includes(AUTO_20));
            // 做梦的日记尾巴
            const tail = diaryTail(entries, 400);
            assert.ok(tail.endsWith(HAND_21));
            assert.match(tail, /## 2026-11-21\n今天上午两节课/);
            assert.equal(diaryTail(entries, 10).length, 10);
        } finally { rmSync(d.root, { recursive: true, force: true }); }
    });

    test('他问到半个多月前：窗口按那一天往回算', () => {
        const now = T('2026-11-22T10:00:00+08:00');
        assert.equal(windowFor('2026-11-21', now), 14);
        assert.ok(windowFor('2026-11-01', now) >= 22);
        assert.equal(windowFor('坏日期', now), 14);
    });

    test('做梦：oneDiary 开着才从那一本取，关着照旧只读 JOURNAL.md', async () => {
        for (const oneDiary of [false, true, undefined]) {
            const d = dirs();
            try {
                seed(d);
                writeFileSync(join(d.soulDir, 'JOURNAL.md'), '## 2026-11-21\n只在 JOURNAL 里的那段。\n');
                const prompts: string[] = [];
                const owner: Contact = { qq: 1, name: '宝宝', tier: 'boyfriend' };
                const jobs = dreamJobs({
                    owner, character: () => ({ name: card.name, books: [] }) as never, dataDir: d.dataDir, soulDir: () => d.soulDir,
                    now: () => new Date('2026-11-21T21:00:00+08:00'), log: () => {}, stopped: () => false,
                    generate: () => async (messages: OpenAIMessage[]) => { prompts.push(String(messages[1]!.content)); return 'SKIP'; },
                    lastFeelings: () => undefined, rememberSelfNote: () => undefined,
                    ...(oneDiary === undefined ? {} : { oneDiary }),
                });
                jobs.tick();
                for (let i = 0; i < 20 && !prompts.length; i++) await new Promise(resolve => setImmediate(resolve));
                assert.equal(prompts.length, 1);
                if (oneDiary) assert.match(prompts[0]!, /今天上午两节课/);
                else { assert.match(prompts[0]!, /只在 JOURNAL 里的那段/); assert.doesNotMatch(prompts[0]!, /今天上午两节课/); }
            } finally { rmSync(d.root, { recursive: true, force: true }); }
        }
    });
});

describe('一本日记：「电脑上」那一行', () => {
    const dayOf = (at: Date) => formatDate(herDay(card.schedule!, at));
    // 他在电脑上的原话：长、好认，任何 8 个字的片段都不能出现在日记材料里
    const USER = '帮我把D盘里那个季度报销的发票表格按月份重新排一下顺便检查金额对不对';
    const HER = '好呀我先把一月到三月的发票都读出来再按日期排好然后核对每一笔的金额';
    const turn = (at: string, userAt?: string) => ({ at: T(at), ...(userAt ? { userAt: T(userAt) } : {}), user: USER, assistant: HER });
    const turns = [
        turn('2026-11-21T14:20:00+08:00', '2026-11-21T14:10:00+08:00'),
        turn('2026-11-21T15:00:00+08:00'),
        turn('2026-11-21T15:40:00+08:00'),
        turn('2026-11-21T16:05:00+08:00'),
        // 半夜那段（02:00 前算 11-21 这一天）
        turn('2026-11-21T23:50:00+08:00', '2026-11-21T23:40:00+08:00'),
        turn('2026-11-22T00:30:00+08:00'),
        // 别的日子
        turn('2026-11-20T10:00:00+08:00'),
    ];
    test('只带她主动选记的摘要，按她的一天归档', () => {
        const line = desktopDiaryLine({
            date: '2026-11-21', dayOf,
            turns: [
                ...turns,
                { ...turn('2026-11-21T13:01:00+08:00'), assistant: '【聊完还在想，也想写进今天的日记：被截断的摘要' },
                { ...turn('2026-11-22T00:35:00+08:00'), assistant: '刚才的话我还在想。 【聊完还在想，也想写进今天的日记：原来我有点怕跟人说再见。】' },
                { ...turn('2026-11-22T10:00:00+08:00'), assistant: '【聊完还在想，也想写进今天的日记：隔天的事。】' },
                { ...turn('2026-11-21T13:00:00+08:00'), user: '【聊完还在想，也想写进今天的日记：他替我写的。】' },
            ],
        });
        assert.equal(line, '电脑上你想留下的事：原来我有点怕跟人说再见。');
        assert.equal(desktopDiaryLine({ date: '2026-11-21', dayOf, turns }), undefined);
    });

    test('不给 desktop 时材料、提示词和原来逐字一样；给了才多那一句说明', () => {
        const day = new Date(2026, 10, 21);
        assert.equal(diaryMaterial(sources, day, [], []), diaryMaterial(sources, day, [], [], undefined));
        assert.doesNotMatch(diaryMaterial(sources, day, []), /电脑上/);
        assert.deepEqual(diaryMessages(card.name, day, 'x'), diaryMessages(card.name, day, 'x', false));
        assert.ok(!String(diaryMessages(card.name, day, 'x')[0]!.content).includes(DESKTOP_DIARY_NOTE));
        assert.ok(String(diaryMessages(card.name, day, 'x', true)[0]!.content).includes(DESKTOP_DIARY_NOTE));
    });
});

describe('一本日记：写', () => {
    const memory = () => {
        const retained: string[] = [];
        return { retained, memory: { retainDiary: async (date: string) => { retained.push(date); return true; }, retainSummary: async () => true, readDiary: async () => undefined } as unknown as LongTermMemory };
    };

    test('日记写手：那一行进材料、冻进来源清单——桌面账滚掉以后写好的日记不被当成来源变了；写完抄一份进 JOURNAL.md，一天一次', async () => {
        const d = dirs();
        try {
            const { retained, memory: mem } = memory();
            const materials: string[] = [], logs: string[] = [];
            let line: string | undefined = '电脑上：14:10–16:05 陪他（中间帮他查了资料）';
            const copied: string[] = [];
            const writer = diaryWriter({
                sources, contacts: [], memory: mem, dir: join(d.dataDir, 'memory'), log: m => logs.push(m), history: { load: () => [] },
                generate: async messages => { materials.push(String(messages[1]!.content)); return `第${materials.length}篇`; },
                desktopLine: date => (date === '2026-11-20' ? line : undefined),
                onDiary: (date, text) => { copied.push(date); appendDayDiary(d.soulDir, date, text); },
            });
            await writer.catchUp(new Date('2026-11-22T10:00:00+08:00'));
            assert.deepEqual(retained, ['2026-11-19', '2026-11-20', '2026-11-21']);
            assert.match(materials[1]!, /\n电脑上：14:10–16:05 陪他（中间帮他查了资料）\n/);
            assert.doesNotMatch(materials[0]! + materials[2]!, /电脑上/);
            const state = JSON.parse(readFileSync(join(d.dataDir, 'memory', 'diary.json'), 'utf8'));
            assert.equal(state.confirmed['diary:2026-11-20'].manifest.desktop, line);
            assert.ok(!('desktop' in state.confirmed['diary:2026-11-19'].manifest), '没有那一行就没有这个字段');
            // 桌面账滚掉了（或者那一行算出来变了）：核对来源用冻住的那行，写好的日记照样有效
            line = undefined;
            assert.equal(writer.verifySources(new Date('2026-11-22T11:00:00+08:00')), true);
            const after = JSON.parse(readFileSync(join(d.dataDir, 'memory', 'diary.json'), 'utf8'));
            assert.ok(Object.values(after.confirmed as Record<string, { sourceVerified: boolean }>).every(r => r.sourceVerified));
            // 抄进 JOURNAL.md：三天各一段「（当天）」
            assert.deepEqual(copied, ['2026-11-19', '2026-11-20', '2026-11-21']);
            const journal = readFileSync(join(d.soulDir, 'JOURNAL.md'), 'utf8');
            assert.equal(journal, '\n## 2026-11-19（当天）\n第1篇\n\n## 2026-11-20（当天）\n第2篇\n\n## 2026-11-21（当天）\n第3篇\n');
            // 再跑一次不重写、不重抄
            await writer.catchUp(new Date('2026-11-22T12:00:00+08:00'));
            assert.equal(retained.length, 3);
            assert.equal(readFileSync(join(d.soulDir, 'JOURNAL.md'), 'utf8'), journal);
            await writer.stop();
        } finally { rmSync(d.root, { recursive: true, force: true }); }
    });

    test('不给 desktopLine / onDiary：来源清单和原来一样，不碰 JOURNAL.md', async () => {
        const d = dirs();
        try {
            const { memory: mem } = memory();
            const writer = diaryWriter({ sources, contacts: [], memory: mem, dir: join(d.dataDir, 'memory'), log: () => {}, history: { load: () => [] }, generate: async () => '一篇' });
            await writer.catchUp(new Date('2026-11-22T10:00:00+08:00'));
            const state = JSON.parse(readFileSync(join(d.dataDir, 'memory', 'diary.json'), 'utf8'));
            for (const receipt of Object.values(state.confirmed as Record<string, { manifest: object }>)) assert.ok(!('desktop' in receipt.manifest));
            assert.throws(() => readFileSync(join(d.soulDir, 'JOURNAL.md')));
        } finally { rmSync(d.root, { recursive: true, force: true }); }
    });

    test('onDiary 出错只记日志，日记照样写成', async () => {
        const d = dirs();
        try {
            const { retained, memory: mem } = memory();
            const logs: string[] = [];
            const writer = diaryWriter({ sources, contacts: [], memory: mem, dir: join(d.dataDir, 'memory'), log: m => logs.push(m), history: { load: () => [] }, generate: async () => '一篇',
                onDiary: () => { throw new Error('磁盘满了'); } });
            await writer.catchUp(new Date('2026-11-22T10:00:00+08:00'));
            assert.equal(retained.length, 3);
            assert.ok(logs.some(m => m.includes('抄给桌面那份没写成')));
        } finally { rmSync(d.root, { recursive: true, force: true }); }
    });

    test('appendDayDiary：已有那天的「（当天）」就不写；她手写的段落留着；正文里的 # 不会切出新的一天', () => {
        const d = dirs();
        try {
            const path = join(d.soulDir, 'JOURNAL.md');
            writeFileSync(path, '## 2026-11-21\n她自己手写的。');
            assert.equal(appendDayDiary(d.soulDir, '2026-11-21', '## 不是标题\n正文'), true);
            assert.equal(appendDayDiary(d.soulDir, '2026-11-21', '又一篇'), false);
            assert.equal(appendDayDiary(d.soulDir, '坏日期', '正文'), false);
            assert.equal(appendDayDiary(d.soulDir, '2026-11-22', '   '), false);
            const text = readFileSync(path, 'utf8');
            assert.equal(text, '## 2026-11-21\n她自己手写的。\n\n## 2026-11-21（当天）\n不是标题\n正文\n');
            assert.ok(hasDayDiary(text, '2026-11-21'));
            assert.ok(!hasDayDiary('## 2026-11-21\n手写', '2026-11-21'));
            // 没有 JOURNAL.md 时新建
            assert.equal(appendDayDiary(join(d.root, 'data'), '2026-11-20', '一篇'), true);
        } finally { rmSync(d.root, { recursive: true, force: true }); }
    });
});
