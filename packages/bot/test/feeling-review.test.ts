import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    FRESH_MS, KEEP_MS, MAX_ACTIVE, MAX_ADD, MAX_ATTEMPTS_PER_DAY, MAX_MESSAGES, MAX_RETIRE, MIN_GAP_MS, SETTLE_MS, applyReviewDecision, describeFeelingsForOwner,
    emptyReviewState, loadReviewState, parseReviewDecision, reviewAppraisals, reviewDue, reviewIfDue, reviewMaterial, reviewMessages, reviewPath, reviewProblem,
    reviewReader, saveReviewState, type Evidence, type ReviewGuard, type ReviewItem, type ReviewState,
} from '../src/emotion/feeling-review.ts';
import { describeFeelings, feelingsAt } from '../src/emotion/feelings.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-review-')); dirs.push(dir); return dir; };

/** 本地时间 2026-10-30 23:00 */
const NOW = new Date(2026, 9, 30, 23, 0, 0).getTime();
const HOUR = 3_600_000;
const MIN = 60_000;
const row = (role: 'user' | 'assistant', content: string, at: number): StoredMessage => ({ time: new Date(at).toISOString(), role, content });

/** 一段聊天：最后一条在 lastAgo 之前；共 count 条，他和她轮着说，每条隔 1 分钟 */
function chat(count: number, lastAgo = 40 * MIN, now = NOW): StoredMessage[] {
    return Array.from({ length: count }, (_, i) => row(i % 2 === 0 ? 'user' : 'assistant', i % 2 === 0 ? `他说的第${i}句话` : `她回的第${i}句`, now - lastAgo - (count - 1 - i) * MIN));
}
const ev = (id: string, ago: number, role: Evidence['role'] = 'him', text = '内容'): Evidence => ({ id, at: NOW - ago, role, text });
const guardOf = (evidence: Evidence[], over: Partial<ReviewGuard> = {}): ReviewGuard => ({ evidence: new Map(evidence.map(item => [item.id, item])), now: NOW, his: [], others: [], existing: [], ...over });
const base = [ev('m1', 50 * MIN, 'him'), ev('m2', 49 * MIN, 'her'), ev('m3', 48 * MIN, 'him'), ev('m4', 47 * MIN, 'her'), ev('d2026-10-30', 30 * MIN, 'diary')];
const cand = (over: Record<string, unknown> = {}) => ({ kind: 'sad' as const, strength: 2, cause: '晚上他隔了很久才回我消息', evidence: ['m1', 'm3'], aboutHim: false, ...over });
const stateWith = (...items: ReviewItem[]): ReviewState => ({ ...emptyReviewState(), items });
const item = (id: string, over: Partial<ReviewItem> = {}): ReviewItem => ({ id, at: NOW - HOUR, kind: 'sad', strength: 2, cause: '作业没写完心里发慌', aboutHim: false, evidence: ['m1', 'm2'], addedAt: NOW - HOUR, ...over });

