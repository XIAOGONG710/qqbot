import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMONS_MAX_BYTES, commonsSearch, commonsFoodSearch, parseCommons, parseCommonsFood, judgePhoto, judgeFood, type CommonsFetch } from '../src/vision/photo-sources.ts';
import { photoShelf } from '../src/vision/photos.ts';

const page = (extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({ title: 'File:Synthetic 1.jpg', imageinfo: [{
 width: 3000, height: 2000, mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic.jpg',
 descriptionurl: 'https://commons.wikimedia.org/wiki/File:Synthetic_1.jpg',
 extmetadata: { LicenseShortName: { value: 'CC0' }, Artist: { value: 'Synthetic author' }, ...meta }, ...extra,
}] });
const body = (...pages: unknown[]) => ({ query: { pages: Object.fromEntries(pages.map((p, i) => [i, p])) } });
const parsers = [(value: unknown) => parseCommons('cat', value), (value: unknown) => parseCommonsFood('炒饭', value)];

test('畸形Commons页不使整批崩溃，有限整数尺寸和字符串授权元数据才被接受', () => {
 for (const parse of parsers) {
  for (const value of [null, {}, [], { query: { pages: null } }]) assert.deepEqual(parse(value), []);
  assert.equal(parse(body(null, 42, { title: {} }, { title: 5, imageinfo: [{}] }, page())).length, 1);
  for (const width of [NaN, Infinity, '3000', 3000.5]) assert.deepEqual(parse(body(page({ width }))), []);
  assert.deepEqual(parse(body(page({}, { LicenseShortName: { value: ['CC0'] } }))), []);
  assert.deepEqual(parse(body({ ...page(), title: ['File:Synthetic.jpg'] })), []);
  assert.deepEqual(parse(body({ ...page({ descriptionurl: undefined }), title: 'File:\ud800.jpg' })), []);
 }
});

test('来源页必须可追溯到Commons，缺页地址由标题生成，授权作者不截断', () => {
 const author = '合成摄影作者'.repeat(20);
 for (const parse of parsers) {
  assert.deepEqual(parse(body(page({ descriptionurl: 'http://127.0.0.1/private' }))), []);
  assert.deepEqual(parse(body(page({ descriptionurl: { secret: 'private' } }))), []);
  const candidate = parse(body(page({ descriptionurl: undefined }, { Artist: { value: author } })))[0]!;
  assert.match(candidate.pageUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File/);
  assert.equal(candidate.artist, author);
 }
});

test('继承的种类或菜名不是搜索词，坏翻页参数在请求前拒绝', async () => {
 let calls = 0;
 const fetch: CommonsFetch = async () => { calls++; return { ok: true, status: 200, json: async () => body(page()) }; };
 const search = commonsSearch({ fetch }); const food = commonsFoodSearch({ fetch });
 for (const key of ['constructor', '__proto__', 'toString']) {
  assert.deepEqual(await search(key as 'cat'), []);
  assert.deepEqual(await food(key), []);
 }
 assert.equal(calls, 0);
 for (const offset of [-1, Infinity, NaN, 0.5]) {
  await assert.rejects(search('cat', offset));
  await assert.rejects(food('炒饭', offset));
 }
 for (const timeoutMs of [0, NaN, Infinity, 2_147_483_648]) await assert.rejects(commonsSearch({ fetch, timeoutMs })('cat'));
 assert.equal(calls, 0);
});

test('忽略abort的fetch和json仍按deadline结束，超时后可重试，不回显供应商正文', async () => {
 for (const create of [commonsSearch, commonsFoodSearch]) {
  for (const phase of ['fetch', 'json']) {
   let resolve!: (value: unknown) => void;
   const held = new Promise<unknown>(r => { resolve = r; });
   let attempt = 0;
   const fetch: CommonsFetch = async () => {
    if (++attempt === 1 && phase === 'fetch') await held;
    return { ok: true, status: 200, json: async () => { if (attempt === 1 && phase === 'json') await held; return body(page()); } };
   };
   const search: (input: string) => Promise<unknown[]> = create === commonsSearch
    ? (input => commonsSearch({ fetch, timeoutMs: 10 })(input as 'cat')) : commonsFoodSearch({ fetch, timeoutMs: 10 });
   const input = create === commonsSearch ? 'cat' : '炒饭';
   const result = await Promise.race([search(input).then(() => 'resolved', error => String(error)), new Promise<string>(r => setTimeout(() => r('hung'), 150))]);
   resolve(undefined);
   assert.match(result, /超时/);
   assert.notEqual(result, 'hung');
   assert.ok((await search(input)).length > 0);
  }
 }
});

test('默认Commons读取限制响应字节，超大/卡住/非成功响应释放流且错误不带正文', async () => {
 let cancelled = 0;
 let supplied = 0;
 const oversized = new ReadableStream<Uint8Array>({ pull(controller) { supplied += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled++; } });
 let fetchMock = mock.method(globalThis, 'fetch', async () => new Response(oversized));
 try {
  await assert.rejects(commonsSearch({ timeoutMs: 100 })('cat'), /读取或解析失败/);
  assert.equal(cancelled, 1);
  assert.ok(supplied <= COMMONS_MAX_BYTES + 2 * 64 * 1024, '超过限额后停止拉取，至多保留流自身一块预取');
 } finally { fetchMock.mock.restore(); }
 const hung = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
 fetchMock = mock.method(globalThis, 'fetch', async () => new Response(hung));
 try {
  await assert.rejects(commonsSearch({ timeoutMs: 10 })('cat'), /超时/);
  assert.equal(cancelled, 2);
 } finally { fetchMock.mock.restore(); }
 const errorBody = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
 fetchMock = mock.method(globalThis, 'fetch', async () => new Response(errorBody, { status: 429 }));
 try {
  await assert.rejects(commonsSearch()('cat'), /429/);
  assert.equal(cancelled, 3);
 } finally { fetchMock.mock.restore(); }
 fetchMock = mock.method(globalThis, 'fetch', async () => new Response('PRIVATE-BODY-MARKER'));
 try {
  await assert.rejects(commonsSearch()('cat'), error => error instanceof Error && !error.message.includes('PRIVATE-BODY-MARKER'));
 } finally { fetchMock.mock.restore(); }
 fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body(page()))));
 try {
  assert.equal((await commonsSearch()('cat')).length, 1);
 } finally { fetchMock.mock.restore(); }
});

