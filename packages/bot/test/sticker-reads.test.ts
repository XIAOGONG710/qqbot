import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { inspectReply } from '../src/language/exit-check.ts';
import { hasReadSticker, isReaction, moodySkip, pendingMessages } from '../src/social/reply-timing.ts';
import { stickerCued } from '../src/social/stickers.ts';
import { mediaReading, needsReading, readMedia, type ImageDescriber } from '../src/vision/media.ts';
import { stickerIsNameless, stickerKey, stickerLine, stickerReads } from '../src/vision/sticker-reads.ts';
import { segmentsToText, type Segment } from '../src/platform/onebot.ts';

const dir = mkdtempSync(join(tmpdir(), 'qqbot-sticker-reads-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const sticker = (file = 'A1B2C3D4E5F6A7B8.gif', extra: Record<string, unknown> = {}): Segment => ({
    type: 'image', data: { file, url: `https://example.invalid/${file}?rkey=abc`, sub_type: 1, summary: '[动画表情]', ...extra },
});
const photo: Segment = { type: 'image', data: { file: 'photo.jpg', url: 'https://example.invalid/photo.jpg', sub_type: 0, summary: '' } };
const MODEL_REPLY = '文字：理理我｜画面：一只橘猫委屈地趴在地上，眼睛水汪汪';
const describer = (answers: Array<string | Error>) => {
    const calls: string[] = [];
    const vision: ImageDescriber = {
        describe: async image => {
            calls.push(image.url);
            const next = answers.shift() ?? MODEL_REPLY;
            if (next instanceof Error) throw next;
            return next;
        },
    };
    return { vision, calls };
};
const run = async (message: Segment[], sources: Parameters<typeof readMedia>[2]) => {
    const logs: string[] = [];
    const text = segmentsToText(await readMedia(message, 1, { timeouts: { voice: 100, ocr: 100, vision: 100 }, ...sources }, line => logs.push(line)));
    return { text, logs };
};

describe('看懂他发的表情包（ADR 0206）：写法和缓存', () => {
    test('看图模型的「文字：…｜画面：…」变成聊天记录里的一行；没字就只写画面；认不出格式整句当画面', () => {
        assert.equal(stickerLine(MODEL_REPLY), '[动画表情：上面写着「理理我」；一只橘猫委屈地趴在地上，眼睛水汪汪]');
        assert.equal(stickerLine('文字：无｜画面：一只狗在笑'), '[动画表情：一只狗在笑]');
        assert.equal(stickerLine('文字：没有｜画面：一只狗在笑'), '[动画表情：一只狗在笑]');
        assert.equal(stickerLine('一只狗在笑'), '[动画表情：一只狗在笑]');
        assert.equal(stickerLine('文字：「晚安」｜画面：月亮'), '[动画表情：上面写着「晚安」；月亮]');
        assert.equal(stickerLine(''), undefined);
        assert.equal(stickerLine('   \n  '), undefined);
    });

    test('方括号、换行去掉，太长截断；不会提前把这一行的括号闭合', () => {
        const line = stickerLine('文字：[救命]\n我不行了｜画面：' + '很'.repeat(80))!;
        assert.equal(line.startsWith('[动画表情：'), true);
        assert.equal(line.endsWith(']'), true);
        assert.equal(line.slice(1, -1).includes('['), false);
        assert.equal(line.slice(1, -1).includes(']'), false);
        assert.equal(line.includes('\n'), false);
        assert.ok([...line].length <= '[动画表情：上面写着「」；]'.length + 30 + 50 + 4, `太长：${[...line].length}`);
    });

    test('只读没有名字的图片表情；商城表情自带名字（「[是的]」）不读', () => {
        assert.equal(stickerIsNameless({ summary: '[动画表情]' }), true);
        assert.equal(stickerIsNameless({ summary: '' }), true);
        assert.equal(stickerIsNameless({ summary: '[表情]' }), true);
        assert.equal(stickerIsNameless({ summary: '[是的]' }), false);
        assert.equal(stickerIsNameless({ summary: '[捂脸]' }), false);
    });

    test('同一张图的编号稳定：不随带时效的查询串变；file 太短退回 URL', () => {
        const a = stickerKey({ file: 'A1B2C3D4E5F6A7B8.gif', url: 'https://x.invalid/a?rkey=1' });
        const b = stickerKey({ file: 'A1B2C3D4E5F6A7B8.gif', url: 'https://x.invalid/a?rkey=2' });
        const c = stickerKey({ file: 'FFFFFFFFFFFFFFFF.gif', url: 'https://x.invalid/a?rkey=1' });
        assert.equal(a, b);
        assert.notEqual(a, c);
        assert.equal(stickerKey({ file: 'a.jpg', url: 'https://x.invalid/p?rkey=1' }), stickerKey({ file: 'b.jpg', url: 'https://x.invalid/p?rkey=2' }));
        assert.equal(stickerKey({}), undefined);
    });

    test('缓存：存、取、落盘后重启还在；超过上限丢最久没见的；坏文件从空的开始', () => {
        const file = join(dir, 'cache', 'read-cache.json');
        const first = stickerReads(file, 3);
        const data = (n: number) => ({ file: `FILE-${String(n).padStart(12, '0')}.gif` });
        for (let n = 1; n <= 3; n++) first.set(data(n), `[动画表情：第 ${n} 张]`);
        assert.equal(first.get(data(1)), '[动画表情：第 1 张]'); // 取一次 = 刚见过
        first.set(data(4), '[动画表情：第 4 张]'); // 丢最久没见的：第 2 张
        assert.equal(first.get(data(2)), undefined);
        assert.equal(first.get(data(1)), '[动画表情：第 1 张]');
        const again = stickerReads(file, 3);
        assert.equal(again.get(data(4)), '[动画表情：第 4 张]');
        assert.equal(again.get(data(2)), undefined);
        writeFileSync(file, '{坏了');
        assert.equal(stickerReads(file).get(data(1)), undefined);
        // 不是我们写的东西不收
        writeFileSync(file, JSON.stringify({ [stickerKey(data(9))!]: '随便什么' }));
        assert.equal(stickerReads(file).get(data(9)), undefined);
    });

    test('没给文件就只在内存里，不落盘', () => {
        const memory = stickerReads();
        memory.set({ file: 'FILE-000000000001.gif' }, '[动画表情：好]');
        assert.equal(memory.get({ file: 'FILE-000000000001.gif' }), '[动画表情：好]');
        assert.equal(existsSync(join(dir, 'undefined')), false);
    });
});