describe('她回想时看到的材料', () => {
    test('最近 36 小时的聊天，编号 m1… 从旧到新；运维行、窗口外、未来的不要；只留最近 60 条再编号', () => {
        const messages = [
            row('user', '三天前', NOW - 80 * HOUR), row('user', '旧到新第一条', NOW - 35 * HOUR), row('assistant', '[B 站私信] 视频（《x》）', NOW - 3 * HOUR), row('assistant', '她回的', NOW - 34 * HOUR),
            row('user', '未来的', NOW + HOUR), row('user', '  ', NOW - 2 * HOUR),
        ];
        const material = reviewMaterial(messages, [], NOW);
        assert.deepEqual(material.map(e => [e.id, e.role, e.text]), [['m1', 'him', '旧到新第一条'], ['m2', 'her', '她回的']]);
        const many = reviewMaterial(Array.from({ length: MAX_MESSAGES + 15 }, (_, i) => row('user', `第${i}条`, NOW - (MAX_MESSAGES + 15 - i) * MIN)), [], NOW);
        assert.equal(many.length, MAX_MESSAGES);
        assert.equal(many[0]!.id, 'm1');
        assert.equal(many[0]!.text, '第15条', '留最近 60 条，重新编号');
    });

    test('日记按日期编号 d<日期>，同一天合在一起，时刻是那天 23:00（不晚于现在）；每条消息截 60 字', () => {
        const diary = reviewMaterial([], [{ date: '2026-10-29', text: '昨天第一段' }, { date: '2026-10-29', text: '昨天第二段' }, { date: '2026-10-30', text: '今天' }], new Date(2026, 9, 30, 18, 0).getTime());
        assert.deepEqual(diary.map(e => [e.id, e.role, e.text]), [['d2026-10-29', 'diary', '昨天第一段 昨天第二段'], ['d2026-10-30', 'diary', '今天']]);
        assert.equal(diary[0]!.at, new Date(2026, 9, 29, 23, 0).getTime());
        assert.equal(diary[1]!.at, new Date(2026, 9, 30, 18, 0).getTime(), '今天的日记不晚于现在');
        const longOne = reviewMaterial([row('user', '长'.repeat(200), NOW - HOUR)], [], NOW);
        assert.equal([...longOne[0]!.text].length, 60);
    });
});

describe('什么时候想（聊完半小时后）', () => {
    const evidence = (count: number, lastAgo: number) => reviewMaterial(chat(count, lastAgo), [], NOW);
    test('一段聊天刚结束（≥30 分钟、≤12 小时）、聊得够多（≥8 条）、有新聊天（≥4 条）才想', () => {
        const state = emptyReviewState();
        assert.equal(reviewDue(state, evidence(10, SETTLE_MS + MIN), NOW), true);
        assert.equal(reviewDue(state, evidence(10, SETTLE_MS - MIN), NOW), false, '还没聊完半小时');
        assert.equal(reviewDue(state, evidence(10, FRESH_MS + MIN), NOW), false, '早就过去了');
        assert.equal(reviewDue(state, evidence(7, 40 * MIN), NOW), false, '聊得太少');
        assert.equal(reviewDue({ ...state, lastWindow: { messages: 10, until: NOW - 40 * MIN } }, evidence(10, 40 * MIN), NOW), false, '没有新聊天');
        assert.equal(reviewDue({ ...state, lastWindow: { messages: 10, until: NOW - 40 * MIN - 6 * MIN } }, evidence(10, 40 * MIN), NOW), true, '后面又聊了 6 条');
        assert.equal(reviewDue({ ...state, lastWindow: { messages: 10, until: NOW - 40 * MIN - 3 * MIN } }, evidence(10, 40 * MIN), NOW), false, '新的只有 3 条');
    });

    test('两次尝试至少隔 1 小时（成功失败都算）；一天最多 8 次', () => {
        const e = evidence(10, 40 * MIN);
        assert.equal(reviewDue({ ...emptyReviewState(), lastAttemptAt: NOW - MIN_GAP_MS + MIN }, e, NOW), false);
        assert.equal(reviewDue({ ...emptyReviewState(), lastAttemptAt: NOW - MIN_GAP_MS - MIN }, e, NOW), true);
        assert.equal(reviewDue({ ...emptyReviewState(), attempts: { day: '2026-10-30', n: MAX_ATTEMPTS_PER_DAY } }, e, NOW), false);
        assert.equal(reviewDue({ ...emptyReviewState(), attempts: { day: '2026-10-29', n: MAX_ATTEMPTS_PER_DAY } }, e, NOW), true, '昨天的不算');
    });
});

