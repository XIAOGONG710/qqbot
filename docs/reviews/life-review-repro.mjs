// Read-only source audit: assertions confirm defects in the reviewed baseline.
// Historical baseline: 53dbaf2c. On repaired code use test/life-review*.test.ts instead.
// Only synthetic fixtures under the system temporary directory are written.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.TZ = 'Asia/Shanghai';
const root = process.argv[2] ?? process.cwd();
const source = name => import(pathToFileURL(`${root}/packages/bot/src/${name}.ts`).href);
const { judgeAction } = await source('life/actions');
const { bodyAt } = await source('life/body');
const { wakeOn, parseSchedule } = await source('life/schedule');
const { parsePromises, promiseKeeper } = await source('life/promises');
const { Acquaintances, acquaintancesAccount, classifyKind } = await source('life/acquaintances');
const { Tastes } = await source('life/tastes');
const { diaryWriter } = await source('life/diary');
const { humanValuesAt } = await source('human-values');
const { bookProgressOn } = await source('life/her-days');
const { pursuitViews } = await source('life/pursuits');
const { sideJobOn } = await source('life/money');
const { photographyProgress } = await source('life/projects');
const { quizzesOn, quizEvents } = await source('life/everyday');
const { quizRecord } = await source('life/pursuits');
const now = new Date('2026-11-05T12:00:00+08:00');
const at = text => new Date(`${text}+08:00`);
const quiet = () => {};
const work = tmpdir();
mkdirSync(work, { recursive: true });
const fixtures = mkdtempSync(join(work, 'life-review-'));
const dir = label => { const path = join(fixtures, label); mkdirSync(path); return path; };
const schedule = {
  sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
  periods: { one: { start: '08:20', end: '09:50' } },
  semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
  kinds: { hard: {}, machine: {}, water: {}, pe: {} },
  courses: [1, 2, 3, 4, 5].map(day => ({ day, slot: 'one', weeks: '1-20', kind: 'hard', name: '高等数学' })),
  free: { morning: ['在休息'], afternoon: ['在休息'], evening: ['在休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍',
};
let count = 0;
async function repro(name, check) { await check(); console.log(`CONFIRMED ${++count}: ${name}`); }

await repro('Expired open loops leak raw private content to logs', async () => {
  const path = dir('privacy');
  const logs = [];
  const what = '合成隐私标记-私人约定内容';
  writeFileSync(join(path, '1-boyfriend.json'), JSON.stringify({ version: 1, promises: [], loops: [{ id: 'u-test', kind: 'unsettled', what, said: '2026-10-25', episode: 'ep-1' }], extracted: {}, early: {} }));
  const keeper = promiseKeeper({ contacts: [{ qq: 1, name: '测试用户', tier: 'boyfriend' }], history: { load: () => [] }, names: () => ({ user: '测试用户', char: '测试角色' }), schedule, dir: path, now: () => now.getTime(), log: text => logs.push(text), extract: async () => '{}' });
  await keeper.sync();
  assert.ok(logs.some(text => text.includes(what)));
});

await repro('Malformed extraction object is accepted as an empty successful result', async () => {
  assert.equal(parsePromises('{"error":"failed to extract"}').add.length, 0);
  const path = dir('extract');
  const history = [
    { role: 'user', content: '明天给我讲讲吧', time: at('2026-11-04T18:00:00').toISOString() },
    { role: 'assistant', content: '好呀，明天给你讲', time: at('2026-11-04T18:01:00').toISOString() },
  ];
  const keeper = promiseKeeper({ contacts: [{ qq: 1, name: '测试用户', tier: 'boyfriend' }], history: { load: () => history }, names: () => ({ user: '测试用户', char: '测试角色' }), schedule, dir: path, now: () => now.getTime(), log: quiet, extract: async () => '{"error":"failed"}' });
  await keeper.sync();
  const state = JSON.parse(readFileSync(join(path, '1-boyfriend.json'), 'utf8'));
  assert.ok(Object.values(state.extracted).includes(true));
  assert.deepEqual(state.promises, []);
});

await repro('Early appointment re-extraction retains old location if time stays the same', async () => {
  const path = dir('appointment');
  const history = [
    { role: 'user', content: '今晚六点东门一起吃饭', time: at('2026-11-05T11:50:00').toISOString() },
    { role: 'assistant', content: '好呀，六点东门见', time: at('2026-11-05T11:51:00').toISOString() },
  ];
  let calls = 0;
  const keeper = promiseKeeper({ contacts: [{ qq: 1, name: '测试用户', tier: 'boyfriend' }], history: { load: () => history }, names: () => ({ user: '测试用户', char: '测试角色' }), schedule, dir: path, now: () => now.getTime(), log: quiet, extract: async () => JSON.stringify({ add: [{ what: ++calls === 1 ? '东门吃饭' : '西门吃饭', date: '2026-11-05', meet: { time: '18:00', where: calls === 1 ? '东门' : '西门' } }], resolved: [] }) });
  await keeper.sync();
  history.push({ role: 'user', content: '改成六点西门见面吧', time: at('2026-11-05T11:55:00').toISOString() });
  await keeper.sync();
  const state = JSON.parse(readFileSync(join(path, '1-boyfriend.json'), 'utf8'));
  assert.equal(calls, 2);
  assert.equal(state.promises[0].meet.where, '东门');
});

await repro('Negative meal duration succeeds with an end time before its start', async () => {
  const start = at('2026-11-05T12:00:00');
  const verdict = judgeAction({ id: 'bad-meal', kind: 'eat', startedAt: start, durationMinutes: -10 }, { schedule, world: { routine: { meals: [{ kind: 'lunch', start, end: at('2026-11-05T12:30:00'), where: 'canteen' }] } } });
  assert.equal(verdict.ok, true);
  assert.ok(Date.parse(verdict.event.at) < start.getTime());
});

await repro('Wake jitter suppresses early-class morning sleepiness', async () => {
  const jittered = { ...schedule, wake: { ...schedule.wake, jitter: { from: '2026-10-01', spreadMin: 10, weekendMin: 20 } } };
  let observed = false;
  for (let day = 1; day <= 28; day++) {
    const date = at(`2026-11-${String(day).padStart(2, '0')}T10:00:00`);
    if ([0, 6].includes(date.getDay())) continue;
    const wake = wakeOn(jittered, date);
    if (wake.getHours() === 7 && wake.getMinutes() === 40) continue;
    assert.equal(bodyAt({}, schedule, date).sleepy?.when, 'morning');
    assert.equal(bodyAt({}, jittered, date).sleepy, undefined);
    observed = true; break;
  }
  assert.ok(observed);
});

await repro('Repeated polling of the same reply creates fictitious repeated encounters', async () => {
  const people = new Acquaintances({ dataDir: dir('people'), now: () => now });
  const account = acquaintancesAccount({ fetchReplies: async () => [{ uid: 7, name: '合成昵称', text: '你好', at: now.toISOString() }] }, people);
  await account.fetchReplies(); await account.fetchReplies();
  assert.equal(people.list()[0].encounters.length, 2);
  assert.ok(people.promptLine()?.includes('又见到了'));
});

await repro('Mentioning an AI product is mistaken for identifying oneself as an AI', async () => {
  assert.equal(classifyKind('我最近在用ChatGPT写代码'), 'ai');
});

await repro('Malformed but valid model JSON crashes preference reflection', async () => {
  const tastes = new Tastes({ dataDir: dir('tastes'), now: () => now, experiences: () => Array.from({ length: 6 }, (_, i) => ({ ref: `e${i}`, at: now.toISOString(), kind: '休闲', text: '玩游戏' })), ask: async () => '[null]' });
  await assert.rejects(tastes.reflect(), TypeError);
});

await repro('A missing known diary is marked as a permanently empty completed week', async () => {
  const path = dir('diary');
  writeFileSync(join(path, 'diary.json'), JSON.stringify({ written: { '2026-11-01': 10, '2026-11-02': 10, '2026-11-03': 10, '2026-11-04': 10 }, texts: {}, weeks: {}, phases: {} }));
  const writer = diaryWriter({ sources: { charName: '测试角色', schedule, moods: [], books: [] }, contacts: [], history: { load: () => [] }, dir: path, log: quiet, generate: async () => '不应生成', memory: { readDiary: async () => undefined, retainSummary: async () => true, retainDiary: async () => true } });
  await writer.catchUp(now);
  const state = JSON.parse(readFileSync(join(path, 'diary.json'), 'utf8'));
  assert.equal(state.weeks['2026-10-26'], 0);
});

await repro('Future messages and events affect supposedly current human-state projections', async () => {
  const base = { at: now, needs: { at: now.toISOString(), energy: 68, hunger: 35, stress: 24 }, history: [], tier: 'boyfriend' };
  const a = humanValuesAt(base);
  const b = humanValuesAt({ ...base, history: [{ role: 'user', content: '未来消息', time: at('2026-11-06T12:00:00').toISOString() }] });
  assert.notEqual(a.loneliness, b.loneliness);
  assert.notEqual(a.boredom, b.boredom);
  const future = { id: 'future', actor: 'linmengyao', kind: 'work_on_project', target: 'photography_growth', subject: '拍照', day: '2026-11-06', startedAt: at('2026-11-06T12:00:00').toISOString(), endedAt: at('2026-11-06T13:00:00').toISOString(), source: 'simulation', result: 'succeeded' };
  assert.equal(photographyProgress([future]).sessions, 1);
});

await repro('Reading progress keeps increasing past the reliable total', async () => {
  const book = { total: { amount: 10, unit: '章' }, progress: { startDay: '2026-11-01', start: 1, everyDays: 1, amount: 5, unit: '章', state: 'reading' } };
  const progress = bookProgressOn(book, at('2026-11-05T00:00:00'));
  assert.equal(progress.finished, true);
  assert.equal(progress.amount, 21);
});

await repro('Future author step completion is already described as done', async () => {
  const views = pursuitViews([{ id: 'custom', title: '画一幅画', why: '练习', status: 'active', steps: [{ text: '起稿', doneAt: '2026-12-01T12:00:00+08:00' }] }], { now, schedule, quizzes: false });
  assert.ok(views[0].text.includes('这几步都做完了'));
});

await repro('Monthly side-job count loses jobs when multiple draws land on one day', async () => {
  let observed;
  for (let month = 0; month < 12; month++) {
    const money = { sideJobs: { perMonth: 10, kinds: ['修图'], pay: [10, 10] } };
    const days = new Date(2026, month + 1, 0).getDate();
    const jobs = Array.from({ length: days }, (_, i) => sideJobOn(money, new Date(2026, month, i + 1))).filter(Boolean);
    if (jobs.length < 10) { observed = jobs.length; break; }
  }
  assert.ok(observed < 10);
});

await repro('Schedule parser silently discards configured date-specific free activities', async () => {
  const parsed = parseSchedule({ ...schedule, free: { ...schedule.free, on: [{ date: '2026-11-05', window: 'evening', text: '生日聚会' }] } }, '合成资料');
  assert.equal(parsed.free.on, undefined);
});

await repro('Course pursuit exposes scores before the evening release event', async () => {
  let checked = false;
  for (let i = 0; i < 140; i++) {
    const day = new Date(2026, 8, 7 + i);
    const quizzes = quizzesOn(schedule, day);
    if (!quizzes.length) continue;
    const releaseMorning = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 2, 10);
    const events = quizEvents(schedule, releaseMorning, true).filter(e => e.id.startsWith('quiz_score:'));
    assert.ok(events.length > 0);
    assert.ok(events.every(e => e.at > releaseMorning));
    assert.ok(quizRecord(schedule, releaseMorning).some(q => q.date === day.toISOString().slice(0, 10) || q.date === `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`));
    checked = true; break;
  }
  assert.ok(checked);
});

await repro('Two same-course lessons on the first class day create duplicate weekly quizzes', async () => {
  const twice = { ...schedule, periods: { ...schedule.periods, two: { start: '10:10', end: '11:40' } }, courses: [
    { day: 1, slot: 'one', weeks: '1-20', kind: 'hard', name: '高等数学' },
    { day: 1, slot: 'two', weeks: '1-20', kind: 'hard', name: '高等数学' },
  ] };
  let checked = false;
  for (let i = 0; i < 20; i++) {
    const day = new Date(2026, 8, 7 + i * 7);
    const quizzes = quizzesOn(twice, day);
    if (!quizzes.length) continue;
    assert.equal(quizzes.length, 2);
    const events = quizEvents(twice, day, true).filter(e => e.id.startsWith('quiz_day:'));
    assert.equal(events.length, 2);
    assert.equal(events[0].id, events[1].id);
    checked = true; break;
  }
  assert.ok(checked);
});

console.log(`All ${count} defect reproductions confirmed. Fixture directory: ${fixtures}`);
