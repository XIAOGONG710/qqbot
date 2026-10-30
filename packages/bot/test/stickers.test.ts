import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { imageStickerAllowance, rankStickers, STICKER_ONLY_SHARE, STICKER_SHORTLIST, STICKER_TURN_CHANCE, stickerCued, stickerOnlyTurn, stickerReactionWords, stickerShelf, stickerTurn, stripStickerArtifacts, type DownloadedSticker, type StickerEntry } from '../src/social/stickers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const png = (seed: number): DownloadedSticker => ({
    type: 'image/png',
    bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, seed]),
});

function setup(options: { keep?: boolean; discover?: string[]; trend?: string[]; same?: boolean; now?: () => Date; libraryMax?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-stickers-'));
    dirs.push(dir);
    const logs: string[] = [];
    const described: string[] = [];
    const downloaded: string[] = [];
    let tick = 0;
    const shelf = stickerShelf({
        dir,
        describe: async ({ url }) => { described.push(url); return url.includes('cat') ? '一只白猫捂着嘴偷笑' : '一只小狗歪头'; },
        decide: async description => ({ keep: options.keep ?? true, description, tags: ['好笑', '偷笑', '好笑'] }),
        download: async url => {
            downloaded.push(url);
            const seed = [...url].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 250 + 1;
            return png(options.same ? 1 : seed);
        },
        ...(options.trend ? { trendDiscover: async () => options.trend! } : {}),
        ...(options.discover ? { discover: async () => options.discover! } : {}),
        discoveryPerRun: 2,
        log: line => logs.push(line),
        now: options.now ?? (() => new Date(Date.UTC(2026, 9, 12, 1, 0, tick++))),
        ...(options.libraryMax ? { libraryMax: options.libraryMax } : {}),
    });
    return { dir, shelf, logs, described, downloaded };
}

describe('图片表情收藏（ADR 0063）', () => {
    test('名单联系人发来的图片表情：看过、喜欢才下载，落盘后可进提示词并解析发送指令', async () => {
        const { dir, shelf, logs, described, downloaded } = setup();
        await shelf.consider([{ type: 'image', data: { url: 'https://qq.invalid/cat.gif', sub_type: 1, summary: '[动画表情]' } }], { from: 10001, messageId: 7 });
        assert.deepEqual(described, ['https://qq.invalid/cat.gif']);
        assert.deepEqual(downloaded, ['https://qq.invalid/cat.gif']);
        assert.equal(shelf.status().count, 1);
        const prompt = shelf.prompt()!;
        assert.match(prompt, /一只白猫捂着嘴偷笑（好笑、偷笑）/);
        const id = /<sticker:([a-f0-9]{12})>/.exec(prompt)![1]!;
        const entry = shelf.resolve(`<sticker:${id}>`)!;
        assert.ok(existsSync(entry.file));
        assert.equal(shelf.history(`<sticker:${id}>`), '她发了个表情包：一只白猫捂着嘴偷笑');
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries[0].source, { kind: 'received', from: 10001, messageId: 7 });
        assert.ok(logs.some(line => line.includes('收藏 一只白猫捂着嘴偷笑')));
    });

    test('不喜欢的也只安全下载一次供识图，记住后同一地址不重复处理', async () => {
        const { shelf, described, downloaded } = setup({ keep: false });
        const message = [{ type: 'image', data: { url: 'https://qq.invalid/dog.gif', sub_type: 1, summary: '[动画表情]' } }];
        await shelf.consider(message, { from: 10001, messageId: 1 });
        await shelf.consider(message, { from: 10002, messageId: 2 });
        assert.deepEqual(described, ['https://qq.invalid/dog.gif']);
        assert.deepEqual(downloaded, ['https://qq.invalid/dog.gif']);
        assert.equal(shelf.prompt(), undefined);
    });

    test('QQ 自定义表情池每次只看少量候选；同内容不重复收藏', async () => {
        const urls = ['https://qq.invalid/a.gif', 'https://qq.invalid/b.gif', 'https://qq.invalid/c.gif'];
        const { dir, shelf, described } = setup({ discover: urls, same: true });
        await shelf.discover();
        await shelf.discover();
        assert.deepEqual(described, urls.slice(0, 2), '一次进程只发现一次、每次最多两个');
        assert.equal(shelf.status().count, 1, '下载内容相同只留一份');
        const afterRestart: string[] = [];
        const again = stickerShelf({
            dir,
            describe: async ({ url }) => { afterRestart.push(url); return '一只小狗歪头'; },
            decide: async description => ({ keep: true, description, tags: ['疑问'] }),
            download: async () => png(2),
            discover: async () => urls,
            discoveryPerRun: 2,
            log: () => {},
        });
        await again.discover();
        assert.deepEqual(afterRestart, [urls[2]], '重启后跳过看过的，继续往后翻');
        assert.equal(again.status().count, 2);
    });

    test('公开目录的候选每天最多审看 3 个（跨小时、跨重启都算），第二天重新计', async () => {
        const trend = Array.from({ length: 8 }, (_, i) => `https://zhaoolee.com/ChineseBQB/media/t${i + 1}.jpg`);
        let time = Date.UTC(2026, 9, 12, 1, 0, 0);
        const { dir, shelf, described } = setup({ trend, now: () => new Date(time) });
        await shelf.discover();
        assert.equal(described.length, 2, '这一小时的预算是 2');
        time += 2 * 3_600_000;
        await shelf.discover();
        assert.equal(described.length, 3, '今天只剩 1 个额度');
        time += 2 * 3_600_000;
        await shelf.discover();
        assert.equal(described.length, 3, '今天的额度用完了，不再审看');
        const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { trend: { count: number } };
        assert.equal(index.trend.count, 3);
        time += 24 * 3_600_000;
        await shelf.discover();
        assert.equal(described.length, 5, '第二天重新计，这一小时的预算 2');
    });

    test('持续更新的网络候选先经过同一收藏判断，再轮到 QQ 自定义表情', async () => {
        const { dir, shelf } = setup({
            trend: ['https://zhaoolee.com/ChineseBQB/media/cat.gif'],
            discover: ['https://qq.invalid/custom.gif'],
        });
        await shelf.discover();
        const sources = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries
            .map((entry: { source: unknown }) => entry.source);
        assert.deepEqual(sources, [
            { kind: 'bqb', name: 'ChineseBQB' },
            { kind: 'qq-custom' },
        ]);
    });

    test('每小时从微信/网页导入箱审看少量候选，网络直链和本地文件都记录来源', async () => {
        let at = Date.UTC(2026, 9, 12, 1);
        const { dir, shelf, described, downloaded } = setup({
            discover: ['https://qq.invalid/custom.gif'],
            now: () => new Date(at),
        });
        writeFileSync(join(dir, 'inbox', 'wechat', 'exported.png'), png(77).bytes);
        writeFileSync(join(dir, 'inbox', 'urls.txt'), '# 一行一个图片直链\nhttps://cdn.invalid/cat-web.gif\n');

        await shelf.discover();
        await shelf.discover();
        assert.equal(described.length, 2, '同一小时只跑一次，且本次预算为两个');
        assert.match(described[0]!, /^data:image\/png;base64,/);
        assert.equal(described[1], 'https://cdn.invalid/cat-web.gif');
        assert.deepEqual(downloaded, ['https://cdn.invalid/cat-web.gif'], '本地图片不再走网络下载器');
        const first = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
        assert.deepEqual(first.entries.map((entry: { source: unknown }) => entry.source), [
            { kind: 'inbox', name: 'exported.png' },
            { kind: 'web', name: 'cdn.invalid' },
        ]);

        at += 60 * 60_000;
        await shelf.discover();
        assert.equal(shelf.status().count, 3, '下一小时才继续看 QQ 自定义表情候选');
    });

    test('收藏达到上限时淘汰最久没用的，保留最近使用过的', async () => {
        const { dir, shelf } = setup({ libraryMax: 2 });
        await shelf.consider([{ type: 'image', data: { url: 'https://qq.invalid/a.gif', sub_type: 1 } }], { from: 1, messageId: 1 });
        await shelf.consider([{ type: 'image', data: { url: 'https://qq.invalid/b.gif', sub_type: 1 } }], { from: 1, messageId: 2 });
        const firstIds = [...shelf.prompt()!.matchAll(/<sticker:([a-f0-9]{12})>/g)].map(match => match[1]!);
        shelf.used(firstIds[0]!);
        await shelf.consider([{ type: 'image', data: { url: 'https://qq.invalid/c.gif', sub_type: 1 } }], { from: 1, messageId: 3 });

        assert.equal(shelf.status().count, 2);
        assert.ok(shelf.resolve(`<sticker:${firstIds[0]}>`), '最近使用过的仍在');
        assert.equal(shelf.resolve(`<sticker:${firstIds[1]}>`), undefined, '最久没用的被淘汰');
        assert.equal(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries.length, 2);
    });

    test('图片表情只作调味：最近八条已发、直接提问、照片请求、正事和刚被吵醒都禁用', () => {
        assert.equal(imageStickerAllowance([{ role: 'user', content: '哈哈哈哈' }]).allowed, true);
        for (const level of ['concern', 'high', 'imminent'] as const) {
            assert.equal(imageStickerAllowance([{ role: 'user', content: '嗯' }], undefined, false, level).allowed, false, `${level} 不依赖意图文案禁用表情包`);
        }
        assert.equal(imageStickerAllowance([
            { role: 'assistant', content: '她发了个表情包：白猫偷笑' },
            { role: 'user', content: '哈哈' },
        ]).allowed, false);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '你今天吃了什么？' }]).allowed, false);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '在干嘛' }], '他想看照片').allowed, false);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '我明天要考试，好焦虑' }]).allowed, false);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '醒醒' }], undefined, true).allowed, false);
    });

    // 10-22：线上 52 次图片表情判定只有 2 次放行（4%），真人约 9% 的轮次带表情包；“回应他刚说的那件事”这条最常见的意图行和招呼式问句原来整条挡掉
    test('招呼式的问句和“回应他刚说的那件事”不再挡表情；真问题、难过、照片这些认真的轮次照旧挡', () => {
        for (const text of ['在吗', '在吗？', '在干嘛', '在干嘛呀', '睡了吗', '吃了吗？', '想我没']) assert.equal(imageStickerAllowance([{ role: 'user', content: text }]).allowed, true, text);
        for (const text of ['你今天吃了什么？', '明天几点上课？', '为什么不回我', '你怎么了？']) assert.equal(imageStickerAllowance([{ role: 'user', content: text }]).allowed, false, text);
        const saysOwn = '[这一轮你想：回应他刚说的那件事；先对这件事本身有个反应（意外、羡慕、心疼、吐槽一句都行），别急着追问细节，真要问也只问一两个字]';
        assert.equal(imageStickerAllowance([{ role: 'user', content: '今天买了杯奶茶哈哈' }], saysOwn).allowed, true);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '过了！哈哈' }], '[这一轮你想：他刚说了件好事，替他高兴]').allowed, true);
        for (const intent of ['[这一轮你想：先直接回答他刚问的，不另起话题]', '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]', '[这一轮你想：他想看照片]']) {
            assert.equal(imageStickerAllowance([{ role: 'user', content: '哈哈哈' }], intent).allowed, false, intent);
        }
    });

    test('发送指令必须独占一行、编号存在且一轮最多一个', async () => {
        const { shelf } = setup();
        await shelf.consider([{ type: 'image', data: { url: 'https://qq.invalid/cat.gif', sub_type: 1 } }], { from: 1, messageId: 1 });
        const id = /<sticker:([a-f0-9]{12})>/.exec(shelf.prompt()!)![1]!;
        assert.equal(shelf.clean(`哈哈 <sticker:${id}>\n<sticker:${id}>\n<sticker:${id}>\n<sticker:000000000000>`), `哈哈\n<sticker:${id}>`);
        assert.equal(shelf.resolve(` <sticker:${id}> `)?.id, id);
        assert.equal(shelf.resolve(`哈哈<sticker:${id}>`), undefined);
        assert.equal(shelf.clean(`<sticker:${id}>`, false), '', '认真照顾轮次不发图片表情');
        assert.equal(shelf.clean('她发了个表情包：白猫偷笑\n正常文字'), '正常文字', '模型不能用历史描述冒充真图片');
        assert.equal(stripStickerArtifacts(`<sticker:${id}>\n[表情包：白猫偷笑]\n正常文字`), '正常文字', '没有发送权限的档位也清掉内部协议和占位文字');
        shelf.used(id);
        assert.equal(shelf.resolve(`<sticker:${id}>`)?.used, 1);
    });

    test('普通图片和纯文字不是图片表情，不进入收藏判断', async () => {
        const { shelf, described } = setup();
        await shelf.consider([{ type: 'image', data: { url: 'https://qq.invalid/photo.jpg', sub_type: 0, summary: '' } }, { type: 'text', data: { text: '看' } }], { from: 1, messageId: 1 });
        await shelf.consider('纯文字', { from: 1, messageId: 2 });
        assert.deepEqual(described, []);
    });
});