describe('一条感受能不能收（在代码里，她改不到）', () => {
    test('正常的收下', () => {
        assert.equal(reviewProblem(cand(), emptyReviewState(), guardOf(base), 0), undefined);
    });

    test('来由 6–40 字；轻重只有 1 和 2（大事只有作者能写）', () => {
        assert.match(reviewProblem(cand({ cause: '难过' }), emptyReviewState(), guardOf(base), 0)!, /太短/);
        assert.match(reviewProblem(cand({ cause: '长'.repeat(41) }), emptyReviewState(), guardOf(base), 0)!, /太长/);
        assert.match(reviewProblem(cand({ strength: 3 }), emptyReviewState(), guardOf(base), 0)!, /大事只有作者能写/);
        assert.match(reviewProblem(cand({ strength: 0 }), emptyReviewState(), guardOf(base), 0)!, /大事只有作者能写/);
    });

    test('依据：要有、编号要是给她看的、明显要 ≥2 条、不能太旧', () => {
        const state = emptyReviewState();
        assert.match(reviewProblem(cand({ evidence: [] }), state, guardOf(base), 0)!, /没有依据/);
        assert.match(reviewProblem(cand({ evidence: ['m1', 'm99'] }), state, guardOf(base), 0)!, /依据「m99」不在给你看的材料里/);
        assert.match(reviewProblem(cand({ evidence: ['m1'] }), state, guardOf(base), 0)!, /至少 2 条依据/);
        assert.match(reviewProblem(cand({ evidence: ['m1', 'm1'] }), state, guardOf(base), 0)!, /至少 2 条依据/, '同一条写两遍还是一条');
        assert.equal(reviewProblem(cand({ strength: 1, evidence: ['m1'] }), state, guardOf(base), 0), undefined, '小事一条就够');
        const old = [ev('m1', 40 * HOUR), ev('m2', 39 * HOUR)];
        assert.match(reviewProblem(cand({ evidence: ['m1', 'm2'] }), state, guardOf(old), 0)!, /太旧了/);
        const future = [ev('m1', -HOUR), ev('m2', -2 * HOUR)];
        assert.match(reviewProblem(cand({ evidence: ['m1', 'm2'] }), state, guardOf(future), 0)!, /太旧了/, '时间在未来也不收');
    });

    test('因为他的态度：依据里必须有他说的话；因他难过 / 烦的一晚最多 1 条（开心 / 担心 / 松了口气 / 累不受限）', () => {
        const state = emptyReviewState();
        assert.match(reviewProblem(cand({ aboutHim: true, evidence: ['m2', 'm4'] }), state, guardOf(base), 0)!, /依据里却没有他说的话/);
        assert.equal(reviewProblem(cand({ aboutHim: true }), state, guardOf(base), 0), undefined);
        assert.match(reviewProblem(cand({ aboutHim: true }), state, guardOf(base), 1)!, /一晚最多记 1 条/);
        assert.match(reviewProblem(cand({ kind: 'annoyed', aboutHim: true }), state, guardOf(base), 1)!, /一晚最多记 1 条/);
        assert.equal(reviewProblem(cand({ kind: 'joy', aboutHim: true, cause: '他夸我今天很可爱，挺开心的' }), state, guardOf(base), 1), undefined);
        assert.equal(reviewProblem(cand({ kind: 'worry', aboutHim: true, cause: '他说他明天要考试心里没底' }), state, guardOf(base), 1), undefined);
    });

    test('底线：危机 / 承认自己是程序 / 骗人真钱；书面的医书词；不引他的话；不写别人；不和已有的重复；满了不收', () => {
        const state = emptyReviewState();
        for (const [cause, reason] of [
            ['难过得觉得自己想死不想活了', /危机/], ['其实我只是个程序没有真的感受', /是不是程序/], ['想骗他转一笔钱来买相机', /骗人或真钱/],
            ['洗完澡肚子坠着难受只想躺着', /书面的词「坠着」/],
        ] as const) assert.match(reviewProblem(cand({ cause }), state, guardOf(base), 0)!, reason, cause);
        assert.match(reviewProblem(cand({ cause: '他说今天没什么可聊的了所以我有点失落' }), state, guardOf(base, { his: ['今天没什么可聊的了，我先睡了'] }), 0)!, /引了他说过的话/);
        assert.match(reviewProblem(cand({ cause: '被他说成「小笨蛋」其实有点开心', kind: 'joy' }), state, guardOf(base, { his: ['你就是个小笨蛋'] }), 0)!, /引了他说过的话/, '引号里 3 个字以上也算');
        assert.match(reviewProblem(cand({ cause: '鸽鸽来找我借了笔记所以有点烦', kind: 'annoyed' }), state, guardOf(base, { others: ['鸽鸽'] }), 0)!, /写到了别人（鸽鸽）/);
        assert.match(reviewProblem(cand({ cause: '晚上他隔了很久才回我的消息' }), stateWith(item('r-1', { cause: '晚上他隔了很久才回我消息' })), guardOf(base), 0)!, /太像/);
        assert.match(reviewProblem(cand({ cause: '晚上他隔了很久才回我消息' }), emptyReviewState(), guardOf(base, { existing: [{ kind: 'sad', cause: '晚上他隔了很久才回我消息' }] }), 0)!, /心里已经有了/);
        assert.equal(reviewProblem(cand({ kind: 'joy', cause: '晚上他隔了很久才回我消息但是说了很甜的话' }), stateWith(item('r-1', { cause: '晚上他隔了很久才回我消息' })), guardOf(base), 0), undefined, '不同种类的感受不算重复');
        const full = stateWith(...Array.from({ length: MAX_ACTIVE }, (_, i) => item(`r-${i}`, { cause: `第${i}件完全不同的事${'甲乙丙丁戊己庚辛'[i]}${'子丑寅卯辰巳午未'[i]}` })));
        assert.match(reviewProblem(cand(), full, guardOf(base), 0)!, /已经记着 8 条/);
    });
});

