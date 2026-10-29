import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { mergePursuits, pursuitsPath, pursuitsReader, pursuitViews, describePursuits, type Pursuit } from '../src/life/pursuits.ts';
import {
    applyDecision, describeForOwner, emptySelfState, KEEP_NOTES, loadSelfState, MAX_ATTEMPTS_PER_DAY, MAX_SELF_ACTIVE, parseDecision, PROPOSAL_COOLDOWN_MS,
    proposalProblem, reflectIfDue, reflectionDue, reflectionMessages, saveSelfState, selfAwareReader, STATUS_COOLDOWN_MS, withSelf, type Decision,
} from '../src/life/self-pursuits.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-selfp-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const DAY = 86_400_000;
/** 本地 21:00（过了每晚想的钟点） */
const NIGHT = new Date(2026, 9, 29, 21, 0).getTime();
const base = mergePursuits([]);
const none = (): Decision => ({ drop: [], pause: [], resume: [], done: [], propose: [], notes: [] });
const propose = (title: string, why = '最近一直想试试，觉得会很有意思', firstStep?: string) => ({ ...none(), propose: [{ title, why, ...(firstStep ? { firstStep } : {}) }] });

describe('底线（写在代码里，她改不到）：这些不会成为她的追求', () => {
    const problem = (title: string, why = '就是想试试看，觉得挺有意思的') => proposalProblem({ title, why }, emptySelfState(), base, NIGHT);

    test('花真钱 / 违法或伤人 / 动他的东西 / 骗人 / 人生大方向：都不收，并且说得出为什么', () => {
        assert.match(problem('炒股赚点生活费')!, /真钱/);
        assert.match(problem('学着入侵别人的账号')!, /违法/);
        assert.match(problem('偷偷翻他的手机看聊天记录', '想知道他在跟谁聊')!, /动他的东西|违法/);
        assert.match(problem('假装成别人去试探同学')!, /骗人/);
        assert.match(problem('准备考研', '想换个方向')!, /人生方向/);
        assert.match(problem('出国读书', '看看外面的世界')!, /人生方向/);
        assert.match(problem('毕业以后去青岛', '离家近一点')!, /人生方向/);
    });

    test('平常的小事收：学着做一道菜、把摄影集整理出来、每周去操场跑两次', () => {
        for (const title of ['学着做一道拿手菜', '把今年拍的照片整理成一本小册子', '每周去操场跑两次步']) assert.equal(problem(title), undefined, title);
    });

    test('一定要说为什么想要；题目 2–30 字；理由 80 字内', () => {
        assert.match(proposalProblem({ title: '学吉他', why: '' }, emptySelfState(), base, NIGHT)!, /为什么/);
        assert.match(proposalProblem({ title: '学', why: '想学一点新东西' }, emptySelfState(), base, NIGHT)!, /题目/);
        assert.match(proposalProblem({ title: '学吉他', why: '长'.repeat(81) }, emptySelfState(), base, NIGHT)!, /太长/);
    });

    test(`自己加的同时最多 ${MAX_SELF_ACTIVE} 件；提了一件之后隔 3 天；和已有的太像不收`, () => {
        const state = emptySelfState();
        for (const title of ['学吉他', '练字', '每天背单词']) {
            applyDecision(state, base, propose(title), NIGHT + state.pursuits.length * 4 * DAY);
        }
        assert.equal(state.pursuits.length, 3);
        assert.match(proposalProblem({ title: '养一盆绿萝', why: '宿舍里想有点绿色' }, state, withSelf(base, state), NIGHT + 20 * DAY)!, /已经有 3 件/);
        const fresh = emptySelfState();
        applyDecision(fresh, base, propose('学吉他'), NIGHT);
        assert.match(proposalProblem({ title: '练字', why: '想把字写好看一点' }, fresh, withSelf(base, fresh), NIGHT + PROPOSAL_COOLDOWN_MS - 1000)!, /隔 3 天/);
        assert.equal(proposalProblem({ title: '练字', why: '想把字写好看一点' }, fresh, withSelf(base, fresh), NIGHT + PROPOSAL_COOLDOWN_MS + 1000), undefined);
        assert.match(proposalProblem({ title: '用相机拍出满意的作品', why: '想拍得好看' }, emptySelfState(), base, NIGHT)!, /太像/);
    });
});