describe('看懂他发的表情包（ADR 0206）：读的那一步', () => {
    test('开着：没有名字的图片表情换成「[动画表情：……]」，混在文字里的话原样', async () => {
        const { vision, calls } = describer([MODEL_REPLY]);
        const r = await run([{ type: 'text', data: { text: '好嘛 ' } }, sticker()], { stickerVision: vision });
        assert.equal(r.text, '好嘛 [动画表情：上面写着「理理我」；一只橘猫委屈地趴在地上，眼睛水汪汪]');
        assert.equal(calls.length, 1);
        assert.match(r.logs.join('\n'), /看表情包：读出 \d+ 个字/);
        assert.equal(r.logs.join('\n').includes('橘猫'), false, '日志不写图上是什么');
    });

    test('没开（不给 stickerVision）：照旧「[动画表情]」，一次调用都没有', async () => {
        const { vision, calls } = describer([]);
        const r = await run([sticker()], { vision });
        assert.equal(r.text, '[动画表情]');
        assert.equal(calls.length, 0);
        assert.equal(needsReading([sticker()]), false);
        assert.equal(needsReading([sticker()], true), true);
    });

    test('商城表情（有名字）不读；普通照片还是走原来的路', async () => {
        const { vision, calls } = describer([]);
        const named = sticker('NAMED000000000000.png', { summary: '[是的]' });
        const r = await run([named], { stickerVision: vision });
        assert.equal(r.text, '[是的]');
        assert.equal(calls.length, 0);
        assert.equal(needsReading([named], true), false);
        assert.equal(needsReading([photo], true), true);
    });

    test('同一张只读一次：第二次用缓存（模型一次也不调）', async () => {
        const { vision, calls } = describer([MODEL_REPLY]);
        const reads = stickerReads();
        const sources = { stickerVision: vision, stickerReads: reads };
        const first = await run([sticker()], sources);
        const second = await run([sticker('A1B2C3D4E5F6A7B8.gif', { url: 'https://example.invalid/A1B2C3D4E5F6A7B8.gif?rkey=zzz' })], sources);
        assert.equal(first.text, second.text);
        assert.equal(calls.length, 1);
        assert.match(second.logs.join('\n'), /见过这张/);
    });

    test('读不出来（超时 / 出错 / 空）：照旧「[动画表情]」，没读出来的不进缓存', async () => {
        const reads = stickerReads();
        for (const answer of [new Error('接口 500'), '', 'hang' as const]) {
            const calls: string[] = [];
            const vision: ImageDescriber = {
                describe: async image => {
                    calls.push(image.url);
                    if (answer === 'hang') return new Promise<string>(() => {});
                    if (answer instanceof Error) throw answer;
                    return answer;
                },
            };
            const r = await run([sticker()], { stickerVision: vision, stickerReads: reads });
            assert.equal(r.text, '[动画表情]', String(answer));
            assert.equal(calls.length, 1);
        }
        assert.equal(reads.get({ file: 'A1B2C3D4E5F6A7B8.gif' }), undefined);
    });

    test('一条消息里最多读两张；第三张照旧', async () => {
        const { vision, calls } = describer([]);
        const r = await run([sticker('AAAAAAAAAAAAAAAA.gif'), sticker('BBBBBBBBBBBBBBBB.gif'), sticker('CCCCCCCCCCCCCCCC.gif')], { stickerVision: vision });
        assert.equal(calls.length, 2);
        assert.equal(r.text.split('[动画表情：').length - 1, 2);
        assert.equal(r.text.endsWith('[动画表情]'), true);
    });

    test('mediaReading：只给 stickerVision 也算开着；没有 url 的表情包读不了就照旧', async () => {
        const { vision, calls } = describer([]);
        const reading = mediaReading({ stickerVision: vision, timeouts: { voice: 100, ocr: 100, vision: 100 } });
        assert.equal(reading.needs([sticker()]), true);
        const noUrl: Segment = { type: 'image', data: { file: 'NOURL0000000000.gif', sub_type: 1, summary: '[动画表情]' } };
        assert.equal(segmentsToText(await reading.read([noUrl], 5, () => {})), '[动画表情]');
        assert.equal(calls.length, 0);
        assert.equal(segmentsToText(await reading.read([sticker()], 6, () => {})).startsWith('[动画表情：'), true);
        reading.stop();
    });
});

