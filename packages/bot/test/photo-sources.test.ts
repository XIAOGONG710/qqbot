import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { COMMONS_USER_AGENT, commonsSearch, judgePhoto, parseCommons, PHOTO_VISION_PROMPT, seriesKey, type CommonsFetch } from '../src/photo-sources.ts';
import { PHOTO_DISCOVERY_PER_RUN, PHOTO_TARGET, photoShelf, type PhotoCandidate, type PhotoJudgement, type PhotoKind, type PhotoSource } from '../src/photos.ts';

// ADR 0109（用户 10-22：照片从网上找高清的、记得去水印）：来源只取 CC0 / 公有领域，看图把关，水印 / 人物没有明确说“没有”就不收

const page = (title: string, info: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
    title,
    imageinfo: [{
        width: 4032, height: 3024, mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/2560px-x.jpg',
        url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/x.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:x.jpg',
        extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: '<a href="x">Some Author</a>' }, ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, { value: v }])) },
        ...info,
    }],
});
const body = (...pages: ReturnType<typeof page>[]) => ({ query: { pages: Object.fromEntries(pages.map((p, i) => [String(i + 1), p])) } });

describe('Commons 搜索结果 → 候选', () => {
    test('只留 jpeg、够大、比例正常、CC0 / 公有领域、地址在 upload.wikimedia.org 的；出处和系列 key 带上', () => {
        const list = parseCommons('cat', body(
            page('File:Calico cat, Lebanon 3.jpg'),
            page('File:Png one.png', { mime: 'image/png' }),
            page('File:Small.jpg', { width: 1800, height: 1200 }),
            page('File:Panorama.jpg', { width: 12000, height: 3000 }),
            page('File:Needs credit.jpg', {}, { LicenseShortName: 'CC BY-SA 4.0' }),
            page('File:Cc zero.jpg', {}, { LicenseShortName: 'CC0' }),
            page('File:Elsewhere.jpg', { thumburl: 'https://example.com/a.jpg' }),
        ));
        assert.deepEqual(list.map(c => c.title), ['File:Calico cat, Lebanon 3.jpg', 'File:Cc zero.jpg']);
        const [first] = list;
        assert.equal(first!.series, 'Calico cat, Lebanon');
        assert.equal(first!.artist, 'Some Author');
        assert.equal(first!.license, 'Public domain');
        assert.equal(first!.width, 4032);
        assert.ok(first!.imageUrl.includes('2560px'));
    });

    test('系列 key：去掉 File:、扩展名、结尾编号', () => {
        assert.equal(seriesKey('File:Calico cat, Lebanon 10.jpg'), 'Calico cat, Lebanon');
        assert.equal(seriesKey('File:Calico cat, Assisi, Italy.jpg'), 'Calico cat, Assisi, Italy');
        assert.equal(seriesKey('File:British shorthair with calico coat (1).jpg'), 'British shorthair with calico coat');
    });

    test('搜索：带说明性 User-Agent、翻页起点、2560 宽缩略图；返回非 200 抛错；没有搜索词的种类不搜', async () => {
        const urls: string[] = [];
        const headers: Record<string, string>[] = [];
        const ok: CommonsFetch = async (url, init) => { urls.push(url); headers.push(init.headers); return { ok: true, status: 200, json: async () => body(page('File:Calico cat 1.jpg')) }; };
        const search = commonsSearch({ fetch: ok });
        assert.equal((await search('cat', 30)).length, 1);
        assert.match(urls[0]!, /gsroffset=30/);
        assert.match(urls[0]!, /iiurlwidth=2560/);
        assert.match(urls[0]!, /calico\+cat/);
        assert.equal(headers[0]!['user-agent'], COMMONS_USER_AGENT);
        assert.deepEqual(await search('work'), [], '作品不走网络');
        const limited = commonsSearch({ fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
        await assert.rejects(() => limited('cat'), /429/);
    });
});

describe('看图把关（水印、人物必须明确说“没有”）', () => {
    const good = { 人物: false, 水印: false, 猫: true, 三花: true, 天空: false, 清晰: true, 说明: '一只三花猫蹲在水泥地上，周围是绿草，光线柔和' };
    const judge = (kind: PhotoKind, o: Record<string, unknown>, wrap = (s: string) => s) => judgePhoto(kind, wrap(JSON.stringify(o)));

    test('合格：三花猫、没有人、没有水印、清晰 → 收，带说明；JSON 前后有别的字也认', () => {
        assert.deepEqual(judge('cat', good), { keep: true, caption: good.说明 });
        assert.equal(judge('cat', good, s => `好的，结果如下：\n${s}\n以上`).keep, true);
        assert.equal(judge('view', { ...good, 猫: false, 三花: false, 天空: true, 说明: '黄昏的天空，云层被染成橘红色' }).keep, true);
    });

    test('水印：有 → 不收；没回答 / 含糊 → 也不收（宁可少收）', () => {
        assert.equal(judge('cat', { ...good, 水印: true }).reason, '有水印 / 文字 / 相框');
        const { 水印: _omit, ...withoutKey } = good;
        assert.equal(judge('cat', withoutKey).reason, '没明确说没有水印');
        assert.equal(judge('cat', { ...good, 水印: '不确定' }).keep, false);
        assert.equal(judge('cat', { ...good, 水印: 'false' }).keep, true, '字符串 false 当没有');
    });

    test('人物同理；不清晰不收；种类不对不收（猫要是三花、天空要以天空为主）', () => {
        assert.equal(judge('cat', { ...good, 人物: true }).reason, '画面里有人');
        const { 人物: _p, ...noPeopleKey } = good;
        assert.equal(judge('cat', noPeopleKey).reason, '没明确说没有人');
        assert.equal(judge('cat', { ...good, 清晰: false }).reason, '不够清晰');
        assert.equal(judge('cat', { ...good, 三花: false }).reason, '不是三花猫');
        assert.equal(judge('cat', { ...good, 猫: false }).reason, '不是三花猫');
        assert.equal(judge('view', { ...good, 天空: false }).reason, '不是以天空为主');
    });

    test('说明：太短 / 太长 / 带地名、品种、外文都不收；解析不了不收', () => {
        assert.equal(judge('cat', { ...good, 说明: '一只猫' }).reason, '说明太短或太长');
        assert.equal(judge('cat', { ...good, 说明: '猫'.repeat(60) }).reason, '说明太短或太长');
        assert.equal(judge('cat', { ...good, 说明: '黎巴嫩街头的一只三花猫蹲着晒太阳' }).reason, '说明里带了地名或品种');
        assert.equal(judge('cat', { ...good, 说明: '一只英国短毛猫趴在窗台上晒太阳' }).reason, '说明里带了地名或品种');
        assert.equal(judge('cat', { ...good, 说明: 'A calico cat sitting on grass today' }).reason, '说明里带了地名或品种');
        assert.equal(judgePhoto('cat', '没有 JSON').keep, false);
        assert.equal(judgePhoto('cat', '{坏的').keep, false);
    });

    test('济南没有的东西不收：模型明说有棕榈 / 热带植物 / 沙滩，或说明里写了；字段没回答不拦（只在明确说「有」时拦）', () => {
        const sky = { ...good, 猫: false, 三花: false, 天空: true, 说明: '黄昏的天空，云层被染成橘红色' };
        assert.equal(judge('view', { ...sky, 热带: true }).reason, '画面里有济南没有的东西（棕榈 / 热带植物 / 沙滩 / 海面 / 岛屿 / 大片水面）');
        assert.equal(judge('view', { ...sky, 说明: '金黄云霞铺满蓝天，底部是棕榈树和树丛的黑色剪影' }).keep, false);
        assert.equal(judge('view', { ...sky, 说明: '蓝天下的沙滩和海浪，光线明亮' }).keep, false);
        assert.equal(judge('view', { ...sky, 说明: '平静水面倒映着橙蓝渐变的晚霞与云层' }).keep, false);
        assert.equal(judge('view', { ...sky, 说明: '粉蓝紫霞光布满天空，下方是深色山影与海面' }).keep, false);
        assert.equal(judge('view', { ...sky, 热带: false }).keep, true);
        assert.equal(judge('view', sky).keep, true, '字段没回答：照旧收');
        assert.ok(PHOTO_VISION_PROMPT.includes('"热带"'));
    });

    test('场景里的招牌 / 外文不收（水印检查只管叠加的字）：模型明说有，或说明里写了；没回答不拦', () => {
        const sky = { ...good, 猫: false, 三花: false, 天空: true, 说明: '黄昏的天空，云层被染成橘红色' };
        assert.equal(judge('view', { ...sky, 招牌: true }).reason, '画面里有招牌 / 文字');
        assert.equal(judge('view', { ...sky, 说明: '日落天空，左下角有一块圆形广告牌' }).keep, false);
        assert.equal(judge('view', { ...sky, 招牌: false }).keep, true);
        assert.equal(judge('view', sky).keep, true);
        assert.ok(PHOTO_VISION_PROMPT.includes('"招牌"'));
    });

    test('给看图模型的要求里写明了：四个角和边缘、署名、日期戳、版权标记、相框', () => {
        for (const word of ['四个角', '水印', '徽标', '署名', '日期戳', '版权', '相框', 'JSON']) assert.ok(PHOTO_VISION_PROMPT.includes(word), word);
    });
});

describe('货架自己去网上找（discover）', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    const cand = (kind: PhotoKind, title: string, series = title.replace(/ \d+$/, '')): PhotoCandidate => ({
        kind, title: `File:${title}.jpg`, pageUrl: `https://commons.wikimedia.org/wiki/File:${title}.jpg`, imageUrl: `https://upload.wikimedia.org/${title}.jpg`,
        width: 4032, height: 3024, license: 'Public domain', artist: 'x', series,
    });
    const bytes = (n: number) => new Uint8Array(150 * 1024).fill(n % 250);
    function setup(over: Partial<PhotoSource> & { judged?: (title: string) => PhotoJudgement } = {}) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-disc-'));
        dirs.push(dir);
        const logs: string[] = [];
        const calls = { search: [] as string[], download: [] as string[], judge: 0 };
        let n = 0;
        const source: PhotoSource = {
            search: over.search ?? (async (kind, offset = 0) => { calls.search.push(`${kind}@${offset}`); return kind === 'cat' ? [cand('cat', 'Calico cat, Lebanon 1'), cand('cat', 'Calico cat, Lebanon 2'), cand('cat', 'Calico cat, Lebanon 3'), cand('cat', 'Calico cat, Assisi 1')] : []; }),
            download: over.download ?? (async url => { calls.download.push(url); return { bytes: bytes(++n), type: 'image/jpeg' as const }; }),
            judge: over.judge ?? (async () => { calls.judge++; return { keep: true, caption: '一只三花猫蹲在水泥地上，周围是绿草' }; }),
        };
        const shelf = photoShelf({ dir, log: m => logs.push(m), source, pauseMs: 0, now: () => new Date('2026-10-23T12:00:00Z') });
        return { dir, logs, calls, shelf, reopen: () => photoShelf({ dir, log: m => logs.push(m), source, pauseMs: 0 }) };
    }

    test('猫：同一个系列放一起（候选最多的那个系列）；每次最多收 PHOTO_DISCOVERY_PER_RUN 张；出处记下来；文件真的落盘', async () => {
        const { shelf, dir, calls } = setup();
        assert.equal(await shelf.discover(), 'done');
        assert.equal(calls.download.length, PHOTO_DISCOVERY_PER_RUN);
        const cats = shelf.list('cat');
        assert.equal(cats.length, PHOTO_DISCOVERY_PER_RUN);
        assert.ok(cats.every(c => c.origin?.series === 'Calico cat, Lebanon' && c.origin.license === 'Public domain'));
        assert.equal(readdirSync(join(dir, 'files')).length, PHOTO_DISCOVERY_PER_RUN);
        // 下一轮接着收同一系列里剩下的，不去碰另一个系列
        await shelf.discover();
        assert.deepEqual(shelf.list('cat').map(c => c.origin!.title).sort(), ['File:Calico cat, Lebanon 1.jpg', 'File:Calico cat, Lebanon 2.jpg', 'File:Calico cat, Lebanon 3.jpg']);
        assert.ok(!calls.download.some(u => u.includes('Assisi')));
    });

    test('被拒的不收，也记成看过、下次不再下载；暂时的错误（429）停这一轮、不记看过、下次再来', async () => {
        let mode: 'reject' | 'limit' | 'ok' = 'reject';
        const { shelf, calls, logs } = setup({
            judge: async () => (mode === 'reject' ? { keep: false, caption: '', reason: '有水印 / 文字 / 相框' } : { keep: true, caption: '一只三花猫蹲在水泥地上，周围是绿草' }),
            download: async url => { if (mode === 'limit') throw new Error('download returned 429'); return { bytes: bytes(url.length), type: 'image/jpeg' as const }; },
        });
        await shelf.discover();
        assert.equal(shelf.list().length, 0);
        assert.ok(logs.some(m => m.includes('不收 File:Calico cat, Lebanon 1.jpg（有水印')));
        mode = 'limit';
        assert.equal(await shelf.discover(), 'retry');
        assert.ok(logs.some(m => m.includes('暂时的错误')));
        mode = 'ok';
        await shelf.discover();
        // 前两张（被拒的）不再下载；被限流的第 3 张没记成看过，这次能收
        assert.deepEqual(shelf.list('cat').map(c => c.origin!.title), ['File:Calico cat, Lebanon 3.jpg']);
        assert.ok(calls.search.length >= 3);
    });

    test('太小的图（不是高清）不收；找失败只记日志；已经够了就不再找；没有来源不做事；同一时刻只跑一个', async () => {
        const small = setup({ download: async () => ({ bytes: new Uint8Array(50 * 1024), type: 'image/jpeg' as const }) });
        await small.shelf.discover();
        assert.equal(small.shelf.list().length, 0);
        assert.ok(small.logs.some(m => m.includes('文件太小')));

        const broken = setup({ search: async () => { throw new Error('ENOTFOUND commons.wikimedia.org'); } });
        assert.equal(await broken.shelf.discover(), 'retry', '断网这类暂时的错误：让调用方过一会儿再来');
        assert.ok(broken.logs.some(m => m.includes('找cat失败')));
        const odd = setup({ search: async () => { throw new Error('JSON 解析不了'); } });
        assert.equal(await odd.shelf.discover(), 'done', '不是暂时的错误：不重试');

        const full = setup();
        for (let i = 0; i < (PHOTO_TARGET.cat ?? 0) / PHOTO_DISCOVERY_PER_RUN + 1; i++) await full.shelf.discover();
        const before = full.calls.search.length;
        await full.shelf.discover();
        assert.equal(full.shelf.list('cat').length, Math.min(PHOTO_TARGET.cat!, 3), '候选只有 3 张同系列的');

        const noneDir = mkdtempSync(join(tmpdir(), 'qqbot-photo-none-'));
        dirs.push(noneDir);
        const none = photoShelf({ dir: noneDir, log: () => {} });
        await none.discover();
        assert.equal(none.status().count, 0);
        assert.ok(before > 0);

        const slow = setup({ search: async kind => { await new Promise(r => setTimeout(r, 20)); return kind === 'cat' ? [cand('cat', 'Calico cat, Lebanon 1')] : []; } });
        await Promise.all([slow.shelf.discover(), slow.shelf.discover()]);
        assert.equal(slow.shelf.list('cat').length, 1);
    });

    test('收下的照片重新打开还在，出处不丢；货架里的照片能被正常取用（提示词、清理、解析）', async () => {
        const { shelf, reopen } = setup();
        await shelf.discover();
        const again = reopen();
        const entry = again.list('cat')[0]!;
        assert.equal(entry.origin?.license, 'Public domain');
        assert.ok(again.prompt('cat')!.includes(entry.id));
        assert.equal(again.clean(`翻到一张\n<photo:${entry.id}>`), `翻到一张\n<photo:${entry.id}>`);
        assert.ok(again.resolve(`<photo:${entry.id}>`)!.file.endsWith('.jpg'));
    });
});
