import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { aiPhotoDraftFreshness, aiPhotoDraftStore, buildAiPhotoPrompt, generateAiPhoto, type AiPhotoContext } from '../src/vision/ai-photo-drafts.ts';

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
        const clock = () => new Date('2026-11-04T03:00:00.000Z');
        const store = aiPhotoDraftStore({ dir, now: clock });
        let calls = 0;
        const first = await store.generate(context(), async () => { calls++; return { bytes: jpeg(7), model: 'image-model' }; });
        const second = await store.generate(context(), async () => { calls++; return { bytes: jpeg(8), model: 'image-model' }; });
        assert.equal(calls, 1);
        assert.equal(second.id, first.id);
        assert.equal(store.status().pending, 1);
        assert.deepEqual(store.preview(first.id), { bytes: jpeg(7), type: 'image/jpeg' });

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

    test('不同事件生成相同图片时拒绝复用旧图，避免反复付费和冒充当前照片', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-duplicate-'));
        const store = aiPhotoDraftStore({ dir, now: () => new Date('2026-11-04T03:00:00.000Z') });
        await store.generate(context({ eventKey: 'first-event' }), async () => ({ bytes: jpeg(17), model: 'm' }));
        await assert.rejects(
            store.generate(context({ eventKey: 'second-event' }), async () => ({ bytes: jpeg(17), model: 'm' })),
            /旧图冒充新的当前照片/,
        );
        assert.equal(store.list().length, 1);
        assert.equal(store.list()[0]?.eventKey, 'first-event');
    });

    test('拒绝的草稿不能直接通过', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-reject-'));
        const store = aiPhotoDraftStore({ dir });
        const draft = await store.generate(context({ eventKey: 'reject-me' }), async () => ({ bytes: jpeg(9), model: 'm' }));
        assert.equal(store.reject(draft.id).status, 'rejected');
        assert.throws(() => store.approve(draft.id, { add: () => ({ id: 'abc123abc123' }) as never }), /不能直接通过/);
    });

    test('新草稿写入明确过期时间，过期后保留预览但拒绝批准', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-expiry-'));
        let clock = new Date('2026-11-04T10:30:00.000Z');
        const store = aiPhotoDraftStore({ dir, now: () => clock });
        const draft = await store.generate(context({ kind: 'food', eventKey: 'food-expiry', dish: '番茄鸡蛋' }), async () => ({ bytes: jpeg(14), model: 'm' }));
        assert.equal(draft.expiresAt, '2026-11-04T13:20:00.000Z');
        assert.equal(aiPhotoDraftFreshness(draft, clock).fresh, true);
        clock = new Date('2026-11-04T13:20:00.000Z');
        const freshness = aiPhotoDraftFreshness(draft, clock);
        assert.equal(freshness.fresh, false);
        assert.match(freshness.fresh ? '' : freshness.reason, /过期.*不能再作为当前照片/);
        assert.deepEqual(store.preview(draft.id), { bytes: jpeg(14), type: 'image/jpeg' });
        assert.throws(() => store.approve(draft.id, { add: () => ({ id: 'abc123abc123' }) as never }), /已于.*过期/);
    });

    test('旧索引没有 expiresAt 时按事件时间和种类推导时效', () => {
        const old = { kind: 'view' as const, at: '2026-11-04T02:00:00.000Z' };
        assert.deepEqual(aiPhotoDraftFreshness(old, new Date('2026-11-04T03:59:59.999Z')), {
            fresh: true, expiresAt: '2026-11-04T04:00:00.000Z',
        });
        assert.equal(aiPhotoDraftFreshness(old, new Date('2026-11-04T04:00:00.000Z')).fresh, false);
        assert.deepEqual(aiPhotoDraftFreshness({ kind: 'view', at: 'bad', expiresAt: 'also-bad' }, new Date('bad')), {
            fresh: false, expiresAt: '', reason: '这张照片的时效信息无效，不能作为当前照片使用',
        });
    });

    test('审核前复核文件编号、内容和普通文件类型，拒绝替换图与目录', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-integrity-'));
        // 时钟钉在题材发生当晚：以前用真实时间，隔一天跑这条就全在「已过期」上失败（11-05 修）
        const store = aiPhotoDraftStore({ dir, now: () => new Date('2026-11-04T18:30:00+08:00') });
        const draft = await store.generate(context({ eventKey: 'integrity' }), async () => ({ bytes: jpeg(10), model: 'm' }));
        const source = join(dir, 'files', draft.file);
        writeFileSync(source, jpeg(11));
        assert.throws(() => store.approve(draft.id, { add: () => ({ id: 'abc123abc123' }) as never }), /内容与编号不一致/);

        writeFileSync(source, jpeg(10));
        renameSync(source, `${source}.old`);
        mkdirSync(source);
        assert.throws(() => store.approve(draft.id, { add: () => ({ id: 'abc123abc123' }) as never }), /文件不安全/);
    });

    test('拒绝符号链接索引', t => {
        const outside = mkdtempSync(join(tmpdir(), 'ai-photo-link-outside-'));
        const indexDir = mkdtempSync(join(tmpdir(), 'ai-photo-link-index-'));
        writeFileSync(join(outside, 'index.json'), JSON.stringify({ version: 1, entries: [] }));
        try { symlinkSync(join(outside, 'index.json'), join(indexDir, 'index.json'), 'file'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('当前 Windows 环境不允许创建符号链接'); throw error; }
        assert.throws(() => aiPhotoDraftStore({ dir: indexDir }), /索引不能是符号链接/);
    });

    test('拒绝符号链接图片目录', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'ai-photo-link-outside-'));
        const filesDir = mkdtempSync(join(tmpdir(), 'ai-photo-link-files-'));
        symlinkSync(outside, join(filesDir, 'files'), 'junction');
        const store = aiPhotoDraftStore({ dir: filesDir });
        let calls = 0;
        await assert.rejects(store.generate(context({ eventKey: 'link-dir' }), async () => { calls++; return { bytes: jpeg(12), model: 'm' }; }), /文件目录不安全/);
        assert.equal(calls, 0);
    });

    test('损坏索引中的编号与文件名错配会拒绝启动', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-bad-index-'));
        const entry = {
            id: 'aaaaaaaaaaaa', eventKey: 'bad', kind: 'cat', subject: '猫', caption: '猫',
            at: '2026-11-04T00:00:00.000Z', createdAt: '2026-11-04T00:00:00.000Z',
            file: 'bbbbbbbbbbbb.jpg', status: 'pending_review', model: 'm', promptHash: 'c'.repeat(64),
        };
        writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, entries: [entry] }));
        assert.throws(() => aiPhotoDraftStore({ dir }), /拒绝启动/);
    });
});
