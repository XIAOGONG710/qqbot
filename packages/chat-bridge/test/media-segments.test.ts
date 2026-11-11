import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { MAX_MEDIA_BYTES, MediaError, allowedMime, createMediaStore, readMediaReference, sniffMime } from '../src/media.ts';
import { UnsupportedSegment, cardFromJson, normalizeMessage, parseAppParts, parseCqString, partsToSegments, rawMessage, segmentsToParts } from '../src/segments.ts';
import { JPEG, PNG, WAV, WEBM, tempDir } from './helpers.ts';

const noFetch = async (): Promise<Uint8Array> => { throw new Error('不该联网'); };

test('按文件头认类型', () => {
    assert.equal(sniffMime(PNG), 'image/png');
    assert.equal(sniffMime(JPEG), 'image/jpeg');
    assert.equal(sniffMime(Buffer.from('GIF89a....')), 'image/gif');
    assert.equal(sniffMime(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
    assert.equal(sniffMime(WAV), 'audio/wav');
    assert.equal(sniffMime(WEBM), 'audio/webm');
    assert.equal(sniffMime(Buffer.from('OggS....')), 'audio/ogg');
    assert.equal(sniffMime(Buffer.from('....ftypM4A ....')), 'audio/mp4');
    assert.equal(sniffMime(Buffer.from('ID3.....')), 'audio/mpeg');
    assert.equal(sniffMime(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'audio/mpeg');
    assert.equal(sniffMime(Buffer.from('<html><script>')), undefined);
    assert.equal(sniffMime(Buffer.from('MZ executable')), undefined);
});

test('类型白名单：去掉参数，不在名单里的不要', () => {
    assert.equal(allowedMime('audio/webm;codecs=opus'), 'audio/webm');
    assert.equal(allowedMime('IMAGE/PNG'), 'image/png');
    assert.equal(allowedMime('image/svg+xml'), undefined);
    assert.equal(allowedMime('text/html'), undefined);
    assert.equal(allowedMime(undefined), undefined);
});

test('媒体仓：存、取、重开后还在；id 是随机的', t => {
    const dir = tempDir(t);
    const store = createMediaStore({ dir });
    const image = store.put(PNG, { mime: 'image/png' });
    const voice = store.put(WAV);
    assert.match(image.id, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(image.id, voice.id);
    assert.deepEqual(readFileSync(image.path), PNG);
    assert.equal(store.get(image.id)?.mime, 'image/png');
    assert.equal(store.put(PNG).id, image.id, '同样的内容不重复存');

    const reopened = createMediaStore({ dir });
    assert.equal(reopened.get(voice.id)?.mime, 'audio/wav');
    assert.equal(reopened.get(voice.id)?.size, WAV.length);
});

test('媒体仓：太大、空的、认不出的、类型对不上的都不收', t => {
    const dir = tempDir(t);
    const store = createMediaStore({ dir });
    const code = (work: () => unknown) => { try { work(); } catch (error) { return error instanceof MediaError ? error.code : 'other'; } return 'accepted'; };
    const big = Buffer.alloc(MAX_MEDIA_BYTES + 1);
    PNG.copy(big);
    assert.equal(code(() => store.put(big)), 'too_large');
    assert.equal(code(() => store.put(Buffer.alloc(0))), 'empty');
    assert.equal(code(() => store.put(Buffer.from('<html>'))), 'unsupported');
    assert.equal(code(() => store.put(PNG, { mime: 'image/jpeg' })), 'unsupported');
    assert.equal(code(() => store.put(WAV, { kind: 'image' })), 'unsupported');
    assert.equal(code(() => store.put(PNG, { kind: 'audio' })), 'unsupported');
    assert.deepEqual(readdirSync(dir), []);
    const exact = Buffer.alloc(MAX_MEDIA_BYTES);
    PNG.copy(exact);
    assert.equal(code(() => store.put(exact)), 'accepted');
});

test('媒体仓：取的时候 id 不能带路径', t => {
    const base = tempDir(t);
    const dir = join(base, 'media');
    writeFileSync(join(base, 'secret-for-traversal-test.png'), PNG);
    const store = createMediaStore({ dir });
    const info = store.put(PNG);
    for (const bad of ['../secret-for-traversal-test', '..\\secret-for-traversal-test', `${info.id}/../x`, `${info.id}.png`, '', 'short', 42, null, `${info.id}\0`]) {
        assert.equal(store.get(bad), undefined, String(bad));
    }
    assert.equal(store.get(info.id)?.path, info.path);
});

test('她的 file 字段：本机路径、file://、base64://、http(s)（只经注入的 fetcher）', async t => {
    const dir = tempDir(t);
    const path = join(dir, 'photo.png');
    writeFileSync(path, PNG);
    assert.deepEqual(await readMediaReference(path, noFetch), PNG);
    assert.deepEqual(await readMediaReference(pathToFileURL(path).href, noFetch), PNG);
    assert.deepEqual(await readMediaReference(`base64://${PNG.toString('base64')}`, noFetch), PNG);
    const fetched: string[] = [];
    assert.deepEqual(await readMediaReference('https://media.example/a.png', async url => { fetched.push(url); return PNG; }), PNG);
    assert.deepEqual(fetched, ['https://media.example/a.png']);

    await assert.rejects(readMediaReference('relative/photo.png', noFetch), MediaError);
    await assert.rejects(readMediaReference(join(dir, 'missing.png'), noFetch), MediaError);
    await assert.rejects(readMediaReference(dir, noFetch), MediaError);
    await assert.rejects(readMediaReference(`base64://${'A'.repeat(MAX_MEDIA_BYTES * 2)}`, noFetch), /10 MiB/);
});

test('CQ 字符串和 raw_message 互相转得回来', () => {
    const segments = parseCqString('你好[CQ:face,id=178]&#91;不是码&#93;[CQ:reply,id=5]');
    assert.deepEqual(segments, [
        { type: 'text', data: { text: '你好' } },
        { type: 'face', data: { id: '178' } },
        { type: 'text', data: { text: '[不是码]' } },
        { type: 'reply', data: { id: '5' } },
    ]);
    assert.equal(rawMessage(segments), '你好[CQ:face,id=178]&#91;不是码&#93;[CQ:reply,id=5]');
    assert.deepEqual(normalizeMessage('纯文字'), [{ type: 'text', data: { text: '纯文字' } }]);
    assert.deepEqual(normalizeMessage({ type: 'text', data: { text: 'a' } }), [{ type: 'text', data: { text: 'a' } }]);
    assert.equal(normalizeMessage([{ nope: 1 }]), undefined);
    assert.equal(normalizeMessage(42), undefined);
});

test('她的段 → Part：文字、小黄脸、图片、语音、卡片、引用', async t => {
    const dir = tempDir(t);
    const media = createMediaStore({ dir: join(dir, 'media') });
    const wav = join(dir, 'voice.wav');
    writeFileSync(wav, WAV);
    const card = JSON.stringify({ prompt: '[分享]某个视频', meta: { detail_1: { title: '哔哩哔哩', desc: '某个视频', qqdocurl: 'https://video.example/v/1' } } });
    const converted = await segmentsToParts([
        { type: 'reply', data: { id: '123' } },
        { type: 'text', data: { text: '看这个' } },
        { type: 'text', data: { text: '！' } },
        { type: 'face', data: { id: '178' } },
        { type: 'image', data: { file: `base64://${PNG.toString('base64')}`, summary: '[照片]', sub_type: 1 } },
        { type: 'record', data: { file: pathToFileURL(wav).href } },
        { type: 'json', data: { data: card } },
    ], { media, fetcher: noFetch, mode: 'strict' });

    assert.equal(converted.replyTo, 123);
    const [text, face, image, voice, cardPart] = converted.parts;
    assert.deepEqual(text, { kind: 'text', text: '看这个！' });
    assert.deepEqual(face, { kind: 'face', id: 178 });
    assert.ok(image?.kind === 'image' && voice?.kind === 'voice');
    assert.deepEqual({ ...image, mediaId: '' }, { kind: 'image', mediaId: '', mime: 'image/png', summary: '[照片]' });
    assert.deepEqual(readFileSync(media.get(image.mediaId)!.path), PNG);
    assert.equal(voice.mime, 'audio/wav');
    assert.deepEqual(cardPart, { kind: 'card', title: '哔哩哔哩', url: 'https://video.example/v/1' });
});

test('发往 App 的：有一段显示不了或读不了就整条失败；镜像的写成占位', async t => {
    const media = createMediaStore({ dir: tempDir(t) });
    const strict = { media, fetcher: noFetch, mode: 'strict' as const };
    await assert.rejects(segmentsToParts([{ type: 'video', data: { file: 'x' } }], strict), UnsupportedSegment);
    await assert.rejects(segmentsToParts([{ type: 'image', data: { file: 'not-a-path.png' } }], strict), UnsupportedSegment);
    await assert.rejects(segmentsToParts([{ type: 'image', data: { file: `base64://${WAV.toString('base64')}` } }], strict), UnsupportedSegment);

    const failing = async (): Promise<Uint8Array> => { throw new Error('offline'); };
    const mirrored = await segmentsToParts([
        { type: 'text', data: { text: '你看' } },
        { type: 'image', data: { file: 'ABC.jpg', url: 'https://cdn.example/abc' } },
        { type: 'image', data: { file: 'DEF.gif', url: 'https://cdn.example/def', summary: '[动画表情]' } },
        { type: 'video', data: {} },
    ], { media, fetcher: failing, mode: 'lenient' });
    assert.deepEqual(mirrored.parts, [{ kind: 'text', text: '你看[图片][动画表情][视频]' }]);
});

test('镜像他在 QQ 上发的图：file 只是名字，用 url 经 fetcher 取', async t => {
    const media = createMediaStore({ dir: tempDir(t) });
    const asked: string[] = [];
    const converted = await segmentsToParts([{ type: 'image', data: { file: 'ABC.jpg', url: 'https://cdn.example/abc', summary: '' } }],
        { media, fetcher: async url => { asked.push(url); return JPEG; }, mode: 'lenient' });
    assert.deepEqual(asked, ['https://cdn.example/abc']);
    assert.equal(converted.parts[0]?.kind === 'image' && converted.parts[0].mime, 'image/jpeg');
});

test('卡片：没有 meta 时用 prompt；不是 http 的链接不要', () => {
    assert.deepEqual(cardFromJson('{"prompt":"[QQ小程序]某个东西"}'), { title: '[QQ小程序]某个东西' });
    assert.deepEqual(cardFromJson('{"meta":{"news":{"title":"标题","jumpUrl":"javascript:alert(1)"}}}'), { title: '标题' });
    assert.deepEqual(cardFromJson('not json'), { title: '[卡片]' });
});

test('Part → 段：图片和语音带本机 url，引用放最前', t => {
    const media = createMediaStore({ dir: tempDir(t) });
    const image = media.put(PNG);
    const voice = media.put(WEBM);
    const segments = partsToSegments([
        { kind: 'text', text: '你看' },
        { kind: 'face', id: 178 },
        { kind: 'image', mediaId: image.id, mime: image.mime },
        { kind: 'voice', mediaId: voice.id, mime: voice.mime },
    ], 55, { media, localUrl: id => `http://127.0.0.1:3200/media/${id}` });
    assert.deepEqual(segments, [
        { type: 'reply', data: { id: '55' } },
        { type: 'text', data: { text: '你看' } },
        { type: 'face', data: { id: '178' } },
        { type: 'image', data: { file: `${image.id}.png`, url: `http://127.0.0.1:3200/media/${image.id}`, file_size: String(PNG.length), sub_type: 0 } },
        { type: 'record', data: { file: `${voice.id}.webm`, url: `http://127.0.0.1:3200/media/${voice.id}`, file_size: String(WEBM.length), path: voice.path } },
    ]);
});

test('App 发来的 parts：只收文字、小黄脸、已上传的图片和语音', t => {
    const media = createMediaStore({ dir: tempDir(t) });
    const image = media.put(PNG);
    const voice = media.put(WEBM);
    const good = parseAppParts([
        { kind: 'text', text: '在吗' },
        { kind: 'face', id: 178, name: '忽略' },
        { kind: 'image', mediaId: image.id, mime: 'image/gif', summary: '伪造的说明' },
        { kind: 'voice', mediaId: voice.id, mime: 'x', durationMs: 1234.4 },
    ], media);
    assert.deepEqual(good, {
        ok: true,
        parts: [
            { kind: 'text', text: '在吗' },
            { kind: 'face', id: 178 },
            { kind: 'image', mediaId: image.id, mime: 'image/png' },
            { kind: 'voice', mediaId: voice.id, mime: 'audio/webm', durationMs: 1234 },
        ],
    });
    const bad = (parts: unknown) => assert.equal(parseAppParts(parts, media).ok, false, JSON.stringify(parts)?.slice(0, 60));
    bad([]);
    bad('text');
    bad([{ kind: 'text', text: '' }]);
    bad([{ kind: 'text' }]);
    bad([{ kind: 'card', title: '假卡片' }]);
    bad([{ kind: 'poke' }]);
    bad([{ kind: 'image', mediaId: 'AAAAAAAAAAAAAAAAAAAAAA' }]);
    bad([{ kind: 'image', mediaId: voice.id }]);
    bad([{ kind: 'voice', mediaId: image.id }]);
    bad([{ kind: 'image', mediaId: '../../etc/passwd' }]);
    bad(Array.from({ length: 21 }, () => ({ kind: 'text', text: 'a' })));
    bad([{ kind: 'text', text: 'a'.repeat(8001) }]);
});
