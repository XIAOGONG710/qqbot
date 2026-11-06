import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { DEFAULT_MENU, dishesBetween } from '../src/life/menu.ts';
import { FOOD_QUERIES, foodVisionPrompt, judgeFood, parseCommonsFood } from '../src/vision/photo-sources.ts';
import { FOOD_MISS_RETRY_MS, FOOD_PER_DISH, FOOD_TRIES_PER_DISH, photoIntent, photoShelf, photoWanted, type FoodSource, type PhotoCandidate } from '../src/vision/photos.ts';
import { useSyntheticTerms } from './fixtures/card.ts';

// 猫名、城市名用合成角色的（ADR 0335）
useSyntheticTerms();

// ADR 0128：吃的照片。按菜名收（Commons，普通人随手拍的饭），看图把关；这一顿吃的什么就只发这道菜的
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('接下来要吃的菜', () => {
    test('dishesBetween：从这天起几天的午饭 + 晚饭，去重；menuFrom 之前的日子没有', () => {
        const dishes = dishesBetween(new Date(2026, 10, 10), 3);
        assert.ok(dishes.length >= 4 && dishes.length <= 6, dishes.join(','));
        assert.equal(new Set(dishes).size, dishes.length);
        const later = dishesBetween(new Date(2026, 10, 10), 3, DEFAULT_MENU, '2026-11-12');
        assert.ok(later.length >= 1 && later.length <= 2, later.join(','));
        assert.deepEqual(dishesBetween(new Date(2026, 10, 10), 2, DEFAULT_MENU, '2027-01-01'), []);
    });

    test('默认菜单里每一道菜都有搜索词（没有的那顿就没有照片，所以得是有意的）', () => {
        for (const dish of [...DEFAULT_MENU.lunch, ...DEFAULT_MENU.dinner]) assert.ok((FOOD_QUERIES[dish] ?? []).length > 0, `${dish} 没有搜索词`);
        for (const [dish, queries] of Object.entries(FOOD_QUERIES)) for (const q of queries) assert.match(q, /^[A-Za-z][A-Za-z -]+$/, `${dish}：${q}`);
    });
});

describe('Commons 搜索结果 → 候选', () => {
    const page = (title: string, extra: Record<string, unknown> = {}, license = 'CC BY-SA 4.0') => ({
        title,
        imageinfo: [{
            width: 3000, height: 2000, mime: 'image/jpeg', thumburl: `https://upload.wikimedia.org/thumb/${title}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/${title}`,
            extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="x">某位摄影师</a>' } }, ...extra,
        }],
    });
    const body = (...pages: unknown[]) => ({ query: { pages: Object.fromEntries(pages.map((p, i) => [String(i), p])) } });

    test('收 CC0 / 公有领域 / CC BY / CC BY-SA（含版本号）；不收 NC / ND / 不认识的许可', () => {
        const ok = ['CC0', 'Public domain', 'CC BY 2.0', 'CC BY 4.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0', 'CC BY-SA 2.5', 'CC BY 2.0 de'];
        const bad = ['CC BY-NC 4.0', 'CC BY-ND 4.0', 'CC BY-NC-SA 3.0', 'All rights reserved', 'GFDL', ''];
        const hits = (license: string) => parseCommonsFood('兰州拉面', body(page('File:A.jpg', {}, license)));
        for (const license of ok) assert.equal(hits(license).length, 1, license);
        for (const license of bad) assert.equal(hits(license).length, 0, license || '(空)');
        const c = hits('CC BY-SA 4.0')[0]!;
        assert.equal(c.kind, 'food');
        assert.equal(c.series, '兰州拉面');
        assert.equal(c.artist, '某位摄影师');
        assert.equal(c.license, 'CC BY-SA 4.0');
    });

    test('不是 jpeg / 太小 / 比例不对 / 图片地址不是 upload.wikimedia.org 的都不要', () => {
        const hits = parseCommonsFood('炒饭', body(
            page('File:a.jpg'),
            page('File:b.png', { mime: 'image/png' }),
            page('File:c.jpg', { width: 1200, height: 800 }),
            page('File:d.jpg', { width: 4000, height: 1000 }),
            page('File:e.jpg', { thumburl: 'https://evil.example/x.jpg' }),
        ));
        assert.deepEqual(hits.map(h => h.title), ['File:a.jpg']);
    });
});

