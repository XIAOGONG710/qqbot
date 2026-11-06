import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { voiceSeconds, readMedia, mediaReading, type MediaReader, type ImageDescriber } from '../src/vision/media.ts';
import { segmentsToText, type Segment } from '../src/platform/onebot.ts';

const photo: Segment[] = [{ type: 'image', data: { url: 'https://synthetic.invalid/image' } }];
const voice: Segment[] = [{ type: 'record', data: {} }];
const hang = <T>() => new Promise<T>(() => {});
async function bounded(task: Promise<Segment[] | string>): Promise<string> {
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([task, new Promise<string>(resolve => { timer = setTimeout(() => resolve('HUNG'), 100); })]);
    clearTimeout(timer!);
    return segmentsToText(result);
}

test('提前取消与停止后的读取不启动看图调用，也不因错过abort事件永久等待', async () => {
    let calls = 0;
    const sources = { vision: { describe: () => { calls++; return hang<string>(); } }, timeouts: { vision: 10 } };
    const controller = new AbortController(); controller.abort();
    assert.equal(await bounded(readMedia(photo, 1, sources, () => {}, controller.signal)), '[图片]');
    const reading = mediaReading(sources); reading.stop();
    assert.equal(await bounded(reading.read(photo, 2, () => {})), '[图片]');
    assert.equal(calls, 0);
});

test('适配器同步触发取消时仍能收尾', async () => {
    const controller = new AbortController();
    const task = readMedia(photo, 3, { vision: { describe: () => { controller.abort(); return hang<string>(); } }, timeouts: { vision: 10 } }, () => {}, controller.signal);
    assert.equal(await bounded(task), '[图片]');
});

test('失败日志不回显语音/OCR/看图服务抛出的私密正文或URL', async () => {
    const marker = 'PRIVATE_MEDIA_MARKER'; const logs: string[] = [];
    const failed = async (): Promise<never> => { throw new Error(marker); };
    await readMedia([...voice, ...photo], 4, { reader: { voiceToText: failed, ocr: failed }, vision: { describe: failed } }, message => logs.push(message));
    assert.ok(logs.length > 0);
    assert.ok(logs.every(message => !message.includes(marker)));
});

test('畸形转写/描述不被String强转为真实事实，OCR只保留字符串行', async () => {
    const reader = { voiceToText: async () => ({ secret: 'not transcription' }), ocr: async () => [{ text: 'not a line' }, '合成文字'] } as unknown as MediaReader;
    const vision = { describe: async () => ({ secret: 'not a description' }) } as unknown as ImageDescriber;
    assert.equal(segmentsToText(await readMedia([...voice, ...photo], 5, { reader, vision }, () => {})), '[语音][图片，上面写着：合成文字]');
});


test('AMR-NB保留帧类型不伪造时长，合法NO_DATA帧仍算入时间', () => {
 for (const ft of [9, 10, 11, 12, 13, 14]) assert.equal(voiceSeconds(Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(100, ft << 3)])), undefined);
 assert.equal(voiceSeconds(Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(100, 15 << 3)])), 2);
 assert.equal(voiceSeconds(Buffer.concat([Buffer.from([0x41]), Buffer.from('#!SILK_V3'), Buffer.from([1, 0, 1])])), undefined, 'SILK前缀只有可选0x02');
});

