import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { BiliAccount, EmotePack } from '../src/bilibili/bilibili-account.ts';
import {
    acceptCommentPicture, biliStickerDiscover, biliStickerScreen, BILI_STICKER_PER_DAY, officialStickers, picturesOf, STICKER_UNCUED_CHANCE,
} from '../src/language/bili-stickers.ts';
import { stickerShelf, stickerTurn, type StickerEntry } from '../src/social/stickers.ts';

// ADR 0132：她自己在 B 站找表情包；不用或少用小黄脸
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-bili-sticker-')); dirs.push(d); return d; };
const pic = (w: number, h: number, kb: number, id = 'a') => ({ img_src: `https://i0.hdslb.com/bfs/new_dyn/${id}.png`, img_width: w, img_height: h, img_size: kb });
const pack = (text: string, n = 3): EmotePack => ({ id: n, text, urls: Array.from({ length: n }, (_, i) => `https://i0.hdslb.com/bfs/emote/${text}${i}.png`) });

describe('评论区图片：像不像表情包（只看尺寸）', () => {
    test('宽高 100–1000、比例 0.5–2、≤ 700 KB 才要；大图（截图 / 宣传图）、太小、太扁、太大的不要', () => {
        assert.equal(acceptCommentPicture(pic(537, 577, 361)), 'https://i0.hdslb.com/bfs/new_dyn/a.png');
        for (const bad of [pic(2000, 1116, 873), pic(1260, 1658, 730), pic(80, 80, 6), pic(900, 300, 100), pic(300, 900, 100), pic(500, 500, 800)]) assert.equal(acceptCommentPicture(bad), undefined, JSON.stringify(bad));
        assert.equal(acceptCommentPicture({ img_src: 'javascript:alert(1)', img_width: 500, img_height: 500, img_size: 100 }), undefined);
        assert.equal(acceptCommentPicture({}), undefined);
    });

    test('热评列表里挑图片（含楼中楼）；没有图 / 格式不对不出错', () => {
        const body = { data: { replies: [
            { content: { pictures: [pic(500, 500, 100, 'x'), pic(3000, 2000, 900, 'big')] }, replies: [{ content: { pictures: [pic(400, 600, 200, 'y')] } }, { content: {} }] },
            { content: { message: '没有图' } },
        ] } };
        assert.deepEqual(picturesOf(body).map(u => u.slice(-5)), ['x.png', 'y.png']);
        assert.deepEqual(picturesOf(undefined), []);
        assert.deepEqual(picturesOf({ data: { replies: 'x' } }), []);
    });
});

describe('官方表情包：只取热词系列和 tv_小电视，不要小黄脸、颜文字', () => {
    test('officialStickers', () => {
        const urls = officialStickers([pack('小黄脸', 5), pack('热词系列一', 2), pack('tv_小电视', 2), pack('颜文字', 4)]);
        assert.equal(urls.length, 4);
        assert.ok(urls.every(u => /热词系列一|tv_小电视/.test(decodeURIComponent(u))));
        assert.ok(!urls.some(u => /小黄脸|颜文字/.test(decodeURIComponent(u))));
    });
});

describe('候选来源', () => {
    const account = (packs: EmotePack[] | 'fail'): BiliAccount => ({ emotePackages: async () => { if (packs === 'fail') throw new Error('登录态不对'); return packs; } }) as unknown as BiliAccount;
    const fakeFetch = (replies: unknown) => async (url: string) => {
        const body = url.includes('popular') ? { data: { list: [{ aid: 1 }, { aid: 2 }] } } : replies;
        return { ok: true, status: 200, json: async () => body };
    };
    const comments = { data: { replies: [{ content: { pictures: [pic(500, 500, 100, 'c1'), pic(600, 400, 100, 'c2')] } }] } };
    const make = (packs: EmotePack[] | 'fail', replies: unknown, fallback?: () => Promise<string[]>) => {
        const logs: string[] = [];
        return { logs, discover: biliStickerDiscover({ account: async () => account(packs), fetch: fakeFetch(replies) as never, now: () => new Date(2026, 10, 12, 12, 0), log: m => logs.push(m) }, fallback) };
    };

    test('官方的和评论区的交替排；官方只有热词 / 小电视；评论区图片都是尺寸合格的', async () => {
        const { discover } = make([pack('小黄脸', 5), pack('热词系列一', 3)], comments);
        const urls = await discover();
        assert.ok(urls.length >= 4, `${urls.length}`);
        assert.ok(urls.some(u => u.includes('/bfs/emote/')) && urls.some(u => u.includes('/bfs/new_dyn/')));
        assert.ok(!urls.some(u => decodeURIComponent(u).includes('小黄脸')));
        assert.ok(urls.slice(0, 2).some(u => u.includes('/bfs/emote/')) && urls.slice(0, 2).some(u => u.includes('/bfs/new_dyn/')), '交替');
    });

    test('官方读不到（登录态不对）：只有评论区的，记一行日志；都没有就用兜底（原来的公开目录）', async () => {
        const broken = make('fail', comments);
        const urls = await broken.discover();
        assert.ok(urls.length >= 2 && urls.every(u => u.includes('/bfs/new_dyn/')));
        assert.ok(broken.logs.some(l => l.includes('读官方表情包失败') && l.includes('登录态不对')));
        const empty = make([], { data: { replies: [] } }, async () => ['https://example.com/bqb.png']);
        assert.deepEqual(await empty.discover(), ['https://example.com/bqb.png']);
        const nothing = make([], { data: { replies: [] } });
        assert.deepEqual(await nothing.discover(), []);
    });
});