describe('看懂表情包之后，别处还照原来的样子认它（ADR 0206）', () => {
    const LINE = '[动画表情：上面写着「理理我」；一只橘猫委屈地趴在地上，眼睛水汪汪]';

    test('单独一个表情包还是「反应」（不回也说得过去、看心情不回照旧），和没读之前一样', () => {
        assert.equal(isReaction('[动画表情]'), true);
        assert.equal(isReaction(LINE), true);
        assert.equal(isReaction('晚上去吃饭吗 ' + LINE), false);
    });

    test('他发了个表情包算“有明确的反应”（可以回个表情）；方括号转义修好后，「心情」「你在干嘛?」不再算', () => {
        assert.equal(stickerCued('[动画表情]'), true);
        assert.equal(stickerCued('[表情]'), true);
        assert.equal(stickerCued(LINE), true);
        for (const text of ['今天心情不错', '你在干嘛?', '活动在周三', '画画好难', '这件事情我想想', '我到了']) assert.equal(stickerCued(text), false, text);
        assert.equal(stickerCued('哈哈哈'), true);
    });

    test('读懂了内容的表情包不算附和：收尾之后、看心情不回这两处代码不替她决定，她看了自己定（用户 10-31）', () => {
        assert.equal(hasReadSticker(LINE), true);
        assert.equal(hasReadSticker('哈哈 ' + LINE), true);
        assert.equal(hasReadSticker('[动画表情]'), false);
        assert.equal(hasReadSticker('动画表情：好玩'), false);
        assert.equal(hasReadSticker('哈哈'), false);
        const at = (minute: number) => new Date(Date.UTC(2026, 9, 29, 14, minute)).toISOString();
        // 她道了晚安（收尾）之后他又发表情包：没读懂的照旧当附和不回；读懂了（「想你」）要回
        const closed = (sticker: string) => [
            { time: at(0), role: 'user' as const, content: '好困啊' },
            { time: at(1), role: 'assistant' as const, content: '那你快睡，晚安' },
            { time: at(2), role: 'user' as const, content: sticker },
        ];
        assert.deepEqual(pendingMessages(closed('[动画表情]')), []);
        assert.equal(pendingMessages(closed(LINE)).length, 1);
        // 看心情不回：同一个种子下，chance=1 时没读懂的会被跳过，读懂了不跳
        const chatting = (sticker: string) => [
            { time: at(0), role: 'user' as const, content: '在干嘛' },
            { time: at(1), role: 'assistant' as const, content: '看剧呢' },
            { time: at(2), role: 'user' as const, content: sticker, messageId: 77 },
        ];
        assert.ok(moodySkip(chatting('[动画表情]'), 1, 1), '没读懂：照旧');
        assert.equal(moodySkip(chatting(LINE), 1, 1), undefined);
        assert.equal(moodySkip(chatting('哈哈'), 1, 1) !== undefined, true, '普通的反应不受影响');
    });

    test('她照抄「[动画表情：…]」那一行：和照抄语音、图片一样重写 / 删掉', () => {
        assert.equal(inspectReply(LINE, []).some(issue => issue.kind === 'media'), true);
        assert.deepEqual(inspectReply('你发的表情包好可爱', []).filter(issue => issue.kind === 'media'), []);
    });
});

test('读过的缓存文件只写在我们给的位置', () => {
    const file = join(dir, 'only-here.json');
    const reads = stickerReads(file);
    reads.set({ file: 'ONLYHERE00000000.gif' }, '[动画表情：好]');
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[stickerKey({ file: 'ONLYHERE00000000.gif' })!], '[动画表情：好]');
    assert.equal(existsSync(`${file}.tmp`), false);
});