describe('晚间的想法：解析、落地', () => {
    test('parseReviewDecision：带围栏、中文或英文的种类、依据去重去空白；坏的 undefined；{} 是没感受', () => {
        const text = '想了想\n```json\n{"add":[{"kind":"难过","strength":2,"cause":"他隔了很久才回","evidence":[" m1 ","m1","m3"],"aboutHim":true},{"kind":"joy","strength":"1","cause":"拿到相机了","evidence":["m2"]},{"kind":"愤怒","strength":1,"cause":"不认识的种类","evidence":["m1"]},{"cause":""},"光一句话"],"retire":[{"id":"r-1","why":"过去了"},{"why":"没 id"}]}\n```';
        const decision = parseReviewDecision(text)!;
        assert.deepEqual(decision.add.map(a => [a.kind, a.strength, a.evidence, a.aboutHim]), [['sad', 2, ['m1', 'm3'], true], ['joy', 1, ['m2'], false], [undefined, 1, ['m1'], false]]);
        assert.deepEqual(decision.retire, [{ id: 'r-1', why: '过去了' }]);
        assert.deepEqual(parseReviewDecision('{}'), { add: [], retire: [] });
        assert.equal(parseReviewDecision('没有 JSON'), undefined);
        assert.equal(parseReviewDecision('{坏'), undefined);
    });

    test('先放下、再记；放下要有理由；没有的 id 略过；感受的时刻是依据里最近那条的时刻；记下依据；id 当天不重复', () => {
        const state = stateWith(item('r-old', { cause: '作业没写完心里发慌', evidence: ['m1', 'm2'] }), item('r-2', { cause: '朋友生病了有点担心', kind: 'worry' }));
        const decision = parseReviewDecision(JSON.stringify({
            retire: [{ id: 'r-old', why: '后来写完了' }, { id: 'r-2', why: '' }, { id: 'r-没有', why: '随便' }],
            add: [cand({ cause: '晚上他隔了很久才回我消息', evidence: ['m3', 'm1'] }), cand({ kind: 'joy', cause: '他说我今天的样子很可爱', evidence: ['m4', 'm2'], aboutHim: false })],
        }))!;
        const applied = applyReviewDecision(state, decision, guardOf(base));
        assert.deepEqual(state.items.map(i => i.id), ['r-2', `r-2026-10-30-1`, `r-2026-10-30-2`]);
        assert.equal(state.items[1]!.at, NOW - 48 * MIN, '依据里最近那条（m3）的时刻');
        assert.deepEqual(state.items[1]!.evidence, ['m3', 'm1']);
        assert.equal(state.items[2]!.at, NOW - 47 * MIN);
        assert.deepEqual([applied.added, applied.retired], [2, 1]);
        assert.equal(state.retired[0]!.why, '后来写完了');
        assert.ok(applied.lines.some(line => line.includes('没说为什么放下')));
        assert.ok(applied.lines.some(line => line.includes('没有「r-没有」')));
    });

    test('一晚最多记 3 条、放下 3 条；因他难过 / 烦的最多 1 条（后面的进「没成」）；不认识的种类、没成的记原因（最多留 10 条）', () => {
        const state = stateWith(...Array.from({ length: 5 }, (_, i) => item(`r-${i}`, { cause: `旧的第${i}件事互不相同${'甲乙丙丁戊'[i]}${'子丑寅卯辰'[i]}` })));
        const decision = parseReviewDecision(JSON.stringify({
            retire: [0, 1, 2, 3].map(i => ({ id: `r-${i}`, why: '过去了' })),
            add: [
                cand({ cause: '被他晾了一晚上有点难过', aboutHim: true }),
                cand({ kind: 'annoyed', cause: '他一直催我回答真的很烦', aboutHim: true }),
                cand({ kind: 'joy', cause: '他夸我写的东西很好看', aboutHim: false }),
                cand({ kind: 'relief', cause: '作业总算交上去了松口气', aboutHim: false }),
                cand({ kind: 'worry', cause: '明天的小测还没复习完', aboutHim: false }),
                { kind: '愤怒', strength: 1, cause: '不认识的感受种类', evidence: ['m1'], aboutHim: false },
            ],
        }))!;
        const applied = applyReviewDecision(state, decision, guardOf(base));
        assert.deepEqual([applied.added, applied.retired], [MAX_ADD, MAX_RETIRE]);
        assert.ok(applied.lines.some(line => line.includes('今晚放下的够多了')));
        assert.ok(applied.lines.some(line => line.includes('今晚记的够多了')));
        const reasons = state.rejected.map(r => r.reason).join('|');
        assert.match(reasons, /因为他难过 \/ 烦的，一晚最多记 1 条/);
        assert.equal(state.items.filter(i => i.aboutHim).length, 1);
        const many = emptyReviewState();
        for (let i = 0; i < 12; i++) applyReviewDecision(many, { add: [{ kind: 'sad', strength: 2, cause: `第${i}条没有依据的想法`, evidence: [], aboutHim: false, rawKind: 'sad' }], retire: [] }, guardOf(base));
        assert.equal(many.rejected.length, 10);
    });

    test('散光了的不留（超过 3 天）', () => {
        const state = stateWith(item('r-old', { at: NOW - KEEP_MS - HOUR }), item('r-new', { at: NOW - HOUR, cause: '另一件完全不同的事让我担心' }));
        applyReviewDecision(state, { add: [], retire: [] }, guardOf(base));
        assert.deepEqual(state.items.map(i => i.id), ['r-new']);
    });
});

