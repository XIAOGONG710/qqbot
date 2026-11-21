import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { disclosureRules } from '../src/emotion/disclosure.ts';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import { assemblePrompt, type Piece, type Slot } from '../src/interpreter/slots.ts';
import { memoryModule, type MemoryPieces } from '../src/modules/memory.ts';
import type { Contact } from '../src/platform/config.ts';

// 记忆这一组（关系概况、要点、他的私人记忆、工作房、DSH 桌面、公共记忆、那一天、今天和别人聊过的、提到的人、披露分寸）迁成模块（ADR 0336）：
// 召回都留在联系人流水线原来的位置，最终的字写进 turn.facts.memory，模块只放。
// 行为基线的 memory 场景管 App 那一路（relationship 4、recalled 10、common 3、recap 1、today 3、people 5、disclosure 8 处）；
// work、summary 由 people.test.ts / context-window.test.ts（模拟器）管，desktop 由 app.test.ts 的 crossRecent 用例管；这里管模块本身。

type MemoryFacts = TurnFacts;

const RELATIONSHIP = '[你们关系的整体情况（从以前的聊天整理的，只作参考，不要原样说出来）]\n在一起一年多，感情稳定。';
const SUMMARY = '[你们前面聊过的事（更早的聊天原文没放进来，这是要点，只作参考；和下面从记忆里想起来的对不上时，以这里为准）：\n- 他 10月14日（周三）下午两点面试]';
const RECALLED = '[你们以前聊过的事（从记忆里想起来的，只作参考；和最近的聊天对不上时以最近的为准，用不上就别提）]\n- 12月7日：他说12月8日上午考高数，有点慌';
const WORK = '[你在电脑那边（DSH）干过的活——都是你干的，只是不是在 QQ 上、不是这一轮：聊到了可以说，但别替他安他没下过的指令（「你让我…」），也别把工程细节当聊天内容报一遍]\n- （电脑那边干过）：你帮他整理了发票';
const DESKTOP = '[你刚才在电脑上（DSH）和他的对话——同一个他、同一个你；接着聊就行，不用复述，也别说成「我在电脑上看到」]\n18:30 他：帮我把发票整理一下\n18:31 你：好';
const COMMON = '[你和名单里别的人聊天时说过、听过的事（从记忆里想起来的，只作参考；不是和阿明聊的，用不上就别提）]\n- 12月5日（可明说·和小周聊的）：小周说奶茶店买一送一';
const RECAP = '[那天（12月7日 周一）你那边的流水账（合成）：下了雨；取了快递]';
const TODAY = '[你今天和别人聊过的事（是你今天的一部分，不是和阿明聊的；只挑大面上的一件，有自然由头时含糊地随口提，不要一上来汇报）]\n- 12月8日（可明说·和小周聊的）：实验报告分工';
const PERSON_A = '[你认识的人：小周]\n小周：同班同学，实验课和她一组';
const PERSON_B = '[你认识的人：鸽鸽]\n鸽鸽：网上认识的朋友';

const boyfriend: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend' };
const classmate: Contact = { qq: 10002, name: '小周', tier: 'classmate' };