describe('看图把关的规则', () => {
    const good = { 人脸: false, 水印: false, 招牌: false, 是这道菜: true, 一份饭: true, 实拍: true, 清晰: true, 说明: '白碗里盛着牛肉面，配香菜和勺子，放在灰色桌面' };
    const judge = (patch: Record<string, unknown> = {}, dish = '兰州拉面') => judgeFood(dish, JSON.stringify({ ...good, ...patch }));

    test('全都过才收', () => {
        assert.equal(judge().keep, true);
        assert.match(foodVisionPrompt('兰州拉面'), /兰州拉面/);
    });

    test('有人脸 / 水印 / 招牌、没说清有没有、不是这道菜、不是一份饭、不是实拍、不清晰：都不收，并说明原因', () => {
        const cases: [Record<string, unknown>, RegExp][] = [
            [{ 人脸: true }, /人脸/], [{ 人脸: undefined }, /没明确说没有人脸/], [{ 水印: true }, /水印/], [{ 水印: '可能' }, /没明确说没有水印/],
            [{ 招牌: true }, /招牌/], [{ 是这道菜: false }, /不是兰州拉面/], [{ 一份饭: false }, /不是一份做好的饭/], [{ 实拍: false }, /实拍/], [{ 清晰: false }, /清晰/],
        ];
        for (const [patch, reason] of cases) {
            const judged = judge(patch);
            assert.equal(judged.keep, false, JSON.stringify(patch));
            assert.match(judged.reason ?? '', reason, JSON.stringify(patch));
        }
    });

    test('说明太短 / 太长 / 带地名或外文：不收；不是 JSON：不收', () => {
        assert.equal(judge({ 说明: '一碗面' }).keep, false);
        assert.equal(judge({ 说明: '一碗面'.repeat(20) }).keep, false);
        assert.equal(judge({ 说明: '兰州街头小店里的一碗牛肉面汤' }).keep, false);
        assert.equal(judge({ 说明: 'A bowl of noodles on a table' }).keep, false);
        assert.equal(judgeFood('炒饭', '我觉得是炒饭').keep, false);
    });
});