describe('她的想法落地：放下 / 暂停 / 恢复 / 记进度 / 提新的', () => {
    test('她可以放下作者给的内置追求——只改她的决定，不动作者的文件；放下后不再是 active', () => {
        const state = emptySelfState();
        const applied = applyDecision(state, base, { ...none(), drop: [{ id: 'camera', why: '热度过了，现在更想把心思放在别的上' }] }, NIGHT);
        assert.deepEqual(state.overrides.camera, { status: 'dropped', at: NIGHT, why: '热度过了，现在更想把心思放在别的上' });
        assert.match(applied.lines[0]!, /放下「用新相机拍出自己满意的东西」/);
        const list = withSelf(base, state);
        assert.equal(list.find(item => item.id === 'camera')!.status, 'dropped');
        assert.equal(list.find(item => item.id === 'courses')!.status, 'active');
    });

    test('放下 / 暂停必须说为什么；不存在的 id 略过', () => {
        const state = emptySelfState();
        const applied = applyDecision(state, base, { ...none(), drop: [{ id: 'courses', why: '' }, { id: '没有这条', why: '随便' }] }, NIGHT);
        assert.deepEqual(state.overrides, {});
        assert.equal(applied.lines.length, 2);
    });

    test('同一条 3 天内只能改一次状态（不来回翻）；过了 3 天可以改主意', () => {
        const state = emptySelfState();
        applyDecision(state, base, { ...none(), pause: [{ id: 'camera', why: '期末周，先放一放' }] }, NIGHT);
        const flip = applyDecision(state, base, { ...none(), resume: [{ id: 'camera', why: '又想拍了' }] }, NIGHT + DAY);
        assert.equal(state.overrides.camera!.status, 'paused');
        assert.match(flip.lines[0]!, /才改过状态不久/);
        applyDecision(state, base, { ...none(), resume: [{ id: 'camera', why: '期末完了，想拍了' }] }, NIGHT + STATUS_COOLDOWN_MS + 1000);
        assert.equal(state.overrides.camera!.status, 'active');
    });

    test('一晚上最多改 2 条状态', () => {
        const state = emptySelfState();
        applyDecision(state, base, propose('学吉他'), NIGHT - 10 * DAY);
        const applied = applyDecision(state, base, {
            ...none(), drop: [{ id: 'courses', why: '理由一' }, { id: 'camera', why: '理由二' }, { id: state.pursuits[0]!.id, why: '理由三' }],
        }, NIGHT);
        assert.equal(Object.keys(state.overrides).length + state.pursuits.filter(item => item.status === 'dropped').length, 2);
        assert.ok(applied.lines.some(line => line.includes('够多了')));
    });

    test('自己加的那条：放下会记原因；进度最多留 20 句', () => {
        const state = emptySelfState();
        applyDecision(state, base, propose('学吉他', '一直想会弹一首完整的歌', '先学会三个和弦'), NIGHT - 10 * DAY);
        const id = state.pursuits[0]!.id;
        for (let i = 0; i < 25; i++) applyDecision(state, base, { ...none(), notes: [{ id, text: `第${i}天练了一会儿` }, { id: 'camera', text: '内置的也能记' }] }, NIGHT + i);
        assert.equal(state.pursuits[0]!.notes!.length, KEEP_NOTES);
        assert.equal(state.pursuits[0]!.notes!.at(-1)!.text, '第24天练了一会儿');
        assert.equal(state.overrides.camera, undefined, '记进度不等于改状态');
        assert.equal(state.notes.camera!.length, KEEP_NOTES, '内置的那条的进度另放，也最多留 20 句');
        applyDecision(state, base, { ...none(), drop: [{ id, why: '手指太疼了，坚持不下去' }] }, NIGHT + 5 * DAY);
        assert.equal(state.pursuits[0]!.status, 'dropped');
        assert.equal(state.pursuits[0]!.endedWhy, '手指太疼了，坚持不下去');
    });

    test('作者给的 / 内置的那几条她也能记进度；写题目不写 id 也认；进了提示词、也读得回来', () => {
        const state = emptySelfState();
        const applied = applyDecision(state, base, { ...none(), notes: [{ id: 'camera', text: '光线好，按了一下午快门，一张都没修' }, { id: '别挂科', text: '晚上刷了两套题，还是怕期末' }, { id: '根本没有这条', text: '会被略过' }] }, NIGHT);
        assert.deepEqual(state.notes.camera!.map(item => item.text), ['光线好，按了一下午快门，一张都没修']);
        assert.deepEqual(state.notes.courses!.map(item => item.text), ['晚上刷了两套题，还是怕期末'], '写题目「别挂科」也找得到');
        assert.equal(applied.lines.length, 2, '不存在的略过');
        const list = withSelf(base, state);
        assert.equal(list.find(item => item.id === 'courses')!.notes!.at(-1)!.text, '晚上刷了两套题，还是怕期末');
        const facts = { now: new Date(NIGHT), schedule: {} as never, quizzes: false };
        assert.match(describePursuits(pursuitViews(list, facts))!, /别挂科——.*；你自己最近记的：晚上刷了两套题，还是怕期末/);
        const dir = tmp();
        saveSelfState(dir, state);
        assert.deepEqual(loadSelfState(dir).notes.camera, state.notes.camera, '落盘后读得回来');
        assert.match(describeForOwner(list, state, NIGHT), /别挂科——.*（作者给的）\n {3}她最近记的：晚上刷了两套题，还是怕期末/);
    });

    test('按题目放下（她写的是题目不是 id）', () => {
        const state = emptySelfState();
        applyDecision(state, base, { ...none(), drop: [{ id: '用新相机拍出自己满意的东西', why: '没那么想拍了' }] }, NIGHT);
        assert.equal(state.overrides.camera!.status, 'dropped');
    });

    test('提了不成的：记在「想过但没成」里，她下次想得起来、他也看得到', () => {
        const state = emptySelfState();
        const applied = applyDecision(state, base, propose('准备考研', '想换个方向'), NIGHT);
        assert.equal(state.pursuits.length, 0);
        assert.equal(state.lastProposalAt, 0, '没成的不占冷却');
        assert.equal(state.rejected.length, 1);
        assert.match(state.rejected[0]!.reason, /人生方向/);
        assert.match(applied.lines[0]!, /想过「准备考研」，没成/);
    });

    test('一晚上最多提 1 件新的', () => {
        const state = emptySelfState();
        applyDecision(state, base, { ...none(), propose: [{ title: '学吉他', why: '一直想会弹一首歌' }, { title: '练字', why: '想把字写好看一点' }] }, NIGHT);
        assert.equal(state.pursuits.length, 1);
    });
});

