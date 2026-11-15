import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import type { MemeDict } from '../src/language/meme-dict.ts';
import { memeDictModule, type MemeDictHit } from '../src/modules/meme-dict.ts';
import { memesModule } from '../src/modules/memes.ts';

// 梗百科（DSH 2026-10-29）迁成模块（ADR 0336）：让路同网络热梗；已经在热梗那一行（facts.meme，热梗模块 contribute 时写）里的词不再给，
// 所以要注册在热梗模块之后。行为基线没有词库（0 处），联系人流水线那一路由 meme-dict-turn.test.ts 管（接线时把词库从选项换成这个模块）。

const DICT_LINE = '他这句里提到一个网络词';
const library = [{ term: '尊嘟假嘟', meaning: '“真的假的”的卖萌说法', example: '', confidence: 'high' as const, firstSeen: '2026-11-01', lastSeen: '2026-11-04', seen: 3 }];

function dictOf(entries: MemeDictHit[]) {
    const asked: string[] = [];
    return {
        asked,
        dict: { mention: (text: string) => { asked.push(text); return entries.find(entry => text.includes(entry.term)); } },
    };
}

describe('梗百科模块（DSH 2026-10-29 / ADR 0336）', () => {
    const at = new Date('2026-11-05T12:00:00+08:00');
    const hit: MemeDictHit = { term: '绝绝子', meaning: '夸东西特别好', origin: '饭圈', tags: '夸张' };
    const turnOf = (said: string, facts: TurnFacts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 7, name: '阿明', tier: 'boyfriend' }, at,
        history: [{ role: 'user', content: '前面那句绝绝子', time: at.toISOString() }, { role: 'assistant', content: '嗯', time: at.toISOString() }, { role: 'user', content: said, time: at.toISOString() }],
        thinking: false, facts, ...patch,
    });

    test('他最后一条里提到词库里的词：放一行（怎么用 / 出处 / 标签），记一条不带内容的日志', () => {
        const { dict, asked } = dictOf([hit]);
        const logs: string[] = [];
        const pieces = memeDictModule(dict, line => logs.push(line)).contribute!(turnOf('今天这个饭绝绝子')) as Piece[];
        assert.deepEqual(pieces, [{ slot: 'memeDict', text: '[他这句里提到一个网络词「绝绝子」：怎么用——夸东西特别好；出处——饭圈；标签——夸张。你大概知道这个梗：顺着他的意思接，别科普、别解释梗、别拆穿]' }]);
        assert.deepEqual(asked, ['今天这个饭绝绝子'], '只查他最后一条');
        assert.deepEqual(logs, ['[7] 梗百科：这一轮查到了他提的词（日志不记内容）']);
    });

    test('出处、标签是空的就不写那一截', () => {
        const { dict } = dictOf([{ term: '绝绝子', meaning: '夸东西特别好', origin: '', tags: '' }]);
        const [piece] = memeDictModule(dict, () => {}).contribute!(turnOf('绝绝子')) as Piece[];
        assert.equal(piece!.text, '[他这句里提到一个网络词「绝绝子」：怎么用——夸东西特别好。你大概知道这个梗：顺着他的意思接，别科普、别解释梗、别拆穿]');
    });

    test('没提到、或者已经在热梗那一行里：不放、不记日志', () => {
        const logs: string[] = [];
        const { dict } = dictOf([hit]);
        assert.deepEqual(memeDictModule(dict, line => logs.push(line)).contribute!(turnOf('在吗')), []);
        assert.deepEqual(memeDictModule(dict, line => logs.push(line)).contribute!(turnOf('绝绝子', { meme: '[他这一句里用了个网上的梗「绝绝子」……]' })), []);
        assert.deepEqual(logs, []);
    });

    test('让路同网络热梗：同学档、主动找他、只想一想、危机、小别扭、他难过时不查词库', () => {
        const { dict, asked } = dictOf([hit]);
        const run = (t: Turn) => memeDictModule(dict, () => {}).contribute!(t) as Piece[];
        const cases: [string, Turn][] = [
            ['同学档', turnOf('绝绝子', {}, { contact: { qq: 8, name: '小周', tier: 'classmate' } })],
            ['主动找他', turnOf('绝绝子', {}, { initiate: { note: '', topic: '' } })],
            ['只想一想', turnOf('绝绝子', {}, { thinking: true })],
            ['危机', turnOf('绝绝子', { crisis: { match: '', level: 'concern' } })],
            ['小别扭', turnOf('绝绝子', { grievance: { stage: 'sulk', days: 3, round: 0 } })],
            ['他难过', turnOf('绝绝子', { baseIntent: '[这一轮你想：他现在心里不好受，先接住他此刻的情绪]' })],
        ];
        for (const [name, t] of cases) assert.deepEqual(run(t), [], name);
        assert.deepEqual(asked, [], '让路时词库一次都不查（迁移前条件在前、查在后）');
        assert.equal(run(turnOf('绝绝子', {}, { history: [] })).length, 0, '没有他的话');
    });

    test('要排在热梗模块之后：热梗那一行里的词不重复给；排在前面就会重复（注册顺序是约束）', () => {
        const { dict } = dictOf([{ term: '尊嘟假嘟', meaning: '真的假的', origin: '', tags: '' }]);
        const memes = () => memesModule(() => library, () => {});
        const after = contributeTurn([memes(), memeDictModule(dict, () => {})], turnOf('尊嘟假嘟'));
        assert.ok(!(after instanceof Promise), '同步返回');
        assert.ok(after.afterHistory.join('\n').includes('尊嘟假嘟'));
        assert.ok(!after.afterHistory.join('\n').includes(DICT_LINE));
        const before = contributeTurn([memeDictModule(dict, () => {}), memes()], turnOf('尊嘟假嘟'));
        assert.ok(!(before instanceof Promise));
        assert.ok(before.afterHistory.join('\n').includes(DICT_LINE));
    });

    test('日志在热梗之后（App 里挂在整张表最后，同迁移前的「旧逻辑」模块）', () => {
        const logs: string[] = [];
        const { dict } = dictOf([hit]);
        contributeTurn([memesModule(() => library, line => logs.push(line)), memeDictModule(dict, line => logs.push(line))], turnOf('尊嘟假嘟绝绝子'));
        assert.deepEqual(logs.map(line => line.replace(/：.*/, '')), ['[7] 网络热梗', '[7] 梗百科']);
    });

    test('App 读好的词库（openMemeDict 的 MemeDict）可以直接给（类型检查管），模块只有 contribute', () => {
        const fromApp = (dict: MemeDict) => memeDictModule(dict, () => {});
        const module = fromApp({ count: () => 0, lookup: () => undefined, mention: () => undefined });
        assert.equal(module.id, 'meme-dict');
        assert.deepEqual(Object.keys(module).sort(), ['contribute', 'id']);
    });
});
