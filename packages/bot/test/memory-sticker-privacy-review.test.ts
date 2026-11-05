import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { planForget, exportContact } from '../src/memory/privacy-forget.ts';
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-sticker-privacy-')); mkdirSync(join(root, 'stickers'));
    return { root, json(name: string, value: unknown) { writeFileSync(join(root, 'stickers', name), JSON.stringify(value)); },
        clean() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sticker-privacy-')); rmSync(root, { recursive: true, force: true }); } };
}
const entry = (from: number, file: string) => ({ id: '0123456789ab', file, source: { kind: 'received', from }, description: '合成私密描述不得出现在报告正文' });
const paths = (root: string) => auditContactPrivacy(root, 10001).artifacts.map(item => item.path.replaceAll('\\', '/'));
test('先图后索引留下的孤儿和实际图片tmp仅列未知混合，不猜其它来源', () => {
    const f = fixture();
    try {
        f.json('index.json', { entries: [entry(10002, 'bbbbbbbbbbbb.png')] });
        for (const name of ['aaaaaaaaaaaa.png', 'cccccccccccc.webp.tmp-123-4', 'bbbbbbbbbbbb.png', 'dddddddddddd.png.tmp-fake']) writeFileSync(join(f.root, 'stickers', name), 'synthetic private bytes');
        const names = paths(f.root);
        assert.ok(names.includes('stickers/aaaaaaaaaaaa.png')); assert.ok(names.includes('stickers/cccccccccccc.webp.tmp-123-4'));
        assert.ok(!names.includes('stickers/bbbbbbbbbbbb.png')); assert.ok(!names.includes('stickers/dddddddddddd.png.tmp-fake'));
        const audit = auditContactPrivacy(f.root, 10001);
        assert.ok(audit.artifacts.every(item => item.kind === 'mixed')); assert.equal(planForget(audit, 'synthetic-common').move.length, 0);
        assert.equal(exportContact(f.root, 10001, join(f.root, 'export')).files.length, 0);
    } finally { f.clean(); }
});
test('表情原子残留和明确关联图片纳mixed清单，不整份导出或遗忘', () => {
    const f = fixture();
    try {
        f.json('index.json.tmp-123-1', { entries: [entry(10001, '0123456789ab.png'), entry(10002, 'bbbbbbbbbbbb.png')] });
        writeFileSync(join(f.root, 'stickers', '0123456789ab.png'), 'synthetic bytes');
        writeFileSync(join(f.root, 'stickers', 'bbbbbbbbbbbb.png'), 'other synthetic bytes');
        const audit = auditContactPrivacy(f.root, 10001), names = paths(f.root);
        assert.ok(names.includes('stickers/index.json.tmp-123-1')); assert.ok(names.includes('stickers/0123456789ab.png')); assert.ok(!names.includes('stickers/bbbbbbbbbbbb.png'));
        assert.ok(audit.artifacts.every(item => item.kind === 'mixed')); assert.ok(!JSON.stringify(audit).includes('合成私密描述'));
        const plan = planForget(audit, 'synthetic-common'); assert.equal(plan.move.length, 0);
        const exported = exportContact(f.root, 10001, join(f.root, 'export')); assert.equal(exported.files.length, 0);
        assert.equal(readFileSync(join(f.root, 'stickers', '0123456789ab.png'), 'utf8'), 'synthetic bytes');
    } finally { f.clean(); }
});
test('表情本体与corrupt备份关联同图去重，近似号码及伪残留不猜归属', () => {
    const f = fixture();
    try {
        f.json('index.json', { entries: [entry(10001, '0123456789ab.png')] });
        f.json('index.json.corrupt-123456', { entries: [entry(10001, '0123456789ab.png')] });
        f.json('index.json.tmp-fake', { entries: [entry(10001, 'fake.png')] });
        f.json('index.json.tmp-123-2', { entries: [entry(100010, 'other.png')] });
        writeFileSync(join(f.root, 'stickers', '0123456789ab.png'), 'synthetic');
        const names = paths(f.root); assert.equal(names.filter(name => name === 'stickers/0123456789ab.png').length, 1);
        assert.ok(names.includes('stickers/index.json.corrupt-123456')); assert.ok(!names.includes('stickers/index.json.tmp-fake')); assert.ok(!names.includes('stickers/index.json.tmp-123-2'));
    } finally { f.clean(); }
});
test('损坏的实际表情残留只报告混合未知，不把原件当空白或输出正文', () => {
    const f = fixture();
    try {
        const file = join(f.root, 'stickers', 'index.json.tmp-123-3'); writeFileSync(file, '{synthetic private fragment');
        const audit = auditContactPrivacy(f.root, 10001); assert.ok(paths(f.root).includes('stickers/index.json.tmp-123-3'));
        assert.ok(audit.limitations.some(line => line.includes('表情'))); assert.ok(!JSON.stringify(audit).includes('synthetic private fragment')); assert.equal(readFileSync(file, 'utf8'), '{synthetic private fragment');
    } finally { f.clean(); }
});
test('索引恶意图片路径不跨出货架，也不把共享索引误当图片', () => {
    const f = fixture();
    try {
        f.json('index.json', { entries: [entry(10001, '../outside.png'), entry(10001, 'index.json')] });
        writeFileSync(join(f.root, 'outside.png'), 'outside synthetic');
        const names = paths(f.root); assert.ok(!names.includes('outside.png')); assert.deepEqual(names, ['stickers/index.json']);
        assert.ok(auditContactPrivacy(f.root, 10001).limitations.some(line => line.includes('表情')));
    } finally { f.clean(); }
});