describe('解析模型的回复', () => {
    test('代码围栏、前后有话、字符串形式的 id 都能读；空对象 = 今晚没什么想法', () => {
        const wrapped = '好的，我想了想：\n```json\n{"drop":[{"id":"camera","why":"没那么想拍了"}],"propose":[{"title":"学吉他","why":"想会弹一首歌","firstStep":"先买拨片"}]}\n```';
        const decision = parseDecision(wrapped)!;
        assert.deepEqual(decision.drop, [{ id: 'camera', why: '没那么想拍了' }]);
        assert.deepEqual(decision.propose, [{ title: '学吉他', why: '想会弹一首歌', firstStep: '先买拨片' }]);
        assert.deepEqual(parseDecision('{}'), none());
        assert.deepEqual(parseDecision('{"pause":["courses"]}')!.pause, [{ id: 'courses', why: '' }]);
    });

    test('不是 JSON / 坏的：undefined（不落地任何东西）', () => {
        for (const text of ['我今天没什么想法', '{"drop": [', '', '[1,2,3]']) assert.equal(parseDecision(text), undefined, text);
    });
});

describe('什么时候想：每晚一次', () => {
    test('晚上 20 点以后才想；想成了 20 小时内不再想；失败隔 2 小时再试，一天最多试 3 次', () => {
        const state = emptySelfState();
        assert.equal(reflectionDue(state, new Date(2026, 9, 29, 19, 59).getTime()), false);
        assert.equal(reflectionDue(state, NIGHT), true);
        state.lastReflectionAt = NIGHT;
        assert.equal(reflectionDue(state, NIGHT + 3_600_000), false, '刚想过');
        assert.equal(reflectionDue(state, NIGHT + 23 * 3_600_000), true, '第二天晚上又可以');
        const failing = emptySelfState();
        failing.lastAttemptAt = NIGHT;
        failing.attempts = { day: '2026-10-29', n: 1 };
        assert.equal(reflectionDue(failing, NIGHT + 3_600_000), false, '失败后 2 小时内不重试');
        assert.equal(reflectionDue(failing, NIGHT + 2 * 3_600_000 + 1000), true);
        failing.attempts = { day: '2026-10-29', n: MAX_ATTEMPTS_PER_DAY };
        assert.equal(reflectionDue(failing, NIGHT + 2.5 * 3_600_000), false, '一天最多试 3 次');
    });

    function deps(dir: string, reply: () => string, log: string[], clock = { now: NIGHT }, calls: unknown[][] = []) {
        return {
            dataDir: dir, now: () => clock.now,
            generate: async (messages: unknown[]) => { calls.push(messages); return reply(); },
            base: () => base, chat: () => [{ role: 'user' as const, content: '今天好累啊' }, { role: 'assistant' as const, content: '那早点睡' }],
            persona: () => '二十岁的大二学生，爱拍照', names: { char: '林梦瑶', user: '宝宝' }, log: (message: string) => log.push(message),
        };
    }

    test('想成了：状态落盘、记 lastReflectionAt、日志写明；没到点不调模型', async () => {
        const dir = tmp();
        const log: string[] = [];
        const calls: unknown[][] = [];
        const clock = { now: NIGHT };
        const result = await reflectIfDue(deps(dir, () => '{"drop":[{"id":"camera","why":"最近没心思拍"}],"propose":[{"title":"学吉他","why":"一直想会弹一首完整的歌"}]}', log, clock, calls));
        assert.equal(result.ran, true);
        const state = loadSelfState(dir);
        assert.equal(state.lastReflectionAt, NIGHT);
        assert.equal(state.overrides.camera!.status, 'dropped');
        assert.equal(state.pursuits[0]!.title, '学吉他');
        assert.ok(log.some(line => line.includes('晚上想了一次') && line.includes('学吉他')));
        // 提示词里有她现在的追求和最近的聊天
        const prompt = JSON.stringify(calls[0]);
        assert.ok(prompt.includes('camera') && prompt.includes('今天好累啊') && prompt.includes('别挂科'));
        // 同一晚再叫一次：没到点，不再调模型
        clock.now = NIGHT + 3_600_000;
        assert.deepEqual(await reflectIfDue(deps(dir, () => '{}', log, clock, calls)), { ran: false });
        assert.equal(calls.length, 1);
    });

    test('模型回的不是 JSON / 报错：不落地任何东西，记一次尝试，lastReflectionAt 不动，2 小时后再试', async () => {
        const dir = tmp();
        const log: string[] = [];
        const clock = { now: NIGHT };
        const result = await reflectIfDue(deps(dir, () => '我今天没什么想法呢', log, clock));
        assert.equal(result.error, '回复里没有可用的 JSON');
        const state = loadSelfState(dir);
        assert.equal(state.lastReflectionAt, 0);
        assert.equal(state.lastAttemptAt, NIGHT);
        assert.deepEqual(state.overrides, {});
        assert.ok(log.some(line => line.includes('今晚没想成')));
        clock.now = NIGHT + 3_600_000;
        assert.deepEqual(await reflectIfDue(deps(dir, () => '{}', log, clock)), { ran: false }, '1 小时后还不到重试的时候');
        clock.now = NIGHT + 2 * 3_600_000 + 1000;
        assert.equal((await reflectIfDue(deps(dir, () => '{}', log, clock))).ran, true);
        assert.equal(loadSelfState(dir).lastReflectionAt, clock.now);
    });

    test('提示词明说：她记的进度、放下的理由，他用 /追求 能看到（她知道自己写的有人看）', () => {
        const text = reflectionMessages({ char: '林梦瑶', user: '宝宝', persona: '大二学生', pursuits: base, chat: [], now: NIGHT }).map(message => message.content).join('\n');
        assert.match(text, /他用 \/追求 都能看到（他只能看，不能改）/);
    });

    test('提示词只提醒、不替她定：说了「没什么想法就输出 {}」「别硬凑」，没有给具体该追求什么', () => {
        const text = reflectionMessages({ char: '林梦瑶', user: '宝宝', persona: '大二学生', pursuits: base, chat: [], now: NIGHT }).map(message => message.content).join('\n');
        assert.match(text, /没什么想法就输出 \{\}/);
        assert.match(text, /真的没想法就别硬凑/);
        assert.match(text, /大方向作者还没定/);
        assert.ok(!/吉他|跑步|画画|做饭/.test(text), '提示词里不给例子——不替她想');
    });
});

