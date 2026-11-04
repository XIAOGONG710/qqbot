import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CompanionGateway, helloEnvelope } from '../src/gateway.ts';
import { CompanionClient } from '../src/client.ts';
import { MemoryPairingStore } from '../src/pairing.ts';
import { CompanionRuntime } from '../src/runtime.ts';
import { validatePhotoDraftSummary, validatePhotoReviewDecisionRequest } from '../src/photo-review.ts';

const draft = {
    id: 'abcdef123456', kind: 'cat' as const, status: 'pending_review' as const,
    caption: '土豆在路边待着', createdAt: '2026-11-04T04:00:00.000Z',
    thumbnail: { mediaId: 'abcdef0123456789', mime: 'image/jpeg' as const, bytes: 4096, width: 320, height: 320 },
};

const envelope = (kind: 'photo.review.list' | 'photo.review.decide', requestId: string, nonce: string, body: unknown, now: number) => ({
    v: 1 as const, kind, requestId, nonce, sentAt: new Date(now).toISOString(), body,
});

describe('手机伴侣照片审核协议（ADR 0245）', () => {
    test('摘要严格排除路径、提示词和任意缩略图 URL', () => {
        assert.equal(validatePhotoDraftSummary(draft).caption, '土豆在路边待着');
        assert.throws(() => validatePhotoDraftSummary({ ...draft, file: '../../secret.jpg' }), /不允许的字段/);
        assert.throws(() => validatePhotoDraftSummary({ ...draft, prompt: 'hidden prompt' }), /不允许的字段/);
        assert.throws(() => validatePhotoDraftSummary({ ...draft, thumbnail: { ...draft.thumbnail, url: 'https://example.invalid/a.jpg' } }), /不允许的字段/);
    });

    test('通过和拒绝都要求客户端明确确认', () => {
        assert.throws(() => validatePhotoReviewDecisionRequest({ draftId: draft.id, decision: 'approve' }), /明确确认/);
        assert.deepEqual(validatePhotoReviewDecisionRequest({ draftId: draft.id, decision: 'reject', confirmation: 'confirmed' }), { draftId: draft.id, decision: 'reject', confirmation: 'confirmed' });
    });

    test('客户端构造列表和确认请求，并只接受对应审核响应', () => {
        const now = Date.parse('2026-11-04T04:03:00.000Z');
        let nonce = 0;
        const client = new CompanionClient({ clientId: 'android-photo-client', pairingCode: 'ABCD-1234', capabilities: ['text'], now: () => now, nonce: () => `photo-client-nonce-${++nonce}` });
        const list = client.listPhotoDrafts({ status: 'pending_review' }, 'photo-client-list');
        assert.equal(list.kind, 'photo.review.list');
        const response = client.accept({ v: 1, requestId: 'resp-photo-client-list', kind: 'photo.review.list.result', sentAt: new Date(now).toISOString(), nonce: 'photo-server-nonce-01', body: { items: [draft], total: 1 } });
        assert.equal(response.kind, 'photo.review.list.result');
        const decision = client.decidePhotoDraft({ draftId: draft.id, decision: 'reject', confirmation: 'confirmed' }, 'photo-client-decision');
        assert.equal(decision.kind, 'photo.review.decide');
        assert.throws(() => client.accept({ v: 1, requestId: 'resp-photo-client-unknown', kind: 'photo.review.decision', sentAt: new Date(now).toISOString(), nonce: 'photo-server-nonce-02', body: { draftId: draft.id, status: 'rejected', reviewedAt: new Date(now).toISOString() } }), /对应的请求/);
    });

    test('未配对设备不能读取草稿，配对后只收到安全摘要', async () => {
        const now = Date.parse('2026-11-04T04:05:00.000Z');
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-photo-review', now);
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => message,
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
            onPhotoReviewList: async (_request, clientId) => {
                assert.equal(clientId, ticket.clientId);
                return { items: [draft], total: 1 };
            },
        }, () => now);
        const request = envelope('photo.review.list', 'photo-list-01', 'photo-list-nonce-01', { status: 'pending_review', limit: 10 }, now);
        assert.equal((await runtime.handle(request, 'photo-session')).accepted, false);
        assert.equal((await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'photo-hello-01', 'photo-hello-nonce-01', new Date(now).toISOString()), 'photo-session')).accepted, true);
        const result = await runtime.handle(request, 'photo-session');
        assert.equal(result.accepted, true);
        if (!result.accepted) return;
        assert.equal(result.response?.kind, 'photo.review.list.result');
        assert.deepEqual(result.response?.body, { items: [draft], total: 1 });
        assert.equal(JSON.stringify(result.response?.body).includes('file'), false);
        assert.equal(JSON.stringify(result.response?.body).includes('prompt'), false);
    });

    test('审核回调绑定设备和 requestId，临时审计失败可用同 requestId 重试', async () => {
        const now = Date.parse('2026-11-04T04:10:00.000Z');
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-photo-audit', now);
        let calls = 0;
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => message,
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
            onPhotoReviewDecision: async (request, clientId, requestId) => {
                calls += 1;
                assert.equal(clientId, ticket.clientId);
                assert.equal(requestId, 'photo-decide-01');
                assert.equal(request.confirmation, 'confirmed');
                if (calls === 1) throw new Error('audit backend unavailable: C:\\secret');
                return { draftId: request.draftId, status: 'approved', reviewedAt: new Date(now).toISOString() };
            },
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'photo-hello-02', 'photo-hello-nonce-02', new Date(now).toISOString()), 'photo-audit-session');
        const body = { draftId: draft.id, decision: 'approve', confirmation: 'confirmed' };
        const first = await runtime.handle(envelope('photo.review.decide', 'photo-decide-01', 'photo-decide-nonce-01', body, now), 'photo-audit-session');
        assert.equal(first.accepted, true);
        if (first.accepted) {
            assert.equal(first.response?.kind, 'error');
            assert.equal(JSON.stringify(first.response?.body).includes('secret'), false);
            assert.match(String((first.response?.body as { message?: string } | undefined)?.message), /稍后重试/);
        }
        const retry = await runtime.handle(envelope('photo.review.decide', 'photo-decide-01', 'photo-decide-nonce-02', body, now), 'photo-audit-session');
        assert.equal(retry.accepted, true);
        if (retry.accepted) {
            assert.equal(retry.response?.kind, 'photo.review.decision');
            assert.deepEqual(retry.response?.body, { draftId: draft.id, status: 'approved', reviewedAt: new Date(now).toISOString() });
        }
        assert.equal(calls, 2);
    });
});

