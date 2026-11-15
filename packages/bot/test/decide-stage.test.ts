import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DECIDE_STAGES, createInterpreter, decideStage, type DecideCtx, type Module, type Turn } from '../src/interpreter/interpreter.ts';
import { mediaOffersModule } from '../src/modules/media-offers.ts';
import { PHOTO_HISTORY_PREFIX } from '../src/vision/photos.ts';

// 判断那一串（ADR 0336「判断那一串」）：行为基线 media 等场景逐字不变；这里核对顺序表和迁出来的判断本身
const NOW = new Date('2026-11-20T20:00:00+08:00');
const said = (text: string): Turn['history'] => [{ role: 'assistant', content: '在呢', time: new Date(NOW.getTime() - 3_600_000).toISOString() }, { role: 'user', content: text, time: NOW.toISOString() }];
const turnOf = (text: string, facts: Turn['facts'] = {}, extra: Partial<Turn> = {}): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: NOW, history: said(text), thinking: false, facts, ...extra,
});
const world = (dish?: string) => ({ routine: { meals: dish ? [{ kind: 'dinner', dish, start: new Date(NOW.getTime() - 3_600_000) }] : [] } }) as unknown as NonNullable<Turn['facts']['world']>;
const ctxOf = (have: readonly string[], extra: Partial<DecideCtx> = {}) => {
    const lines: string[] = [];
    const asked: unknown[][] = [];
    const ctx: DecideCtx = {
        photos: { has: (kind, dish) => { asked.push([kind, dish]); return have.includes(dish ? `${kind}:${dish}` : kind); }, list: () => [] },
        log: line => lines.push(line), ...extra,
    };
    return { ctx, lines, asked };
};
const decide = (turn: Turn, ctx: DecideCtx) => { decideStage([mediaOffersModule()], 'photo', turn, ctx); return turn.facts; };

describe('判断顺序表（ADR 0336「判断那一串」）', () => {
    test('表上的位置随迁出逐个加，先后照流水线里原来的顺序：照片 → 最终的意图', () => {
        assert.deepEqual(DECIDE_STAGES.slice(0, 2), ['photo', 'intent']);
    });

    test('一个位置上按注册顺序跑，拿到同一轮和流水线给的东西；只挂 decideAt 的模块不被解释器筛掉', () => {
        const seen: string[] = [];
        const { ctx } = ctxOf([]);
        const a: Module = { id: 'a', decideAt: { photo: (turn, got) => { seen.push(`a${got === ctx ? '+' : '-'}`); turn.facts.photo = 'cat'; } } };
        const b: Module = { id: 'b', decideAt: { photo: turn => { seen.push(`b:${turn.facts.photo}`); } } };
        decideStage([a, b], 'photo', turnOf('在吗'), ctx);
        assert.deepEqual(seen, ['a+', 'b:cat']);
        const interpreter = createInterpreter({ modules: [a], exec: { every: () => 0 as never, cancel: () => {} } });
        assert.deepEqual(interpreter.turnModules.map(module => module.id), ['a']);
    });
});