describe('读法：作者的 + 她的决定 + 她自己加的', () => {
    test('她的决定盖过作者文件里的状态；她自己加的接在后面；文件改了下一次读就跟着变', () => {
        const dir = tmp();
        writeFileSync(pursuitsPath(dir), JSON.stringify({ pursuits: [{ id: 'camera', title: '用新相机拍出自己满意的东西', why: '作者改过的话', status: 'paused' }] }));
        const state = emptySelfState();
        state.overrides.camera = { status: 'active', at: NIGHT, why: '我又想拍了' };
        state.pursuits.push({ id: 'self-1', title: '学吉他', why: '想会弹一首歌', status: 'active', source: 'self', proposedAt: NIGHT });
        saveSelfState(dir, state);
        const read = selfAwareReader(dir, pursuitsReader(dir, () => {}));
        const list = read();
        assert.equal(list.find(item => item.id === 'camera')!.status, 'active', '她说想拍，作者文件里的暂停不算');
        assert.equal(list.at(-1)!.id, 'self-1');
        const next = loadSelfState(dir);
        next.pursuits[0] = { ...next.pursuits[0]!, status: 'dropped' };
        saveSelfState(dir, next);
        assert.equal(read().find(item => item.id === 'self-1')!.status, 'dropped');
    });

    test('进提示词的话：她自己定的那条带上她自己记的最近一句；还没记过就是她想的第一步', () => {
        const mine: Pursuit = { id: 'self-1', title: '学吉他', why: '想会弹一首歌', status: 'active', source: 'self', proposedAt: NIGHT, firstStep: '先学三个和弦' };
        const facts = { now: new Date(NIGHT), schedule: {} as never, quizzes: false };
        assert.match(describePursuits(pursuitViews([mine], facts))!, /学吉他——想会弹一首歌；你想的第一步：先学三个和弦/);
        const text = describePursuits(pursuitViews([{ ...mine, notes: [{ at: NIGHT, text: '今天手指磨得疼，但弹出了 C 和弦' }] }], facts))!;
        assert.match(text, /你自己最近记的：今天手指磨得疼，但弹出了 C 和弦/);
        assert.doesNotMatch(text, /第一步/);
    });

    test('状态文件读坏了：当她还没想过，不抛错', () => {
        const dir = tmp();
        writeFileSync(join(dir, 'pursuits-self.json'), '{ 坏了');
        assert.deepEqual(loadSelfState(dir), emptySelfState());
        writeFileSync(join(dir, 'pursuits-self.json'), JSON.stringify({ pursuits: [{ id: 1 }, 'x'], overrides: { camera: { status: '乱写' } }, rejected: 'no' }));
        assert.deepEqual(loadSelfState(dir).pursuits, []);
        assert.deepEqual(loadSelfState(dir).overrides, {});
    });
});

