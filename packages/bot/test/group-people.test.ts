import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { GROUP_PEOPLE_MAX, groupPeople, whenText } from '../src/social/group-people.ts';

// 用户 2026-11-14：群里聊过的人再见不能不认识，要有基础认知（聊过多少、上次什么时候、说过什么）
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-people-')); dirs.push(dir); return dir; };
const at = (iso: string) => iso;

describe('群里认识的人', () => {
    test('第一次见就是第一次见，聊过之后记得句数、上次什么时候、说过什么', () => {
        const book = groupPeople(tmp());
        book.note(555, { qq: 30001, name: '老王', content: '周六打球来不来', at: at('2026-11-14T10:00:00+08:00') });
        assert.match(book.render(555, { now: Date.parse('2026-11-14T10:05:00+08:00') })!, /老王：今天第一次见/);
        book.note(555, { qq: 30001, name: '老王', content: '别点外卖了', at: at('2026-11-14T12:00:00+08:00') });
        const line = book.render(555, { now: Date.parse('2026-11-14T12:30:00+08:00') })!;
        assert.match(line, /老王：聊过 2 句，最后一次是30 分钟前/);
        assert.ok(line.includes('「周六打球来不来」') && line.includes('「别点外卖了」'), line);
        assert.ok(!line.includes('第一次见'), '聊过两句就不是第一次见了');
    });

    test('改了群名片还认得：旧名字留着当别名', () => {
        const book = groupPeople(tmp());
        book.note(555, { qq: 30001, name: '老王', content: 'a', at: at('2026-11-13T10:00:00+08:00') });
        book.note(555, { qq: 30001, name: '王哥', content: 'b', at: at('2026-11-14T10:00:00+08:00') });
        const line = book.render(555, { now: Date.parse('2026-11-14T10:05:00+08:00') })!;
        assert.ok(line.includes('王哥（也叫「老王」）'), line);
    });

    test('重启还记得（落盘）；能按 qq 排除人；没记过就什么都不写', () => {
        const dir = tmp();
        groupPeople(dir).note(555, { qq: 30001, name: '老王', content: '在吗', at: at('2026-11-14T10:00:00+08:00') });
        const again = groupPeople(dir);
        assert.ok(again.render(555)!.includes('老王'));
        assert.equal(again.render(555, { exclude: 30001 }), undefined);
        assert.equal(again.render(556), undefined, '另一个群的人不能串过来');
    });

    test('记满上限时先丢最久没说话的', () => {
        const book = groupPeople(tmp());
        for (let i = 0; i < GROUP_PEOPLE_MAX; i++) {
            book.note(555, { qq: 1000 + i, name: `群友${i}`, content: 'x', at: at(`2026-11-${String(1 + (i % 9)).padStart(2, '0')}T10:00:00+08:00`) });
        }
        book.note(555, { qq: 9999, name: '新来的', content: '大家好', at: at('2026-11-14T10:00:00+08:00') });
        const list = book.load(555);
        assert.equal(list.length, GROUP_PEOPLE_MAX);
        assert.ok(list.some(person => person.qq === 9999));
        assert.ok(!list.some(person => person.qq === 1000), '11-01 最久没说话的那个应该被挤掉');
    });

    test('「多久以前」说人话', () => {
        const now = Date.parse('2026-11-14T12:00:00+08:00');
        assert.equal(whenText('2026-11-14T11:59:30+08:00', now), '刚才');
        assert.equal(whenText('2026-11-14T11:20:00+08:00', now), '40 分钟前');
        assert.equal(whenText('2026-11-14T09:00:00+08:00', now), '3 小时前');
        assert.equal(whenText('2026-11-11T12:00:00+08:00', now), '3 天前');
    });

    test('落盘的文件能被读回（坏文件不挡说话）', () => {
        const dir = tmp();
        const book = groupPeople(dir);
        book.note(555, { qq: 30001, name: '老王', content: '在吗', at: at('2026-11-14T10:00:00+08:00') });
        const saved = JSON.parse(readFileSync(join(dir, 'groups', '555.people.json'), 'utf8')) as unknown[];
        assert.equal(saved.length, 1);
        // 坏文件：从空的开始，不抛错
        const broken = tmp();
        mkdirSync(join(broken, 'groups'), { recursive: true });
        writeFileSync(join(broken, 'groups', '555.people.json'), '{oops');
        assert.equal(groupPeople(broken).render(555), undefined);
    });
});
