// Synthetic real-App probe for the account decorators' stop ownership.
// It uses only temporary cards/credentials and fake Bilibili HTTP responses.
// Exit 0 reports the observed boundary; it is not a correctness assertion.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const at = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 24; i++) await tick(); }
async function until(check) {
 const deadline = Date.now() + 3000;
 while (!check()) { assert.ok(Date.now() < deadline, 'synthetic account decorator checkpoint timed out'); await new Promise(done => setTimeout(done, 5)); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(root, dataDir, mode) {
 mkdirSync(join(dataDir, 'secrets'), { recursive: true });
 for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
 writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), JSON.stringify({
  sessdata: 'SYNTHETIC_SESSION', biliJct: 'SYNTHETIC_CSRF', dedeUserId: '123', buvid3: 'SYNTHETIC_DEVICE', savedAt: '2026-11-05T00:00:00Z',
 }));
 return parseAppConfig({
  llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
  contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], bilibiliAccount: true, bilibiliAtUid: 456, bilibiliReplies: mode,
  acquaintances: true, timeline: true, jokes: false, idioms: false, schedule: false, moody: false, speechCheck: false,
  herDays: false, realWeather: false, proactive: 'off', media: false,
 }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
}

function read(path) { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }
function replyPayload() {
 return { code: 0, data: { items: [{ reply_time: at / 1000 - 10, user: { mid: 456, nickname: '合成留言者' }, item: {
  source_id: '701', target_id: '700', root_id: '700', subject_id: 1, business_id: 1,
  source_content: '这只合成猫咪也太可爱了', root_reply_content: '合成猫咪今天很开心',
 } }] } };
}

async function observeLateRead() {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-acquaintances-read-')), dataDir = join(root, 'data');
 const oldFetch = globalThis.fetch, held = deferred(), logs = [], requests = [];
 const peoplePath = join(dataDir, 'people.json'), timelinePath = join(dataDir, 'timeline.jsonl'), lockPath = join(dataDir, 'bot.lock');
 let app, replacement, entered = false, stopped = false;
 try {
  const config = fixture(root, dataDir, 'dryRun');
  globalThis.fetch = async input => {
   const url = new URL(String(input)); assert.equal(url.hostname, 'api.bilibili.com'); requests.push(url.pathname);
   if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, uname: '合成账号', mid: 123 } });
   if (url.pathname.endsWith('/unread')) return Response.json({ code: 0, data: { sys_msg: 0 } });
   if (url.pathname.endsWith('/msgfeed/reply')) { entered = true; await held.promise; return Response.json(replyPayload()); }
   assert.fail(`unexpected synthetic route ${url.pathname}`);
  };
  const base = { config, sensitive: { on: () => false, describe: () => '' }, pipeline: { now: () => at, generate: async () => 'SYNTHETIC_REPLY' },
   transport: { friendHistory: async () => [], sendPrivateText: async () => 900 } };
  app = startApp({ ...base, log: line => logs.push(line) });
  await app.connected(20000); await until(() => entered);
  const logAtStop = logs.length;
  const drain = Promise.resolve(app.stop()).then(() => { stopped = true; });
  await settle();
  const whileReadHeld = { stopResolved: stopped, leaseHeld: existsSync(lockPath), peopleBytes: read(peoplePath).length, timelineBytes: read(timelinePath).length };
  held.resolve(); await drain; await settle();
  const afterStop = { stopResolved: stopped, leaseReleased: !existsSync(lockPath), peopleBytes: read(peoplePath).length, timelineBytes: read(timelinePath).length };

  // A real replacement sees whatever the cancelled old read committed before releasing its lease.
  replacement = startApp({ ...base, log: () => {} });
  const replacementHeldLease = existsSync(lockPath);
  const peopleText = read(peoplePath), timelineText = read(timelinePath);
  let people = [];
  try { people = JSON.parse(peopleText).people ?? []; } catch { /* The raw byte facts below remain authoritative. */ }
  const afterLateRead = {
   replacementHeldLease,
   replacementInheritedCancelledRead: replacementHeldLease && peopleText.length > 0,
   observedPeople: people.map(person => ({ platform: person.platform, uid: person.uid, name: person.name, last: person.last })),
   timelineBytes: timelineText.length,
   oldLateLogs: logs.slice(logAtStop),
  };
  console.log(JSON.stringify({ probe: 'decorated-account-late-read', requests, whileReadHeld, afterStop, afterLateRead }));
 } finally {
  held.resolve(); await app?.stop(); await replacement?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-acquaintances-read-')); rmSync(root, { recursive: true, force: true });
 }
}

async function observeMutationAck() {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-acquaintances-mutation-')), dataDir = join(root, 'data');
 const oldFetch = globalThis.fetch, held = deferred(), logs = [], requests = [];
 const timelinePath = join(dataDir, 'timeline.jsonl'), lockPath = join(dataDir, 'bot.lock');
 let app, entered = false, stopped = false;
 try {
  const config = fixture(root, dataDir, 'on');
  globalThis.fetch = async (input, init) => {
   const url = new URL(String(input)); assert.equal(url.hostname, 'api.bilibili.com'); requests.push(url.pathname);
   if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, uname: '合成账号', mid: 123 } });
   if (url.pathname.endsWith('/unread')) return Response.json({ code: 0, data: { sys_msg: 0 } });
   if (url.pathname.endsWith('/msgfeed/reply')) return Response.json(replyPayload());
   if (url.pathname.endsWith('/reply/add')) { assert.equal(init?.method, 'POST'); entered = true; await held.promise; return Response.json({ code: 0, data: { rpid_str: '702' } }); }
   assert.fail(`unexpected synthetic route ${url.pathname}`);
  };
  app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
   transport: { friendHistory: async () => [], sendPrivateText: async () => 900 },
   pipeline: { now: () => at, generate: async () => '它看起来确实挺开心的' } });
  await app.connected(20000); await until(() => entered);
  const logAtStop = logs.length;
  const drain = Promise.resolve(app.stop()).then(() => { stopped = true; });
  await settle();
  const whileAckHeld = { stopResolved: stopped, leaseHeld: existsSync(lockPath), timelineBytes: read(timelinePath).length };
  held.resolve(); await drain; await settle();
  const timeline = read(timelinePath).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const afterAck = { stopResolved: stopped, leaseReleased: !existsSync(lockPath), timeline: timeline.map(entry => ({ channel: entry.channel, kind: entry.kind, summary: entry.summary, ok: entry.ok })), lateLogs: logs.slice(logAtStop) };
  console.log(JSON.stringify({ probe: 'decorated-account-dispatched-mutation', requests, whileAckHeld, afterAck }));
 } finally {
  held.resolve(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-acquaintances-mutation-')); rmSync(root, { recursive: true, force: true });
 }
}

await observeLateRead();
await observeMutationAck();
