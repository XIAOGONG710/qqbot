import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { imageStickerAllowance, stickerShelf, stripStickerArtifacts, type DownloadedSticker } from '../src/stickers.ts';

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

    test('不喜欢的不下载并记住；同一地址再遇到不重复看', async () => {
        const { shelf, described, downloaded } = setup({ keep: false });
        const message = [{ type: 'image', data: { url: 'https://qq.invalid/dog.gif', sub_type: 1, summary: '[动画表情]' } }];
        await shelf.consider(message, { from: 10001, messageId: 1 });
        await shelf.consider(message, { from: 10002, messageId: 2 });
        assert.deepEqual(described, ['https://qq.invalid/dog.gif']);
        assert.deepEqual(downloaded, []);
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
        assert.equal(imageStickerAllowance([
            { role: 'assistant', content: '她发了个表情包：白猫偷笑' },
            { role: 'user', content: '哈哈' },
        ]).allowed, false);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '你今天吃了什么？' }]).allowed, false);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '在干嘛' }], '他想看照片').allowed, false);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '我明天要考试，好焦虑' }]).allowed, false);
        assert.equal(imageStickerAllowance([{ role: 'user', content: '醒醒' }], undefined, true).allowed, false);
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
