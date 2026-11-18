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
        history: () => [], log: line => lines.push(line), ...extra,
    };
    return { ctx, lines, asked };
};
const decide = (turn: Turn, ctx: DecideCtx) => { decideStage([mediaOffersModule()], 'photo', turn, ctx); return turn.facts; };

describe('判断顺序表（ADR 0336「判断那一串」）', () => {
    test('表上的位置随迁出逐个加，先后照流水线里原来的顺序：真人数值和成长层（buildPrompt 开头）→ 召回 → 那一天 → 答应的事 → 挂着的事 → 还没说过的事 → 照片 → 梦 → 最终的意图 → 心境 → 连续性 → 图片表情 → 深思 → 长短要的两样 → 「/亲热」 → 质感的上下文 → 聊天原文和记忆的收尾 → 清单', () => {
        assert.deepEqual([...DECIDE_STAGES], ['values', 'recall', 'recap', 'promises', 'loops', 'news', 'photo', 'dream', 'intent', 'feelings', 'continuity', 'stickers', 'deliberate', 'length', 'intimate', 'texture', 'context', 'lists']);
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
        none(turnOf(ask), { history: () => [], log: bare.ctx.log });
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

describe('图片表情这一轮用不用（modules/media-offers.ts 的 decideAt.stickers）', () => {
    const run = (text: string, facts: Turn['facts'] = {}, odds: NonNullable<DecideCtx['stickers']> | null = { chance: 1 }, extra: Partial<Turn> = {}) => {
        const { ctx, lines } = ctxOf([], odds ? { stickers: odds } : {});
        const turn = turnOf(text, facts, extra);
        decideStage([mediaOffersModule()], 'stickers', turn, ctx);
        return { facts: turn.facts, lines };
    };

    test('没有收藏库、只想一想：不看，也不记日志', () => {
        assert.deepEqual(run('哈哈哈哈笑死', {}, null), { facts: {}, lines: [] });
        assert.deepEqual(run('哈哈哈哈笑死', {}, { chance: 1 }, { thinking: true }), { facts: {}, lines: [] });
    });

    test('他这句有明确反应、抽到：允许、带上他这一轮说的话，记一行日志', () => {
        const out = run('哈哈哈哈笑死');
        assert.deepEqual(out.facts, { stickersAllowed: true, stickerDraw: { text: '哈哈哈哈笑死' } });
        assert.deepEqual(out.lines, ['图片表情：这一轮抽到要发一个']);
    });

    test('没抽到：只写允许（模型自己写的认识的编号清理时可以留）', () => {
        assert.deepEqual(run('哈哈哈哈笑死', {}, { chance: 0 }), { facts: { stickersAllowed: true }, lines: [] });
    });

    test('没有明确反应的轮次：给了 uncued 才抽', () => {
        assert.equal(run('今天去图书馆了', {}, { chance: 1 }).facts.stickerDraw, undefined);
        assert.deepEqual(run('今天去图书馆了', {}, { chance: 1, uncued: 1 }).facts.stickerDraw, { text: '今天去图书馆了' });
    });

    test('抽到之后再抽只发表情：写 stickerOnly，日志换一句', () => {
        const out = run('哈哈哈哈笑死', {}, { chance: 1, onlyChance: 1 });
        assert.deepEqual(out.facts, { stickersAllowed: true, stickerOnly: true, stickerDraw: { text: '哈哈哈哈笑死', only: true } });
        assert.deepEqual(out.lines, ['图片表情：这一轮抽到只发表情、不写文字']);
    });

    test('不允许：危机、被吵醒、他问了直接问题、意图要认真接——不抽，记原因', () => {
        const blocked = (out: ReturnType<typeof run>, reason: string) => {
            assert.equal(out.facts.stickersAllowed, undefined);
            assert.equal(out.facts.stickerDraw, undefined);
            assert.deepEqual(out.lines, [`图片表情：这轮不用（${reason}）`]);
        };
        blocked(run('哈哈哈哈笑死', { crisis: { level: 'high' } as NonNullable<Turn['facts']['crisis']> }), '危机辅助响应');
        blocked(run('哈哈哈哈笑死', {}, { chance: 1 }, { woken: true }), '刚被消息吵醒');
        blocked(run('你今天怎么没来？'), '他这一轮问了直接问题');
        const care = run('哈哈哈哈笑死', { intent: '[这一轮你想：先接住他此刻的情绪]' });
        assert.equal(care.facts.stickersAllowed, undefined);
        assert.equal(care.lines.length, 1);
    });

    test('这一轮发照片就不发表情（允许也不算）', () => {
        const out = run('哈哈哈哈笑死', { photo: 'cat' });
        assert.equal(out.facts.stickersAllowed, undefined);
        assert.equal(out.facts.stickerDraw, undefined);
        assert.deepEqual(out.lines, ['图片表情：这轮不用（undefined）'], '原来就是这句（允许但被照片挡住时没有原因），照搬');
    });
});

describe('质感的上下文（modules/decorate.ts 的 decideAt.texture）', async () => {
    const { textureModule } = await import('../src/modules/decorate.ts');
    const reply = (content: string) => ({ role: 'assistant' as const, content, time: NOW.toISOString() });
    const run = (text: string, facts: Turn['facts'] = {}, extra: Partial<Turn> = {}, stored: ReturnType<typeof reply>[] = []) => {
        const { ctx } = ctxOf([], { history: () => stored });
        const turn = turnOf(text, facts, extra);
        decideStage([textureModule()], 'texture', turn, ctx);
        return turn.facts.texture;
    };

    test('男朋友档、不是只想一想才有；带上他这一串说的话', () => {
        assert.deepEqual(run('今天去图书馆了'), { said: '今天去图书馆了', serious: false, recentFaces: 0, recentTildes: 0 });
        assert.equal(run('今天去图书馆了', {}, { contact: { qq: 2, name: '小周', tier: 'classmate' } }), undefined);
        assert.equal(run('今天去图书馆了', {}, { thinking: true }), undefined);
    });

    test('认真的回合：危机、小别扭生效、他难过、意图是先接住他此刻的情绪', () => {
        assert.equal(run('哈哈', { crisis: { level: 'high' } as NonNullable<Turn['facts']['crisis']> })!.serious, true);
        assert.equal(run('哈哈', { grievanceActive: true })!.serious, true);
        assert.equal(run('哈哈', { sulk: true })!.serious, true);
        assert.equal(run('哈哈', { baseIntent: '[这一轮你想：先接住他此刻的情绪]' })!.serious, true);
        assert.equal(run('今天被导师骂了，好难过')!.serious, true);
        assert.equal(run('哈哈')!.serious, false);
    });

    test('她最近几次回复带了几次小黄脸、句尾「～」：从存下来的聊天记录里数（那一刻现读）', () => {
        const out = run('哈哈', {}, {}, [reply('好呀[doge]'), reply('在的～'), reply('嗯嗯')]);
        assert.equal(out!.recentFaces, 1);
        assert.equal(out!.recentTildes, 1);
    });
});

describe('深思和语义路由的判断（modules/deliberate.ts 的 decideAt.deliberate）', async () => {
    const { deliberateModule } = await import('../src/modules/deliberate.ts');
    const { ROUTED_HINTS } = await import('../src/language/turn-weight.ts');
    type Routed = { kind: 'light' | 'heavy' | 'opinion'; why?: string } | undefined;
    const setup = (text: string, facts: Turn['facts'] = {}, given: { off?: boolean; route?: () => Promise<Routed> } = {}, extra: Partial<Turn> = {}) => {
        const asked: string[] = [];
        const { ctx, lines } = ctxOf([], given.off ? {} : { deliberate: {
            model: 'fake-pro',
            ...(given.route ? { turnWeight: (input: { said: string }) => { asked.push(input.said); return given.route!() as never; } } : {}),
        } });
        const turn = turnOf(text, facts, extra);
        return { turn, lines, asked, out: decideStage([deliberateModule()], 'deliberate', turn, ctx) };
    };
    const EXPLAIN = '你能详细讲讲为什么会这样吗，我想听你完整的想法';

    test('关键词认出来的认真问：同步定下深思，不去问分类，记一行日志', () => {
        const s = setup(EXPLAIN, {}, { route: async () => ({ kind: 'heavy' }) });
        assert.equal(s.out, undefined, '同步：流水线不用等');
        assert.equal(s.turn.facts.deliberate, true);
        assert.equal(s.turn.facts.routedHint, undefined);
        assert.deepEqual(s.asked, []);
        assert.deepEqual(s.lines, ['深思：他在认真问她，这一轮不套字数和条数、用 fake-pro、提示词只留一句“先想清楚”']);
    });

    test('没开深思、闲聊又没有语义路由：不深思，同步返回', () => {
        assert.equal(setup(EXPLAIN, {}, { off: true }).turn.facts.deliberate, undefined);
        const chat = setup('今天去图书馆了');
        assert.equal(chat.out, undefined);
        assert.equal(chat.turn.facts.deliberate, undefined);
        assert.deepEqual(chat.lines, []);
    });

    test('语义路由：关键词没认出来才问一次；分类说值得认真就深思，按类别多一小句方向；说是闲聊就不深思', async () => {
        const heavy = setup('我爸今天住院了', {}, { route: async () => ({ kind: 'heavy', why: '家人住院' }) });
        assert.ok(heavy.out instanceof Promise, '要等分类：返回 promise');
        assert.equal(heavy.turn.facts.deliberate, undefined, '分类回来之前还没定');
        await heavy.out;
        assert.deepEqual(heavy.asked, ['我爸今天住院了']);
        assert.equal(heavy.turn.facts.deliberate, true);
        assert.equal(heavy.turn.facts.routedHint, ROUTED_HINTS.heavy);
        assert.deepEqual(heavy.lines, ['深思：语义路由认为他这一轮是「在说沉重的事」（家人住院），这一轮不套字数和条数、用 fake-pro、提示词只留一句“先想清楚”、再加一小句方向']);
        const opinion = setup('你觉得我该不该换专业', {}, { route: async () => ({ kind: 'opinion' }) });
        await opinion.out;
        assert.deepEqual(opinion.asked, ['你觉得我该不该换专业']);
        assert.equal(opinion.turn.facts.deliberate, true);
        assert.equal(opinion.turn.facts.routedHint, undefined, '要她的看法：不加方向');
        const light = setup('今天去图书馆了', {}, { route: async () => ({ kind: 'light' }) });
        await light.out;
        assert.deepEqual(light.asked, ['今天去图书馆了']);
        assert.equal(light.turn.facts.deliberate, undefined);
        assert.deepEqual(light.lines, []);
    });

    test('分类出错、没结果：当没问，不深思也不抛', async () => {
        const failed = setup('我爸今天住院了', {}, { route: async () => { throw new Error('超时'); } });
        await failed.out;
        assert.equal(failed.turn.facts.deliberate, undefined);
        const none = setup('我爸今天住院了', {}, { route: async () => undefined });
        await none.out;
        assert.equal(none.turn.facts.deliberate, undefined);
    });

    test('让路的轮次：危机、只发表情、发照片、被打断、只想一想、小别扭生效、主动找他——不深思，连分类都不问', () => {
        const route = async (): Promise<Routed> => ({ kind: 'heavy' });
        const skipped = (facts: Turn['facts'], extra: Partial<Turn> = {}) => {
            const s = setup(EXPLAIN, facts, { route }, extra);
            assert.equal(s.out, undefined);
            assert.equal(s.turn.facts.deliberate, undefined);
            assert.deepEqual(s.asked, []);
        };
        skipped({ crisis: { level: 'high' } as NonNullable<Turn['facts']['crisis']> });
        skipped({ stickerOnly: true });
        skipped({ photo: 'cat' });
        skipped({ interruption: { text: '猫打翻了水杯', minutesAgo: 1 } });
        skipped({ grievanceActive: true });
        skipped({}, { thinking: true });
        skipped({}, { initiate: { note: '想他了' } as NonNullable<Turn['initiate']> });
    });
});

describe('长短和形状要的两样（modules/shape.ts 的 decideAt.length）', async () => {
    const { shapeModule } = await import('../src/modules/shape.ts');
    const run = (facts: Turn['facts'] = {}, extra: Partial<DecideCtx> = {}) => {
        const { ctx } = ctxOf([], extra);
        const turn = turnOf('在吗', facts);
        decideStage([shapeModule({ log: () => {} })], 'length', turn, ctx);
        return turn.facts;
    };
    const values = (over: Record<string, number>) => ({ energy: 60, hunger: 40, stress: 40, mood: 60, ...over }) as unknown as NonNullable<Turn['facts']['humanValues']>;

    test('平常：不低落；没有她那边、身体、心情时没有可挑的话题', () => {
        const facts = run();
        assert.equal(facts.low, undefined);
        assert.deepEqual(facts.agendaTopics, []);
    });

    test('低落：真人数值低（没劲 / 饿 / 压力大 / 心情差）；心境那一行放了而且偏低', () => {
        assert.equal(run({ humanValues: values({ energy: 30 }) }).low, true);
        assert.equal(run({ humanValues: values({ hunger: 82 }) }).low, true);
        assert.equal(run({ humanValues: values({ stress: 78 }) }).low, true);
        assert.equal(run({ humanValues: values({ mood: 30 }) }).low, true);
        assert.equal(run({ humanValues: values({}) }).low, undefined);
        const sad = [{ kind: 'sad', weight: 2.5, level: 'strong', cause: '梦', source: 'self', aboutHim: false }] as NonNullable<Turn['facts']['felt']>;
        assert.equal(run({ felt: sad, feelingLine: '[你此刻的心境：难过]' }).low, true);
        assert.equal(run({ felt: sad }).low, undefined, '那一行没放（小别扭生效之类）就不算');
    });

    test('话题：她那边那一行的标签，去掉已经说过的；卡上有心情、开了她自己的日子时加「心情」', async () => {
        const { loadTierCard } = await import('../src/platform/contact.ts');
        const { worldAt } = await import('../src/world/world.ts');
        const { syntheticCardPattern } = await import('./fixtures/card.ts');
        const card = loadTierCard(syntheticCardPattern, 'boyfriend').character;
        const world = worldAt(card.herWorld!, card.schedule!, NOW)!;
        const topics = (facts: Turn['facts'], extra: Partial<DecideCtx> = {}) => {
            const { ctx } = ctxOf([], extra);
            const turn = { ...turnOf('在吗', facts), card };
            decideStage([shapeModule({ log: () => {} })], 'length', turn, ctx);
            return turn.facts.agendaTopics ?? [];
        };
        const all = topics({ world });
        assert.ok(all.length > 0, '合成世界那一行有标签');
        assert.ok(!all.includes('心情'), '没给作息（没开她自己的日子）就没有心情');
        assert.deepEqual(topics({ world }, { schedule: card.schedule! }), [...all, '心情']);
        const homework = all.filter(label => /作业/.test(label));
        const cat = all.filter(label => /猫/.test(label));
        assert.ok(homework.length + cat.length > 0, '合成世界里有作业或猫，能验证去掉说过的');
        assert.deepEqual(topics({ world, told: ['作业', '猫'] }), all.filter(label => !/作业/.test(label) && !/猫/.test(label)));
    });
});

describe('assess 之前原位取的几样（recap / promises / loops / news）', async () => {
    const { memoryModule } = await import('../src/modules/memory.ts');
    const { timeNotesModule } = await import('../src/modules/time-notes.ts');
    const { warmModule } = await import('../src/modules/warm.ts');
    const { intentModule } = await import('../src/modules/intent.ts');
    const modules = [memoryModule(), timeNotesModule(), warmModule({ log: () => {} }), intentModule()];
    const runAll = (turn: Turn, extra: Partial<DecideCtx>) => {
        const { ctx, lines } = ctxOf([], extra);
        for (const stage of ['recap', 'promises', 'loops', 'news'] as const) decideStage(modules, stage, turn, ctx);
        return lines;
    };
    const loop = (what: string) => ({ what }) as never;
    const promises = {
        describe: () => '[你答应过他：周五一起去看电影]',
        openLoops: () => ({ waiting: [loop('面试结果')], unanswered: [], unsettled: [loop('吵架那件事')] }),
    } as unknown as NonNullable<DecideCtx['promises']>;

    test('先后和日志照流水线原来的：那一天 → 答应的事 → 挂着的事；写进 facts', () => {
        const turn = turnOf('周一你干嘛了', { askedDay: { start: new Date('2026-11-16T00:00:00+08:00') } as NonNullable<Turn['facts']['askedDay']> });
        const lines = runAll(turn, {
            recapOf: () => ({ day: '11月16日 周一', lines: ['下雨', '取快递'], text: '[那天的流水账]' }),
            selfNote: () => '[你的签名：好困]', promises,
        });
        assert.deepEqual(lines, ['想起那天：11月16日 周一（2 件）', '时间块里提醒了她答应的事', '挂着的事：等结果 1、没回答 0、没了结 1']);
        assert.equal(turn.facts.recap, '[那天的流水账]');
        assert.equal(turn.facts.selfNote, '[你的签名：好困]');
        assert.equal(turn.facts.promised, true);
        assert.equal(turn.facts.promisedLine, '[你答应过他：周五一起去看电影]');
        assert.deepEqual([turn.facts.waiting, turn.facts.unanswered, turn.facts.unsettled], [['面试结果'], [], ['吵架那件事']]);
    });

    test('问到的是一段（上周、国庆）不给那一天的流水账；名单外的人不查答应的事和挂着的事', () => {
        let asked = 0;
        const period = turnOf('上周干嘛了', { askedDay: { start: NOW, period: '上周' } as unknown as NonNullable<Turn['facts']['askedDay']> });
        runAll(period, { recapOf: () => { asked++; return undefined; } });
        assert.equal(asked, 0);
        const stranger = turnOf('在吗', {}, { contact: { qq: 9, name: '路人', tier: 'unlisted' } as Turn['contact'] });
        runAll(stranger, { promises: { describe: () => { throw new Error('不该查'); }, openLoops: () => { throw new Error('不该查'); } } as unknown as NonNullable<DecideCtx['promises']> });
        assert.equal(stranger.facts.promised, undefined);
        assert.equal(stranger.facts.waiting, undefined);
    });

    test('还没说过的事：没开她自己的日子（没给作息）或不是男朋友档时不算', () => {
        const turn = turnOf('在吗', { world: { day: '2026-11-20' } as unknown as NonNullable<Turn['facts']['world']> });
        runAll(turn, {});
        assert.equal(turn.facts.news, undefined);
    });
});

describe('梦、连续性、「/亲热」的取（dream / continuity / intimate）', async () => {
    const { feelingsModule } = await import('../src/modules/feelings.ts');
    const { continuityModule } = await import('../src/modules/continuity.ts');
    const { intentLineModule } = await import('../src/modules/intent-line.ts');
    const feelings = (herFeelings: boolean) => ({ herFeelings, everydayLife: false, worldAt: () => undefined });
    const crisis = { level: 'high' } as unknown as NonNullable<Turn['facts']['crisis']>;
    const dreams = () => ({ line: '[你昨晚梦到考试迟到]', appraisals: [{ kind: 'anxious' }] as never[] });

    test('梦：开了心境、男朋友档、不是危机回合才读；那一行和打分写进 facts', () => {
        const read = (turn: Turn, on: boolean) => { const { ctx } = ctxOf([], { dreams, feelings: feelings(on) }); decideStage([feelingsModule()], 'dream', turn, ctx); return turn.facts; };
        assert.equal(read(turnOf('早'), true).dreamLine, '[你昨晚梦到考试迟到]');
        assert.equal(read(turnOf('早'), true).dreamAppraisals?.length, 1);
        assert.equal(read(turnOf('早'), false).dreamLine, undefined);
        assert.equal(read(turnOf('早', { crisis }), true).dreamLine, undefined);
        assert.equal(read(turnOf('早', {}, { contact: { qq: 2, name: '小周', tier: 'classmate' } }), true).dreamLine, undefined);
    });

    test('连续性：危机、只想一想不取（同步返回）；按他没回的那一串取，取回来的写进 facts；出错记一行当没有；停下照旧抛', async () => {
        const asked: unknown[] = [];
        const take = (turn: Turn, continuity: NonNullable<DecideCtx['continuity']>) => {
            const { ctx, lines } = ctxOf([], { continuity: async context => { asked.push(context); return continuity(context); } });
            return { result: decideStage([continuityModule()], 'continuity', turn, ctx), lines, turn };
        };
        assert.equal(take(turnOf('在吗', { crisis }), async () => ['x']).result, undefined);
        assert.equal(take(turnOf('在吗', {}, { thinking: true }), async () => ['x']).result, undefined);
        assert.equal(asked.length, 0);
        const ok = take(turnOf('你上次说的那家店'), async () => ['[你上网查到：那家店周一休息]']);
        await ok.result;
        assert.deepEqual(ok.turn.facts.continuity, ['[你上网查到：那家店周一休息]']);
        assert.deepEqual(asked, [{ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, said: '你上次说的那家店', initiating: false, now: NOW }]);
        const failed = take(turnOf('在吗'), async () => { throw new Error('超时'); });
        await failed.result;
        assert.equal(failed.turn.facts.continuity, undefined);
        assert.deepEqual(failed.lines, ['连续性：出错，这一轮不放（超时）']);
        const stopped = take(turnOf('在吗'), async () => { throw new DOMException('停了', 'AbortError'); });
        await assert.rejects(stopped.result as Promise<void>, { name: 'AbortError' });
    });

    test('「/亲热」：主动找他、危机回合不取（不扣条数）；取到记一行、写进 facts', () => {
        let taken = 0;
        const intimacyLine = () => { taken++; return '[他刚让你黏一点]'; };
        const take = (turn: Turn) => { const { ctx, lines } = ctxOf([], { intimacyLine }); decideStage([intentLineModule()], 'intimate', turn, ctx); return { facts: turn.facts, lines }; };
        assert.equal(take(turnOf('在吗', {}, { initiate: { note: '', topic: '' } as NonNullable<Turn['initiate']> })).facts.intimateLine, undefined);
        assert.equal(take(turnOf('在吗', { crisis })).facts.intimateLine, undefined);
        assert.equal(taken, 0);
        const got = take(turnOf('在吗'));
        assert.equal(got.facts.intimateLine, '[他刚让你黏一点]');
        assert.deepEqual(got.lines, ['亲热：他刚发过 /亲热，这一轮提示词里让她黏一点']);
    });
});

describe('聊天原文和记忆的收尾（memory 的 decideAt.context）、清单的取（media-offers 的 decideAt.lists）', async () => {
    const { memoryModule } = await import('../src/modules/memory.ts');
    const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
    const chat: Turn['history'] = [
        { role: 'user', content: '一', time: at(50) }, { role: 'assistant', content: '二', time: at(40) },
        { role: 'user', content: '三', time: at(30) }, { role: 'assistant', content: '四', time: at(20) },
        { role: 'user', content: '五', time: at(10) },
    ];
    const run = (extra: Partial<Turn> = {}, context?: DecideCtx['context'], facts: Turn['facts'] = {}) => {
        const turn = turnOf('五', facts, { history: chat, ...extra });
        const { ctx } = ctxOf([], context ? { context } : {});
        decideStage([memoryModule()], 'context', turn, ctx);
        return turn.facts;
    };

    test('没开长期记忆：原文全放；只想一想时清空；召回的、那一天拼成 memory，什么都没有就不写', () => {
        assert.deepEqual(run().shown, { chat, omitted: 0 });
        assert.deepEqual(run({ thinking: true }).shown, { chat: [], omitted: 0 });
        assert.equal(run().memory, undefined);
        const facts = run({}, undefined, { recall: { recalled: '[旧事]', people: ['[小周]'] }, recap: '[那天]' });
        assert.deepEqual(facts.memory, { recalled: '[旧事]', recap: '[那天]', people: ['[小周]'] });
    });

    test('配置了最近几轮：要点整理好了就换成要点 + 最近几轮（没好就照旧，不等）', () => {
        const summarized: unknown[] = [];
        const window = (ready: boolean) => ({ turns: 1, step: 1, summarize: (older: readonly unknown[]) => { summarized.push(older.length); return ready ? { ready: true as const, text: '- 前面聊了一和二' } : { ready: false as const }; } }) as unknown as NonNullable<DecideCtx['context']>['window'];
        const done = run({}, { recentOnly: true, window: window(true) });
        assert.equal(done.memory?.summary, '- 前面聊了一和二');
        assert.ok(done.shown!.omitted > 0);
        assert.equal(done.shown!.chat.length + done.shown!.omitted, chat.length);
        const waiting = run({}, { recentOnly: true, window: window(false) });
        assert.deepEqual(waiting.shown, { chat, omitted: 0 });
        assert.equal(waiting.memory, undefined);
        assert.ok(summarized.length === 2);
    });

    test('清单：抽到表情 / 定了发照片时向货架取两次（条件一次、内容一次）；审核过的那张用判断时备好的', () => {
        const calls: string[] = [];
        const lists = { stickers: () => { calls.push('sticker'); return '[表情清单]'; }, photos: () => { calls.push('photo'); return '[照片清单]'; } };
        const take = (facts: Turn['facts']) => { const turn = turnOf('在吗', facts); const { ctx } = ctxOf([], { lists }); decideStage([mediaOffersModule()], 'lists', turn, ctx); return turn.facts; };
        const both = take({ stickerDraw: { text: '在吗' }, photo: 'cat' });
        assert.deepEqual([both.stickerLine, both.photoLine], ['[表情清单]', '[照片清单]']);
        assert.deepEqual(calls, ['sticker', 'sticker', 'photo', 'photo']);
        calls.length = 0;
        const reviewed = take({ photo: 'food', photoPrompt: '[只发这一张]' });
        assert.equal(reviewed.photoLine, '[只发这一张]');
        assert.deepEqual(calls, []);
        assert.equal(take({}).stickerLine, undefined);
    });
});