test('Commons返回API错误时可重试，不当成永久空结果，错误正文不回显', async () => {
 const fetch: CommonsFetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 'maxlag', info: 'PRIVATE-ERROR-MARKER' } }) });
 for (const search of [() => commonsSearch({ fetch })('cat'), () => commonsFoodSearch({ fetch })('炒饭')]) {
  await assert.rejects(search, error => error instanceof Error && /接口返回错误/.test(error.message) && !error.message.includes('PRIVATE-ERROR-MARKER'));
 }
});

test('看图的说明必须是字符串，不能把数组拼成合法说明', () => {
 const common = { 水印: false, 清晰: true, 说明: ['一只三花猫蹲在草地上'] };
 assert.equal(judgePhoto('cat', JSON.stringify({ ...common, 人物: false, 猫: true, 三花: true })).keep, false);
 assert.equal(judgeFood('炒饭', JSON.stringify({ ...common, 人脸: false, 招牌: false, 是这道菜: true, 一份饭: true, 实拍: true })).keep, false);
});

test('来源的脱敏暂时错误仍使普通和食物货架安排重试', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-source-retry-'));
 const unused = async (): Promise<never> => { throw new Error('不应下载或识图'); };
 try {
  const failures: CommonsFetch[] = [
   async () => { throw new Error('PRIVATE-NETWORK-MARKER'); },
   async () => ({ ok: false, status: 502, json: async () => undefined }),
   async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 'maxlag', info: 'PRIVATE-API-MARKER' } }) }),
  ];
  for (const [i, fetch] of failures.entries()) {
   const logs: string[] = [];
   const shelf = photoShelf({ dir: join(dir, String(i)), log: message => logs.push(message),
    source: { search: commonsSearch({ fetch }), download: unused, judge: unused },
    foodSource: { search: commonsFoodSearch({ fetch }), download: unused, judge: unused },
   });
   assert.equal(await shelf.discover(), 'retry');
   assert.equal(await shelf.discoverFood(['炒饭']), 'retry');
   assert.ok(logs.every(message => !message.includes('PRIVATE-')));
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
