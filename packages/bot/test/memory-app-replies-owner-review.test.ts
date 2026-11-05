// Synthetic real-App stop ownership regression.
import { test } from "node:test";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
const at = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, 'synthetic reply wait timed out'); await new Promise(done => setTimeout(done, 5)); } }

async function observe(stage: 'compose' | 'compose-fail' | 'account' | 'fetch' | 'post') {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-replies-owner-')), dataDir = join(root, 'data');
 mkdirSync(join(dataDir, 'secrets'), { recursive: true });
 const oldFetch = globalThis.fetch, requests: { path: string; lease: boolean }[] = [], logs: string[] = [], models: { lease: boolean }[] = [];
 let app: App | undefined, release!: () => void, entered = false, grantedLog: ((line: string) => void) | undefined, stopped = false;
 const held = new Promise<void>(done => { release = done; });
 const read = (name: string) => { const path = join(dataDir, 'presence', name); return existsSync(path) ? readFileSync(path, 'utf8') : ''; };
 try {
  for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
  writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), JSON.stringify({ sessdata: 'SYNTHETIC_SESSION', biliJct: 'SYNTHETIC_CSRF', dedeUserId: '123', buvid3: 'SYNTHETIC_DEVICE', savedAt: '2026-11-05T00:00:00Z' }));
  const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
   contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], bilibiliAccount: true, bilibiliAtUid: 456, bilibiliReplies: stage === 'post' ? 'on' : 'dryRun',
   jokes: false, idioms: false, schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
  globalThis.fetch = async (input, init) => {
   const url = new URL(String(input)); assert.equal(url.hostname, 'api.bilibili.com');
   requests.push({ path: url.pathname, lease: existsSync(join(dataDir, 'bot.lock')) });
   if ((stage === 'account' && url.pathname.endsWith('/nav')) || (stage === 'fetch' && url.pathname.endsWith('/msgfeed/reply')) || (stage === 'post' && url.pathname.endsWith('/reply/add'))) { entered = true; await held; }
   if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, uname: '合成账号', mid: 123 } });
   if (url.pathname.endsWith('/unread')) return Response.json({ code: 0, data: { sys_msg: 0 } });
   if (url.pathname.endsWith('/msgfeed/reply')) return Response.json({ code: 0, data: { items: [{ reply_time: at / 1000 - 10, user: { mid: 456, nickname: '合成留言者' }, item: { source_id: '701', target_id: '700', root_id: '700', subject_id: 1, business_id: 1, source_content: '这只合成猫咪也太可爱了', root_reply_content: '合成猫咪今天很开心' } }] } });
   if (url.pathname.endsWith('/reply/add')) { assert.equal(init?.method, 'POST'); return Response.json({ code: 0, data: { rpid_str: '702' } }); }
   assert.fail(`unexpected synthetic route ${url.pathname}`);
  };
  app = startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: line => logs.push(line), transport: { friendHistory: async () => [], sendPrivateText: async () => 900 },
   pipeline: { now: () => at, generate: async (messages, log) => { assert.ok(messages[0]?.content.includes('现在有人回复了你')); models.push({ lease: existsSync(join(dataDir, 'bot.lock')) }); grantedLog = log;
    if (stage === 'compose' || stage === 'compose-fail') { entered = true; await held; if (stage === 'compose-fail') throw Error('SYNTHETIC_LATE_REPLY_MODEL_FAILURE'); }
    return '它看起来确实挺开心的';
   } } });
  await app.connected(20000); await until(() => entered);
  const requestCount = requests.length, modelCount = models.length, before = { state: read('bilibili-replies.json'), corpus: read('bilibili-corpus.jsonl'), draft: read('drafts.md') };
  const drain = Promise.resolve(app.stop()).then(() => { stopped = true; });
  await settle(); const heldLease = existsSync(join(dataDir, 'bot.lock')), settledWhileHeld = stopped, logCount = logs.length;
  if (stage === 'compose-fail') grantedLog?.('SYNTHETIC_LATE_GRANTED_REPLY_LOG');
  release(); await drain; await settle();
  const after = { state: read('bilibili-replies.json'), corpus: read('bilibili-corpus.jsonl'), draft: read('drafts.md') };
  return { stage, heldLease, settledWhileHeld, successorRequests: requests.slice(requestCount), successorModels: models.slice(modelCount), stateChanged: before.state !== after.state, corpusChanged: before.corpus !== after.corpus, draftChanged: before.draft !== after.draft, lateLogs: logs.slice(logCount), allRequestCount: requests.length };
 } finally {
  release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-replies-owner-')); rmSync(root, { recursive: true, force: true });
 }
}
for (const stage of ['compose', 'compose-fail', 'account', 'fetch'] as const) test('真实App回复停止阻止晚阶段: '+stage, async () => {
 const r=await observe(stage); assert.deepEqual(r.successorRequests,[]); assert.deepEqual(r.successorModels,[]);
 assert.equal(r.stateChanged,false); assert.equal(r.corpusChanged,false); assert.equal(r.draftChanged,false); assert.deepEqual(r.lateLogs,[]);
});
test('真实App已派回复ACK保收尾并等待目录租约',async()=>{const r=await observe('post'); assert.equal(r.heldLease,true); assert.equal(r.settledWhileHeld,false); assert.equal(r.corpusChanged,true); assert.equal(r.draftChanged,false); assert.deepEqual(r.successorRequests,[]);});