describe('/追求：他只能看', () => {
    test('列出在追的（标明作者给的 / 她自己定的）、放下的和原因、想过没成的；说明他改不了；以「（」开头', () => {
        const state = emptySelfState();
        applyDecision(state, base, propose('学吉他', '一直想会弹一首完整的歌'), NIGHT - 10 * DAY);
        applyDecision(state, base, { ...none(), drop: [{ id: 'camera', why: '最近没心思拍' }], notes: [{ id: state.pursuits[0]!.id, text: '练了三个和弦' }] }, NIGHT - 5 * DAY);
        applyDecision(state, base, propose('准备考研', '想换个方向'), NIGHT);
        const text = describeForOwner(withSelf(base, state), state, NIGHT);
        assert.ok(text.startsWith('（') && text.endsWith('）'));
        assert.match(text, /别挂科——.*（作者给的）/);
        assert.match(text, /学吉他——一直想会弹一首完整的歌（她自己定的，10 天前）/);
        assert.match(text, /她最近记的：练了三个和弦/);
        assert.match(text, /用新相机拍出自己满意的东西（放下了：最近没心思拍）/);
        assert.match(text, /她想过、但没成的：\n- 准备考研（人生方向类/);
        assert.match(text, /你只能看，不能改；她随时可以改主意/);
    });
});
