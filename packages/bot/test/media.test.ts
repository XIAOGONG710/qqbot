import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
    imageLine, isSticker, listenMs, LISTEN_DEFAULT_MS, mediaReading, needsReading, OCR_MAX_CHARS, OCR_MAX_IMAGES, ocrLines, parseVoiceLine,
    readMedia, voiceLine, voiceSeconds, type MediaReader,
} from '../src/vision/media.ts';
import { segmentsToText, type Segment } from '../src/platform/onebot.ts';

const dir = mkdtempSync(join(tmpdir(), 'qqbot-media-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** QQ 的 SILK：[0x02]「#!SILK_V3」，每块 2 字节小端长度 + 内容，一块 20 毫秒 */
function silk(frames: number): Buffer {
    const parts = [Buffer.from([0x02]), Buffer.from('#!SILK_V3')];
    for (let i = 0; i < frames; i++) {
        const size = 40 + (i % 7);
        const head = Buffer.alloc(2);
        head.writeInt16LE(size);
        parts.push(head, Buffer.alloc(size, i % 251));
    }
    return Buffer.concat(parts);
}
/** AMR-NB：「#!AMR\n」，12.2k 模式每帧 1 字节帧头 + 31 字节 */
function amr(frames: number): Buffer {
    return Buffer.concat([Buffer.from('#!AMR\n'), ...Array.from({ length: frames }, () => Buffer.concat([Buffer.from([0x3c]), Buffer.alloc(31)]))]);
}

const voice = (path?: string): Segment[] => [{ type: 'record', data: { file: 'abc.amr', file_size: '3000', ...(path ? { path } : {}) } }];
const photo = (url = 'https://example.invalid/a.jpg', extra: Record<string, unknown> = {}): Segment => ({ type: 'image', data: { file: 'a.jpg', url, sub_type: 0, summary: '', ...extra } });
const hang = <T>() => new Promise<T>(() => {});

/** 假 NapCat：按消息 id 给转写结果，按 URL 给 OCR 结果；记下调了几次 */
function napcat(voices: Record<number, string | Error | 'hang'> = {}, ocr: Record<string, string[] | Error | 'hang'> = {}) {
    const calls = { voice: [] as number[], ocr: [] as string[] };
    const reader: MediaReader = {
        voiceToText: async id => {
            calls.voice.push(id);
            const result = voices[id];
            if (result === 'hang') return hang();
            if (result instanceof Error) throw result;
            if (result === undefined) throw new Error('消息不存在');
            return result;
        },
        ocr: async url => {
            calls.ocr.push(url);
            const result = ocr[url];
            if (result === 'hang') return hang();
            if (result instanceof Error) throw result;
            return result ?? [];
        },
    };
    return { reader, calls };
}

const read = async (message: Segment[], reader: MediaReader, extra: Partial<Parameters<typeof readMedia>[2]> = {}) => {
    const logs: string[] = [];
    const text = segmentsToText(await readMedia(message, 7, { reader, timeouts: { voice: 100, ocr: 100, vision: 100 }, ...extra }, m => logs.push(m)));
    return { text, logs };
};

describe('听语音、看图（ADR 0052）：写法', () => {
    test('语音、图片的一行；方括号和换行去掉', () => {
        assert.equal(voiceLine({ seconds: 8, text: '今天好累' }), '[语音 8秒：今天好累]');
        assert.equal(voiceLine({ text: '今天好累' }), '[语音：今天好累]');
        assert.equal(voiceLine({ seconds: 8 }), '[语音 8秒]');
        assert.equal(voiceLine({}), '[语音]');
        assert.equal(imageLine({}), '[图片]');
        assert.equal(imageLine({ ocr: '期中考试安排' }), '[图片，上面写着：期中考试安排]');
        assert.equal(imageLine({ description: '一只橘猫趴在窗台上' }), '[图片：一只橘猫趴在窗台上]');
        assert.equal(imageLine({ description: '一张课表', ocr: '高数' }), '[图片：一张课表；上面写着：高数]');
    });

    test('从聊天记录里认出语音：几秒、转出来的字；听多久', () => {
        assert.deepEqual(parseVoiceLine('[语音 8秒：今天好累]'), { seconds: 8, text: '今天好累' });
        assert.deepEqual(parseVoiceLine('[语音]'), {});
        assert.deepEqual(parseVoiceLine('[语音 12秒]'), { seconds: 12 });
        assert.equal(parseVoiceLine('[图片]'), undefined);
        assert.equal(parseVoiceLine('我刚发了[语音]'), undefined);
        assert.equal(listenMs('[语音 8秒：今天好累]'), 8000);
        assert.equal(listenMs('[语音：今天食堂人好多我排了二十分钟]'), 14 * 250, '只知道字：每秒 4 个字');
        assert.equal(listenMs('[语音：嗯]'), 2000, '最少 2 秒');
        assert.equal(listenMs('[语音]'), LISTEN_DEFAULT_MS);
        assert.equal(listenMs('[语音 90秒]'), 60_000, '最多 60 秒');
        assert.equal(listenMs('好的'), 0);
    });

    test('表情包：sub_type 不是 0 或者 summary 是名字；照片、截图要看', () => {
        assert.equal(isSticker({ sub_type: 1, summary: '[动画表情]' }), true);
        assert.equal(isSticker({ sub_type: 0, summary: '[是的]' }), true);
        assert.equal(isSticker({ sub_type: 0, summary: '' }), false);
        assert.equal(isSticker({ summary: '[图片]' }), false);
        assert.equal(needsReading([{ type: 'text', data: { text: '在吗' } }]), false);
        assert.equal(needsReading([{ type: 'image', data: { sub_type: 1, summary: '[动画表情]' } }]), false);
        assert.equal(needsReading([photo()]), true);
        assert.equal(needsReading(voice()), true);
        assert.equal(needsReading('纯文本'), false);
    });

    test('NapCat ocr_image 的返回：实测的数组、示例里的 { texts }，都认；空的、不是字的跳过', () => {
        assert.deepEqual(ocrLines([{ text: '期中考试安排', pt1: { x: '22', y: '24' }, charBox: [], score: '' }, { text: ' 地点：知行楼301 ' }, { text: '' }]), ['期中考试安排', '地点：知行楼301']);
        assert.deepEqual(ocrLines({ texts: [{ text: '识别内容', coordinates: [] }] }), ['识别内容']);
        assert.deepEqual(ocrLines(null), []);
        assert.deepEqual(ocrLines('oops'), []);
    });

    test('语音文件几秒：SILK、AMR 数帧（一帧 20 毫秒）；认不出来的没有', () => {
        assert.equal(voiceSeconds(silk(400)), 8);
        assert.equal(voiceSeconds(silk(10)), 1, '不到 1 秒算 1 秒');
        assert.equal(voiceSeconds(silk(400).subarray(1)), 8, '没有开头 0x02 的标准 SILK');
        const partial = voiceSeconds(silk(400).subarray(0, 3000));
        assert.ok(partial !== undefined && partial < 8, '写了一半的文件按写好的算，不抛错');
        assert.equal(voiceSeconds(amr(250)), 5);
        assert.equal(voiceSeconds(Buffer.from('ID3 mp3 data')), undefined);
        assert.equal(voiceSeconds(Buffer.alloc(0)), undefined);
    });
});

describe('听语音、看图（ADR 0052）：读消息（假 NapCat）', () => {
    test('语音转出来了：秒数从本地文件数，字进那一行', async () => {
        const path = join(dir, 'ok.silk');
        writeFileSync(path, silk(400));
        const { reader, calls } = napcat({ 7: '今天食堂\n人超多[笑]' });
        const { text, logs } = await read(voice(path), reader);
        assert.equal(text, '[语音 8秒：今天食堂 人超多【笑】]');
        assert.deepEqual(calls.voice, [7]);
        assert.match(logs[0]!, /^听语音：转出 \d+ 个字，8 秒（\d+\.\d 秒）$/);
    });

    test('转不出来、超时：有秒数写秒数，没有就是老样子「[语音]」，不卡住', async () => {
        const path = join(dir, 'fail.silk');
        writeFileSync(path, silk(150));
        assert.equal((await read(voice(path), napcat({ 7: new Error('获取语音转文字结果失败') }).reader)).text, '[语音 3秒]');
        const started = Date.now();
        const timedOut = await read(voice(), napcat({ 7: 'hang' }).reader);
        assert.equal(timedOut.text, '[语音]');
        assert.ok(Date.now() - started < 1000);
        assert.deepEqual(timedOut.logs, ['听语音：没转出来（超时 0.1 秒）']);
        assert.equal((await read(voice(join(dir, 'missing.silk')), napcat({ 7: '' }).reader)).text, '[语音]', '文件不在、转出来是空的');
    });

    test('截图有字：「[图片，上面写着：……]」，太长截断；没字、超时（没字的图 NapCat 不回）、出错：「[图片]」', async () => {
        const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}行复习提纲的内容`);
        const { reader } = napcat({}, {
            'https://x/shot.png': ['期中考试安排', '高等数学11月12日上午9:00'],
            'https://x/long.png': long,
            'https://x/blank.jpg': 'hang',
            'https://x/noise.jpg': ['1'],
            'https://x/bad.jpg': new Error('下载文件失败: Not Found'),
        });
        assert.equal((await read([photo('https://x/shot.png')], reader)).text, '[图片，上面写着：期中考试安排 高等数学11月12日上午9:00]');
        const cut = (await read([photo('https://x/long.png')], reader)).text;
        assert.ok(cut.endsWith('…]'), cut);
        assert.equal([...cut].length, '[图片，上面写着：'.length + OCR_MAX_CHARS + 2);
        const blank = await read([photo('https://x/blank.jpg')], reader);
        assert.equal(blank.text, '[图片]');
        assert.deepEqual(blank.logs, ['看图：没认出字（超时 0.1 秒）']);
        assert.equal((await read([photo('https://x/noise.jpg')], reader)).text, '[图片]', '照片里零星一个字符不算有字');
        assert.equal((await read([photo('https://x/bad.jpg')], reader)).text, '[图片]');
        assert.equal((await read([photo('')], reader)).text, '[图片]', '没有 URL 不看');
    });

    test('表情包不跑 OCR，照旧用名字；文字和图在一条里照常拼', async () => {
        const { reader, calls } = napcat({}, { 'https://x/a.jpg': ['好的'] });
        const sticker: Segment = { type: 'image', data: { url: 'https://x/a.jpg', sub_type: 1, summary: '[动画表情]' } };
        assert.equal((await read([sticker], reader)).text, '[动画表情]');
        assert.deepEqual(calls.ocr, []);
        assert.equal((await read([{ type: 'text', data: { text: '你看' } }, photo('https://x/a.jpg')], reader)).text, '你看[图片，上面写着：好的]');
    });

    test(`一条里最多看 ${OCR_MAX_IMAGES} 张`, async () => {
        const { reader, calls } = napcat();
        const text = (await read(Array.from({ length: 5 }, (_, i) => photo(`https://x/${i}.jpg`)), reader)).text;
        assert.equal(text, '[图片]'.repeat(5));
        assert.equal(calls.ocr.length, OCR_MAX_IMAGES);
    });

    test('看图（vision）：配了才看，描述和图上的字都写；看不出来退回只有字', async () => {
        const { reader } = napcat({}, { 'https://x/a.jpg': ['麻辣香锅18元'] });
        const seen: string[] = [];
        const vision = { describe: async ({ url }: { url: string }) => { seen.push(url); return '食堂的一份麻辣香锅'; } };
        assert.equal((await read([photo('https://x/a.jpg')], reader, { vision })).text, '[图片：食堂的一份麻辣香锅；上面写着：麻辣香锅18元]');
        assert.deepEqual(seen, ['https://x/a.jpg']);
        const broken = { describe: () => hang<string>() };
        assert.equal((await read([photo('https://x/a.jpg')], reader, { vision: broken })).text, '[图片，上面写着：麻辣香锅18元]');
    });

    test('同一条正在读：共用一次调用；读完放掉；没有 reader 不读', async () => {
        let release!: (text: string) => void;
        let count = 0;
        const reader: MediaReader = { voiceToText: () => { count++; return new Promise(resolve => { release = resolve; }); } };
        const reading = mediaReading({ reader });
        const first = reading.read(voice(), 9, () => {});
        const second = reading.read(voice(), 9, () => {});
        await new Promise(r => setTimeout(r, 10));
        release('在吗');
        assert.equal(segmentsToText(await first), '[语音：在吗]');
        assert.equal(await second, await first);
        assert.equal(count, 1);
        assert.equal(reading.needs(voice()), true);
        assert.equal(mediaReading({}).needs(voice()), false);
        assert.deepEqual(await mediaReading({}).read(voice(), 9, () => {}), voice());
    });

    test('跨联系人的 OCR 也受全局并发上限约束，排队项不会提前启动', async () => {
        let calls = 0;
        let active = 0;
        let peak = 0;
        const releases: (() => void)[] = [];
        const reader: MediaReader = {
            ocr: () => new Promise<string[]>(resolve => {
                calls++;
                active++;
                peak = Math.max(peak, active);
                releases.push(() => { active--; resolve([]); });
            }),
        };
        const tasks = [1, 2, 3].map(id => readMedia([photo(`https://x/${id}.jpg`)], id, { reader, timeouts: { ocr: 1000 } }, () => {}));
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(calls, 2);
        assert.equal(peak, 2);
        releases.shift()!();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(calls, 3);
        for (const release of releases.splice(0)) release();
        await Promise.all(tasks);
    });

    test('停止 mediaReading 会把取消信号传给正在执行的适配器', async () => {
        let aborted = false;
        const reader: MediaReader = {
            voiceToText: (_id, signal) => new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
            }),
        };
        const reading = mediaReading({ reader, timeouts: { voice: 1000 } });
        const task = reading.read(voice(), 10, () => {});
        await new Promise(resolve => setTimeout(resolve, 10));
        reading.stop();
        assert.equal(segmentsToText(await task), '[语音]');
        assert.equal(aborted, true);
    });
});
