import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    aiPhotoRequestService,
    currentAiPhotoContext,
    isExplicitCurrentPhotoRequest,
    requestCurrentAiPhoto,
    worldAiPhotoContexts,
} from '../src/proactive/ai-photo-requests.ts';
import type { WorldNow } from '../src/world/world.ts';
import type { AiPhotoContext, AiPhotoDraft, AiPhotoDraftStore } from '../src/vision/ai-photo-drafts.ts';

function draft(context: AiPhotoContext, createdAt = context.at): AiPhotoDraft {
    return {
        id: '0123456789ab', eventKey: context.eventKey, kind: context.kind, subject: context.subject,
        caption: context.caption, at: context.at, createdAt, file: '0123456789ab.jpg', status: 'pending_review',
        model: 'fake', promptHash: 'a'.repeat(64), ...(context.dish ? { dish: context.dish } : {}),
    };
}

function fakeStore(entries: AiPhotoDraft[] = [], fail = false): AiPhotoDraftStore {
    return {
        async generate(context) {
            if (fail) throw new Error('provider secret response');
            const made = draft(context);
            entries.push(made);
            return made;
        },
        list: status => entries.filter(entry => !status || entry.status === status).map(entry => ({ ...entry })),
        preview: () => { throw new Error('not used'); },
        approve: () => { throw new Error('not used'); },
        reject: () => { throw new Error('not used'); },
        status: () => ({ total: entries.length, pending: entries.length, approved: 0, rejected: 0 }),
    };
}

const context = (eventKey: string, at: Date): AiPhotoContext => ({
    kind: 'view', eventKey, subject: '普通窗外', caption: '窗外的一张', at: at.toISOString(),
});

