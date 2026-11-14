import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { feelingsAt } from '../src/emotion/feelings.ts';
import { moodStateLine } from '../src/emotion/express.ts';
import { groupAffect, groupAffectOf, mergeFelt } from '../src/social/group-affect.ts';
import { groupPeople } from '../src/social/group-people.ts';
import { IMPRESSION_MAX_CHARS, impressionCandidate, impressionDue, impressionPrompt, parseImpression } from '../src/social/group-impression.ts';

// 用户 2026-11-14：群里的对话要能改她的心境；对群里的人要有性格印象，而且留得住
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-affect-')); dirs.push(dir); return dir; };
const NOW = Date.parse('2026-11-14T12:00:00+08:00');

describe('群里的遭遇进心境', () => {
    test('冲她来的夸奖算开心、冲她发火算烦；别人互夸互骂不算', () => {
        const praise = groupAffectOf({ entry: { content: '@你 你唱得真好听', messageId: 1 }, addressed: true, at: NOW });
        assert.equal(praise?.kind, 'joy');
        const rude = groupAffectOf({ entry: { content: '@你 闭嘴吧你', messageId: 2 }, addressed: true, at: NOW });
        assert.equal(rude?.kind, 'annoyed');
        assert.equal(groupAffectOf({ entry: { content: '老王唱得真好听', messageId: 3 }, addressed: false, at: NOW }), undefined);
        assert.equal(groupAffectOf({ entry: { content: '@你 今天吃啥', messageId: 4 }, addressed: true, at: NOW }), undefined, '平常的话不算事');
        const crisis = groupAffectOf({ entry: { content: '真的不想活了', messageId: 5 }, addressed: false, at: NOW });
        assert.equal(crisis?.kind, 'worry');
    });

    test('记下来的评估会衰减，也会落盘（重启还带着）', () => {
        const dir = tmp();
        const store = groupAffect(dir);
        store.note(555, groupAffectOf({ entry: { content: '@你 谢谢你', messageId: 7 }, addressed: true, at: NOW })!);
        store.note(555, groupAffectOf({ entry: { content: '@你 谢谢你', messageId: 7 }, addressed: true, at: NOW })!, );
        assert.equal(store.appraisals(555).length, 1, '同一条只记一次');
        const felt = feelingsAt(groupAffect(dir).appraisals(555), NOW);
        assert.equal(felt[0]?.kind, 'joy');
        // 一天半以后开心散得差不多了
        const later = feelingsAt(groupAffect(dir).appraisals(555), NOW + 36 * 3_600_000);
        assert.ok(!later.length || later[0]!.weight < felt[0]!.weight);
    });

    test('两组感受合并：同一种取更重的', () => {
        const a = [{ kind: 'joy' as const, weight: 1, level: 'faint' as const, cause: 'x', source: 'him' as const, aboutHim: true }];
        const b = [{ kind: 'joy' as const, weight: 2, level: 'clear' as const, cause: 'y', source: 'group' as const, aboutHim: false }];
        const merged = mergeFelt(a, b);
        assert.equal(merged.length, 1);
        assert.equal(merged[0]!.weight, 2);
        assert.ok(moodStateLine(merged)!.includes('心情不错'));
    });
});

describe('对他们的印象', () => {
    const person = (extra: Partial<Parameters<typeof impressionDue>[0]> = {}) => ({
        qq: 30001, names: ['老王'], msgs: 6, firstAt: '2026-11-01T10:00:00+08:00', lastAt: '2026-11-14T11:00:00+08:00',
        said: ['周六打球来不来', '别点外卖了', '我下周出差'], ...extra,
    });

    test('说得少的、刚写过的都不重写', () => {
        assert.equal(impressionDue(person({ msgs: 2 }), NOW), false);
        assert.equal(impressionDue(person(), NOW), true, '没印象的先写');
        assert.equal(impressionDue(person({ impression: '爱打球', impressionAt: '2026-11-10T10:00:00+08:00' }), NOW), false);
        assert.equal(impressionDue(person({ impression: '爱打球', impressionAt: '2026-10-01T10:00:00+08:00' }), NOW), true, '两周以上可以重写');
    });

    test('提示词只放他自己的原话，写不出格式就截断', () => {
        const prompt = impressionPrompt(person());
        assert.ok(prompt.includes('老王') && prompt.includes('周六打球来不来'));
        assert.ok(prompt.includes('不超过 30'), prompt);
        assert.equal(parseImpression('「爱打球，说话直」'), '爱打球，说话直');
        assert.equal(parseImpression('印象：爱聊球\n第二行'), '爱聊球');
        assert.equal(parseImpression('   '), undefined);
        const long = parseImpression('啊'.repeat(80))!;
        assert.equal([...long].length, IMPRESSION_MAX_CHARS + 1, '超长截断并带省略号');
    });

    test('一批里挑一个人写：先挑没印象的、其次话最多的', () => {
        const people = [person({ qq: 1 }), person({ qq: 2, impression: '老熟人', impressionAt: '2026-09-01T10:00:00+08:00', msgs: 20 })];
        assert.equal(impressionCandidate(people, new Set([1, 2]), NOW)?.qq, 1, '没印象的先写');
        assert.equal(impressionCandidate(people, new Set([2]), NOW)?.qq, 2);
        assert.equal(impressionCandidate(people, new Set([3]), NOW), undefined, '这批没这个人就不写');
    });

    test('印象写进底账，重启还在，提示词里看得见', () => {
        const dir = tmp();
        const book = groupPeople(dir);
        book.note(555, { qq: 30001, name: '老王', content: '周六打球来不来', at: '2026-11-14T11:00:00+08:00' });
        book.note(555, { qq: 30001, name: '老王', content: '别点外卖了', at: '2026-11-14T11:10:00+08:00' });
        book.setImpression(555, 30001, '爱打球，说话直', '2026-11-14T11:30:00+08:00');
        const line = groupPeople(dir).render(555, { now: NOW })!;
        assert.ok(line.includes('你对他的印象：爱打球，说话直'), line);
    });
});
