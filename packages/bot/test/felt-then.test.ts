import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { feltDayNote, feltDuring, feltNoteFor, feltThen, sameThing, withoutGrudges } from '../src/emotion/felt-then.ts';
import { appraisals, type Appraisal } from '../src/emotion/feelings.ts';
import type { RecallResult } from '../src/memory/hindsight.ts';
import { formatRecalled } from '../src/memory/long-term.ts';
import { loadTierCard, recapText } from '../src/platform/contact.ts';
import { worldAt } from '../src/world/world.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// ADR 0218：回忆带着当时的感觉。她：「连当时谁说了什么都在，但就是没有那个『我当时什么感觉』」
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const a = (id: string, when: number, kind: Appraisal['kind'], strength: Appraisal['strength'], cause: string, extra: Partial<Appraisal> = {}): Appraisal =>
    ({ id, at: when, kind, strength, cause, source: 'self', ...extra });

describe('回忆带着当时的感觉：护栏和对得上', () => {
    test('因为他而难过 / 烦 / 担心的拿掉；因为他开心的留着；别的来由的难过留着', () => {
        const list = [
            a('1', at(2, 20), 'sad', 2, '他说话很冲', { aboutHim: true }),
            a('2', at(2, 20), 'joy', 2, '他陪我聊到很晚', { aboutHim: true }),
            a('3', at(2, 20), 'sad', 2, '小测没考好'),
        ];
        assert.deepEqual(withoutGrudges(list).map(x => x.id), ['2', '3']);
        const felt = feltThen(list, at(2, 21));
        assert.ok(felt.every(f => f.cause !== '他说话很冲'), JSON.stringify(felt));
        assert.ok(felt.length <= 2);
    });

    test('只附明显以上的；对得上（同一件事）才附；对不上不硬贴', () => {
        const felt = feltThen([a('1', at(2, 20), 'tired', 3, '专业课的作业做到十一点还没弄完')], at(2, 21));
        assert.equal(felt[0]!.level, 'strong');
        assert.ok(sameThing(felt[0]!, '林梦瑶说专业课作业做到很晚'));
        assert.equal(feltNoteFor(felt, '你说专业课作业做到很晚'), '那时你心里很累', '只写感觉，不重复经过');
        assert.equal(feltNoteFor(felt, '宝宝下午面试过了'), undefined);
        assert.equal(feltThen([a('1', at(2, 20), 'joy', 1, '晚霞很好看')], at(2, 21)).length, 0, '小事（刚能察觉）不附');
    });

    test('当时的感觉按事情发生时取：下午的难过到晚上淡了，也算那天的', () => {
        const list = [a('1', at(2, 15), 'sad', 2, '水卡丢了，跑了两趟宿管')];
        assert.equal(feltThen(list, at(2, 21, 30)).length, 0, '按晚上那一刻算就没了');
        const felt = feltDuring(list, at(2, 0), at(2, 21, 30));
        assert.equal(felt[0]!.kind, 'sad');
        assert.equal(felt[0]!.cause, '水卡丢了，跑了两趟宿管');
        assert.deepEqual(feltDuring([a('1', at(2, 15), 'sad', 2, '他说话很冲', { aboutHim: true })], at(2, 0), at(2, 21, 30)), [], '护栏照样在');
    });

    test('他问到那天：整天的，写明「是你当时的感觉、不用说出来」；没有就没有', () => {
        const felt = feltThen([a('1', at(2, 20), 'annoyed', 2, '和舍友拌了两句嘴'), a('2', at(2, 19), 'joy', 2, '代码终于跑通了')], at(2, 21));
        const note = feltDayNote(felt)!;
        assert.match(note, /^那天你心里：有点(烦|开心)——/);
        assert.ok(note.includes('是你当时的感觉，现在不一定还这样') && note.includes('不用说出来'));
        assert.equal(feltDayNote([]), undefined);
    });
});

describe('回忆带着当时的感觉：接进记忆和那天的流水账', () => {
    const result = (text: string, occurred: string): RecallResult => ({ id: text, text, type: 'world', occurred_start: occurred, mentioned_at: occurred, entities: [] } as unknown as RecallResult);

    test('召回的记忆：对得上的那条括号里多一句；计划（还没到的）、没传钩子时和原来一样', () => {
        const now = new Date(2026, 10, 5, 20, 0);
        const results = [result('林梦瑶说专业课作业做到很晚', '2026-11-02T13:00:00+08:00'), result('林梦瑶打算周六去拍照', '2026-11-08T10:00:00+08:00')];
        const plain = formatRecalled(results, { now });
        const felt = (day: Date, text: string) => (day.getDate() === 2 && text.includes('作业') ? '那时你心里很累——作业做到十一点' : undefined);
        const withFelt = formatRecalled(results, { now, felt })!;
        assert.match(withFelt, /11月2日（那时你心里很累——作业做到十一点）：林梦瑶说专业课作业做到很晚/);
        assert.ok(!/打算.*那时你心里/.test(withFelt), '还没到的计划不附');
        assert.equal(formatRecalled(results, { now, felt: () => undefined }), plain, '对不上时一字不差');
    });

    test('那天的流水账：有感觉就带上；没有时和原来一字不差', () => {
        assert.equal(recapText('11月2日 周一', ['下了雨']), recapText('11月2日 周一', ['下了雨'], undefined, undefined));
        const text = recapText('11月2日 周一', ['下了雨'], undefined, '那天你心里：有点烦——和舍友拌了两句嘴（是你当时的感觉，现在不一定还这样；不用说出来，说也别夸大）');
        assert.ok(text.includes('下了雨；那天你心里：有点烦——和舍友拌了两句嘴'), text);
    });
});

describe('回忆带着当时的感觉：用真实的卡算（世界里那天发生的事）', () => {
    test('有起伏的那天晚上，算出来的感觉就是那件事；来由都是世界里真发生的', () => {
        const card = loadTierCard(syntheticCardPattern, 'boyfriend', { everydayLife: true, everydayFrom: '2026-11-03', worldDrama: true });
        const world = card.character.herWorld!;
        const schedule = card.character.schedule!;
        let checked = 0;
        for (let d = 3; d < 60 && checked < 3; d++) {
            const evening = new Date(2026, 10, d, 21, 30);
            const now = worldAt(world, schedule, evening);
            const drama = now?.events.find(e => e.id.startsWith('drama_') && e.feel && e.feel.strength >= 2);
            if (!now || !drama) continue;
            const felt = feltDuring(appraisals({ now: evening.getTime(), history: [], world: now }), new Date(2026, 10, d).getTime(), evening.getTime());
            assert.ok(felt.length >= 1, `${now.day} ${drama.text}`);
            // 来由是那天世界里真发生的：今天的小事，或者「你那边」猫那一行（喂猫时见没见到它，feelings.ts 的 world:cat-*）
            const catFacts = now.cat && 'fed' in now.cat.today ? [`${now.cat.name}今天出来蹭你了`, `${now.cat.name}今天没出来`] : [];
            assert.ok(felt.every(f => now.events.some(e => e.text === f.cause) || catFacts.includes(f.cause)), `${now.day}：来由都是那天的事 ${JSON.stringify(felt)}`);
            checked++;
        }
        assert.ok(checked >= 2, `只找到 ${checked} 天`);
    });
});
