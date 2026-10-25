import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createPresence, type PresenceTransport } from '../src/presence.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const schedule = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json')).schedule!;
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
