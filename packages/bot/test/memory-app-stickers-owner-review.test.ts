import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { stickerShelf, type StickerEntry } from '../src/social/stickers.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, '合成表情等待超时'); await new Promise(done => setTimeout(done, 5)); } }
async function stopPure(stop: () => Promise<void> | undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.resolve(stop()), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('停止不能等待不合作的纯候选依赖')), 3000); })]); }
    finally { clearTimeout(timer); }
}
const now = new Date('2026-11-05T12:00:00+08:00');
type Stage = 'trend' | 'custom-source' | 'download' | 'describe' | 'decide' | 'favorites' | 'none';
const message = (url: string) => [{ type: 'image', data: { url, sub_type: 1, summary: '[动画表情]' } }];

/** A complete synthetic 1x1 RGBA PNG: real chunks/CRC, no decoder or network. */
function png(seed: number): Uint8Array {
    const chunk = (type: string, data: Buffer) => {
        const named = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
        for (const byte of named) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
        const header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([header, named, tail]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, seed, 60, 120, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(stage: Stage, via: 'discover' | 'message' = 'discover', lateFailure = false, favoriteOutcome: 'success' | 'reject' | 'throw' = 'success') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-stickers-owner-')), dataDir = join(root, 'data'), dir = join(dataDir, 'stickers'); mkdirSync(dir, { recursive: true });
    const previousFetch = globalThis.fetch, logs: string[] = [], calls: string[] = [];
    let app: App | undefined, release!: () => void, entered = false, favoriteCalls = 0, syncStop: Promise<void> | undefined, syncHeldLease: boolean | undefined;
    const held = new Promise<void>(done => { release = done; });
    const pause = async (where: Stage) => { if (where === stage) { entered = true; await held; if (lateFailure) throw new Error('SYNTHETIC_LATE_STICKER_ERROR'); } };
    const entries: StickerEntry[] = [];
    if (stage === 'favorites') {
        for (const seed of [1, 2]) {
            const bytes = png(seed), id = createHash('sha256').update(bytes).digest('hex').slice(0, 12), file = `${id}.png`; writeFileSync(join(dir, file), bytes);
            entries.push({ id, file, description: `合成表情${seed}`, tags: ['合成'], source: { kind: 'inbox', name: 'synthetic.png' }, createdAt: now.toISOString(), used: 0 });
        }
        writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, entries, seen: [] }));
    }
    const shelf = stickerShelf({ dir, now: () => new Date(now), log: line => logs.push(line), discoveryPerRun: 2, favoritesGapMs: 0,
        download: async url => { calls.push('download'); await pause('download'); return { type: 'image/png', bytes: png(url.endsWith('c.png') ? 3 : url.endsWith('b.png') ? 2 : 1) }; },
        describe: async () => { calls.push('describe'); await pause('describe'); return '合成小猫微笑'; },
        decide: async description => { calls.push('decide'); await pause('decide'); return { keep: true, description, tags: ['合成'] }; },
        ...(stage === 'favorites' ? { favorites: { add: () => {
            favoriteCalls++; calls.push('favorites');
            if (favoriteOutcome === 'throw') {
                entered = true; syncStop = app!.stop(); syncHeldLease = existsSync(join(dataDir, 'bot.lock'));
                throw new Error('SYNTHETIC_FAVORITE_SYNC_THROW');
            }
            return (async () => { await pause('favorites'); if (favoriteOutcome === 'reject') throw new Error('SYNTHETIC_FAVORITE_REJECTED_ACK'); return 'a'.repeat(32); })();
        } } } : {}),
        ...(via === 'discover' && stage !== 'favorites' ? stage === 'trend'
            ? { trendDiscover: async () => { calls.push('trend'); await pause('trend'); return ['https://synthetic.invalid/a.png']; } }
            : { discover: async () => { calls.push('custom-source'); await pause('custom-source'); return ['https://synthetic.invalid/a.png']; } } : {}),
    });
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], stickers: 'collect', biliStickers: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('Network prohibited in synthetic sticker fixture'); };
    const make = () => startApp({ config, stickers: shelf, sensitive: { on: () => false, describe: () => '' }, log: line => logs.push(line),
        transport: { friendHistory: async () => [], sendPrivateText: async () => 900 }, pipeline: { now: () => now.getTime(), settle: { quietMs: 0, maxMs: 0 }, generate: async () => '合成回应' } });
    const receive = (url: string, id = 100) => app!.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: id, real_seq: String(id), time: now.getTime() / 1000,
        raw_message: '', sender: { user_id: 10001 }, message: message(url) });
    const cleanup = async () => {
        release(); await app?.stop(); await settle(); globalThis.fetch = previousFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-stickers-owner-')); rmSync(root, { recursive: true, force: true });
    };
    try { app = make(); await app.connected(20000); if (via === 'message') receive('https://synthetic.invalid/a.png'); if (stage !== 'none') await until(() => entered); }
    catch (error) { await cleanup(); throw error; }
    return { root, dataDir, dir, shelf, calls, logs, entries, release, receive, favoriteCalls: () => favoriteCalls, syncStop: () => syncStop, syncHeldLease: () => syncHeldLease, stop: () => app!.stop(),
        index: () => existsSync(join(dir, 'index.json')) ? readFileSync(join(dir, 'index.json'), 'utf8') : undefined,
        images: () => readdirSync(dir).filter(name => name.endsWith('.png')).sort(),
        async restart() { await app!.stop(); app = make(); await app.connected(20000); await settle(); }, cleanup,
    };
}

