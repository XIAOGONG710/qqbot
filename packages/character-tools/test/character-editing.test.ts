// 共用编辑层（character-editing.ts）：查看、预览、快照冲突、档位隐私、写入中断回滚。
// 全部在临时目录里的合成角色上跑，不碰真实资料。

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { createCharacterEditor, type CharacterPaths } from '../src/character-editing.ts';

const fixture = resolve(import.meta.dirname, '../../bot/test/fixtures/synthetic-character');
const roots: string[] = [];

function setUp(): { paths: CharacterPaths; original: { persona: string; known: string } } {
    const root = mkdtempSync(join(tmpdir(), 'character-editing-'));
    roots.push(root);
    cpSync(fixture, root, { recursive: true });
    const paths = { sourceDir: join(root, 'source'), stDir: join(root, 'st'), prefix: 'synthetic' };
    return {
        paths,
        original: {
            persona: readFileSync(join(paths.sourceDir, 'persona.yml'), 'utf8'),
            known: readFileSync(join(paths.stDir, 'synthetic-known.json'), 'utf8'),
        },
    };
}

after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('查看返回各部资料和快照 token', () => {
    const { paths } = setUp();
    const snapshot = createCharacterEditor(paths).load();
    assert.equal((snapshot.parts.persona as { name: string }).name, '测试角色');
    assert.ok(snapshot.parts.tiers);
    assert.deepEqual(snapshot.missing, []);
    assert.match(snapshot.token, /^[a-f0-9]{64}$/);
});

test('预览通过时不写盘', () => {
    const { paths, original } = setUp();
    const editor = createCharacterEditor(paths);
    const snapshot = editor.load();
    const persona = structuredClone(snapshot.parts.persona as Record<string, unknown>);
    persona.name = '测试角色二号';
    const outcome = editor.preview('persona', persona, snapshot.token);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.ok(outcome.written.includes('persona.yml'));
    assert.equal(readFileSync(join(paths.sourceDir, 'persona.yml'), 'utf8'), original.persona);
});

test('非法资料只给位置、类别和合成样本', () => {
    const { paths } = setUp();
    const editor = createCharacterEditor(paths);
    const snapshot = editor.load();
    const persona = structuredClone(snapshot.parts.persona as Record<string, unknown>);
    persona.name = '   ';
    const outcome = editor.save('persona', persona, snapshot.token);
    assert.equal(outcome.ok, false);
    if (outcome.ok || outcome.conflict) return;
    assert.equal(outcome.problems.length, 1);
    const [problem] = outcome.problems;
    assert.ok(problem);
    assert.equal(problem!.kind, 'format');
    assert.equal(problem!.field, 'persona.yml.name');
    assert.ok(!JSON.stringify(problem).includes('   '));
    assert.ok(problem!.hint.length > 0);
});

test('档位误公开时报告档位和字段，不返回命中的词', () => {
    const { paths } = setUp();
    const editor = createCharacterEditor(paths);
    const snapshot = editor.load();
    const persona = structuredClone(snapshot.parts.persona as Record<string, unknown>);
    const sections = persona.sections as Record<string, Record<string, { text: string }>>;
    sections.relation!.together!.text = '你和阿测在一起，前任阿岩的事不聊';
    const outcome = editor.preview('persona', persona, snapshot.token);
    assert.equal(outcome.ok, false);
    if (outcome.ok || outcome.conflict) return;
    const problem = outcome.problems.find(item => item.kind === 'privacy');
    assert.ok(problem);
    assert.equal(problem!.tier, 'boyfriend');
    assert.ok(!JSON.stringify(outcome.problems).includes('阿岩'));
});

test('源文件在别处变过时报告冲突，不写盘', () => {
    const { paths, original } = setUp();
    const editor = createCharacterEditor(paths);
    const snapshot = editor.load();
    writeFileSync(join(paths.sourceDir, 'moods.yml'), readFileSync(join(paths.sourceDir, 'moods.yml'), 'utf8') + '\n');
    const persona = structuredClone(snapshot.parts.persona as Record<string, unknown>);
    persona.name = '测试角色三号';
    const outcome = editor.save('persona', persona, snapshot.token);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.conflict === true, true);
    if (outcome.ok || !outcome.conflict) return;
    assert.match(outcome.token, /^[a-f0-9]{64}$/);
    assert.equal(readFileSync(join(paths.sourceDir, 'persona.yml'), 'utf8'), original.persona);
});

test('写到一半失败时，已经写的文件回到原样', () => {
    const { paths, original } = setUp();
    let count = 0;
    const editor = createCharacterEditor(paths, {
        writeFile(path, text) {
            // 前两个写完，第三个开始失败：模拟写到一半断电 / 磁盘满
            if (++count > 2) throw new Error('disk full');
            writeFileSync(path, text);
        },
    });
    const snapshot = editor.load();
    const persona = structuredClone(snapshot.parts.persona as Record<string, unknown>);
    persona.name = '测试角色四号';
    const outcome = editor.save('persona', persona, snapshot.token);
    assert.equal(outcome.ok, false);
    if (outcome.ok || outcome.conflict) return;
    assert.equal(outcome.problems[0]?.kind, 'format');
    assert.match(outcome.problems[0]?.hint ?? '', /恢复/);
    assert.equal(readFileSync(join(paths.sourceDir, 'persona.yml'), 'utf8'), original.persona);
    assert.equal(readFileSync(join(paths.stDir, 'synthetic-known.json'), 'utf8'), original.known);
});

test('保存成功：源文件和生成的卡一起更新，快照跟着变', () => {
    const { paths } = setUp();
    const editor = createCharacterEditor(paths);
    const snapshot = editor.load();
    const persona = structuredClone(snapshot.parts.persona as Record<string, unknown>);
    persona.name = '测试角色五号';
    const outcome = editor.save('persona', persona, snapshot.token);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.ok(outcome.written.includes('persona.yml'));
    assert.ok(readFileSync(join(paths.sourceDir, 'persona.yml'), 'utf8').includes('测试角色五号'));
    assert.ok(readFileSync(join(paths.stDir, 'synthetic-known.json'), 'utf8').includes('测试角色五号'));
    assert.notEqual(outcome.token, snapshot.token);
    assert.equal(createCharacterEditor(paths).load().token, outcome.token);
});

test('没带快照 token 的旧用法（Koishi 页面第一次保存）照样能存', () => {
    const { paths } = setUp();
    const editor = createCharacterEditor(paths);
    const snapshot = editor.load();
    const persona = structuredClone(snapshot.parts.persona as Record<string, unknown>);
    persona.name = '测试角色六号';
    const outcome = editor.save('persona', persona);
    assert.equal(outcome.ok, true);
});
