import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { aiPhotoDraftStore, buildAiPhotoPrompt, generateAiPhoto, type AiPhotoContext } from '../src/vision/ai-photo-drafts.ts';

const context = (patch: Partial<AiPhotoContext> = {}): AiPhotoContext => ({
    kind: 'cat', eventKey: 'cat:2026-11-04:evening', subject: '土豆蹲在自行车棚旁边',
    caption: '土豆蹲在自行车棚旁边看落叶', at: '2026-11-04T18:20:00+08:00',
    weather: '阴，12°C', place: '宿舍楼下的普通自行车棚', activity: '下楼喂猫', ...patch,
});

// detectImageType 只需要真实文件头；生成器测试不解码像素。
const jpeg = (marker = 1) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, marker, 0, 1, 2, 3]);

describe('AI 生活照草稿（ADR 0239）', () => {
    test('提示词只带清洗后的世界事实，并明确禁止人物、文字与电影感', () => {
        const prompt = buildAiPhotoPrompt(context({ subject: '土豆\n蹲着\u0000', place: '宿舍楼下\r\n自行车棚' }));
        assert.match(prompt, /土豆 蹲着/);
        assert.match(prompt, /宿舍楼下 自行车棚/);
        assert.match(prompt, /Show no person, face, body part, hand/);
        assert.match(prompt, /no readable text, logo, watermark or timestamp/);
        assert.match(prompt, /Do not use cinematic grading/);
        assert.doesNotMatch(prompt, /\u0000|\r|\n/);
    });

    test('食物草稿必须给实际菜名', () => {
        assert.throws(() => buildAiPhotoPrompt(context({ kind: 'food', dish: undefined })), /必须给出菜名/);
    });

    test('生图调用使用独立密钥和当前图片接口，不读取失败响应正文', async () => {
        let request: { url: string; auth?: string; body?: Record<string, unknown> } | undefined;
        const result = await generateAiPhoto('prompt', {
            baseUrl: 'https://api.example.test/v1/', apiKey: 'image-secret', model: 'image-model',
            fetch: async (url, init) => {
                request = { url, auth: init.headers.authorization, body: JSON.parse(init.body) as Record<string, unknown> };
                return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(jpeg()).toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
            },
        });
        assert.equal(request?.url, 'https://api.example.test/v1/images/generations');
        assert.equal(request?.auth, 'Bearer image-secret');
        assert.deepEqual(request?.body, { model: 'image-model', prompt: 'prompt', n: 1, size: '1024x1024', quality: 'medium', output_format: 'jpeg', background: 'opaque' });
        assert.deepEqual(result.bytes, jpeg());

        await assert.rejects(generateAiPhoto('PRIVATE PROMPT', {
            baseUrl: 'https://api.example.test/v1/', apiKey: 'image-secret', model: 'image-model',
            fetch: async () => new Response('PRIVATE PROMPT image-secret', { status: 429 }),
        }), error => error instanceof Error && error.message === '生图服务返回 429');
    });

    test('公共明文服务和伪造图片都拒绝', async () => {
        await assert.rejects(generateAiPhoto('x', { baseUrl: 'http://example.com/v1', apiKey: 'x', model: 'x', fetch: async () => new Response() }), /必须使用 HTTPS/);
        await assert.rejects(generateAiPhoto('x', {
            baseUrl: 'https://example.com/v1', apiKey: 'x', model: 'x',
            fetch: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not image').toString('base64') }] }), { status: 200 }),
        }), /格式不受支持/);
    });

    test('同一事件只生成一次；审核通过后才导入照片货架', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-'));
        const clock = () => new Date('2026-11-04T10:00:00.000Z');
        const store = aiPhotoDraftStore({ dir, now: clock });
        let calls = 0;
        const first = await store.generate(context(), async () => { calls++; return { bytes: jpeg(7), model: 'image-model' }; });
        const second = await store.generate(context(), async () => { calls++; return { bytes: jpeg(8), model: 'image-model' }; });
        assert.equal(calls, 1);
        assert.equal(second.id, first.id);
        assert.equal(store.status().pending, 1);

        let imported: { source: string; kind: string; caption: string; dish?: string } | undefined;
        const approved = store.approve(first.id, {
            add(source, kind, caption, dish) { imported = { source, kind, caption, ...(dish ? { dish } : {}) }; return { id: 'abc123abc123' } as never; },
        });
        assert.equal(approved.status, 'approved');
        assert.equal(approved.shelfId, 'abc123abc123');
        assert.equal(imported?.kind, 'cat');
        assert.equal(imported?.caption, context().caption);
        assert.deepEqual(new Uint8Array(readFileSync(imported!.source)), jpeg(7));
        assert.throws(() => store.reject(first.id), /已通过/);

        const reopened = aiPhotoDraftStore({ dir, now: clock });
        assert.equal(reopened.status().approved, 1);
        assert.equal(reopened.list()[0]?.promptHash.length, 64);
        assert.equal('prompt' in (reopened.list()[0] as unknown as Record<string, unknown>), false);
    });

    test('拒绝的草稿不能直接通过', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-reject-'));
        const store = aiPhotoDraftStore({ dir });
        const draft = await store.generate(context({ eventKey: 'reject-me' }), async () => ({ bytes: jpeg(9), model: 'm' }));
        assert.equal(store.reject(draft.id).status, 'rejected');
        assert.throws(() => store.approve(draft.id, { add: () => ({ id: 'abc123abc123' }) as never }), /不能直接通过/);
    });
});
