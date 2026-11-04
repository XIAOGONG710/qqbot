import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { aiPhotoRequestService, currentAiPhotoContext, requestCurrentAiPhoto } from '../src/proactive/ai-photo-requests.ts';
import { createAiPhotoProviderPool, type AiPhotoProvider } from '../src/vision/ai-photo-provider.ts';
import { aiPhotoDraftStore } from '../src/vision/ai-photo-drafts.ts';
import { parseAiPhotoVisualReview, qualityCheckedAiPhotoGenerator } from '../src/vision/ai-photo-quality-adapter.ts';
import type { WorldNow } from '../src/world/world.ts';

function png(width = 1024, height = 1024): Uint8Array {
    const bytes = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    bytes[24] = 8;
    bytes[25] = 2;
    return new Uint8Array(bytes);
}

const visualReview = (matches: boolean) => parseAiPhotoVisualReview(JSON.stringify({
    sceneKind: 'view', confidence: 0.95, personCount: 0, faceCount: 0, handCount: 0,
    readableText: false, watermark: false, famousLandmark: false, cinematicStyle: false,
    subjectMatches: matches, dishMatches: true, weatherMatches: true, timeMatches: true, referenceMatches: true,
}));

test('当前照片从世界事实到预算、质量重试、人工批准再回到 QQ 保持闭环', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-e2e-'));
    const at = new Date('2026-11-04T12:30:00+08:00');
    const world: WorldNow = { day: '2026-11-04', atSchool: true, parcels: [], homework: [], events: [] };
    const context = currentAiPhotoContext('view', world, at)!;
    const logs: string[] = [];
    const provider: AiPhotoProvider = {
        id: 'local', local: true, baseUrl: 'http://127.0.0.1:8188/v1', apiKey: 'test-only', model: 'local-test', timeoutMs: 1000,
    };
    const pool = createAiPhotoProviderPool({
        dir: join(root, 'usage'), providers: [provider], dailyLimit: 2, now: () => at, log: line => logs.push(line),
        generate: async () => ({ bytes: png(), model: provider.model }),
    });
    const store = aiPhotoDraftStore({ dir: join(root, 'drafts'), now: () => at });
    let reviews = 0;
    const service = aiPhotoRequestService({
        store, stateFile: join(root, 'auto-state.json'), now: () => at,
        generator: (prompt, requestContext) => qualityCheckedAiPhotoGenerator({
            context: requestContext,
            generate: value => pool.generate(value),
            reviewer: async () => visualReview(++reviews > 1),
            maxQualityRegenerations: 1,
            log: line => logs.push(line),
        })(prompt),
    });

    assert.equal(await service.request(context), 'generated');
    assert.deepEqual(pool.status(), {
        day: '2026-11-04', attempts: 2, generated: 2, failed: 0, remaining: 0, providers: ['local'],
    });
    assert.equal(store.status().pending, 1);
    assert.equal(requestCurrentAiPhoto(service, 'view', world, at).state, 'pending');

    const draft = store.list('pending_review')[0]!;
    store.approve(draft.id, { add: () => ({ id: 'fedcba987654' }) as never });
    assert.deepEqual(requestCurrentAiPhoto(service, 'view', world, at), {
        state: 'approved', eventKey: context.eventKey, shelfId: 'fedcba987654',
    });
    assert.equal(logs.some(line => /test-only|http:\/\//.test(line)), false);
    assert.equal(logs.some(line => line.includes('不会自动发送')), true);
});

