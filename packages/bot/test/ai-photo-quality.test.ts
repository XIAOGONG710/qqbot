import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { aiPhotoDimensions, assessAiPhotoQuality, type AiPhotoVisualReview, type AiPhotoWorldFacts } from '../src/vision/ai-photo-quality.ts';
import { aiPhotoReferenceStore } from '../src/vision/ai-photo-references.ts';

function png(width = 1024, height = 1024): Uint8Array {
    const b = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
    b[24] = 8; b[25] = 2;
    return new Uint8Array(b);
}

function jpeg(width = 1024, height = 768): Uint8Array {
    const b = Buffer.alloc(15);
    Buffer.from([0xff, 0xd8, 0xff, 0xc0]).copy(b);
    b.writeUInt16BE(11, 4); b[6] = 8; b.writeUInt16BE(height, 7); b.writeUInt16BE(width, 9);
    b[11] = 1; b[12] = 1; b[13] = 0x11; b[14] = 0;
    return new Uint8Array(b);
}

function webp(width = 900, height = 1200): Uint8Array {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(22, 4); b.write('WEBPVP8X', 8, 'ascii'); b.writeUInt32LE(10, 16);
    const put24 = (offset: number, value: number) => { b[offset] = value & 255; b[offset + 1] = (value >>> 8) & 255; b[offset + 2] = (value >>> 16) & 255; };
    put24(24, width - 1); put24(27, height - 1);
    return new Uint8Array(b);
}

const facts = (patch: Partial<AiPhotoWorldFacts> = {}): AiPhotoWorldFacts => ({
    kind: 'cat', at: '2026-11-04T18:20:00+08:00', subject: '土豆蹲在自行车棚旁边', weather: '阴', timeOfDay: 'dusk', ...patch,
});

const cleanReview = (patch: Partial<AiPhotoVisualReview> = {}): AiPhotoVisualReview => ({
    sceneKind: 'cat', confidence: 0.96, personCount: 0, faceCount: 0, handCount: 0,
    readableText: false, watermark: false, famousLandmark: false, cinematicStyle: false,
    subjectMatches: true, weatherMatches: true, timeMatches: true, referenceMatches: true, ...patch,
});

describe('AI 生活照图片结构（ADR 0242）', () => {
    test('按文件内容解析 PNG / JPEG / WebP 的尺寸', () => {
        assert.deepEqual(aiPhotoDimensions(png(1024, 768)), { type: 'image/png', width: 1024, height: 768 });
        assert.deepEqual(aiPhotoDimensions(jpeg(1200, 900)), { type: 'image/jpeg', width: 1200, height: 900 });
        assert.deepEqual(aiPhotoDimensions(webp(900, 1200)), { type: 'image/webp', width: 900, height: 1200 });
    });

    test('只有文件头、截断段、非法 PNG 参数都不算可解码结构', () => {
        assert.equal(aiPhotoDimensions(Uint8Array.from([0xff, 0xd8, 0xff])), undefined);
        assert.equal(aiPhotoDimensions(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), undefined);
        const bad = png(); bad[24] = 3;
        assert.equal(aiPhotoDimensions(bad), undefined);
    });
});