describe('图片表情：代码定哪几轮发、按他这句话挑一小撮（10-19，ADR 0063 调整）', () => {
    const entry = (id: string, description: string, tags: string[], used = 0): StickerEntry => ({
        id, file: `${id}.png`, description, tags, source: { kind: 'received', from: 1, messageId: 1 }, createdAt: '2026-10-12T00:00:00.000Z', used,
    });
    const shelf = [
        entry('aaaaaaaaaaa1', '卡通仓鼠盖被睡觉', ['晚安', '睡', '可爱']),
        entry('aaaaaaaaaaa2', '粉色小人举着食物兴奋', ['吃', '美食', '兴奋']),
        entry('aaaaaaaaaaa3', '白猫捂嘴偷笑', ['搞笑', '偷笑', '开心']),
        entry('aaaaaaaaaaa4', '小熊翻白眼', ['无语', '嫌弃']),
        entry('aaaaaaaaaaa5', '小狗歪头', ['可爱']),
    ];

    test('他这句话里有明确的反应才抽签：晚安、哈哈、抱抱、吃、无语、他发来的表情；「知道啦」「哦哦 好」这类没有', () => {
        for (const text of ['晚安', '先睡了啊宝', '哈哈哈哈你完了', '想你了，抱抱', '我先去吃饭了', '真是无语', '[动画表情]', '真的假的！！']) assert.equal(stickerCued(text), true, text);
        for (const text of ['知道啦', '哦哦 好', '图书馆三楼 两点', '反正十二月才正式考', '']) assert.equal(stickerCued(text), false, text);
        // 方括号没转义时线索成了字符类（/[(?:动画)?表情]/），带「表 情 动 画 ( ) ? :」的话都命中（2026-10-31 修）
        for (const text of ['今天心情不错', '这件事情我想想', '画画好难', '活动在周三', '你在干嘛?', '到了:']) assert.equal(stickerCued(text), false, text);
        assert.equal(stickerCued('[表情]'), true);
    });

    test('按他这句话排：命中反应词多的在前，同分的少用的在前；没有明确反应时找通用的', () => {
        assert.equal(rankStickers(shelf, '晚安')[0]!.id, 'aaaaaaaaaaa1');
        assert.equal(rankStickers(shelf, '我先去吃饭了')[0]!.id, 'aaaaaaaaaaa2');
        assert.equal(rankStickers(shelf, '哈哈哈哈你完了')[0]!.id, 'aaaaaaaaaaa3');
        assert.equal(rankStickers(shelf, '真是无语')[0]!.id, 'aaaaaaaaaaa4');
        // 同分的少用的在前
        const used = [entry('bbbbbbbbbbb1', '白猫偷笑', ['搞笑'], 5), entry('bbbbbbbbbbb2', '黄鸭大笑', ['搞笑'], 0)];
        assert.equal(rankStickers(used, '哈哈')[0]!.id, 'bbbbbbbbbbb2');
        assert.ok(stickerReactionWords('图书馆三楼').includes('可爱'), '没有明确反应 = 通用词');
        assert.equal(rankStickers(shelf, '晚安').length, shelf.length, '只排序不丢');
    });

    test('抽签：同一句每次一样；概率跟着配置走；没有他的话不抽', () => {
        const history = (i: number) => [{ role: 'user' as const, content: `第 ${i} 句哈哈`, time: new Date(Date.UTC(2026, 9, 19, 12, 0, i)).toISOString() }];
        const draws = (chance: number) => Array.from({ length: 2000 }, (_, i) => stickerTurn(history(i), chance)).filter(Boolean).length / 2000;
        assert.ok(Math.abs(draws(STICKER_TURN_CHANCE) - STICKER_TURN_CHANCE) < 0.04, String(draws(STICKER_TURN_CHANCE)));
        assert.equal(draws(0), 0);
        assert.equal(draws(1), 1);
        assert.equal(stickerTurn(history(3)), stickerTurn(history(3)));
        assert.equal(stickerTurn([{ role: 'assistant', content: '在' }]), false);
    });

    // ADR 0099：他自己的线上话里发表情的轮次约六成只有表情
    test('只发表情的抽签：占抽到发表情的轮次的 STICKER_ONLY_SHARE；同一句每次一样；和「发不发」的抽签互不影响；没有他的话不抽', () => {
        const history = (i: number) => [{ role: 'user' as const, content: `第 ${i} 句哈哈`, time: new Date(Date.UTC(2026, 9, 19, 12, 0, i)).toISOString() }];
        const only = (chance?: number) => Array.from({ length: 3000 }, (_, i) => stickerOnlyTurn(history(i), chance)).filter(Boolean).length / 3000;
        assert.ok(Math.abs(only() - STICKER_ONLY_SHARE) < 0.04, String(only()));
        assert.equal(only(0), 0);
        assert.equal(only(1), 1);
        assert.equal(stickerOnlyTurn(history(5)), stickerOnlyTurn(history(5)));
        assert.equal(stickerOnlyTurn([{ role: 'assistant', content: '在' }]), false);
        // 在“抽到发表情”的那些轮次里，只发表情的比例也是 STICKER_ONLY_SHARE（两个抽签不相关）
        const drawn = Array.from({ length: 6000 }, (_, i) => history(i)).filter(h => stickerTurn(h));
        const share = drawn.filter(h => stickerOnlyTurn(h)).length / drawn.length;
        assert.ok(Math.abs(share - STICKER_ONLY_SHARE) < 0.05, String(share));
    });

    test('传了他这一轮的话、且这一轮只发表情：提示词写明只回一行编号、别的什么都不写；还是只列按他这句话挑的几张', async () => {
        const { shelf: real } = setup();
        for (let i = 0; i < 10; i++) {
            await real.consider([{ type: 'image', data: { url: `https://qq.invalid/cat${i}.gif`, sub_type: 1, summary: '[动画表情]' } }], { from: 10001, messageId: i + 1 });
        }
        const only = real.prompt({ text: '哈哈哈', only: true })!;
        assert.match(only, /这一轮你只发一个图片表情，不写任何文字/);
        assert.match(only, /别的什么都不写/);
        assert.doesNotMatch(only, /文字回完以后/);
        assert.ok([...only.matchAll(/<sticker:([a-f0-9]{12})>：/g)].length <= STICKER_SHORTLIST);
        assert.match(real.prompt({ text: '哈哈哈' })!, /文字回完以后/, '没写 only 还是旧写法');
    });

    test('传了他这一轮的话：只列按它挑出来的几张并写明这一轮要发一个；不传还是旧办法（最久没用的 12 张）', async () => {
        const { shelf: real } = setup();
        for (let i = 0; i < 10; i++) {
            await real.consider([{ type: 'image', data: { url: `https://qq.invalid/cat${i}.gif`, sub_type: 1, summary: '[动画表情]' } }], { from: 10001, messageId: i + 1 });
        }
        const forced = real.prompt({ text: '晚安' })!;
        assert.match(forced, /这一轮你要发一个图片表情/);
        assert.ok([...forced.matchAll(/<sticker:([a-f0-9]{12})>：/g)].length <= STICKER_SHORTLIST);
        assert.match(forced, /编号只能从下面选/);
        const legacy = real.prompt()!;
        assert.match(legacy, /只有这轮真的合适时才用/);
        assert.equal(real.prompt({ text: '晚安' }) === legacy, false);
    });
});