describe('这一轮发不发照片（modules/media-offers.ts 的 decideAt.photo）', () => {
    test('他要看猫、货架里有、允许发：写 photo，记一行日志', () => {
        const { ctx, lines } = ctxOf(['cat']);
        assert.deepEqual(decide(turnOf('给我看看猫的照片'), ctx), { photo: 'cat' });
        assert.deepEqual(lines, ['照片货架：他想看cat，货架里有，这一轮发一张']);
    });

    test('货架里没有这一类、他没要看：什么都不写', () => {
        assert.deepEqual(decide(turnOf('给我看看猫的照片'), ctxOf(['view']).ctx), {});
        assert.deepEqual(decide(turnOf('今天好累'), ctxOf(['cat']).ctx), {});
    });

    test('只说「发张照片」：取货架上有的第一类', () => {
        assert.equal(decide(turnOf('发张照片看看'), ctxOf(['work', 'view']).ctx).photo, 'view');
    });

    test('吃的：只拿她最近那一顿那道菜的，写 photoDish；主动那条自己带着哪一类和菜名', () => {
        const eaten = ctxOf(['food:合成炒饭']);
        assert.deepEqual(decide(turnOf('看看你吃的什么，拍张照片', { world: world('合成炒饭') }), eaten.ctx), { world: world('合成炒饭'), photo: 'food', photoDish: '合成炒饭' });
        assert.deepEqual(eaten.asked.at(-1), ['food', '合成炒饭']);
        const other = decide(turnOf('看看你吃的什么，拍张照片', { world: world('合成面') }), ctxOf(['food:合成炒饭']).ctx);
        assert.equal(other.photo, undefined, '货架里只有别的菜：不发');
        const initiating = turnOf('在吗', {}, { initiate: { note: '喂完猫拍的', photo: 'food', photoDish: '合成炒饭' } as NonNullable<Turn['initiate']> });
        assert.equal(decide(initiating, ctxOf(['food:合成炒饭']).ctx).photoDish, '合成炒饭');
    });

    test('不是男朋友档、只想一想、危机、小别扭、他难过、没有货架：不看', () => {
        const have = () => ctxOf(['cat']);
        const ask = '给我看看猫的照片';
        const none = (turn: Turn, ctx = have().ctx) => assert.equal(decide(turn, ctx).photo, undefined);
        none(turnOf(ask, {}, { contact: { qq: 2, name: '小周', tier: 'classmate' } }));
        none(turnOf(ask, {}, { thinking: true }));
        none(turnOf(ask, { crisis: { level: 'high' } as NonNullable<Turn['facts']['crisis']> }));
        none(turnOf(ask, { grievance: { stage: 'sulk' } as NonNullable<Turn['facts']['grievance']> }));
        none(turnOf(ask, { baseIntent: '[这一轮你想：先接住他此刻的情绪]' }));
        const bare = have();
        none(turnOf(ask), { log: bare.ctx.log });
        assert.deepEqual(bare.asked, [], '这些轮次连货架都不问');
    });

    test('刚发过一张、刚被吵醒：这一轮不发，记原因', () => {
        const recent = turnOf('再看看猫的照片');
        (recent as { history: Turn['history'] }).history = [{ role: 'assistant', content: `${PHOTO_HISTORY_PREFIX}猫在窗台上`, time: new Date(NOW.getTime() - 60_000).toISOString() }, ...recent.history.slice(1)];
        const again = ctxOf(['cat']);
        assert.equal(decide(recent, again.ctx).photo, undefined);
        assert.deepEqual(again.lines, ['照片货架：这一轮不发（刚发过一张）']);
        const woken = ctxOf(['cat']);
        assert.equal(decide(turnOf('给我看看猫的照片', {}, { woken: true }), woken.ctx).photo, undefined);
        assert.deepEqual(woken.lines, ['照片货架：这一轮不发（刚被消息吵醒）']);
    });

    test('他要「现在」的照片：只有审核通过、和此刻匹配的那一张能发（只给这一张的清单）；没有就写 photoUnavailable，不拿旧图冒充', () => {
        const entry = { id: 'abcdef012345', caption: '窗外的晚霞' };
        const approved = ctxOf(['view'], {
            photos: { has: () => true, list: () => [entry, { id: '000000000000', caption: '旧的' }] as never },
            currentAiPhoto: () => ({ state: 'approved', eventKey: 'k', shelfId: entry.id }),
        });
        const facts = decide(turnOf('拍张现在窗外的风景照片给我看', { world: world() }), approved.ctx);
        assert.equal(facts.photo, 'view');
        assert.equal(facts.photoPrompt, `[和他这次“现在的照片”请求精确对应、已经人工审核过的照片（只能发这一张，编号不解释）：先用一句话带一下，然后另起一行只写 <photo:${entry.id}>]\n- <photo:${entry.id}>：窗外的晚霞`);
        assert.equal(facts.photoUnavailable, undefined);
        const pending = ctxOf(['view'], { currentAiPhoto: () => ({ state: 'pending' }) });
        const waiting = decide(turnOf('拍张现在窗外的风景照片给我看', { world: world() }), pending.ctx);
        assert.equal(waiting.photo, undefined, '货架里有旧的风景也不发');
        assert.equal(waiting.photoUnavailable, true);
        assert.deepEqual(pending.lines, ['AI 照片草稿：当前请求没有已审核匹配照片（pending），不拿旧图冒充']);
    });

    test('没有「现在的照片」的解析（没开 AI 生活照）：照旧从货架发', () => {
        assert.equal(decide(turnOf('拍张现在窗外的风景照片给我看', { world: world() }), ctxOf(['view']).ctx).photo, 'view');
    });
});

