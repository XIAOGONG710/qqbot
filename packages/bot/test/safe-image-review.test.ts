import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchRemoteImage, validateImageDataUrl, type HostResolver, type ImageFetch } from '../src/vision/safe-image.ts';
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const publicDns: HostResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const url = 'https://synthetic.example/image';
const healthy: ImageFetch = async () => new Response(png);
async function settles(promise: Promise<unknown>, milliseconds = 150): Promise<unknown> {
 let timer: ReturnType<typeof setTimeout>;
 try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('review deadline exceeded')), milliseconds); })]); }
 finally { clearTimeout(timer!); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('DNS不响应取消时仍按截止返回，之后不再开始网络请求', async () => {
 const dns = deferred<readonly { address: string; family: number }[]>(); let fetched = 0;
 const pending = fetchRemoteImage(url, { timeoutMs: 15, resolve: () => dns.promise, fetch: async () => { fetched++; return new Response(png); } });
 try { await assert.rejects(() => settles(pending), /timed out/); }
 finally { dns.resolve([{ address: '93.184.216.34', family: 4 }]); await pending.catch(() => {}); }
 assert.equal(fetched, 0);
});

test('不响应abort的fetch仍按截止返回，晚到响应正文会取消', async () => {
 const late = deferred<Response>(); let cancelled = false;
 const pending = fetchRemoteImage(url, { timeoutMs: 15, resolve: publicDns, fetch: () => late.promise });
 try { await assert.rejects(() => settles(pending), /timed out/); }
 finally { let stream!: ReadableStreamDefaultController<Uint8Array>; late.resolve(new Response(new ReadableStream<Uint8Array>({ start(value) { stream = value; value.enqueue(png); }, cancel() { cancelled = true; } }))); setTimeout(() => { try { stream.close(); } catch {} }, 0); await pending.catch(() => {}); }
 await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(cancelled);
});

test('停顿流在外部取消后及时退出，并取消正文及释放reader锁', async () => {
 let cancelled = false; let controller!: ReadableStreamDefaultController<Uint8Array>;
 const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(png); }, cancel() { cancelled = true; } });
 const stop = new AbortController(); const pending = fetchRemoteImage(url, { timeoutMs: 1000, signal: stop.signal, resolve: publicDns, fetch: async () => new Response(body) });
 const timer = setTimeout(() => stop.abort(new Error('synthetic cancellation')), 15);
 try { await assert.rejects(() => settles(pending), /synthetic cancellation/); }
 finally { clearTimeout(timer); try { controller.close(); } catch {} await pending.catch(() => {}); }
 assert.ok(cancelled); assert.equal(body.locked, false);
});

test('重定向取消正文永不settle也不能挂住下载门', async () => {
 const cancel = deferred<void>(); let calls = 0;
 const pending = fetchRemoteImage(url, { timeoutMs: 30, resolve: publicDns, fetch: async () => ++calls === 1
  ? new Response(new ReadableStream({ cancel: () => cancel.promise }), { status: 302, headers: { location: '/next' } }) : new Response(png) });
 try { assert.equal((await settles(pending) as { type: string }).type, 'image/png'); }
 finally { cancel.resolve(); await pending.catch(() => {}); }
});

test('超额流取消永不settle也及时失败并释放reader锁', async () => {
 const cancel = deferred<void>(); const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png); }, cancel: () => cancel.promise });
 const pending = fetchRemoteImage(url, { timeoutMs: 30, maxBytes: 8, resolve: publicDns, fetch: async () => new Response(body) });
 try { await assert.rejects(() => settles(pending), /exceeds/); }
 finally { cancel.resolve(); await pending.catch(() => {}); }
 assert.equal(body.locked, false);
});

test('排队时间计入单次截止，过期排队请求不执行', async () => {
 const dns = deferred<readonly { address: string; family: number }[]>(); let ready = 0; const entered = deferred<void>();
 const blockers = Array.from({ length: 3 }, () => fetchRemoteImage(url, { timeoutMs: 1000, resolve: async () => { if (++ready === 3) entered.resolve(); return dns.promise; }, fetch: healthy }));
 await entered.promise; let fetched = false;
 const pending = fetchRemoteImage(url, { timeoutMs: 15, resolve: publicDns, fetch: async () => { fetched = true; return new Response(png); } });
 try { await assert.rejects(() => settles(pending), /timed out/); }
 finally { dns.resolve([{ address: '93.184.216.34', family: 4 }]); await Promise.all(blockers); await pending.catch(() => {}); }
 assert.equal(fetched, false);
});

test('非法限额在DNS和网络之前拒绝，NaN不能取消流大小约束', async () => {
 let called = false;
 for (const options of [{ maxBytes: NaN }, { maxBytes: Infinity }, { maxBytes: 0 }, { maxBytes: 1.5 }, { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 0 }, { timeoutMs: 2147483648 }, { maxRedirects: NaN }, { maxRedirects: -1 }, { maxRedirects: 1.5 }]) {
  await assert.rejects(() => fetchRemoteImage(url, { ...options, resolve: async () => { called = true; return publicDns('synthetic.example'); }, fetch: healthy }), /invalid/);
 }
 assert.equal(called, false);
});

