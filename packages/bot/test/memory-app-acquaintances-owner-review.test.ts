// Synthetic real-App regression for Bilibili account decorators' stop ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { BiliAccount } from '../src/bilibili/bilibili-account.ts';
import { Acquaintances, acquaintancesAccount } from '../src/life/acquaintances.ts';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const at = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 24; i++) await tick(); }
async function until(check: () => boolean) {
 const deadline = Date.now() + 3000;
 while (!check()) { assert.ok(Date.now() < deadline, 'synthetic account decorator checkpoint timed out'); await new Promise(done => setTimeout(done, 5)); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function fixture(root: string, dataDir: string, mode: 'dryRun' | 'on') {
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

const payload = () => ({ code: 0, data: { items: [{
 reply_time: at / 1000 - 10, user: { mid: 456, nickname: '合成留言者' },
 item: { source_id: '701', target_id: '700', root_id: '700', subject_id: 1, business_id: 1, source_content: '这只合成猫咪也太可爱了', root_reply_content: '合成猫咪今天很开心' },
}] } });

test('认识的人账号装饰器完整透传 fetchReplies 的取消信号', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-acquaintances-signal-'));
 let received: AbortSignal | undefined;
 try {
  const account = { fetchReplies: async (signal?: AbortSignal) => { received = signal; return []; } } as unknown as BiliAccount;
  const wrapped = acquaintancesAccount(account, new Acquaintances({ dataDir: dir }));
  const controller = new AbortController();
  await wrapped.fetchReplies(controller.signal);
  assert.equal(received, controller.signal);
 } finally {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-acquaintances-signal-')); rmSync(dir, { recursive: true, force: true });
 }
});

test('停止取消旧 fetchReplies，且下一实例不继承认识的人副作用', async () => {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-acquaintances-stop-')), dataDir = join(root, 'data');
 const oldFetch = globalThis.fetch, held = deferred(), peoplePath = join(dataDir, 'people.json');
 let app: App | undefined, replacement: App | undefined, entered = false, stopped = false, replySignal: AbortSignal | undefined;
 try {
  const config = fixture(root, dataDir, 'dryRun');
  globalThis.fetch = async (input, init) => {
   const url = new URL(String(input)); assert.equal(url.hostname, 'api.bilibili.com');
   if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, uname: '合成账号', mid: 123 } });
   if (url.pathname.endsWith('/unread')) return Response.json({ code: 0, data: { sys_msg: 0 } });
   if (url.pathname.endsWith('/msgfeed/reply')) {
    entered = true; replySignal = init?.signal ?? undefined;
    return await new Promise<Response>((resolveResponse, reject) => {
     held.promise.then(() => resolveResponse(Response.json(payload())));
     replySignal?.addEventListener('abort', () => reject(replySignal?.reason), { once: true });
    });
   }
   assert.fail(`unexpected synthetic route ${url.pathname}`);
  };
  const base = { config, log: () => {}, sensitive: { on: () => false, describe: () => '' },
   transport: { friendHistory: async () => [], sendPrivateText: async () => 900 }, pipeline: { now: () => at, generate: async () => 'SYNTHETIC_REPLY' } };
  app = startApp(base); await app.connected(20000); await until(() => entered);
  const drain = Promise.resolve(app.stop()).then(() => { stopped = true; });
  await settle();
  const stoppedBeforeUnderlyingRead = stopped, peopleBeforeUnderlyingRead = existsSync(peoplePath);
  held.resolve(); await drain; await settle();
  const peopleAfterStop = existsSync(peoplePath);
  replacement = startApp(base);
  const inherited = new Acquaintances({ dataDir }).list();

  assert.ok(replySignal, 'fetchReplies must receive the App lifetime signal');
  assert.equal(replySignal.aborted, true);
  assert.equal(stoppedBeforeUnderlyingRead, true, 'a cancellable pure read must not hold the directory lease');
  assert.equal(peopleBeforeUnderlyingRead, false);
  assert.equal(peopleAfterStop, false, 'a cancelled old read must not publish people.json');
  assert.deepEqual(inherited, [], 'the replacement instance must not inherit a cancelled old read');
 } finally {
  held.resolve(); await app?.stop(); await replacement?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-acquaintances-stop-')); rmSync(root, { recursive: true, force: true });
 }
});

test('已派 postReply ACK 仍在目录租约内记时间线后收尾', async () => {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-acquaintances-mutation-')), dataDir = join(root, 'data');
 const oldFetch = globalThis.fetch, held = deferred(), timelinePath = join(dataDir, 'timeline.jsonl'), lockPath = join(dataDir, 'bot.lock');
 let app: App | undefined, entered = false, stopped = false;
 try {
  const config = fixture(root, dataDir, 'on');
  globalThis.fetch = async (input, init) => {
   const url = new URL(String(input)); assert.equal(url.hostname, 'api.bilibili.com');
   if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, uname: '合成账号', mid: 123 } });
   if (url.pathname.endsWith('/unread')) return Response.json({ code: 0, data: { sys_msg: 0 } });
   if (url.pathname.endsWith('/msgfeed/reply')) return Response.json(payload());
   if (url.pathname.endsWith('/reply/add')) { assert.equal(init?.method, 'POST'); entered = true; await held.promise; return Response.json({ code: 0, data: { rpid_str: '702' } }); }
   assert.fail(`unexpected synthetic route ${url.pathname}`);
  };
  app = startApp({ config, log: () => {}, sensitive: { on: () => false, describe: () => '' },
   transport: { friendHistory: async () => [], sendPrivateText: async () => 900 }, pipeline: { now: () => at, generate: async () => '它看起来确实挺开心的' } });
  await app.connected(20000); await until(() => entered);
  const drain = Promise.resolve(app.stop()).then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false);
  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(timelinePath), false);
  held.resolve(); await drain; await settle();
  const entries = readFileSync(timelinePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { channel: string; kind: string });
  assert.equal(stopped, true);
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(entries.map(({ channel, kind }) => ({ channel, kind })), [{ channel: 'bilibili', kind: 'reply' }]);
 } finally {
  held.resolve(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-acquaintances-mutation-')); rmSync(root, { recursive: true, force: true });
 }
});
