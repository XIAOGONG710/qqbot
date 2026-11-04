import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    test('只持久化内容哈希和引用 ID；同一内容不重复', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-ref-'));
        const file = join(dir, 'references.json');
        const store = aiPhotoReferenceStore({ file, now: () => new Date('2026-11-04T00:00:00.000Z') });
        const first = store.add({ kind: 'cat', bytes: png(), referenceId: 'potato-v1', nonHumanSubject: true });
        const again = store.add({ kind: 'cat', bytes: png(), referenceId: 'potato-v2', nonHumanSubject: true });
        assert.equal(again.id, first.id);
        assert.deepEqual(store.idsFor('cat'), ['potato-v1']);
        const stored = readFileSync(file, 'utf8');
        assert.doesNotMatch(stored, /137,80,78|data:image|subject|label|path/);
        assert.match(stored, /"contentHash"/);
        assert.match(stored, /"referenceId": "potato-v1"/);

        const reopened = aiPhotoReferenceStore({ file });
        assert.equal(reopened.list('cat').length, 1);
        assert.equal(reopened.remove(first.id), true);
        assert.equal(reopened.list().length, 0);
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
    });
});
