import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { inspectReply } from '../src/exit-check.ts';
import { splitReply } from '../src/reply.ts';
import {
    PHOTO_GAP_MS, PHOTO_HISTORY_PREFIX, PHOTO_MAX_PER_DAY, photoAllowance, photoIntent, photoShelf, photoWanted,
} from '../src/vision/photos.ts';

// ADR 0109：照片货架。图片内容无所谓，货架只认扩展名、大小和作者写的说明
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-photos-'));
    dirs.push(dir);
    const src = join(dir, 'src');
    mkdirSync(src);
    const logs: string[] = [];
    const make = () => photoShelf({ dir: join(dir, 'shelf'), log: m => logs.push(m), now: () => new Date('2026-10-23T12:00:00Z') });
    const file = (name: string, content: string) => { const p = join(src, name); writeFileSync(p, content); return p; };
    return { dir, logs, make, file };
}

describe('照片货架', () => {
    test('作者加照片：复制进货架、按内容定编号、重复加返回已有的；换个壳（重新打开）还在', () => {
        const { make, file } = setup();
        const shelf = make();
        const a = shelf.add(file('a.jpg', 'cat-1'), 'cat', ' 土豆趴在自行车棚顶上晒太阳 ');
        assert.match(a.id, /^[a-f0-9]{12}$/);
        assert.equal(a.caption, '土豆趴在自行车棚顶上晒太阳');
        assert.equal(shelf.add(file('copy.jpg', 'cat-1'), 'cat', '别的说明').id, a.id, '内容一样 = 同一张');
        shelf.add(file('b.png', 'view-1'), 'view', '宿舍窗外的晚霞');
        assert.deepEqual(shelf.status(), { count: 2, byKind: { cat: 1, view: 1, work: 0, food: 0 } });
        assert.equal(shelf.has('cat'), true);
        assert.equal(shelf.has('work'), false);
        const again = make();
        assert.equal(again.list().length, 2);
        assert.equal(again.resolve(`<photo:${a.id}>`)?.caption, '土豆趴在自行车棚顶上晒太阳');
    });

    test('不合格的不收：种类、扩展名、空说明、太大', () => {
        const { make, file } = setup();
        const shelf = make();
        assert.throws(() => shelf.add(file('a.jpg', 'x'), 'selfie' as never, '自拍'), /种类只能是/);
        assert.throws(() => shelf.add(file('a.gif', 'x'), 'cat', '动图'), /只收/);
        assert.throws(() => shelf.add(file('a.jpg', 'x'), 'cat', '  '), /写一句/);
        assert.equal(shelf.status().count, 0);
    });

    test('提示词：只列这一类，写明以前拍的、编号只能从里面选；用得少的 / 最久没发的在前', () => {
        const { make, file } = setup();
        const shelf = make();
        const a = shelf.add(file('a.jpg', '1'), 'cat', '土豆晒太阳');
        const b = shelf.add(file('b.jpg', '2'), 'cat', '土豆吃猫粮');
        shelf.add(file('c.jpg', '3'), 'view', '窗外的晚霞');
        shelf.used(a.id);
        const prompt = shelf.prompt('cat')!;
        assert.ok(prompt.includes('以前拍的') && prompt.includes('一轮最多发一张'));
        assert.ok(prompt.indexOf(b.id) < prompt.indexOf(a.id), '没发过的在前');
        assert.ok(!prompt.includes('晚霞'));
        assert.equal(shelf.prompt('work'), undefined);
    });

    test('清理：已知的单独一行留一个；未知的、混在文字里的、第二张都去掉；这一轮不该发就全去掉', () => {
        const { make, file, logs } = setup();
        const shelf = make();
        const a = shelf.add(file('a.jpg', '1'), 'cat', '土豆晒太阳');
        const b = shelf.add(file('b.jpg', '2'), 'cat', '土豆吃猫粮');
        assert.equal(shelf.clean(`翻到一张\n<photo:${a.id}>`), `翻到一张\n<photo:${a.id}>`);
        assert.equal(shelf.clean(`翻到一张\n<photo:${a.id}>\n<photo:${b.id}>`), `翻到一张\n<photo:${a.id}>`, '同一轮第二张去掉');
        assert.equal(shelf.clean('看\n<photo:aaaaaaaaaaaa>'), '看', '未知编号去掉');
        const mixed = shelf.clean(`看这个 <photo:${a.id}> 可爱吧`);
        assert.ok(!mixed.includes('<photo') && mixed.includes('可爱吧'), '混在文字里的指令去掉、文字留着');
        assert.equal(shelf.clean(`翻到一张\n<photo:${a.id}>`, false), '翻到一张', '这一轮不该发：整条指令去掉');
        assert.ok(logs.some(m => m.includes('这一轮不该发的')));
    });

    test('发出去之后：聊天记录里写成可读的一句；普通文字原样；used 计数', () => {
        const { make, file } = setup();
        const shelf = make();
        const a = shelf.add(file('a.jpg', '1'), 'cat', '土豆晒太阳');
        assert.equal(shelf.history(`<photo:${a.id}>`), `${PHOTO_HISTORY_PREFIX}土豆晒太阳`);
        assert.equal(shelf.history('哈哈'), '哈哈');
        shelf.used(a.id);
        assert.equal(shelf.list()[0]!.used, 1);
        assert.ok(shelf.resolve(`<photo:${a.id}>`)!.file.endsWith(`${a.id}.jpg`));
        assert.equal(shelf.remove(a.id), true);
        assert.equal(shelf.resolve(`<photo:${a.id}>`), undefined);
    });
});