describe('想的时候（reviewIfDue）', () => {
    const deps = (dataDir: string, generate: (messages: unknown) => Promise<string>, history: StoredMessage[], over: { now?: number; logs?: string[]; existing?: Array<{ kind: 'sad'; cause: string }> } = {}) => ({
        dataDir, soulDir: dataDir, now: () => over.now ?? NOW, generate: generate as never, history: () => history,
        persona: () => '大学生', names: { char: '林梦瑶', user: '宝宝' }, others: () => ['鸽鸽'], existing: () => over.existing ?? [],
        log: (line: string) => over.logs?.push(line),
    });
    const reply = JSON.stringify({ add: [{ kind: '难过', strength: 2, cause: '他说的话让我心里有点堵', evidence: ['m1', 'm3'], aboutHim: true }] });

    test('成功：落笔记、依据、感受的时刻；记下最后一条消息的时刻；日志不记内容；同一段不再想，新聊了 ≥4 条且过了 1 小时才再想', async () => {
        const dir = tmp();
        const logs: string[] = [];
        const history = chat(10, 40 * MIN);
        let calls = 0;
        const generate = async () => { calls++; return reply; };
        const result = await reviewIfDue(deps(dir, generate, history, { logs }));
        assert.equal(result.ran, true);
        assert.equal(result.error, undefined);
        const state = loadReviewState(dir);
        assert.equal(state.items.length, 1);
        assert.equal(state.items[0]!.cause, '他说的话让我心里有点堵');
        assert.deepEqual(state.items[0]!.evidence, ['m1', 'm3']);
        assert.equal(state.lastWindow?.until, Date.parse(history.at(-1)!.time));
        assert.equal(state.lastReflectionAt, NOW);
        assert.match(logs.join('\n'), /心境回想：聊完回想了一次（10 条消息）——记下 1 条、放下 0 条/);
        assert.ok(!logs.join('\n').includes('心里有点堵'), '日志不记内容');
        assert.deepEqual(await reviewIfDue(deps(dir, generate, history, { now: NOW + 2 * HOUR })), { ran: false }, '没有新聊天');
        const more = [...history, ...chat(6, 40 * MIN, NOW + 3 * HOUR)];
        assert.equal((await reviewIfDue(deps(dir, generate, more, { now: NOW + 3 * HOUR }))).ran, true);
        assert.equal(calls, 2);
    });

    test('还没聊完 / 聊得太少 / 刚想过：不叫模型，也不算一次尝试', async () => {
        const dir = tmp();
        let calls = 0;
        const generate = async () => { calls++; return '{}'; };
        for (const history of [chat(10, 10 * MIN), chat(5, 40 * MIN), []]) assert.deepEqual(await reviewIfDue(deps(dir, generate, history)), { ran: false });
        assert.equal(calls, 0);
        assert.equal(loadReviewState(dir).attempts.n, 0);
    });

    test('失败：不动笔记、不记成功、记一次尝试；1 小时内不重试，之后再试', async () => {
        const dir = tmp();
        const logs: string[] = [];
        const history = chat(10, 40 * MIN);
        const failing = await reviewIfDue(deps(dir, async () => { throw new Error('网络断了'); }, history, { logs }));
        assert.deepEqual(failing, { ran: true, error: '网络断了' });
        const state = loadReviewState(dir);
        assert.deepEqual([state.lastReflectionAt, state.attempts.n, state.items.length], [0, 1, 0]);
        assert.match(logs.join('\n'), /这次没想成（网络断了），1 小时后再试/);
        assert.deepEqual(await reviewIfDue(deps(dir, async () => reply, history, { now: NOW + 30 * MIN })), { ran: false });
        assert.equal((await reviewIfDue(deps(dir, async () => reply, history, { now: NOW + MIN_GAP_MS + MIN }))).ran, true);
        const bad = await reviewIfDue(deps(tmp(), async () => '没有 JSON', history));
        assert.equal(bad.error, '回复里没有可用的 JSON');
    });

    test('整条路径上的防线：编造的依据、他的话、别人的名字、已有的感受，都进「没成」；一条没收也算想成了', async () => {
        const dir = tmp();
        const history = chat(10, 40 * MIN);
        const result = await reviewIfDue(deps(dir, async () => JSON.stringify({ add: [
            { kind: '难过', strength: 2, cause: '编出来的依据让我难过', evidence: ['m1', 'm77'], aboutHim: false },
            { kind: '烦', strength: 1, cause: '鸽鸽又来借东西让我有点烦', evidence: ['m2'], aboutHim: false },
            { kind: '难过', strength: 1, cause: '他今晚没有回我消息有点失落', evidence: ['m1'], aboutHim: false },
        ] }), history, { existing: [{ kind: 'sad', cause: '他今晚没有回我消息有点失落' }] }));
        assert.equal(result.applied?.added, 0);
        const state = loadReviewState(dir);
        assert.equal(state.rejected.length, 3);
        const reasons = state.rejected.map(r => r.reason).join('|');
        assert.match(reasons, /m77/);
        assert.match(reasons, /鸽鸽/);
        assert.match(reasons, /心里已经有了/);
        assert.equal(state.lastReflectionAt, NOW);
    });

    test('提示词：编号的聊天、日记、心里已有的、之前记的带 id；写明依据、小事 / 明显、不夸大、他看得到', () => {
        const messages = reviewMessages({
            char: '林梦瑶', user: '宝宝', persona: '大学生', now: NOW, existing: ['开心（他夸我了）'], items: [item('r-1')],
            evidence: [ev('m1', 50 * MIN, 'him', '你在干嘛'), ev('m2', 49 * MIN, 'her', '在看书'), ev('d2026-10-30', 0, 'diary', '今天看了一天书')],
        });
        const system = messages[0]!.content;
        const user = messages[1]!.content;
        assert.match(system, /你是林梦瑶/);
        assert.match(system, /你和他聊完有一阵了/);
        assert.match(user, /m1 \[10-30 22:10\] 宝宝：你在干嘛\nm2 \[10-30 22:11\] 你：在看书/);
        assert.match(user, /d2026-10-30：今天看了一天书/);
        assert.match(user, /- 开心（他夸我了）/);
        assert.match(user, /- r-1｜难过·明显｜作业没写完心里发慌（依据 m1、m2）/);
        assert.match(user, /宝宝用 \/心境 都能看到/);
        assert.match(user, /每一条都要在 evidence 里指出是哪几条消息或日记/);
        assert.match(user, /strength 1 是小事（单独一件不会表现出来），2 是明显的（要 2 条以上依据），没有更重的——大事不由你记/);
        assert.match(user, /别因为他没回你就编出难过/);
        assert.match(user, /不引用宝宝的原话，不写别人的名字，不夸大/);
        assert.match(user, /开心 \/ 松了口气 \/ 担心 \/ 难过 \/ 烦 \/ 累/);
    });
});