test('data URL在base64分配前拒绝超额输入并校验限额', () => {
 const data = 'data:image/png;base64,' + Buffer.from(png).toString('base64');
 for (const limit of [NaN, Infinity, 0, 1.5]) assert.throws(() => validateImageDataUrl(data, limit), /invalid/);
 const original = Buffer.from; let decoded = false;
 Buffer.from = ((value: unknown, ...args: unknown[]) => { if (typeof value === 'string' && args[0] === 'base64') decoded = true; return (original as Function)(value, ...args); }) as typeof original;
 try { assert.throws(() => validateImageDataUrl(data, 8), /too large/); assert.equal(decoded, false); }
 finally { Buffer.from = original; }
 assert.equal(validateImageDataUrl(data, 9), data);
});

test('拒绝本地NAT64和新增非公网IPv6用途前缀，每跳DNS重新校验', async () => {
 let fetched = 0;
 for (const address of ['64:ff9b:1::7f00:1', '100:0:0:1::1', '2001:2::1', '3fff::1', '5f00::1', 'fec0::1', '0:0:0:0:0:ffff:5db8:d822']) {
  await assert.rejects(() => fetchRemoteImage(url, { resolve: async () => [{ address, family: 6 }], fetch: async () => { fetched++; return new Response(png); } }), /non-public/);
 }
 assert.equal(fetched, 0);
 let resolutions = 0;
 await assert.rejects(() => fetchRemoteImage(url, { resolve: async () => ++resolutions === 1 ? publicDns('synthetic.example') : [{ address: '10.0.0.1', family: 4 }], fetch: async () => new Response(null, { status: 302, headers: { location: '/next' } }) }), /non-public/);
 assert.equal(resolutions, 2);
});


test('三个无响应DNS超时后释放所有并发槽，后续请求无需等旧DNS恢复', async () => {
 const dns = deferred<readonly { address: string; family: number }[]>();
 const stalled = Array.from({ length: 3 }, () => fetchRemoteImage(url, { timeoutMs: 15, resolve: () => dns.promise, fetch: healthy }));
 try {
  const results = await settles(Promise.allSettled(stalled)) as PromiseSettledResult<unknown>[];
  assert.ok(results.every(result => result.status === 'rejected' && /timed out/.test(String(result.reason))));
  assert.equal((await settles(fetchRemoteImage(url, { timeoutMs: 50, resolve: publicDns, fetch: healthy })) as { type: string }).type, 'image/png');
 } finally { dns.resolve([{ address: '93.184.216.34', family: 4 }]); await Promise.allSettled(stalled); }
});

test('成功读取和流错误均释放reader锁，错误流不会产生伪图片', async () => {
 const success = new Response(png); await fetchRemoteImage(url, { resolve: publicDns, fetch: async () => success });
 assert.equal(success.body!.locked, false);
 const failure = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png); controller.error(new Error('synthetic read failure')); } });
 await assert.rejects(() => fetchRemoteImage(url, { resolve: publicDns, fetch: async () => new Response(failure) }), /synthetic read failure/);
 assert.equal(failure.locked, false);
});

test('预先取消不会开始DNS和fetch，合法零次跳转仍允许直达图片', async () => {
 const stop = new AbortController(); stop.abort(new Error('synthetic early cancellation')); let called = false;
 await assert.rejects(() => fetchRemoteImage(url, { signal: stop.signal, resolve: async () => { called = true; return publicDns('synthetic.example'); }, fetch: healthy }), /synthetic early cancellation/);
 assert.equal(called, false);
 assert.equal((await fetchRemoteImage(url, { maxRedirects: 0, resolve: publicDns, fetch: healthy })).type, 'image/png');
});


test('IETF协议专用2001::/23默认拒绝，例外不能扩大为邻接地址或整个子网', async () => {
 let fetched = 0;
 for (const address of ['2001:5::1', '2001:1::4', '2001:1::ffff', '2001:4:111::1', '2001:4:113::1', '2001:1ff::1']) {
  await assert.rejects(() => fetchRemoteImage(url, { resolve: async () => [{ address, family: 6 }], fetch: async () => { fetched++; return new Response(png); } }), /non-public/);
  await assert.rejects(() => fetchRemoteImage('http://[' + address + ']/image', { fetch: healthy }), /local|private/);
 }
 assert.equal(fetched, 0);
});

test('IETF协议专用范围更具体的全球可达例外允许，混入默认拒绝地址仍整体拒绝', async () => {
 for (const address of ['2001:1::1', '2001:1::2', '2001:1::3', '2001:3::1', '2001:4:112::1', '2001:20::1', '2001:2f:ffff::1', '2001:30::1', '2001:3f:ffff::1']) {
  const resolve: HostResolver = async () => [{ address, family: 6 }];
  assert.equal((await fetchRemoteImage(url, { resolve, fetch: healthy })).type, 'image/png');
  assert.equal((await fetchRemoteImage('http://[' + address + ']/image', { fetch: healthy })).type, 'image/png');
 }
 await assert.rejects(() => fetchRemoteImage(url, { resolve: async () => [{ address: '2001:3::1', family: 6 }, { address: '2001:5::1', family: 6 }], fetch: healthy }), /non-public/);
});
