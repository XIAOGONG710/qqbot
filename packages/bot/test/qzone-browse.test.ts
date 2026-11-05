import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createPresence, describeSelf, type PresenceTransport } from '../src/social/presence.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

const schedule = loadCharacterCard(syntheticCardPath('boyfriend')).schedule!;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-browse-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const at = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();

const feed = () => ({
    action: 'get_qzone_msg_list',
    items: [
        { id: '1', text: '楼下的猫又在门口蹲着', images: 0 },
        { id: '2', text: '今晚的云被落日烧红了', images: 1 },
    ],
});

function presence(mode: 'off' | 'dryRun' | 'on', reads: string[]) {
    const dir = tmp();
    const transport: PresenceTransport = {
        readQzoneFeed: async count => { reads.push(String(count)); return feed(); },
    };
    const p = createPresence({
        flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzoneBrowse: mode },
        transport,
        schedule,
        likeTargets: [],
        dir,
        now: () => at(10, 23, 11, 30),
        log: () => undefined,
    });
    return { p, dir };
}

describe('她自己翻空间动态（ADR 0142）', () => {
    test('开着：读一页，摘成一行进提示词（6 小时内），两跳之间不重复读', async () => {
        const reads: string[] = [];
        const { p } = presence('on', reads);
        await p.tick();
        assert.deepEqual(reads, ['8']);
        const note = p.selfNote(at(10, 23, 11, 30));
        assert.match(note ?? '', /刚才翻了会儿 QQ 空间/);
        assert.match(note ?? '', /楼下的猫又在门口蹲着/);
        await p.tick();
        assert.equal(reads.length, 1);
        assert.equal(p.selfNote(at(10, 24, 3, 0)), undefined, '过了 6 小时就不再提着');
    });

    test('只写草稿：写进 presence/drafts.md，不进提示词', async () => {
        const reads: string[] = [];
        const { p, dir } = presence('dryRun', reads);
        await p.tick();
        assert.equal(reads.length, 1);
        assert.equal(p.selfNote(at(10, 23, 11, 30)), undefined);
        const draft = readFileSync(join(dir, 'drafts.md'), 'utf8');
        assert.match(draft, /翻了会儿空间/);
        assert.match(draft, /楼下的猫又在门口蹲着/);
    });

    test('关着：一次都不读', async () => {
        const reads: string[] = [];
        const { p } = presence('off', reads);
        await p.tick();
        assert.deepEqual(reads, []);
        assert.equal(p.selfNote(at(10, 23, 11, 30)), undefined);
    });

    test('睡着或上课不读', async () => {
        const reads: string[] = [];
        const dir = tmp();
        const p = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzoneBrowse: 'on' },
            transport: { readQzoneFeed: async count => { reads.push(String(count)); return feed(); } },
            schedule,
            likeTargets: [],
            dir,
            now: () => at(10, 23, 3, 0),
            log: () => undefined,
        });
        await p.tick();
        assert.deepEqual(reads, [], '凌晨三点不翻空间');
    });
});