test('自动请求按事件去重并限制每日生成数', async () => {
    const now = new Date('2026-11-04T10:00:00+08:00');
    const entries: AiPhotoDraft[] = [];
    const service = aiPhotoRequestService({
        store: fakeStore(entries), generator: async () => { throw new Error('store fake does not call it'); },
        stateFile: join(mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-')), 'state.json'), now: () => now, dailyMax: 1,
    });
    assert.equal(await service.request(context('qq-current:one', now)), 'generated');
    assert.equal(await service.request(context('qq-current:one', now)), 'existing');
    assert.equal(await service.request(context('qq-current:two', now)), 'daily_limit');
    assert.equal(entries.length, 1);
});

test('失败后进入持久冷却且日志不包含供应商错误正文', async () => {
    let now = new Date('2026-11-04T10:00:00+08:00');
    const logs: string[] = [];
    const stateFile = join(mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-')), 'state.json');
    const service = aiPhotoRequestService({
        store: fakeStore([], true), generator: async () => { throw new Error('unused'); },
        stateFile, now: () => now,
        failureCooldownMs: 60_000, log: message => logs.push(message),
    });
    assert.equal(await service.request(context('one', now)), 'failed');
    now = new Date(now.getTime() + 30_000);
    const reopened = aiPhotoRequestService({
        store: fakeStore([]), generator: async () => { throw new Error('unused'); }, stateFile, now: () => now, failureCooldownMs: 60_000,
    });
    assert.equal(await reopened.request(context('two', now)), 'cooldown');
    assert.equal(logs.some(line => line.includes('provider secret response')), false);
});

test('过期世界事件在调用供应商前跳过，不占生成次数或每日额度', async () => {
    const now = new Date('2026-11-04T18:00:00.000Z');
    let generated = 0;
    const store = fakeStore([]);
    const original = store.generate;
    store.generate = async (...args) => { generated++; return original(...args); };
    const service = aiPhotoRequestService({
        store, generator: async () => { throw new Error('不应调用'); },
        stateFile: join(mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-expired-')), 'state.json'), now: () => now,
    });
    assert.equal(await service.request(context('world:old-view', new Date('2026-11-04T10:00:00.000Z'))), 'expired');
    assert.equal(generated, 0);
    assert.equal(store.list().length, 0);
});

test('世界照片事件只在发生后建立带稳定事件键的事实上下文', () => {
    let found: AiPhotoContext | undefined;
    for (let day = 1; day <= 31 && !found; day++) {
        const date = `2026-10-${String(day).padStart(2, '0')}`;
        const fed = new Date(`${date}T08:00:00+08:00`);
        const world: WorldNow = {
            day: date, atSchool: true,
            cat: { name: '团子饼', today: { fed, seen: true }, yesterdayFed: true, foodDays: 3 },
            parcels: [], homework: [], events: [],
        };
        found = worldAiPhotoContexts(world, new Date(`${date}T23:00:00+08:00`)).find(value => value.kind === 'cat');
    }
    assert.ok(found);
    assert.match(found.eventKey, /^world:cat_photo:/);
    assert.equal(found.subject.includes('团子饼'), true);
});

test('QQ 当前照片请求不拿旧图：无审核图先请求，有精确审核图才返回编号', async () => {
    const at = new Date('2026-11-04T12:30:00+08:00');
    const world: WorldNow = {
        day: '2026-11-04', atSchool: true, parcels: [], homework: [], events: [],
        routine: { meals: [{ kind: 'lunch', start: new Date('2026-11-04T12:00:00+08:00'), end: new Date('2026-11-04T12:40:00+08:00'), where: 'canteen', dish: '番茄鸡蛋' }] },
    };
    assert.equal(isExplicitCurrentPhotoRequest('把你现在这顿饭拍给我看看'), true);
    assert.equal(isExplicitCurrentPhotoRequest('发张以前拍的风景'), false);
    assert.equal(currentAiPhotoContext('food', { ...world, routine: undefined }, at), undefined);

    const entries: AiPhotoDraft[] = [];
    const service = aiPhotoRequestService({
        store: fakeStore(entries), generator: async () => { throw new Error('unused'); },
        stateFile: join(mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-')), 'state.json'), now: () => at,
    });
    const first = requestCurrentAiPhoto(service, 'food', world, at, '番茄鸡蛋');
    assert.equal(first.state, 'requested');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entries.length, 1);
    entries[0] = { ...entries[0]!, status: 'approved', shelfId: 'fedcba987654' };
    assert.deepEqual(requestCurrentAiPhoto(service, 'food', world, at, '番茄鸡蛋'), {
        state: 'approved', eventKey: entries[0]!.eventKey, shelfId: 'fedcba987654',
    });

    const sameHour = currentAiPhotoContext('food', world, new Date('2026-11-04T12:55:00+08:00'), '番茄鸡蛋');
    assert.equal(sameHour?.eventKey, entries[0]!.eventKey);
    const nextMeal = currentAiPhotoContext('food', world, new Date('2026-11-04T18:30:00+08:00'), '番茄鸡蛋');
    assert.notEqual(nextMeal?.eventKey, entries[0]!.eventKey);
    const tomorrow = currentAiPhotoContext('food', { ...world, day: '2026-11-05' }, new Date('2026-11-05T12:30:00+08:00'), '番茄鸡蛋');
    assert.notEqual(tomorrow?.eventKey, entries[0]!.eventKey);
    assert.match(tomorrow?.eventKey ?? '', /^qq-current:food:2026-11-05:12:番茄鸡蛋$/);
});

test('已批准但已过期的精确照片也不能作为当前照片发送', () => {
    const at = new Date('2026-11-04T12:30:00+08:00');
    const world: WorldNow = { day: '2026-11-04', atSchool: true, parcels: [], homework: [], events: [] };
    const current = currentAiPhotoContext('view', world, at)!;
    const entries: AiPhotoDraft[] = [{
        ...draft(current), status: 'approved', shelfId: 'fedcba987654',
        expiresAt: '2026-11-04T04:29:59.000Z',
    }];
    const service = aiPhotoRequestService({
        store: fakeStore(entries), generator: async () => { throw new Error('unused'); },
        stateFile: join(mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-')), 'state.json'), now: () => at,
    });
    assert.deepEqual(requestCurrentAiPhoto(service, 'view', world, at), {
        state: 'unavailable', eventKey: current.eventKey,
    });
});