test('超额本地音频仅省略秒数，转写照常；目录不是可读音频', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-media-bound-'));
 try {
  const oversized = Buffer.alloc(3 * 1024 * 1024, 15 << 3); Buffer.from('#!AMR\n').copy(oversized);
  assert.equal(voiceSeconds(oversized), undefined);
  const path = join(dir, 'large.amr'); writeFileSync(path, oversized);
  for (const audioPath of [path, dir]) assert.equal(segmentsToText(await readMedia([{ type: 'record', data: { path: audioPath } }], 101, { reader: { voiceToText: async () => '合成转写' } }, () => {})), '[语音：合成转写]');
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('本地元数据读取有限且文件增长不绕过上限，句柄始终关闭', async () => {
 const original = fsPromises.open; let reads = 0; let closed = 0;
 const fake = { stat: async () => ({ isFile: () => true, size: 6 }), close: async () => { closed++; },
  read: async (buffer: Uint8Array, offset: number, length: number) => { reads += length; assert.ok(length <= 7); buffer.set(Buffer.from('#!AMR\n' + 'x').subarray(0, length), offset); return { bytesRead: length, buffer }; } };
 fsPromises.open = (async () => fake) as unknown as typeof original; syncBuiltinESMExports();
 try {
  const result = await readMedia([{ type: 'record', data: { path: 'synthetic-growing.amr' } }], 102, { reader: { voiceToText: async () => '合成转写' } }, () => {});
  assert.equal(segmentsToText(result), '[语音：合成转写]'); assert.ok(reads > 0 && reads <= 7); assert.equal(closed, 1);
 } finally { fsPromises.open = original; syncBuiltinESMExports(); }
});


test('成功和错误收尾均移除within的abort监听器', async () => {
 const added = new Set<unknown>(); const originalAdd = AbortSignal.prototype.addEventListener; const originalRemove = AbortSignal.prototype.removeEventListener;
 const add = mock.method(AbortSignal.prototype, 'addEventListener', function(this: AbortSignal, ...args: Parameters<AbortSignal['addEventListener']>) { if (args[0] === 'abort') added.add(args[1]); return originalAdd.apply(this, args); });
 const remove = mock.method(AbortSignal.prototype, 'removeEventListener', function(this: AbortSignal, ...args: Parameters<AbortSignal['removeEventListener']>) { if (args[0] === 'abort') added.delete(args[1]); return originalRemove.apply(this, args); });
 try {
  for (const describe of [async () => '合成描述', async (): Promise<string> => { throw new Error('synthetic'); }]) await readMedia(photo, 110, { vision: { describe } }, () => {});
  assert.equal(added.size, 0);
 } finally { add.mock.restore(); remove.mock.restore(); }
});

test('取消后才打开的本地文件仍关闭，不继续stat读取', async () => {
 const original = fsPromises.open; let release!: (value: unknown) => void; let closed = 0; let statted = false;
 fsPromises.open = (() => new Promise(resolve => { release = resolve; })) as unknown as typeof original; syncBuiltinESMExports();
 try {
  const result = await bounded(readMedia([{ type: 'record', data: { path: 'synthetic-delayed.amr' } }], 111, { timeouts: { voice: 10 }, reader: { voiceToText: async () => '合成转写' } }, () => {}));
  assert.equal(result, '[语音：合成转写]');
  release({ close: async () => { closed++; }, stat: async () => { statted = true; throw new Error('unexpected stat'); } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1); assert.equal(statted, false);
 } finally { fsPromises.open = original; syncBuiltinESMExports(); }
});

test('本地读取中取消会主动关闭句柄，迟到读结果不再继续读取', async () => {
 const original = fsPromises.open; let release!: (value: unknown) => void; let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }); let closed = 0; let reads = 0;
 const fake = { stat: async () => ({ isFile: () => true, size: 8 }), close: async () => { closed++; }, read: () => { reads++; entered(); return new Promise(resolve => { release = resolve; }); } };
 fsPromises.open = (async () => fake) as unknown as typeof original; syncBuiltinESMExports();
 const stop = new AbortController(); const task = readMedia([{ type: 'record', data: { path: 'synthetic-paused.amr' } }], 112, { timeouts: { voice: 500 }, reader: { voiceToText: async () => '合成转写' } }, () => {}, stop.signal);
 try {
  await ready; await new Promise(resolve => setImmediate(resolve)); stop.abort(new Error('PRIVATE_CANCEL_REASON')); assert.equal(await bounded(task), '[语音：合成转写]'); assert.equal(closed, 1);
  release({ bytesRead: 0 }); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1); assert.equal(closed, 1);
 } finally { fsPromises.open = original; syncBuiltinESMExports(); }
});
