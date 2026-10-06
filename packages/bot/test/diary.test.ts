import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { Contact } from '../src/config.ts';
import { DIARY_BACKFILL_DAYS, DIARY_CHAT_CHARS, diaryMaterial, diaryMessages, diaryWriter, type DiarySources } from '../src/diary.ts';
import type { StoredMessage } from '../src/history.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const sources: DiarySources = { charName: card.name, schedule: card.schedule!, moods: card.moods, books: card.books };
const at = (iso: string, role: 'user' | 'assistant', content: string): StoredMessage => ({ time: new Date(iso).toISOString(), role, content });

describe('她的日记（ADR 0017）', () => {
    test('材料：几点起、课（只写课型，不写课名和教室）、空闲活动、心情、书；不写在哪；没聊天的日子写明', () => {
        const text = diaryMaterial(sources, new Date(2026, 9, 9), []);
        assert.match(text, /^日期：10月9日 周五\n几点起：07:40\n课：08:20–09:40 机房课；09:55–11:15 机房课；13:40–15:00 机房课\n/);
        assert.match(text, /\n空闲时：.*晚上/);
        assert.match(text, /\n心情：安静（今天有早八，起得太早了）/);
        assert.match(text, /\n在读：《药屋少女的呢喃》看到第 8 卷/);
        assert.match(text, /\n今天没和名单里的人聊天。$/);
        assert.doesNotMatch(text, /在哪|知行楼|济南|Python|概率论/);
        assert.match(diaryMaterial(sources, new Date(2026, 9, 6), []), /^日期：10月6日 周二（国庆节放假）\n/);
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

    test('提示词只写怎么写，日期对', () => {
        const [system, user] = diaryMessages('林梦瑶', new Date(2026, 9, 6), '材料');
        assert.match(system!.content as string, /^你是林梦瑶，在读的女大学生，睡前在写今天（10月6日）的日记。/);
        assert.match(system!.content as string, /聊天里你说过自己做了什么.*照写/);
        assert.equal(user!.content, '材料');
    });

    test('补写：她这一天之前的 3 天，从早到晚；写过的不再写；那天的聊天按她的一天（到 02:00）算；陌生人档不算', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-'));
        const retained: { date: string; text: string }[] = [];
        const memory = { retainDiary: async (date: string, _day: Date, text: string) => { retained.push({ date, text }); return true; } } as unknown as LongTermMemory;
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

            await writer.catchUp(new Date('2026-10-08T03:00:00+08:00'));
            assert.deepEqual(retained.map(r => r.date).slice(3), ['2026-10-07'], '写过的不再写');
            assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8')).written), ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('模型出错、回空的、写进记忆失败：这次停下，不记成写过，下次再写；同一时间只跑一次', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-'));
        let fail: 'model' | 'empty' | 'memory' | undefined = 'model';
        let calls = 0;
        const memory = { retainDiary: async () => fail !== 'memory' } as unknown as LongTermMemory;
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
            assert.equal(calls, 3, '两次一起调只跑一次，补 3 天');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