describe('看好友的空间（ADR 0143 / 0145）', () => {
    const friendFeed = () => [{ id: 'p1', text: '今天拍到了很好看的云', images: 1 }];

    test('开着：按名单看一个人发的说说，进提示词；4 小时内不再看', async () => {
        const reads: number[] = [];
        const dir = tmp();
        const p = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzonePeek: 'on' },
            transport: { readUserQzone: async uin => { reads.push(uin); return friendFeed(); } },
            schedule,
            likeTargets: [],
            peekTargets: [{ qq: 10001, name: '小雨' }],
            dir,
            now: () => at(10, 23, 11, 30),
            log: () => undefined,
        });
        await p.tick();
        assert.deepEqual(reads, [10001]);
        const note = p.selfNote(at(10, 23, 11, 30));
        assert.match(note ?? '', /刷了会儿 QQ 空间的好友动态，看到小雨发了/);
        assert.match(note ?? '', /今天拍到了很好看的云/);
        assert.match(note ?? '', /^\[你刚才刷空间看到的（是别人发的，不是你发的/, '看到的别人的话单独一行，不混进「他能看到的你」');
        assert.doesNotMatch(note ?? '', /你在 QQ 上的样子/);
        await p.tick();
        assert.equal(reads.length, 1);
    });

    test('带时间的说说：说「昨天晚上发了」；超过 3 天的、看过的不再当新鲜事', async () => {
        const now = at(10, 23, 11, 30);
        const feed = [
            { id: 'old', text: '一周前的旧说说', images: 0, at: now - 7 * 86_400_000 },
            { id: 'y', text: '昨晚的月亮', images: 0, at: at(10, 22, 21, 10) },
            { id: 'future', text: '时钟不对的', images: 0, at: now + 30 * 3_600_000 },
        ];
        let current = now;
        const p = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzonePeek: 'on' },
            transport: { readUserQzone: async () => feed },
            schedule, likeTargets: [], peekTargets: [{ qq: 10001, name: '小雨' }],
            dir: tmp(), now: () => current, log: () => undefined,
        });
        await p.tick();
        const first = p.selfNote(now) ?? '';
        assert.match(first, /小雨昨天晚上发了「昨晚的月亮」/);
        assert.doesNotMatch(first, /一周前|时钟不对/);
        // 5 小时后又读一遍：同一条已经看过，不再当新鲜事（上一条的 6 小时窗口也过了）
        current = now + 7 * 3_600_000 - 1_800_000;
        await p.tick();
        assert.equal(p.selfNote(current), undefined);
    });

    test('读不到：6 小时后再试，不是永久停用；这期间不重复读', async () => {
        let calls = 0;
        let current = at(10, 23, 11, 30);
        let works = false;
        const p = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzonePeek: 'on' },
            transport: { readUserQzone: async () => { calls++; return works ? [{ id: 'n', text: '终于读到了', images: 0 }] : undefined; } },
            schedule, likeTargets: [], peekTargets: [{ qq: 10001, name: '小雨' }],
            dir: tmp(), now: () => current, log: () => undefined,
        });
        await p.tick();
        current = at(10, 23, 15, 45); // 4 小时 15 分后：过了常规间隔，但还在 6 小时重试期内
        await p.tick();
        assert.equal(calls, 1);
        works = true;
        current = at(10, 23, 17, 40); // 6 小时 10 分后
        await p.tick();
        assert.equal(calls, 2);
        assert.match(p.selfNote(current) ?? '', /终于读到了/);
    });

    test('读到了但这个人没有新说说（[]）：不算读不到，也不进提示词', async () => {
        let calls = 0;
        const p = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzonePeek: 'on' },
            transport: { readUserQzone: async () => { calls++; return []; } },
            schedule, likeTargets: [], peekTargets: [{ qq: 10001, name: '小雨' }],
            dir: tmp(), now: () => at(10, 23, 11, 30), log: () => undefined,
        });
        await p.tick();
        assert.equal(calls, 1);
        assert.equal(p.selfNote(at(10, 23, 11, 30)), undefined);
    });

    test('提示词里两行分开：她自己的样子 + 她刷到的别人的', () => {
        const now = at(10, 23, 12, 0);
        const both = describeSelf({ signature: { text: '困' }, qzone: [], peek: { at: now - 60_000, note: '你刷了会儿 QQ 空间的好友动态，看到小雨发了「云」' } }, now)!;
        const lines = both.split(String.fromCharCode(10));
        assert.equal(lines.length, 2);
        assert.match(lines[0]!, /^\[你在 QQ 上的样子（.*）：个性签名现在是「困」\]$/);
        assert.match(lines[1]!, /^\[你刚才刷空间看到的（.*）：.*小雨发了「云」\]$/);
        assert.equal(describeSelf({ qzone: [], peek: { at: now - 7 * 3_600_000, note: 'x' } }, now), undefined, '6 小时后不再提着');
    });

    test('试运行只写草稿；读不到只记一次、不假装', async () => {
        const dir = tmp();
        const p = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzonePeek: 'dryRun' },
            transport: { readUserQzone: async () => friendFeed() },
            schedule, likeTargets: [], peekTargets: [{ qq: 10001, name: '小雨' }],
            dir, now: () => at(10, 23, 11, 30), log: () => undefined,
        });
        await p.tick();
        assert.equal(p.selfNote(at(10, 23, 11, 30)), undefined);
        assert.match(readFileSync(join(dir, 'drafts.md'), 'utf8'), /刷到小雨的说说/);

        const reads: number[] = [];
        const broken = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzonePeek: 'on' },
            transport: { readUserQzone: async uin => { reads.push(uin); return undefined; } },
            schedule, likeTargets: [], peekTargets: [{ qq: 10001, name: '小雨' }],
            dir: tmp(), now: () => at(10, 23, 11, 30), log: () => undefined,
        });
        await broken.tick();
        await broken.tick();
        assert.equal(reads.length, 1, '读不到就不再试');
        assert.equal(broken.selfNote(at(10, 23, 11, 30)), undefined);
    });
});

describe('刷陌生人（ADR 0144）', () => {
    const feed = () => ({ action: 'emotion_cgi_re_feeds', items: [{ text: '今天风好大，出门五分钟就后悔了', images: 0 }, { text: '食堂的糖醋里脊居然不甜', images: 1 }] });

    test('开着：摘一句进提示词，样本落 strangers.jsonl（只有正文）', async () => {
        const dir = tmp();
        const p = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzoneStrangers: 'on' },
            transport: { readStrangerFeed: async () => feed() },
            schedule, likeTargets: [], dir, now: () => at(10, 23, 11, 30), log: () => undefined,
        });
        await p.tick();
        const note = p.selfNote(at(10, 23, 11, 30));
        assert.match(note ?? '', /陌生人发的/);
        assert.match(note ?? '', /今天风好大/);
        const samples = readFileSync(join(dir, 'strangers.jsonl'), 'utf8').trim().split(String.fromCharCode(10));
        assert.equal(samples.length, 2);
        assert.equal((samples[0] ?? '').includes('uin'), false);
    });

    test('试运行只写草稿；读不到只试一次', async () => {
        const dir = tmp();
        const p = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzoneStrangers: 'dryRun' },
            transport: { readStrangerFeed: async () => feed() },
            schedule, likeTargets: [], dir, now: () => at(10, 23, 11, 30), log: () => undefined,
        });
        await p.tick();
        assert.equal(p.selfNote(at(10, 23, 11, 30)), undefined);
        assert.match(readFileSync(join(dir, 'drafts.md'), 'utf8'), /陌生人/);

        const calls: number[] = [];
        const broken = createPresence({
            flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzoneStrangers: 'on' },
            transport: { readStrangerFeed: async () => { calls.push(1); return undefined; } },
            schedule, likeTargets: [], dir: tmp(), now: () => at(10, 23, 11, 30), log: () => undefined,
        });
        await broken.tick();
        await broken.tick();
        assert.equal(calls.length, 1);
    });
});
