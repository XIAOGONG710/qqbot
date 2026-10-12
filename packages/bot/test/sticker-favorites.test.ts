import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { qqFavorites, type QqCall } from '../src/sticker-favorites.ts';
import { stickerShelf, type DownloadedSticker, type StickerFavorites } from '../src/stickers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-fav-')); dirs.push(dir); return dir; };
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

describe('QQ 收藏的表情接口适配（ADR 0063，10-12 在真号上验证过各步返回）', () => {
    test('add：算文件 md5（大写）、用 add_custom_face 加进收藏并返回 md5', async () => {
        const dir = tmp();
        const file = join(dir, 'a.png');
        writeFileSync(file, 'sticker-bytes');
        const calls: [string, Record<string, unknown>][] = [];
        const call: QqCall = async (action, params) => { calls.push([action, params]); return { result: 0, errMsg: '', isExist: 0 }; };
        const md5 = await qqFavorites(call).favorites.add(file);
        assert.equal(md5, createHash('md5').update('sticker-bytes').digest('hex').toUpperCase());
        assert.deepEqual(calls, [['add_custom_face', { file, is_origin: true }]]);
    });

    test('remove：按 md5（不分大小写）在收藏列表里找 resId 再删；没有就什么都不删', async () => {
        const calls: [string, Record<string, unknown>][] = [];
        const call: QqCall = async (action, params) => {
            calls.push([action, params]);
            if (action === 'fetch_custom_face_detail') return [{ md5: 'AAAA', resId: 'r-a', url: 'https://p.qpic.cn/a' }, { md5: 'BBBB', resId: 'r-b' }, { nonsense: true }];
            return { result: 0 };
        };
        const { favorites } = qqFavorites(call);
        await favorites.remove('bbbb');
        assert.deepEqual(calls.at(-1), ['delete_custom_face', { res_id: 'r-b' }]);
        calls.length = 0;
        await favorites.remove('CCCC');
        assert.deepEqual(calls.map(([action]) => action), ['fetch_custom_face_detail']);
    });

    test('discover：只返回别处加进 QQ 收藏的（跳过我们同步进去的），没有地址或 md5 的项忽略', async () => {
        const call: QqCall = async () => [
            { md5: 'AAAA', resId: 'r-a', url: 'https://p.qpic.cn/a' },
            { md5: 'BBBB', resId: 'r-b', url: 'https://p.qpic.cn/b' },
            { md5: 'CCCC', resId: 'r-c' },
            { resId: 'r-d', url: 'https://p.qpic.cn/d' },
            'junk',
        ];
        assert.deepEqual(await qqFavorites(call).discover(new Set(['AAAA'])), ['https://p.qpic.cn/b']);
        assert.deepEqual(await qqFavorites(async () => 'not-a-list').discover(new Set()), []);
    });
});

const png = (seed: number): DownloadedSticker => ({ type: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, seed]) });

function shelfWith(options: { failFirst?: boolean; libraryMax?: number; perSync?: number; discover?: (known: ReadonlySet<string>) => Promise<string[]> } = {}) {
    const dir = tmp();
    const logs: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    let failed = !options.failFirst;
    const favorites: StickerFavorites = {
        async add(file) {
            if (!failed) { failed = true; throw new Error('QQ 没回应'); }
            added.push(file);
            return createHash('md5').update(readFileSync(file)).digest('hex').toUpperCase();
        },
        async remove(md5) { removed.push(md5); },
    };
    let time = Date.UTC(2026, 9, 12, 1, 0, 0);
    const shelf = stickerShelf({
        dir,
        describe: async () => '一只小狗歪头',
        decide: async description => ({ keep: true, description, tags: ['可爱'] }),
        download: async url => png(Number(url.split('/').at(-1))),
        favorites,
        favoritesGapMs: 0,
        ...(options.perSync ? { favoritesPerSync: options.perSync } : {}),
        ...(options.libraryMax ? { libraryMax: options.libraryMax } : {}),
        ...(options.discover ? { discover: options.discover } : {}),
        log: line => logs.push(line),
        now: () => new Date(time),
    });
    const consider = (n: number) => shelf.consider([{ type: 'image', data: { url: `https://qq.invalid/${n}`, sub_type: 1, summary: '[动画表情]' } }], { from: 1, messageId: n });
    return { dir, shelf, logs, added, removed, consider, advance: (ms: number) => { time += ms; } };
}

const indexOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { entries: { id: string; qq?: { md5: string } }[] };

describe('收藏同步进 QQ 账号的收藏的表情', () => {
    test('每收藏一张就同步加进 QQ 收藏（绝对路径），md5 记进 index.json', async () => {
        const { dir, consider, added } = shelfWith();
        await consider(1);
        await settle();
        assert.equal(added.length, 1);
        assert.ok(isAbsolute(added[0]!));
        const entry = indexOf(dir).entries[0]!;
        assert.match(entry.qq!.md5, /^[0-9A-F]{32}$/);
    });

    test('同步失败只记日志、本地收藏不受影响；下一次发现时补上', async () => {
        const { dir, shelf, consider, logs, added, advance } = shelfWith({ failFirst: true });
        await consider(1);
        await settle();
        assert.ok(logs.some(line => line.includes('QQ 收藏操作失败') && line.includes('QQ 没回应')));
        assert.equal(indexOf(dir).entries.length, 1);
        assert.equal(indexOf(dir).entries[0]!.qq, undefined);
        advance(2 * 3_600_000);
        await shelf.discover();
        await settle();
        assert.equal(added.length, 1);
        assert.ok(indexOf(dir).entries[0]!.qq);
    });

    test('淘汰最久没用的时，也把它从 QQ 收藏里删掉（按 md5）', async () => {
        const { dir, consider, removed } = shelfWith({ libraryMax: 1 });
        await consider(1);
        await settle();
        const first = indexOf(dir).entries[0]!.qq!.md5;
        await consider(2);
        await settle();
        assert.deepEqual(removed, [first]);
        assert.equal(indexOf(dir).entries.length, 1);
    });

    test('上线前就收了的补同步：每次发现最多补 perSync 张，已经同步过的不再加', async () => {
        const { dir, added } = shelfWith();
        // 先在没有同步能力的情况下存 3 张（模拟上线前的存货）
        const plain = stickerShelf({ dir, describe: async () => '一只小狗歪头', decide: async description => ({ keep: true, description, tags: [] }), download: async url => png(Number(url.split('/').at(-1))), log: () => {} });
        for (const n of [11, 12, 13]) await plain.consider([{ type: 'image', data: { url: `https://qq.invalid/${n}`, sub_type: 1, summary: '[动画表情]' } }], { from: 1, messageId: n });
        assert.equal(indexOf(dir).entries.length, 3);
        const again = stickerShelf({
            dir, describe: async () => '', decide: async description => ({ keep: false, description, tags: [] }), log: () => {},
            favorites: { async add(file) { added.push(file); return createHash('md5').update(readFileSync(file)).digest('hex').toUpperCase(); }, async remove() {} },
            favoritesGapMs: 0, favoritesPerSync: 2,
        });
        await again.discover();
        await settle();
        assert.equal(added.length, 2, '这一次只补 2 张');
        assert.equal(indexOf(dir).entries.filter(entry => entry.qq).length, 2);
    });

    test('discover 拿到的是已同步进 QQ 收藏的 md5：QQ 收藏池里它们不会被当成新候选再看一遍', async () => {
        let known: ReadonlySet<string> = new Set();
        const { consider, shelf, advance } = shelfWith({ discover: async set => { known = set; return []; } });
        await consider(1);
        await settle();
        advance(2 * 3_600_000);
        await shelf.discover();
        assert.equal(known.size, 1);
        assert.match([...known][0]!, /^[0-9A-F]{32}$/);
    });
});