describe('变成心境、给他看', () => {
    test('reviewAppraisals：来源是「她自己回想的」（self），id 稳定；小事单独不明显，明显的进心境那一行', () => {
        const small = reviewAppraisals([item('r-1', { strength: 1, kind: 'worry', at: NOW - MIN })]);
        assert.equal(small[0]!.source, 'self');
        assert.equal(small[0]!.id, 'review:r-1');
        assert.equal(feelingsAt(small, NOW).filter(f => f.level !== 'faint').length, 0, '小事单独一件不会表现出来');
        const clear = reviewAppraisals([item('r-2', { kind: 'sad', strength: 2, at: NOW - MIN, cause: '被他晾了一晚上有点难过', aboutHim: true })]);
        const felt = feelingsAt(clear, NOW);
        assert.equal(felt[0]!.level, 'clear');
        assert.equal(felt[0]!.source, 'self');
        assert.match(describeFeelings(felt, '宝宝', { melt: false, voiced: new Set(), mayCry: true })!, /有点难过（被他晾了一晚上有点难过）/);
        // 散得快：难过半衰期 8 小时，过 20 小时就没了
        assert.deepEqual(feelingsAt(clear, NOW + 40 * HOUR), []);
    });

    test('reviewReader：按修改时间缓存；文件变了重读；没有文件是空的', () => {
        const dir = tmp();
        const read = reviewReader(dir);
        assert.deepEqual(read(), []);
        saveReviewState(dir, stateWith(item('r-1')));
        assert.equal(read().length, 1);
        assert.equal(read(), read(), '没变就是同一个数组');
        saveReviewState(dir, stateWith(item('r-1'), item('r-2', { cause: '另一件完全不同的事让我担心', kind: 'worry' })));
        const later = new Date(Date.now() + 5000);
        utimesSync(reviewPath(dir), later, later);
        assert.equal(read().length, 2);
    });

    test('loadReviewState：坏文件、缺字段、不认识的种类 / 轻重当没有', () => {
        const dir = tmp();
        mkdirSync(dir, { recursive: true });
        writeFileSync(reviewPath(dir), '{坏');
        assert.deepEqual(loadReviewState(dir), emptyReviewState());
        writeFileSync(reviewPath(dir), JSON.stringify({ items: [
            { id: 'a', at: 1, kind: 'sad', strength: 2, cause: '好的一条来由', aboutHim: true, evidence: ['m1', 5], addedAt: 2 },
            { id: 'b', at: 1, kind: 'rage', strength: 2, cause: '种类不对' }, { id: 'c', at: 1, kind: 'sad', strength: 3, cause: '轻重不对' }, { id: 7, cause: 'id 不对' },
        ], attempts: { day: 5 }, lastWindow: { messages: 3, until: 'x' } }));
        const state = loadReviewState(dir);
        assert.deepEqual(state.items.map(i => [i.id, i.evidence]), [['a', ['m1']]]);
        assert.deepEqual(state.attempts, { day: '', n: 0 });
        assert.equal(state.lastWindow, undefined);
    });

    test('/心境 的回复：以「（」开头；此刻的心境和来由、她自己回想记下的（带依据）、放下的、没成的；开关关着不列回想；他只能看', () => {
        const state: ReviewState = {
            ...stateWith(item('r-1', { cause: '被他晾了一晚上有点难过', aboutHim: true, evidence: ['m1', 'm3'], at: NOW - 2 * HOUR })),
            retired: [{ at: NOW, text: '旧的烦', why: '后来聊开了' }], rejected: [{ at: NOW, text: '想记没成的', reason: '依据「m99」不在给你看的材料里' }],
        };
        const current = { at: NOW - 20 * MIN, felt: [{ kind: 'sad' as const, level: 'clear', cause: '被他晾了一晚上有点难过', source: 'self' }, { kind: 'joy' as const, level: 'faint', cause: '小事', source: 'world' }] };
        const text = describeFeelingsForOwner(current, state, NOW, true);
        assert.ok(text.startsWith('（') && text.endsWith('）'));
        assert.match(text, /她此刻的心境（20 分钟前算的）：\n- 难过·明显：被他晾了一晚上有点难过（她自己回想的）/);
        assert.doesNotMatch(text, /小事（/, '隐约的不列');
        assert.match(text, /她聊完自己回想、指出了依据的（1 条）：\n- 难过·明显：被他晾了一晚上有点难过（2 小时前的事；依据 m1、m3）/);
        assert.match(text, /她放下的：\n- 旧的烦（后来聊开了）/);
        assert.match(text, /她想记、但没成的：\n- 想记没成的（依据「m99」不在给你看的材料里）/);
        assert.match(text, /你只能看，不能改/);
        const off = describeFeelingsForOwner(current, state, NOW, false);
        assert.doesNotMatch(off, /自己回想、指出了依据/);
        assert.match(describeFeelingsForOwner(undefined, emptyReviewState(), NOW, true), /最近还没有给她算过心境/);
        assert.match(describeFeelingsForOwner({ at: NOW, felt: [] }, emptyReviewState(), NOW, true), /她此刻没有明显的感受（刚刚算的）/);
        assert.match(describeFeelingsForOwner({ at: NOW, felt: [] }, emptyReviewState(), NOW, true), /她还没有聊完回想出来的感受/);
    });
});