describe('收藏前的筛（只对评论区图片）', () => {
    test('真人的照片、截图、广告引流不收；动漫 / 游戏 / 动物 / 卡通 / 文字梗照旧收；官方表情包不筛', () => {
        const comment = { kind: 'bili', name: 'comment' };
        for (const text of ['白西装男子咧嘴笑看上方', '红白格子衬衫男士举臂大笑', '银白短发Coser眨眼比手势', '聊天界面风格，文字框表现手滑点赞老板', '视频字幕界面', '含加粉丝团引流文字', '游戏画面里角色站在草地']) {
            assert.ok(biliStickerScreen(text, comment), text);
        }
        for (const text of ['橘猫面无表情直视镜头，显无语冷漠', '卡通京剧猫戴彩冠大眼睛微笑', '白底黑色手写风格大字“好家伙”', '蓝色宝可梦握拳严肃望旁', '柴犬把前爪伸进石狮嘴里']) {
            assert.equal(biliStickerScreen(text, comment), undefined, text);
        }
        assert.equal(biliStickerScreen('白西装男子咧嘴笑', { kind: 'bili', name: 'emote' }), undefined);
        assert.equal(biliStickerScreen('白西装男子咧嘴笑', { kind: 'bqb' }), undefined);
    });
});

describe('表情包收藏：换来源、筛、没有明确反应也抽', () => {
    const png = () => ({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, (_, i) => i)]), type: 'image/png' as const });
    const make = (urls: string[], descriptions: Record<string, string>) => {
        const logs: string[] = [];
        let fresh = 0;
        const shelf = stickerShelf({
            dir: tmp(), log: m => logs.push(m), download: async () => { fresh++; const image = png(); image.bytes[20] = fresh; return image; },
            describe: async ({ url }) => descriptions[url] ?? '一只橘猫',
            decide: async description => ({ keep: true, description, tags: ['可爱'] }),
            trendDiscover: async () => ['https://example.com/old-bqb.png'],
            screen: biliStickerScreen, discoveryPerRun: 10, trendPerDay: 10, discoveryIntervalMs: 0,
        });
        shelf.setTrend?.(() => async () => urls, BILI_STICKER_PER_DAY);
        return { shelf, logs };
    };
    const entries = (shelf: { prompt(c?: { text: string }): string | undefined }) => shelf.prompt({ text: '在吗' }) ?? '';

    test('setTrend 换来源：收的是 B 站的；来源标 bili（官方 emote / 评论区 comment）；筛掉的不收并写明原因', async () => {
        const urls = ['https://i0.hdslb.com/bfs/emote/a.png', 'https://i0.hdslb.com/bfs/new_dyn/b.png', 'https://i0.hdslb.com/bfs/new_dyn/c.png'];
        const { shelf, logs } = make(urls, { [urls[1]!]: '白西装男子咧嘴笑看上方', [urls[2]!]: '卡通京剧猫大眼睛微笑' });
        await shelf.discover();
        assert.equal(shelf.status().count, 2, logs.join('\n'));
        assert.ok(logs.some(l => l.includes('真人的照片') && l.includes('白西装男子')));
        assert.ok(!logs.some(l => l.includes('old-bqb')));
        assert.ok(entries(shelf).length > 0);
    });

    test('perDay：B 站这路每天最多审看 BILI_STICKER_PER_DAY 个（原来公开目录是 3 个）', async () => {
        const urls = Array.from({ length: 12 }, (_, i) => `https://i0.hdslb.com/bfs/emote/${i}.png`);
        const { shelf } = make(urls, {});
        await shelf.discover();
        assert.equal(shelf.status().count, BILI_STICKER_PER_DAY);
    });

    test('stickerTurn 的 salt：没有明确反应那条路的抽签和有反应那条路的互不影响；概率约等于给的', () => {
        const chats = Array.from({ length: 400 }, (_, i) => [{ role: 'user' as const, content: `今天吃了拉面${i}`, time: `2026-11-12T20:${String(i % 60).padStart(2, '0')}:00+08:00` }]);
        const plain = chats.filter(chat => stickerTurn(chat, STICKER_UNCUED_CHANCE)).length / chats.length;
        const uncued = chats.filter(chat => stickerTurn(chat, STICKER_UNCUED_CHANCE, 'sticker uncued')).length / chats.length;
        for (const rate of [plain, uncued]) assert.ok(rate > STICKER_UNCUED_CHANCE * 0.5 && rate < STICKER_UNCUED_CHANCE * 1.6, `${rate}`);
        assert.notDeepEqual(chats.map(chat => stickerTurn(chat, 0.5)), chats.map(chat => stickerTurn(chat, 0.5, 'sticker uncued')), '种子分开');
        assert.deepEqual(chats.slice(0, 50).map(chat => stickerTurn(chat, 0.5)), chats.slice(0, 50).map(chat => stickerTurn(chat, 0.5, 'sticker')), '默认 salt 就是原来的');
    });
});

// 类型只是为了确认 StickerEntry 的 source 认得 bili
const _check: StickerEntry['source'] = { kind: 'bili', name: 'emote' };
void _check;
