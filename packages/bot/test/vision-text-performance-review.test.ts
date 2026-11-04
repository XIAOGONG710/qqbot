import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { parseCommons, parseCommonsFood } from '../src/vision/photo-sources.ts';
import { readMedia, OCR_MAX_CHARS, VOICE_MAX_CHARS } from '../src/vision/media.ts';
import { segmentsToText } from '../src/platform/onebot.ts';

const body = (artist: string) => ({ query: { pages: { '0': { title: 'File:Synthetic.jpg', imageinfo: [{ mime: 'image/jpeg', width: 3000, height: 2000,
    url: 'https://upload.wikimedia.org/synthetic.jpg', extmetadata: { LicenseShortName: { value: 'CC0' }, Artist: { value: artist } } }] } } } });

test('未闭合HTML字段在2MiB响应预算内也须及时解析，不能反复回扫', () => {
    const module = new URL('../src/vision/photo-sources.ts', import.meta.url).href;
    const script = `import { parseCommons } from ${JSON.stringify(module)};
        const artist = '<'.repeat(1_500_000);
        const body = ${JSON.stringify(body('placeholder'))}; body.query.pages[0].imageinfo[0].extmetadata.Artist.value = artist;
        const result = parseCommons('cat', body); if (result[0]?.artist !== artist) throw Error('artist changed'); console.log('done');`;
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr.slice(-1000)); assert.match(result.stdout, /done/);
});

test('真实OCR及转写字符串只截取输出所需字符，64MiB堆不展开整个字符数组', () => {
    const module = new URL('../src/vision/media.ts', import.meta.url).href;
    const script = `import { readMedia } from ${JSON.stringify(module)};
        const value = '字'.repeat(8_000_000);
        const result = await readMedia([{ type:'record',data:{} },{ type:'image',data:{url:'https://synthetic.invalid/image'} }], 1,
            {reader:{ voiceToText: async () => value, ocr: async () => [value] }}, () => {});
        if (result[0].data.text.length > 320 || result[1].data.text.length > 100) throw Error('not truncated'); console.log('done');`;
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr.slice(-1000)); assert.match(result.stdout, /done/);
});

test('HTML标签、嵌套左尖括号和空标签保留既有语义', () => {
    for (const [input, expected] of [
        [' 甲 <b>乙</b>\n丙 ', '甲 乙 丙'], ['甲<>乙', '甲<>乙'], ['甲<<b>乙>', '甲乙>'],
        ['<><tag>甲</tag><>', '<>甲<>'], ['<<>', ''], ['未闭合<<<', '未闭合<<<'],
    ]) {
        assert.equal(parseCommons('cat', body(input!))[0]!.artist, expected);
        assert.equal(parseCommonsFood('合成菜', body(input!))[0]!.artist, expected);
    }
});

test('媒体截断保留空白压缩、括号替换和emoji代码点边界', async () => {
    const raw = ` \n[😀]\t${'甲😀'.repeat(160)}  `;
    const flat = raw.replace(/\s+/g, ' ').replace(/\[/g, '【').replace(/\]/g, '】').trim();
    const expected = (max: number) => [...flat].slice(0, max).join('') + '…';
    const result = await readMedia([{ type: 'record', data: {} }, { type: 'image', data: { url: 'https://synthetic.invalid/image' } }], 1,
        { reader: { voiceToText: async () => raw, ocr: async () => [raw] } }, () => {});
    assert.equal(segmentsToText(result), `[语音：${expected(VOICE_MAX_CHARS)}][图片，上面写着：${expected(OCR_MAX_CHARS)}]`);
});