describe('最终的意图和小别扭是否生效（modules/intent.ts 的 decideAt.intent）', async () => {
    const { intentModule } = await import('../src/modules/intent.ts');
    const { describeGrievance } = await import('../src/emotion/grievance.ts');
    const { photoIntent } = await import('../src/vision/photos.ts');
    const BASE = '[这一轮你想：先直接回答他刚问的]';
    const run = (facts: Turn['facts'], extra: Partial<Turn> = {}) => {
        const { ctx, lines } = ctxOf([]);
        const turn = turnOf('在吗', facts, extra);
        decideStage([intentModule()], 'intent', turn, ctx);
        return { facts: turn.facts, lines };
    };

    test('平常：用意图阶梯给的那一句，记一行日志；没有意图就不写', () => {
        const plain = run({ baseIntent: BASE });
        assert.equal(plain.facts.intent, BASE);
        assert.deepEqual(plain.lines, ['这一轮有意图：先直接回答他刚问的']);
        const none = run({});
        assert.equal(none.facts.intent, undefined);
        assert.deepEqual(none.lines, []);
    });

    test('这一轮发照片：换成发照片那一句；审核过的「现在的照片」是只发这一张那一句；主动那条不换', () => {
        assert.equal(run({ baseIntent: BASE, photo: 'cat' }).facts.intent, photoIntent('cat'));
        assert.match(run({ baseIntent: BASE, photo: 'view', photoPrompt: '清单' }).facts.intent!, /已经审核过的：自然带一句后发这一张/);
        assert.equal(run({ baseIntent: BASE, photo: 'cat' }, { initiate: { note: '喂完猫拍的' } as NonNullable<Turn['initiate']> }).facts.intent, BASE);
    });

    test('「现在的照片」发不了：换成如实说发不了那一句；被打断：不带意图', () => {
        assert.match(run({ baseIntent: BASE, photoUnavailable: true }).facts.intent!, /如实说这会儿发不了/);
        const interrupted = run({ baseIntent: BASE, interruption: { text: '猫打翻了水杯', minutesAgo: 1 } });
        assert.equal(interrupted.facts.intent, undefined);
        assert.deepEqual(interrupted.lines, []);
    });

    test('小别扭生效 = 最终的意图就是小别扭那一句：写 grievanceActive 和 sulk；和好只写 grievanceActive；被别的意图盖掉就不算', () => {
        const sulk = { stage: 'sulk', days: 3, round: 0 } as NonNullable<Turn['facts']['grievance']>;
        const active = run({ grievance: sulk, baseIntent: describeGrievance(sulk) });
        assert.equal(active.facts.grievanceActive, true);
        assert.equal(active.facts.sulk, true);
        assert.equal(active.lines[0], '小别扭：他隔了 3 天才来（他回来后第 1 轮；日志不记内容）');
        assert.equal(active.lines.length, 2, '后面还有「这一轮有意图」那一行');
        const makeup = { stage: 'makeup', days: 3, round: 1 } as NonNullable<Turn['facts']['grievance']>;
        const made = run({ grievance: makeup, baseIntent: describeGrievance(makeup) });
        assert.equal(made.facts.grievanceActive, true);
        assert.equal(made.facts.sulk, undefined);
        assert.match(made.lines[0]!, /^和好：/);
        const ignored = { stage: 'sulk', days: 0, round: 0, cause: 'ignored' } as NonNullable<Turn['facts']['grievance']>;
        assert.equal(run({ grievance: ignored, baseIntent: describeGrievance(ignored) }).lines[0], '小别扭：她倾诉了几条他隔了很久才回（他回来后第一轮；日志不记内容）');
        const covered = run({ grievance: sulk, baseIntent: BASE });
        assert.equal(covered.facts.grievanceActive, undefined);
        assert.equal(covered.facts.sulk, undefined);
        const interrupted = run({ grievance: sulk, baseIntent: describeGrievance(sulk), interruption: { text: '猫打翻了水杯', minutesAgo: 1 } });
        assert.equal(interrupted.facts.grievanceActive, undefined, '被打断的这一轮不带意图，小别扭也不算生效');
    });
});