describe('货架：按菜名收、按菜名发', () => {
    const fakeSource = (db: Record<string, PhotoCandidate[]>, options: { judge?: (dish: string, n: number) => boolean; failAt?: string } = {}) => {
        const calls = { search: [] as string[], download: 0, judged: 0 };
        const source: FoodSource = {
            search: async (dish, offset = 0) => { calls.search.push(`${dish}@${offset}`); if (options.failAt === dish) throw new Error('Commons 搜索返回 429'); return offset === 0 ? db[dish] ?? [] : []; },
            download: async () => { calls.download++; return { bytes: new Uint8Array(200 * 1024).fill(calls.download), type: 'image/jpeg' as const }; },
            judge: async (_image, dish) => { calls.judged++; return options.judge?.(dish, calls.judged) === false ? { keep: false, caption: '', reason: '测试不收' } : { keep: true, caption: `一碗${dish}放在木桌上` }; },
        };
        return { source, calls };
    };
    const candidate = (dish: string, n: number): PhotoCandidate => ({ kind: 'food', title: `File:${dish}-${n}.jpg`, pageUrl: 'https://commons.wikimedia.org/x', imageUrl: `https://upload.wikimedia.org/${dish}-${n}.jpg`, width: 3000, height: 2000, license: 'CC BY-SA 4.0', artist: '某人', series: dish });
    const make = (source: FoodSource, clock = { t: Date.parse('2026-11-10T08:00:00Z') }) => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-food-'));
        dirs.push(dir);
        const logs: string[] = [];
        const shelf = photoShelf({ dir, log: m => logs.push(m), foodSource: source, pauseMs: 0, now: () => new Date(clock.t) });
        return { shelf, logs, clock, dir, reopen: () => photoShelf({ dir, log: () => undefined, pauseMs: 0 }) };
    };

    test('每道菜收到 FOOD_PER_DISH 张为止；只有这道菜的照片算这道菜；没给菜名 = 没有', async () => {
        const { source, calls } = fakeSource({ 兰州拉面: [1, 2, 3, 4].map(n => candidate('兰州拉面', n)), 麻辣烫: [1].map(n => candidate('麻辣烫', n)) });
        const { shelf, reopen } = make(source);
        assert.equal(await shelf.discoverFood(['兰州拉面', '麻辣烫', '黄焖鸡米饭']), 'done');
        assert.equal(shelf.list('food', '兰州拉面').length, FOOD_PER_DISH);
        assert.equal(shelf.list('food', '麻辣烫').length, 1);
        assert.equal(shelf.has('food', '黄焖鸡米饭'), false, '搜不到就没有');
        assert.equal(shelf.has('food'), false, '没给菜名 = 没有');
        assert.equal(shelf.has('food', '兰州拉面'), true);
        assert.equal(shelf.status().byKind.food, FOOD_PER_DISH + 1);
        assert.ok(calls.download <= FOOD_PER_DISH + 1 + 1);
        const entry = shelf.list('food', '兰州拉面')[0]!;
        assert.equal(entry.dish, '兰州拉面');
        assert.equal(entry.origin?.license, 'CC BY-SA 4.0');
        assert.equal(entry.origin?.artist, '某人');
        // 重新打开还在，菜名也在
        assert.equal(reopen().list('food', '兰州拉面').length, FOOD_PER_DISH);
        assert.equal(reopen().has('food', '麻辣烫'), true);
    });

    test('提示词：只列这道菜的，写明是这一顿拍的（可以说刚拍的）；别的种类的提示词不变', async () => {
        const { source } = fakeSource({ 炒饭: [1, 2].map(n => candidate('炒饭', n)), 麻辣烫: [1, 2].map(n => candidate('麻辣烫', n)) });
        const { shelf } = make(source);
        await shelf.discoverFood(['炒饭', '麻辣烫']);
        const prompt = shelf.prompt('food', '炒饭')!;
        assert.ok(prompt.includes('一碗炒饭放在木桌上') && !prompt.includes('一碗麻辣烫'), prompt);
        assert.match(prompt, /这一顿你拍的「炒饭」，可以说是吃饭时拍的/);
        assert.doesNotMatch(prompt, /别说成刚拍的/);
        assert.equal(shelf.prompt('food'), undefined);
        assert.equal(shelf.prompt('food', '水饺'), undefined);
        assert.equal(shelf.resolve(`<photo:${shelf.list('food', '炒饭')[0]!.id}>`)?.dish, '炒饭');
    });

    test('看过的不再看；看图不收的算看过；一道菜一轮最多试 FOOD_TRIES_PER_DISH 张', async () => {
        const many = Array.from({ length: 10 }, (_, n) => candidate('炒饭', n));
        const { source, calls } = fakeSource({ 炒饭: many }, { judge: () => false });
        const { shelf } = make(source);
        await shelf.discoverFood(['炒饭']);
        assert.equal(calls.judged, FOOD_TRIES_PER_DISH);
        assert.equal(shelf.has('food', '炒饭'), false);
        const before = calls.judged;
        await shelf.discoverFood(['炒饭']);
        assert.equal(calls.judged - before, FOOD_TRIES_PER_DISH, '下一轮看的是后面的几张，前面看过的不再看');
        assert.ok(calls.judged <= many.length);
    });

    test('搜不到的菜 FOOD_MISS_RETRY_MS 内不再搜；限流 / 断网：这一轮停并让调用方稍后再来', async () => {
        const { source, calls } = fakeSource({});
        const { shelf, clock } = make(source);
        await shelf.discoverFood(['酸辣粉']);
        await shelf.discoverFood(['酸辣粉']);
        assert.equal(calls.search.filter(s => s.startsWith('酸辣粉')).length, 1, '刚搜过没有，不再搜');
        clock.t += FOOD_MISS_RETRY_MS + 1000;
        await shelf.discoverFood(['酸辣粉']);
        assert.equal(calls.search.filter(s => s.startsWith('酸辣粉')).length, 2, '过了 6 小时再搜');
        const limited = fakeSource({}, { failAt: '炒饭' });
        const second = make(limited.source);
        assert.equal(await second.shelf.discoverFood(['炒饭']), 'retry');
        assert.ok(second.logs.some(l => l.includes('找「炒饭」的照片失败')));
    });

    test('没配吃的来源：什么都不做', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-food-'));
        dirs.push(dir);
        const shelf = photoShelf({ dir, log: () => undefined });
        assert.equal(await shelf.discoverFood(['炒饭']), 'done');
        assert.equal(shelf.has('food', '炒饭'), false);
    });
});

describe('他想看吃的', () => {
    test('photoWanted：要看 + 吃的 / 午饭 / 晚饭 / 外卖 → food；猫、风景、作品、没有明确对象的不变', () => {
        for (const text of ['拍给我看看你吃的', '午饭吃的啥发我看看', '看看你的晚饭', '发张外卖的照片', '你吃了啥拍一张', '食堂的饭给我看看']) assert.equal(photoWanted(text), 'food', text);
        assert.equal(photoWanted('看看团子饼'), 'cat');
        assert.equal(photoWanted('看看窗外的晚霞'), 'view');
        assert.equal(photoWanted('发你拍的片子来看看'), 'work');
        assert.equal(photoWanted('发张照片看看'), 'any');
        assert.equal(photoWanted('中午吃的啥呀'), undefined, '没有要看的意思');
        assert.equal(photoWanted('发张自拍看看'), undefined, '自拍照旧不在');
    });

    test('意图行：说是哪一顿、吃的什么，细节看“你那边”，不编；先带一句再另起一行放照片', () => {
        const text = photoIntent('food');
        for (const phrase of ['哪一顿', '看「你那边」吃的那一行', '没写的细节不编', '另起一行单独发照片']) assert.ok(text.includes(phrase), phrase);
        assert.doesNotMatch(text, /以前拍的/);
    });
});