describe('AI 生活照自动质量门（ADR 0242）', () => {
    test('本地结构 / 尺寸和世界事实不过关时不调用视觉模型', async () => {
        let calls = 0;
        const result = await assessAiPhotoQuality({
            bytes: png(320, 1024), facts: facts({ kind: 'food', dish: undefined, at: 'bad date' }),
            reviewer: async () => { calls++; return cleanReview(); },
        });
        assert.equal(calls, 0);
        assert.equal(result.passed, false);
        assert.match(result.reasons.join('；'), /世界时间无效/);
        assert.match(result.reasons.join('；'), /缺少实际菜名/);
        assert.match(result.reasons.join('；'), /图片太小/);
    });

    test('没有视觉审查器或审查器失败时失败关闭，不外泄错误原文', async () => {
        assert.deepEqual((await assessAiPhotoQuality({ bytes: png(), facts: facts() })).reasons, ['尚未完成视觉审查']);
        const failed = await assessAiPhotoQuality({ bytes: png(), facts: facts(), reviewer: async () => { throw new Error('secret prompt'); } });
        assert.deepEqual(failed.reasons, ['视觉审查失败，请稍后重试']);
        assert.doesNotMatch(failed.reasons.join(''), /secret/);
    });

    test('调用方伪造的参考图在视觉请求前失败关闭', async () => {
        let calls = 0;
        const result = await assessAiPhotoQuality({
            bytes: png(), facts: facts(),
            referenceImages: [{ id: 'abcdef012345', bytes: png(), type: 'image/jpeg' }],
            reviewer: async () => { calls++; return cleanReview(); },
        });
        assert.equal(calls, 0);
        assert.match(result.reasons.join('；'), /视觉参考图片格式或尺寸不合法/);

        const large = (tail: number) => {
            const value = Buffer.alloc(5 * 1024 * 1024);
            value.set(png(), 0); value[value.length - 1] = tail;
            return new Uint8Array(value);
        };
        const oversized = await assessAiPhotoQuality({
            bytes: png(), facts: facts(),
            referenceImages: [
                { id: '111111111111', bytes: large(1), type: 'image/png' },
                { id: '222222222222', bytes: large(2), type: 'image/png' },
            ],
            reviewer: async () => { calls++; return cleanReview(); },
        });
        assert.equal(calls, 0);
        assert.match(oversized.reasons.join('；'), /视觉参考总大小超过上限/);
    });

    test('人物、手、文字、水印、地标、棚拍感和事实不符都会给中文原因', async () => {
        const result = await assessAiPhotoQuality({
            bytes: png(), facts: facts({ kind: 'food', dish: '番茄鸡蛋面' }), referenceIds: ['bowl-v1'],
            reviewer: async input => {
                assert.deepEqual(input.referenceIds, ['bowl-v1']);
                return cleanReview({
                    sceneKind: 'view', confidence: 0.5, personCount: 1, faceCount: 1, handCount: 2,
                    readableText: true, watermark: true, famousLandmark: true, cinematicStyle: true,
                    subjectMatches: false, dishMatches: false, weatherMatches: false, timeMatches: false, referenceMatches: false,
                });
            },
        });
        assert.equal(result.passed, false);
        const line = result.reasons.join('；');
        for (const expected of ['把握不足', '人物', '人脸', '手或其他身体部位', '可读文字', '水印', '著名地标', '电影感', '画面类型', '主体', '菜品', '天气', '光线时段', '视觉设定']) assert.match(line, new RegExp(expected));
    });

    test('结构、非人物边界、世界事实和参考一致性全通过才放行', async () => {
        const result = await assessAiPhotoQuality({ bytes: jpeg(), facts: facts(), referenceIds: ['potato-v1'], reviewer: async () => cleanReview() });
        assert.equal(result.passed, true);
        assert.deepEqual(result.reasons, []);
        assert.equal(result.type, 'image/jpeg');
        assert.equal(result.width, 1024);
    });
});

