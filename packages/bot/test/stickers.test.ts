import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { stickerShelf, stripStickerArtifacts, type DownloadedSticker } from '../src/stickers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const png = (seed: number): DownloadedSticker => ({
    type: 'image/png',
    bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, seed]),
});

function setup(options: { keep?: boolean; discover?: string[]; same?: boolean } = {}) {
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
        download: async url => { downloaded.push(url); return png(options.same ? 1 : url.length); },
        ...(options.discover ? { discover: async () => options.discover! } : {}),
        discoveryPerRun: 2,
        log: line => logs.push(line),
        now: () => new Date(Date.UTC(2026, 9, 12, 1, 0, tick++)),
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