describe('记忆模块（ADR 0336）', () => {
    const at = new Date('2026-12-08T19:00:00+08:00');
    const turnOf = (memory?: MemoryPieces, patch: Partial<Turn> = {}, facts: TurnFacts = {}): Turn => ({
        contact: boyfriend, at, history: [{ role: 'user', content: '在干嘛', time: at.toISOString() }], thinking: false,
        facts: { ...facts, ...(memory ? { memory } : {}) } as MemoryFacts, ...patch,
    });
    const run = (t: Turn) => memoryModule().contribute!(t) as Piece[];
    const all: MemoryPieces = {
        relationship: RELATIONSHIP, summary: SUMMARY, recalled: RECALLED, work: WORK, desktop: DESKTOP,
        common: COMMON, recap: RECAP, today: TODAY, people: [PERSON_A, PERSON_B],
    };

    test('旧逻辑什么都没写（没开长期记忆、名单外）：什么都不放', () => {
        assert.deepEqual(run(turnOf()), []);
        assert.deepEqual(run(turnOf({})), []);
        assert.deepEqual(run(turnOf({ relationship: '', summary: '', recalled: '', work: '', desktop: '', common: '', recap: '', today: '', people: [] })), [], '空串、空名单当没有（迁移前按真假判断）');
    });

    test('每一段各进各的槽、原文照放；提到的人一人一段、按先后；最后接披露分寸', () => {
        assert.deepEqual(run(turnOf(all)), [
            { slot: 'relationship', text: RELATIONSHIP },
            { slot: 'summary', text: SUMMARY },
            { slot: 'recalled', text: RECALLED },
            { slot: 'work', text: WORK },
            { slot: 'desktop', text: DESKTOP },
            { slot: 'common', text: COMMON },
            { slot: 'recap', text: RECAP },
            { slot: 'today', text: TODAY },
            { slot: 'people', text: PERSON_A },
            { slot: 'people', text: PERSON_B },
            { slot: 'disclosure', text: disclosureRules(boyfriend) },
        ]);
    });

    test('披露分寸只跟着别人的事：公共记忆、今天和别人聊过的、提到的人有一样就放；只有他自己的、要点、工作房、桌面、那一天不放', () => {
        const rules = { slot: 'disclosure', text: disclosureRules(boyfriend) };
        assert.deepEqual(run(turnOf({ common: COMMON })), [{ slot: 'common', text: COMMON }, rules]);
        assert.deepEqual(run(turnOf({ today: TODAY })), [{ slot: 'today', text: TODAY }, rules]);
        assert.deepEqual(run(turnOf({ people: [PERSON_A] })), [{ slot: 'people', text: PERSON_A }, rules]);
        assert.deepEqual(run(turnOf({ relationship: RELATIONSHIP, summary: SUMMARY, recalled: RECALLED, work: WORK, desktop: DESKTOP, recap: RECAP })).map(p => p.slot),
            ['relationship', 'summary', 'recalled', 'work', 'desktop', 'recap']);
        assert.deepEqual(run(turnOf({ common: '', today: '', people: [] })), [], '空的不算');
    });

    test('披露分寸按听的人的档位写（亲密的人可以挑一件大面上的事，别的人不主动提）', () => {
        const toClassmate = run(turnOf({ common: COMMON }, { contact: classmate })).at(-1)!;
        assert.deepEqual(toClassmate, { slot: 'disclosure', text: disclosureRules(classmate) });
        assert.match(toClassmate.text, /不要主动向小周提任何别人的事/);
        assert.match(run(turnOf({ common: COMMON })).at(-1)!.text, /主动向阿明提别人时比标签再保守一级/);
    });

    test('只放、不判断：危机、只想一想、主动找他照放（迁移前这几段都不看；该不该召回由召回的地方定）', () => {
        const expected = run(turnOf(all));
        assert.deepEqual(run(turnOf(all, { thinking: true })), expected);
        assert.deepEqual(run(turnOf(all, { initiate: { note: '[想他了，找他说句话]', topic: '想他' } })), expected);
        assert.deepEqual(run(turnOf(all, {}, { crisis: { level: 'high' } as TurnFacts['crisis'] })), expected);
    });

    test('同步返回：不多等一个微任务；关系概况在 main 之后，其余按槽位表排在聊天记录之后', () => {
        const assembled = contributeTurn([memoryModule()], turnOf(all));
        assert.ok(!(assembled instanceof Promise));
        assert.deepEqual(assembled.afterMain, [RELATIONSHIP]);
        assert.deepEqual(assembled.afterHistory, [SUMMARY, RECALLED, WORK, DESKTOP, COMMON, RECAP, TODAY, PERSON_A, PERSON_B, disclosureRules(boyfriend)]);
    });

    // 迁移前 contact.ts 手写的那一串（原样抄下来）：每种有 / 没有的组合，模块拼出来和它逐字一样
    test('和迁移前联系人流水线手写的那几段拼出来逐字一样（所有组合）', () => {
        const legacy = (m: MemoryPieces, contact: Contact): Piece[] => {
            const when = (slot: Slot, text: string | undefined | false | null): Piece[] => (text ? [{ slot, text }] : []);
            const { relationship, summary, recalled, work, desktop, common, today } = m;
            const recap = m.recap ? { text: m.recap } : undefined;
            const peopleText = m.people ?? [];
            return [
                ...when('relationship', relationship),
                ...when('summary', summary),
                ...when('recalled', recalled),
                ...when('work', work),
                ...when('desktop', desktop),
                ...when('common', common),
                ...(recap ? [{ slot: 'recap' as const, text: recap.text }] : []),
                ...when('today', today),
                ...peopleText.map(text => ({ slot: 'people' as const, text })),
                ...(common || today || peopleText.length ? [{ slot: 'disclosure' as const, text: disclosureRules(contact) }] : []),
            ];
        };
        const keys = ['relationship', 'summary', 'recalled', 'work', 'desktop', 'common', 'recap', 'today', 'people'] as const;
        let checked = 0;
        for (let mask = 0; mask < 1 << keys.length; mask++) {
            const m: MemoryPieces = {};
            keys.forEach((key, i) => {
                if (!(mask & (1 << i))) return;
                if (key === 'people') m.people = mask & 1 ? [PERSON_A, PERSON_B] : [PERSON_B];
                else m[key] = all[key];
            });
            for (const contact of [boyfriend, classmate]) {
                const turn = turnOf(m, { contact });
                assert.deepEqual(contributeTurn([memoryModule()], turn), assemblePrompt(legacy(m, contact)), `组合 ${mask}`);
                checked++;
            }
        }
        assert.equal(checked, 2 << keys.length);
    });
});