for (const [stage, via] of [['trend', 'discover'], ['custom-source', 'discover'], ['download', 'discover'], ['describe', 'discover'], ['decide', 'discover'], ['download', 'message'], ['describe', 'message'], ['decide', 'message']] as const) {
    test(`真实App.stop取消表情${via}/${stage}，晚结果不后继或写index/image/log`, async () => {
        const f = await fixture(stage, via);
        try {
            await stopPure(f.stop); const calls = [...f.calls], logs = [...f.logs], index = f.index(), images = f.images();
            assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); f.release(); await settle();
            assert.deepEqual(f.calls, calls); assert.deepEqual(f.logs, logs); assert.equal(f.index(), index); assert.deepEqual(f.images(), images);
        } finally { await f.cleanup(); }
    });
}

test('表情纯模型晚失败不能在App停止后记错误正文', async () => {
    const f = await fixture('describe', 'message', true);
    try { await stopPure(f.stop); const logs = [...f.logs]; f.release(); await settle(); assert.deepEqual(f.logs, logs); assert.equal(f.shelf.status().count, 0); }
    finally { await f.cleanup(); }
});

test('已派QQ收藏add保ACK和index事实，App持锁等收尾且不再派队列第二个add', async () => {
    const f = await fixture('favorites');
    try {
        assert.equal(f.favoriteCalls(), 1); const stopping = f.stop(); await tick();
        const heldLease = existsSync(join(f.dataDir, 'bot.lock'));
        f.release(); await stopping; await settle();
        const state = JSON.parse(f.index()!) as { entries: StickerEntry[] };
        assert.deepEqual({ heldLease, firstAck: state.entries.find(entry => entry.id === f.entries[0]!.id)?.qq?.md5,
            secondUnsent: state.entries.find(entry => entry.id === f.entries[1]!.id)?.qq === undefined, calls: f.favoriteCalls(), releasedAfter: !existsSync(join(f.dataDir, 'bot.lock')) },
        { heldLease: true, firstAck: 'A'.repeat(32), secondUnsent: true, calls: 1, releasedAfter: true }, '保真收尾已派ACK，取消尚未派发的收藏队列');
    } finally { await f.cleanup(); }
});

test('已确认表情收藏和图片在正常App停止后保留', async () => {
    const f = await fixture('none');
    try { await until(() => f.shelf.status().count === 1); const index = f.index(), images = f.images(); await f.stop(); assert.equal(f.index(), index); assert.deepEqual(f.images(), images); }
    finally { await f.cleanup(); }
});

test('App只关闭自己的表情工作，借用同一shelf在停止后及新App仍可继续用', async () => {
    const f = await fixture('none', 'message');
    try {
        await until(() => f.shelf.status().count === 1); await f.stop();
        await f.shelf.consider(message('https://synthetic.invalid/b.png'), { from: 10001, messageId: 200 }); assert.equal(f.shelf.status().count, 2);
        await f.restart(); f.receive('https://synthetic.invalid/c.png', 300); await until(() => f.shelf.status().count === 3);
        assert.equal(f.images().length, 3); await f.stop(); assert.equal(f.shelf.status().count, 3);
    } finally { await f.cleanup(); }
});

test('取消App未完成候选后同一URL能由其他borrower重新处理，不被旧pending吞掉', async () => {
    const f = await fixture('describe', 'message'); let external: Promise<void> | undefined;
    try {
        await stopPure(f.stop);
        external = f.shelf.consider(message('https://synthetic.invalid/a.png'), { from: 10001, messageId: 200 });
        await settle(); assert.equal(f.calls.filter(call => call === 'download').length, 2, '取消旧scope必须释放候选资格，不能把新borrower算作仍在途');
        f.release(); await external; await settle(); assert.equal(f.shelf.status().count, 1);
    } finally { f.release(); await external; await f.cleanup(); }
});

test('QQ收藏已派add失败ACK先持锁收尾，不写伪qq且不派后继add', async () => {
    const f = await fixture('favorites', 'discover', false, 'reject');
    try {
        const stopping = f.stop(); await tick(); const heldLease = existsSync(join(f.dataDir, 'bot.lock'));
        f.release(); await stopping; await settle();
        const state = JSON.parse(f.index()!) as { entries: StickerEntry[] };
        assert.deepEqual({ heldLease, calls: f.favoriteCalls(), hasQq: state.entries.some(entry => entry.qq), count: state.entries.length, released: !existsSync(join(f.dataDir, 'bot.lock')) },
            { heldLease: true, calls: 1, hasQq: false, count: 2, released: true });
    } finally { await f.cleanup(); }
});

test('favorites.add函数体同步stop再抛错仍属于已登记调用，不写伪qq或丢失本地收藏', async () => {
    const f = await fixture('favorites', 'discover', false, 'throw');
    try {
        const drain = f.syncStop(); await drain; await settle();
        const state = JSON.parse(f.index()!) as { entries: StickerEntry[] };
        assert.deepEqual({ heldInside: f.syncHeldLease(), ownedDrain: drain instanceof Promise, calls: f.favoriteCalls(), hasQq: state.entries.some(entry => entry.qq), count: state.entries.length, released: !existsSync(join(f.dataDir, 'bot.lock')) },
            { heldInside: true, ownedDrain: true, calls: 1, hasQq: false, count: 2, released: true });
    } finally { await f.cleanup(); }
});
