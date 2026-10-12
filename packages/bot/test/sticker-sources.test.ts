import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { acceptBqbItem, BQB_BASE, BQB_DEFAULT_ALLOW, bqbDiscover, bqbPool } from '../src/sticker-sources.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-bqb-')); dirs.push(dir); return dir; };

let n = 0;
const item = (categoryTitle: string, extra: Record<string, unknown> = {}) => ({
    src: `media/${String(++n).padStart(4, '0')}abcdef.jpg`, categoryTitle, bytes: 40_000, width: 300, height: 300, animated: false, ...extra,
});
const catalog = () => [
    ...Array.from({ length: 30 }, () => item('白色小人👶🏻')),
    ...Array.from({ length: 4 }, () => item('是喵星人啦')),
    ...Array.from({ length: 4 }, () => item('开心鸭')),
    item('特朗普'), item('反港独'), item('冠状病毒'),
    item('微信网友贡献表情包 暂存 有时间慢慢整理'),
    item('是喵星人啦', { bytes: 3_000_000 }),
    item('是喵星人啦', { width: 20, height: 20 }),
    item('是喵星人啦', { src: 'https://evil.example/x.jpg' }),
    null, 'junk',
];

describe('表情包候选来源 bqb（ADR 0063 第二阶段）', () => {
    test('只收名单内的类别，时政、疫情、没审过的投稿类、太大太小、地址不对的一律不要', () => {
        const accepted = catalog().map(raw => acceptBqbItem(raw, BQB_DEFAULT_ALLOW)).filter(Boolean);
        assert.equal(accepted.length, 38);
        assert.deepEqual([...new Set(accepted.map(i => i!.category))].sort(), ['开心鸭', '是喵星人啦', '白色小人'].sort());
    });

    test('类别黑名单比名单优先：就算有人把时政类加进 allow 也不要', () => {
        assert.equal(acceptBqbItem(item('特朗普'), ['特朗普']), undefined);
        assert.equal(acceptBqbItem(item('反港独'), ['反港独']), undefined);
        assert.equal(acceptBqbItem(item('冠状病毒'), ['冠状病毒']), undefined);
        assert.ok(acceptBqbItem(item('狗🐶'), ['狗']));
    });

    test('候选池按类别轮流取：800 张的大类不会把别的类别挤掉', () => {
        const items = catalog().map(raw => acceptBqbItem(raw, BQB_DEFAULT_ALLOW)).filter((i): i is NonNullable<typeof i> => !!i);
        const pool = bqbPool(items, '2026-10-12', 9);
        const categories = new Set(pool.map(url => items.find(i => BQB_BASE + i.src === url)!.category));
        assert.equal(pool.length, 9);
        assert.equal(categories.size, 3);
        assert.ok(pool.every(url => url.startsWith(BQB_BASE + 'media/')));
    });

    test('同一天同一个池（重启不洗牌），换一天换一批', () => {
        const items = catalog().map(raw => acceptBqbItem(raw, BQB_DEFAULT_ALLOW)).filter((i): i is NonNullable<typeof i> => !!i);
        assert.deepEqual(bqbPool(items, '2026-10-12', 12), bqbPool(items, '2026-10-12', 12));
        assert.notDeepEqual(bqbPool(items, '2026-10-12', 12), bqbPool(items, '2026-10-13', 12));
    });

    test('目录只取一次、存成过滤后的小缓存；过期才重取；取不到时用旧缓存，没有缓存就报错', async () => {
        const dir = tmp();
        const logs: string[] = [];
        let calls = 0;
        let fail = false;
        let time = Date.UTC(2026, 9, 12, 4, 0, 0);
        const discover = bqbDiscover({
            dir, log: line => logs.push(line), pool: 6, now: () => new Date(time),
            fetchJson: async url => { calls++; assert.equal(url, `${BQB_BASE}catalog/search.json`); if (fail) throw new Error('断网'); return catalog(); },
        });
        const first = await discover();
        assert.equal(first.length, 6);
        assert.equal(calls, 1);
        const cached = JSON.parse(readFileSync(join(dir, 'bqb-catalog.json'), 'utf8')) as { items: unknown[] };
        assert.equal(cached.items.length, 38, '缓存里只有过滤后的项');
        await discover();
        assert.equal(calls, 1, '缓存没过期不重取');
        time += 8 * 86_400_000;
        fail = true;
        assert.equal((await discover()).length, 6, '取不到时继续用旧缓存');
        assert.equal(calls, 2);
        assert.ok(logs.some(line => line.includes('继续用旧缓存')));
        await assert.rejects(bqbDiscover({ dir: tmp(), log: () => {}, fetchJson: async () => { throw new Error('断网'); } })());
    });

    test('目录里新出现的类别只记一行日志、不自动收（新梗常常是新类别）', async () => {
        const dir = tmp();
        const logs: string[] = [];
        let time = Date.UTC(2026, 9, 12, 4, 0, 0);
        let rows: unknown[] = catalog();
        const discover = bqbDiscover({ dir, log: line => logs.push(line), pool: 50, now: () => new Date(time), fetchJson: async () => rows });
        const before = await discover();
        assert.ok(!logs.some(line => line.includes('新类别')), '第一次没有可比的旧目录');
        time += 8 * 86_400_000;
        rows = [...catalog(), item('某个新出的梗🆕'), item('某个新出的梗🆕')];
        const after = await discover();
        assert.ok(logs.some(line => line.includes('新类别') && line.includes('某个新出的梗')));
        assert.equal(after.length, before.length, '新类别不在名单里，候选不变');
    });

    test('名单收紧后，旧缓存里不再合格的项马上不出现', async () => {
        const dir = tmp();
        const base = { dir, log: () => {}, pool: 50, fetchJson: async () => catalog() };
        const all = await bqbDiscover(base)();
        assert.ok(all.length > 8);
        const only = await bqbDiscover({ ...base, allow: ['开心鸭'] })();
        assert.equal(only.length, 4);
    });
});
