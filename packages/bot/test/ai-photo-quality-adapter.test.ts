import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
    aiPhotoQualityFacts, aiPhotoReviewModelFromImageDescriber, aiPhotoTimeOfDay, createAiPhotoVisualReviewer,
    parseAiPhotoVisualReview, qualityCheckedAiPhotoGenerator,
} from '../src/vision/ai-photo-quality-adapter.ts';
import type { AiPhotoContext } from '../src/vision/ai-photo-drafts.ts';

function png(width = 1024, height = 1024): Uint8Array {
    const b = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
    b[24] = 8; b[25] = 2;
    return new Uint8Array(b);
}

const referenceImage = () => {
    const bytes = png();
    return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 12), bytes, type: 'image/png' as const };
};

const context: AiPhotoContext = {
    kind: 'cat', eventKey: 'cat:1', subject: '团子饼在自行车棚旁边', caption: '团子饼在路边待着',
    at: '2026-11-04T10:20:00.000Z', weather: '阴',
};

const review = (patch: Record<string, unknown> = {}) => JSON.stringify({
    sceneKind: 'cat', confidence: 0.95, personCount: 0, faceCount: 0, handCount: 0,
    readableText: false, watermark: false, famousLandmark: false, cinematicStyle: false,
    subjectMatches: true, dishMatches: true, weatherMatches: true, timeMatches: true, referenceMatches: true,
    ...patch,
});

describe('AI 照片质量适配器（ADR 0242）', () => {
    test('视觉结果只接受固定裸 JSON 和严格字段类型', () => {
        assert.equal(parseAiPhotoVisualReview(review()).sceneKind, 'cat');
        for (const bad of [
            `\`\`\`json\n${review()}\n\`\`\``, `${review()}\n说明`, review({ extra: true }),
            review({ confidence: '0.9' }), review({ personCount: 0.5 }), review({ sceneKind: 'portrait' }),
        ]) assert.throws(() => parseAiPhotoVisualReview(bad), /格式无效/);
    });

    test('生成安全 data URL 并把世界事实作为不可信 JSON 交给模型', async () => {
        let received: { dataUrl: string; referenceDataUrls?: readonly string[]; prompt: string } | undefined;
        const reviewer = createAiPhotoVisualReviewer({
            review: async input => { received = input; return review(); },
        });
        const result = await reviewer({
            bytes: png(), type: 'image/png', width: 1024, height: 1024, facts: aiPhotoQualityFacts(context), referenceIds: [],
            referenceImages: [referenceImage()],
        });
        assert.equal(result.subjectMatches, true);
        assert.match(received!.dataUrl, /^data:image\/png;base64,/);
        assert.equal(received!.referenceDataUrls?.length, 1);
        assert.match(received!.referenceDataUrls?.[0] ?? '', /^data:image\/png;base64,/);
        assert.match(received!.prompt, /FACTS=.*团子饼在自行车棚旁边/);
        assert.match(received!.prompt, /不可信数据/);
    });

    test('模型错误和畸形正文不会被质量门回显', async () => {
        let generated = 0;
        const generator = qualityCheckedAiPhotoGenerator({
            context, generate: async () => { generated++; return { bytes: png(), model: 'image-model' }; },
            reviewer: createAiPhotoVisualReviewer({ review: async () => { throw new Error('SECRET raw output'); } }),
        });
        await assert.rejects(generator('PRIVATE PROMPT'), error => error instanceof Error
            && /视觉审查失败/.test(error.message) && !/SECRET|PRIVATE/.test(error.message));
        assert.equal(generated, 1);
    });

    test('通过才把生成结果交回草稿仓库，并按种类取非人物参考 ID', async () => {
        const kinds: string[] = [];
        const generated = { bytes: png(), model: 'image-model' };
        const generator = qualityCheckedAiPhotoGenerator({
            context, generate: async prompt => { assert.equal(prompt, 'safe prompt'); return generated; },
            references: { imagesFor: kind => { kinds.push(kind); return [referenceImage()]; } },
            reviewer: async input => {
                assert.equal(input.referenceImages?.length, 1);
                return parseAiPhotoVisualReview(review());
            },
        });
        assert.equal(await generator('safe prompt'), generated);
        assert.deepEqual(kinds, ['cat']);
    });

    test('质量拒绝只重生成一次，第二张通过后返回且留下安全审计日志', async () => {
        let generated = 0;
        let reviewed = 0;
        const logs: string[] = [];
        const generator = qualityCheckedAiPhotoGenerator({
            context,
            generate: async () => ({ bytes: png(), model: `image-${++generated}` }),
            reviewer: async () => parseAiPhotoVisualReview(review({ subjectMatches: ++reviewed > 1 })),
            maxQualityRegenerations: 8,
            log: message => logs.push(message),
        });
        assert.equal((await generator('safe prompt')).model, 'image-2');
        assert.equal(generated, 2);
        assert.equal(reviewed, 2);
        assert.deepEqual(logs, ['AI 照片：质量检查未通过，按限制重生成 1 次；不会自动发送']);
    });

    test('连续质量拒绝后停止，不会进行第三次生成', async () => {
        let generated = 0;
        const generator = qualityCheckedAiPhotoGenerator({
            context,
            generate: async () => ({ bytes: png(), model: `image-${++generated}` }),
            reviewer: async () => parseAiPhotoVisualReview(review({ readableText: true })),
            maxQualityRegenerations: 1,
        });
        await assert.rejects(generator('safe prompt'), /质量检查未通过.*可读文字/);
        assert.equal(generated, 2);
    });

    test('时段按世界账时区计算，非法日期和时区明确拒绝', () => {
        assert.equal(aiPhotoTimeOfDay('2026-11-03T21:30:00.000Z'), 'dawn');
        assert.equal(aiPhotoTimeOfDay('2026-11-04T04:00:00.000Z'), 'day');
        assert.equal(aiPhotoTimeOfDay('2026-11-04T10:30:00.000Z'), 'dusk');
        assert.equal(aiPhotoTimeOfDay('2026-11-04T14:00:00.000Z'), 'night');
        assert.throws(() => aiPhotoTimeOfDay('bad'), /有效日期/);
        assert.throws(() => aiPhotoTimeOfDay('2026-11-04T00:00:00Z', 'Bad/Zone'), /时区无效/);
    });

    test('可复用现有 ImageDescriber，且只传 data URL', async () => {
        let seenPrompt = '';
        const model = aiPhotoReviewModelFromImageDescriber(prompt => ({
            describe: async image => {
                seenPrompt = prompt;
                assert.equal(image.url, image.dataUrl);
                assert.match(image.url, /^data:image\/png;base64,/);
                return review();
            },
        }));
        const reviewer = createAiPhotoVisualReviewer(model);
        await reviewer({ bytes: png(), type: 'image/png', width: 1024, height: 1024, facts: aiPhotoQualityFacts(context), referenceIds: [] });
        assert.match(seenPrompt, /只返回一个裸 JSON/);
    });
});