describe('非人物视觉参考资料（ADR 0242）', () => {
    test('参考原图留在受控目录并真实可读；索引不嵌入图片且同一内容不重复', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-ref-'));
        const file = join(dir, 'references.json');
        const store = aiPhotoReferenceStore({ file, now: () => new Date('2026-11-04T00:00:00.000Z') });
        const first = store.add({ kind: 'cat', bytes: png(), referenceId: 'potato-v1', nonHumanSubject: true });
        const again = store.add({ kind: 'cat', bytes: png(), referenceId: 'potato-v2', nonHumanSubject: true });
        assert.equal(again.id, first.id);
        assert.deepEqual(store.idsFor('cat'), ['potato-v1']);
        const images = store.imagesFor('cat');
        assert.equal(images.length, 1);
        assert.equal(images[0]!.type, 'image/png');
        assert.deepEqual(images[0]!.bytes, png());
        const stored = readFileSync(file, 'utf8');
        assert.doesNotMatch(stored, /137,80,78|data:image|subject|label|path/);
        assert.match(stored, /"contentHash"/);
        assert.match(stored, /"referenceId": "potato-v1"/);
        assert.equal(existsSync(join(dir, 'files', `${first.id}.png`)), true);

        const reopened = aiPhotoReferenceStore({ file });
        assert.equal(reopened.list('cat').length, 1);
        assert.equal(reopened.remove(first.id), true);
        assert.equal(reopened.list().length, 0);
        assert.equal(existsSync(join(dir, 'files', `${first.id}.png`)), false);
    });

    test('拒绝人物引用、自由文本式 ID 和损坏状态', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-ref-bad-'));
        const file = join(dir, 'references.json');
        const store = aiPhotoReferenceStore({ file });
        assert.throws(() => store.add({ kind: 'cat', bytes: png(), referenceId: 'selfie-face-v1', nonHumanSubject: true }), /人物内容/);
        assert.throws(() => store.add({ kind: 'cat', bytes: png(), referenceId: '这是一段人物描述', nonHumanSubject: true }), /格式无效/);
        assert.throws(() => store.add({ kind: 'cat', bytes: png(), referenceId: 'cat-v1', nonHumanSubject: false } as never), /不含人物/);
        writeFileSync(file, '{"version":1,"entries":[{"freeText":"face"}]}');
        assert.throws(() => aiPhotoReferenceStore({ file }), /拒绝启动/);
        writeFileSync(file, JSON.stringify({ version: 1, entries: Array.from({ length: 5 }, (_, index) => ({
            id: String(index + 1).repeat(12), kind: 'cat', contentHash: String(index + 1).repeat(64),
            referenceId: `cat-${index}`, addedAt: '2026-11-04T00:00:00.000Z',
        })) }));
        assert.throws(() => aiPhotoReferenceStore({ file }), /拒绝启动/);
    });

    test('旧版只有外部编号的索引可读但不冒充真实参考图，再登记时迁移本地文件', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-ref-legacy-'));
        const file = join(dir, 'index.json');
        const bytes = png();
        const hash = createHash('sha256').update(bytes).digest('hex');
        writeFileSync(file, JSON.stringify({ version: 1, entries: [{
            id: hash.slice(0, 12), kind: 'cat', contentHash: hash, referenceId: 'potato-v1', addedAt: '2026-11-04T00:00:00.000Z',
        }] }));
        const store = aiPhotoReferenceStore({ file });
        assert.deepEqual(store.imagesFor('cat'), []);
        store.add({ kind: 'cat', bytes, referenceId: 'potato-v1', nonHumanSubject: true });
        assert.equal(store.imagesFor('cat').length, 1);
    });

    test('每类最多四张且文件被替换时失败关闭', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-ref-limit-'));
        const file = join(dir, 'index.json');
        const store = aiPhotoReferenceStore({ file });
        const entries = Array.from({ length: 4 }, (_, index) => {
            const bytes = png(); bytes[29] = index + 1;
            return store.add({ kind: 'cat', bytes, referenceId: `potato-${index}`, nonHumanSubject: true });
        });
        const fifth = png(); fifth[29] = 9;
        assert.throws(() => store.add({ kind: 'cat', bytes: fifth, referenceId: 'potato-5', nonHumanSubject: true }), /达到上限/);
        writeFileSync(join(dir, 'files', entries[0]!.file!), png(800, 800));
        assert.throws(() => store.remove(entries[0]!.id), /内容与索引不一致/);
        assert.equal(store.list('cat').length, 4, '校验失败时不能先从索引删除条目');
        assert.throws(() => aiPhotoReferenceStore({ file }), /内容与索引不一致/);
    });

    test('图片哈希和参考名称分别命中不同条目时拒绝合并', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-ref-conflict-'));
        const store = aiPhotoReferenceStore({ file: join(dir, 'index.json') });
        const first = png(); first[29] = 1;
        const second = png(); second[29] = 2;
        store.add({ kind: 'cat', bytes: first, referenceId: 'potato-a', nonHumanSubject: true });
        store.add({ kind: 'cat', bytes: second, referenceId: 'potato-b', nonHumanSubject: true });
        assert.throws(() => store.add({ kind: 'cat', bytes: first, referenceId: 'potato-b', nonHumanSubject: true }), /不同条目/);
        assert.throws(() => store.add({ kind: 'cat', bytes: png(900, 900), referenceId: 'potato-a', nonHumanSubject: true }), /另一张图片/);
        assert.throws(() => store.add({ kind: 'desk', bytes: first, referenceId: 'desk-a', nonHumanSubject: true }), /另一种类别/);
    });

    test('参考图片目录不能是符号链接或目录联接', t => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-ref-link-'));
        const outside = mkdtempSync(join(tmpdir(), 'ai-photo-ref-outside-'));
        mkdirSync(dir, { recursive: true });
        try { symlinkSync(outside, join(dir, 'files'), 'junction'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('当前 Windows 账户没有创建目录联接的权限');
            throw error;
        }
        const store = aiPhotoReferenceStore({ file: join(dir, 'index.json') });
        assert.throws(() => store.add({ kind: 'cat', bytes: png(), referenceId: 'potato-v1', nonHumanSubject: true }), /目录不安全/);
    });
});