describe('召回（memoryModule 的 decideAt.recall，联系人流水线原位调）', async () => {
    const { decideStage } = await import('../src/interpreter/interpreter.ts');
    const { loadTierCard } = await import('../src/platform/contact.ts');
    const { syntheticCardPattern } = await import('./fixtures/card.ts');
    const card = loadTierCard(syntheticCardPattern, 'boyfriend').character;
    const at = new Date('2026-12-08T19:00:00+08:00');
    const run = async (said: string, recall: NonNullable<Parameters<typeof decideStage>[3]['recall']> | undefined, patch: Partial<Turn> = {}) => {
        const lines: string[] = [];
        const turn: Turn = { contact: boyfriend, at, history: [{ role: 'user', content: said, time: at.toISOString() }], thinking: false, card, facts: {}, ...patch };
        await decideStage([memoryModule()], 'recall', turn, { history: () => [], log: line => lines.push(line), ...(recall ? { recall } : {}) });
        return { facts: turn.facts, lines };
    };

    test('流水线没给召回要的（不经流水线建的轮次）：什么都不写', async () => {
        const { facts, lines } = await run('在干嘛', undefined);
        assert.deepEqual(facts, {});
        assert.deepEqual(lines, []);
    });

    test('没有长期记忆：提到名单里的人照样有介绍；没有线索；群里那一句按他最后说的取、DSH 桌面那段照放、各记一行', async () => {
        const asked: unknown[] = [];
        const { facts, lines } = await run('小周今天怎么样', {
            contacts: [boyfriend, { ...classmate, intro: '同班同学，实验课和她一组' }],
            groupRecent: (question, when) => { asked.push([question, when]); return '[群里刚才]'; },
            desktopRecent: () => '18:30 他：帮我把发票整理一下\n18:31 你：好',
        });
        assert.deepEqual(asked, [['小周今天怎么样', at]]);
        assert.equal(facts.cue, undefined);
        assert.equal(facts.groupEcho, '[群里刚才]');
        assert.equal(facts.recall?.people?.length, 1);
        assert.match(facts.recall!.people![0]!, /小周/);
        assert.ok(facts.recall?.desktop);
        assert.deepEqual(lines, ['带上他刚才在 DSH 桌面上的对话 1 轮', '提起了 小周：介绍']);
    });

    test('主动找他时不问群里（没有「他这次说的」）', async () => {
        let asked = 0;
        const { facts } = await run('在干嘛', { groupRecent: () => { asked++; return 'x'; } }, { initiate: { note: '想他了', topic: '' } as NonNullable<Turn['initiate']> });
        assert.equal(asked, 0);
        assert.equal(facts.groupEcho, undefined);
    });

    test('有长期记忆：他的记忆、关系概况、工作房按原来的先后取，她的名字换成「你」，记日志', async () => {
        const calls: string[] = [];
        const memory = {
            commonEntities: async () => { calls.push('entities'); return []; },
            recall: async () => { calls.push('recall'); return `[旧事]\n- ${card.name}说过考试`; },
            canRecallContactMemory: () => false,
            relationship: () => { calls.push('relationship'); return '[关系]\n在一起一年多'; },
            recallWork: async () => { calls.push('work'); return undefined; },
            impression: () => undefined,
            othersToday: async () => { calls.push('today'); return undefined; },
            recallCommon: async () => { calls.push('common'); return undefined; },
        } as unknown as NonNullable<NonNullable<Parameters<typeof decideStage>[3]['recall']>['memory']>;
        const { facts, lines } = await run('在干嘛', { memory, contacts: [boyfriend] });
        assert.deepEqual(calls.slice(0, 4), ['entities', 'today', 'recall', 'relationship']);
        assert.ok(calls.includes('work'));
        assert.equal(facts.recall?.recalled, '[旧事]\n- 你说过考试');
        assert.equal(facts.recall?.relationship, '[关系]\n在一起一年多');
        assert.equal(lines[0], '召回长期记忆 1 条');
    });
});
