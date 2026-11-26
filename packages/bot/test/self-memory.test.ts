import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn } from '../src/interpreter/interpreter.ts';
import { SELF_MEMORY_NOTE, selfMemoryModule, type SelfMemoryOptions } from '../src/modules/self-memory.ts';

// 直接测 self-memory.ts：三行的常量、男朋友档的判断、当轮纠正优先、可选参数。
const at = new Date('2026-11-29T13:00:00+08:00');
const said = (content: string) => ({ role: 'user' as const, content, time: at.toISOString() });
const boyfriend = (history: Turn['history'], extra: Partial<Turn> = {}): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' },
    at,
    history,
    thinking: false,
    facts: {},
    ...extra,
});
type Piece = { slot: string; text: string };
const pieces = (module: ReturnType<typeof selfMemoryModule>, turn: Turn): Piece[] => module.contribute!(turn) as Piece[];

describe('SELF_MEMORY_NOTE', () => {
    test('包含全部四种标记和「标记不会发出去」的约定', () => {
        assert.ok(SELF_MEMORY_NOTE.startsWith('记忆由你自己决定：'));
        assert.ok(SELF_MEMORY_NOTE.includes('<<记住：一句话>>'));
        assert.ok(SELF_MEMORY_NOTE.includes('<<日记：一段>>'));
        assert.ok(SELF_MEMORY_NOTE.includes('<<私密：…>>'));
        assert.ok(SELF_MEMORY_NOTE.includes('<<查：关键词>>'));
        assert.ok(SELF_MEMORY_NOTE.includes('不想答应的事可以拒绝'));
        assert.ok(SELF_MEMORY_NOTE.includes('这个我不想聊'));
        assert.ok(SELF_MEMORY_NOTE.includes('别硬编'));
        assert.ok(SELF_MEMORY_NOTE.includes('这些标记不会发出去'));
        assert.ok(SELF_MEMORY_NOTE.length > 300);
    });
});

describe('selfMemoryModule（DSH 10-30 / 10-31，ADR 0336）', () => {
    test('模块 id 正确；男朋友档、非主动时三行齐全且顺序固定，理解偏过按他最后一句（去空白）查', () => {
        const asked: string[] = [];
        let traceCalls = 0;
        const module = selfMemoryModule({
            understanding: words => { asked.push(words); return words.includes('老板') ? '[理解偏过]' : undefined; },
            traces: () => { traceCalls++; return '[他最近的事]'; },
        });
        assert.equal(module.id, 'self-memory');
        assert.deepEqual(module.contribute!(boyfriend([said('早的'), said('  那家公司老板  ')])), [
            { slot: 'understanding', text: '[理解偏过]' },
            { slot: 'traces', text: '[他最近的事]' },
            { slot: 'selfMemory', text: SELF_MEMORY_NOTE },
        ]);
        assert.deepEqual(asked, ['那家公司老板']);
        assert.equal(traceCalls, 1);
    });

    test('空输入 / 缺字段：他没说过话或只有空白时不查理解偏过，但留痕行和记忆行仍在', () => {
        const asked: string[] = [];
        const module = selfMemoryModule({ understanding: words => { asked.push(words); return '[理解偏过]'; }, traces: () => '[他最近的事]' });
        assert.deepEqual(module.contribute!(boyfriend([])), [
            { slot: 'traces', text: '[他最近的事]' },
            { slot: 'selfMemory', text: SELF_MEMORY_NOTE },
        ]);
        assert.deepEqual(module.contribute!(boyfriend([said('   ')])), [
            { slot: 'traces', text: '[他最近的事]' },
            { slot: 'selfMemory', text: SELF_MEMORY_NOTE },
        ]);
        assert.deepEqual(asked, []);
    });

    test('只给男朋友档、主动找他时不放后两行，且不去读回调', () => {
        let reads = 0;
        const module = selfMemoryModule({ understanding: () => { reads++; return '[理解偏过]'; }, traces: () => { reads++; return '[他最近的事]'; } });
        const onlyNote = [{ slot: 'selfMemory', text: SELF_MEMORY_NOTE }];
        assert.deepEqual(pieces(module, boyfriend([said('老板')], { contact: { qq: 2, name: '小周', tier: 'classmate' } })), onlyNote);
        assert.deepEqual(pieces(module, boyfriend([said('老板')], { initiate: { note: '', topic: '' } })), onlyNote);
        assert.equal(reads, 0);
        // 危机、只想一想照样放
        assert.deepEqual(pieces(module, boyfriend([said('老板')], { thinking: true, facts: { crisis: { level: 'acute' } as never } })).map(p => p.slot), ['understanding', 'traces', 'selfMemory']);
    });

    test('可选输出不写时就不放该行：understanding / traces 返回 undefined 只剩记忆行', () => {
        const module = selfMemoryModule({ understanding: () => undefined, traces: () => undefined });
        assert.deepEqual(pieces(module, boyfriend([said('老板')])), [{ slot: 'selfMemory', text: SELF_MEMORY_NOTE }]);
    });

    test('可选参数 immediateCorrection 不传 / 不命中时回落到历史提醒，命中时优先且把联系人传进去', () => {
        const seenContacts: number[] = [];
        const withOption: SelfMemoryOptions = {
            understanding: () => '[历史提醒]',
            traces: () => undefined,
            immediateCorrection: (contact, words) => {
                seenContacts.push(contact.qq);
                return contact.qq === 1 && words.startsWith('不是这个意思') ? '[当轮修复]' : undefined;
            },
        };
        const module = selfMemoryModule(withOption);
        assert.equal(pieces(module, boyfriend([said('不是这个意思，老板')]))[0]!.text, '[当轮修复]');
        assert.deepEqual(seenContacts, [1]);
        assert.equal(pieces(module, boyfriend([said('那家公司老板')]))[0]!.text, '[历史提醒]');
        // 别的联系人不修；他还没说话时连回调都不调
        assert.equal(pieces(module, boyfriend([said('不是这个意思，老板')], { contact: { qq: 2, name: '小周', tier: 'boyfriend' } }))[0]!.text, '[历史提醒]');
        seenContacts.length = 0;
        assert.deepEqual(pieces(module, boyfriend([])), [{ slot: 'selfMemory', text: SELF_MEMORY_NOTE }]);
        assert.deepEqual(seenContacts, []);

        const withoutOption = selfMemoryModule({ understanding: () => '[历史提醒]', traces: () => undefined });
        assert.equal(pieces(withoutOption, boyfriend([said('不是这个意思，老板')]))[0]!.text, '[历史提醒]');
    });

    test('超长输入原样转给回调，超长输出原样进提示词，不截断', () => {
        const long = '老板'.repeat(2000);
        let forwarded = '';
        const module = selfMemoryModule({ understanding: words => { forwarded = words; return '[长]'; }, traces: () => undefined });
        assert.deepEqual(pieces(module, boyfriend([said(long)])), [
            { slot: 'understanding', text: '[长]' },
            { slot: 'selfMemory', text: SELF_MEMORY_NOTE },
        ]);
        assert.equal(forwarded, long);

        const longText = '记'.repeat(5000);
        const big = selfMemoryModule({ understanding: () => longText, traces: () => longText });
        const result = pieces(big, boyfriend([said('老板')]));
        assert.equal(result.length, 3);
        assert.equal(result[0]!.text, longText);
        assert.equal(result[1]!.text, longText);
    });
});
