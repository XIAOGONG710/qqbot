import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { aiPhotoLivePreflight, runAiPhotoLiveCheck } from '../src/ops/ai-photo-live-check.ts';
import { aiPhotoDraftStore, type AiPhotoContext } from '../src/vision/ai-photo-drafts.ts';
import type { AiPhotoProvider } from '../src/vision/ai-photo-provider.ts';

const png = () => {
    const bytes = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(1024, 16);
    bytes.writeUInt32BE(1024, 20);
    bytes[24] = 8;
    bytes[25] = 2;
    return new Uint8Array(bytes);
};

const provider: AiPhotoProvider = { id: 'primary', baseUrl: 'https://image.example/v1', apiKey: 'secret', model: 'image-model', timeoutMs: 1000, local: false };

describe('真实生图闭环验收', () => {
    test('预检只报告供应商角色与阻塞项，不暴露配置正文', () => {
        assert.deepEqual(aiPhotoLivePreflight({ providers: [provider], dailyLimit: 4, visualReview: true }), {
            ready: true, providers: ['primary'], dailyLimit: 4, visualReview: true, blockers: [],
        });
        const blocked = aiPhotoLivePreflight({ providers: [], dailyLimit: 0, visualReview: false });
        assert.equal(blocked.ready, false);
        assert.equal(JSON.stringify(blocked).includes('secret'), false);
        assert.equal(blocked.blockers.length, 3);
    });

    test('显式确认后生成、落盘并重新读取，但停在待审核状态', async () => {
        const at = new Date('2026-11-04T10:00:00.000Z');
        const store = aiPhotoDraftStore({ dir: join(mkdtempSync(join(tmpdir(), 'photo-live-')), 'drafts'), now: () => at });
        const context: AiPhotoContext = { kind: 'view', eventKey: 'smoke:2026-11-04T10:00', subject: '普通窗外景色', caption: '窗外随手拍', at: at.toISOString() };
        const result = await runAiPhotoLiveCheck({
            confirmed: true, context, store, now: () => at,
            generator: async () => ({ bytes: png(), model: 'test-model' }),
        });
        assert.equal(result.status, 'pending_review');
        assert.equal(result.mime, 'image/png');
        assert.equal(result.bytes, 33);
        assert.deepEqual(store.status(), { total: 1, pending: 1, approved: 0, rejected: 0 });
    });

    test('没有确认、过期事件和重复事件键都在供应商调用前失败', async () => {
        const now = new Date('2026-11-04T12:00:00.000Z');
        const store = aiPhotoDraftStore({ dir: join(mkdtempSync(join(tmpdir(), 'photo-live-guard-')), 'drafts'), now: () => now });
        const current: AiPhotoContext = { kind: 'desk', eventKey: 'smoke:new', subject: '普通书桌', caption: '桌面', at: now.toISOString() };
        let calls = 0;
        const generator = async () => { calls++; return { bytes: png(), model: 'test-model' }; };
        await assert.rejects(runAiPhotoLiveCheck({ confirmed: false, context: current, store, generator, now: () => now }), /confirm-live/);
        await assert.rejects(runAiPhotoLiveCheck({ confirmed: true, context: { ...current, eventKey: 'smoke:old', at: '2026-11-04T01:00:00.000Z' }, store, generator, now: () => now }), /过期/);
        await runAiPhotoLiveCheck({ confirmed: true, context: current, store, generator, now: () => now });
        await assert.rejects(runAiPhotoLiveCheck({ confirmed: true, context: current, store, generator, now: () => now }), /事件键已经生成过/);
        assert.equal(calls, 1);
    });
});
