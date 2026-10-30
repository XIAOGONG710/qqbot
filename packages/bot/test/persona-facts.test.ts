import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { personaFacts } from '../src/platform/contact.ts';

const CARDS = resolve(import.meta.dirname, '../../../characters/linmengyao/st');
const SECTION = (head: string) => `【${head}】`;

describe('设定只留事实（personaFacts，DSH 10-30）', () => {
    test('事实段留下；心事 / 口癖与称呼 / 会变拿掉；开头那句没有标题的也不要', () => {
        const text = ['林梦瑶，在读大学生。', '【和他的关系】对门邻居。', '【心事】怕被冷落。', '【口癖与称呼】爱说“哎呀”。', '【家】济南。', '【会变】越熟越嘴硬。', '【被问是不是 AI】承认。'].join('\n');
        const facts = personaFacts(text);
        for (const head of ['和他的关系', '家', '被问是不是 AI']) assert.ok(facts.includes(SECTION(head)), head);
        for (const head of ['心事', '口癖与称呼', '会变']) assert.equal(facts.includes(SECTION(head)), false, head);
        assert.equal(facts.includes('在读大学生'), false);
        assert.equal(personaFacts(undefined), '');
        assert.equal(personaFacts(''), '');
    });

    test('底线：每一张有设定的卡，【被问是不是 AI】都在留下的部分里（承认是程序不能跟着性格一起被清掉，ADR 0067）', () => {
        const names = readdirSync(CARDS).filter(name => name.endsWith('.json'));
        let checked = 0;
        for (const name of names) {
            const raw = JSON.parse(readFileSync(join(CARDS, name), 'utf8')) as { data?: { description?: string }; description?: string };
            const description = String(raw.data?.description ?? raw.description ?? '');
            if (!description) continue; // scenes-* 这类没有设定的卡
            const facts = personaFacts(description);
            assert.ok(facts.includes(SECTION('被问是不是 AI')), `${name} 丢了「被问是不是 AI」`);
            for (const head of ['心事', '口癖与称呼', '会变']) assert.equal(facts.includes(SECTION(head)), false, `${name} 还带着 ${head}`);
            checked += 1;
        }
        assert.ok(checked >= 10, `只检查了 ${checked} 张卡，路径多半错了`);
    });
});