describe('什么时候发', () => {
    test('他要看哪一类：对象明确才算；要她本人（自拍）不算；没对象只说“发张照片”取手上有的', () => {
        for (const [text, kind] of [
            ['发张土豆的照片我看看', 'cat'], ['土豆呢，让我看看', 'cat'], ['看看猫', 'cat'], ['想看看那只三花', 'cat'],
            ['拍张窗外的天空给我看', 'view'], ['看看今天的晚霞', 'view'],
            ['你拍的片子给我看看', 'work'], ['发几张你修的图看看', 'work'],
            ['发张照片看看', 'any'], ['有照片吗', 'any'],
        ] as const) assert.equal(photoWanted(text), kind, text);
        for (const text of ['发张自拍看看', '想看你', '让我看看你现在的样子', '在吗', '土豆今天怎么样', '你拍的好看']) assert.equal(photoWanted(text), undefined, text);
    });

    const at = (h: number) => new Date(2026, 9, 23, h, 0).getTime();
    const iso = (h: number) => new Date(at(h)).toISOString();
    test('允许：危机 / 被吵醒 / 3 小时内发过 / 今天发够了，都不发', () => {
        assert.deepEqual(photoAllowance([], at(15)), { allowed: true });
        assert.equal(photoAllowance([], at(15), true).allowed, false);
        assert.equal(photoAllowance([], at(15), false, true).allowed, false);
        const sent = (h: number) => ({ role: 'assistant' as const, content: `${PHOTO_HISTORY_PREFIX}土豆`, time: iso(h) });
        assert.equal(photoAllowance([sent(13)], at(15)).reason, '刚发过一张');
        assert.deepEqual(photoAllowance([sent(10)], at(15)), { allowed: true }, '隔了 5 小时可以');
        assert.equal(PHOTO_GAP_MS, 3 * 60 * 60_000);
        const many = Array.from({ length: PHOTO_MAX_PER_DAY }, (_, i) => sent(7 + i));
        assert.equal(photoAllowance(many, at(20)).reason, '今天发够了');
        assert.deepEqual(photoAllowance([{ role: 'assistant', content: '哈哈', time: iso(14) }], at(15)), { allowed: true }, '普通话不算');
    });

    test('出口检查：回复里真带着一张照片时，“翻出来发你”不算她做不到的承诺；没带照片照旧拦', () => {
        const withPhoto = '翻出来了，发你看\n<photo:abcdef123456>';
        assert.deepEqual(inspectReply(withPhoto, []).filter(issue => issue.kind === 'promise'), []);
        assert.ok(inspectReply('翻出来了，发你看', []).some(issue => issue.kind === 'promise'), '没带照片：照旧是承诺');
        assert.ok(inspectReply('我拍一张给你看\n哈哈', []).some(issue => issue.kind === 'promise'));
    });

    test('拆气泡：照片那一行自己占一条，不并进文字（一行超过条数上限时也一样）', () => {
        assert.deepEqual(splitReply('翻到一张\n<photo:abcdef123456>'), ['翻到一张', '<photo:abcdef123456>']);
        const crowded = splitReply('一\n二\n三\n<photo:abcdef123456>\n四\n五\n六', 3);
        assert.ok(crowded.includes('<photo:abcdef123456>'), JSON.stringify(crowded));
        assert.equal(crowded.length, 3);
    });

    test('意图行：以前拍的、不说成刚拍的，先一句话带、另起一行放照片', () => {
        const line = photoIntent('cat');
        assert.ok(line.includes('土豆') && line.includes('以前拍的') && line.includes('别说成刚拍的') && line.includes('另起一行'), line);
        assert.doesNotMatch(line, /[「」]/, '不给台词');
    });
});

