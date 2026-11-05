import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { readSource } from '../../character-tools/src/source.ts';
import { characterPaths, consoleData, saveCharacter, setConsoleState } from '../src/console.ts';
import { syntheticSourceDir, syntheticStDir } from '../../bot/test/fixtures/card.ts';

const dir = mkdtempSync(join(tmpdir(), 'qqbot-console-'));
cpSync(syntheticSourceDir, join(dir, 'source'), { recursive: true });
cpSync(syntheticStDir, join(dir, 'st'), { recursive: true });
after(() => rmSync(dir, { recursive: true, force: true }));

const paths = characterPaths(join(dir, 'st', 'synthetic-{tier}.json'))!;
setConsoleState({ character: paths });
const mtimes = () => Object.fromEntries(readdirSync(join(dir, 'st')).map(f => [f, statSync(join(dir, 'st', f)).mtimeMs]));

describe('控制台的角色资料（ADR 0010）', () => {
    test('从角色卡路径推出资料目录和文件名前缀', () => {
        assert.deepEqual(paths, { stDir: join(dir, 'st'), sourceDir: join(dir, 'source'), prefix: 'synthetic' });
    });

    test('只检查不写；资料没变时保存也不改 st/ 下的文件（插件监听 st/，没变就不重启）', () => {
        const source = readSource(paths.sourceDir);
        const before = mtimes();
        assert.deepEqual(saveCharacter('scenes', source.scenes, true), { ok: true, written: [] });
        assert.deepEqual(saveCharacter('scenes', source.scenes), { ok: true, written: [] });
        assert.deepEqual(mtimes(), before);
    });

    test('改了一个场景：写回 source/，重新生成用到它的世界书', () => {
        const source = readSource(paths.sourceDir);
        // 场景按场景档（tiers.yml 的 scenes）归属：找只属于男朋友档那一组的场景
        const group = source.tiers.tiers.find(t => t.name === 'boyfriend')!.scenes;
        assert.deepEqual(source.tiers.tiers.filter(t => t.scenes === group).map(t => t.name), ['boyfriend'], '合成资料里这一组只给男朋友档');
        const scene = source.scenes.find(s => s.tiers.length === 1 && s.tiers[0] === group)!;
        scene.examples.push('虚构的一句新例句');
        const result = saveCharacter('scenes', source.scenes);
        // 用到这个场景的世界书：这一档的原卡一本，加上它的承认版一本（ADR 0067）
        assert.deepEqual(result, { ok: true, written: ['synthetic-scenes-boyfriend.json', 'synthetic-scenes-boyfriend-open.json'] });
        assert.ok(readFileSync(join(dir, 'source', 'scenes.yml'), 'utf8').includes('虚构的一句新例句'));
        assert.ok(readFileSync(join(dir, 'st', 'synthetic-scenes-boyfriend.json'), 'utf8').includes('「虚构的一句新例句」'));
        assert.ok(readFileSync(join(dir, 'st', 'synthetic-scenes-boyfriend-open.json'), 'utf8').includes('「虚构的一句新例句」'));
    });

    test('档位隐私检查不过：不写，返回哪一档、哪个场景、哪个词', () => {
        const source = readSource(paths.sourceDir);
        const before = readFileSync(join(dir, 'source', 'scenes.yml'), 'utf8');
        const word = source.tiers.tiers.find(t => t.name === 'classmate')!.banned[0]!;
        const scene = source.scenes.find(s => s.tiers.includes(source.tiers.tiers.find(t => t.name === 'classmate')!.scenes))!;
        scene.avoid.push(word);
        const result = saveCharacter('scenes', source.scenes);
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.problems?.some(p => p.tier === 'classmate' && p.where === `世界书 ${scene.id}` && p.word === word));
        assert.equal(readFileSync(join(dir, 'source', 'scenes.yml'), 'utf8'), before);
    });

    test('结构写错、引用写错：不写，返回一句话的错误', () => {
        const source = readSource(paths.sourceDir);
        const bad = saveCharacter('tiers', { ...source.tiers, tiers: [{ ...source.tiers.tiers[0]!, social: 'nobody' }, ...source.tiers.tiers.slice(1)] });
        assert.deepEqual(bad, { ok: false, error: 'tiers.yml 档位 boyfriend 的 social「nobody」在 persona.yml 的 social 里没有' });
        const shape = saveCharacter('schedule', { ...source.schedule, sleep: '2点' });
        assert.ok(!shape.ok && /schedule\.yml\.sleep 应为 HH:MM/.test(shape.error!));
    });

    test('心情和在读的书（ADR 0015）：没变不写；改了重新生成带它们的卡；清空的可选项当作没写；书的内容也过档位隐私检查', () => {
        const source = readSource(paths.sourceDir);
        const before = mtimes();
        assert.deepEqual(saveCharacter('moods', source.moods), { ok: true, written: [] });
        assert.deepEqual(saveCharacter('books', source.books), { ok: true, written: [] });
        assert.deepEqual(mtimes(), before);

        const moods = structuredClone(source.moods)!;
        moods.moods.find(mood => mood.name === '开心')!.style.text = '今天有点蔫，回得短（虚构的改写）';
        const saved = saveCharacter('moods', moods);
        assert.ok(saved.ok && saved.written.includes('synthetic-classmate.json') && !saved.written.includes('synthetic-stranger.json'));
        assert.ok(readFileSync(join(dir, 'st', 'synthetic-classmate.json'), 'utf8').includes('虚构的改写'));

        const books = structuredClone(source.books)!;
        (books.books[0] as { activity?: unknown }).activity = { window: '', text: '' };
        (books.books[0] as { progress: { max?: unknown } }).progress.max = '';
        assert.ok(saveCharacter('books', books).ok);
        const reread = readSource(paths.sourceDir).books!.books[0]!;
        assert.equal(reread.activity, undefined);
        assert.equal(reread.progress.max, undefined);

        const word = source.tiers.tiers.find(t => t.name === 'classmate')!.banned[0]!;
        const leaky = structuredClone(source.books)!;
        leaky.books.find(book => book.nodes.length)!.nodes[0]!.points.push(`虚构的一句${word}`);
        const leak = saveCharacter('books', leaky);
        assert.ok(!leak.ok && leak.problems?.some(p => p.tier === 'classmate' && p.word === word));
    });

    test('页面的数据：插件没在跑时带上原因', () => {
        setConsoleState({ running: false, error: '配置有误，插件没有启动：x' });
        const data = consoleData();
        assert.equal(data.running, false);
        assert.equal(data.error, '配置有误，插件没有启动：x');
        assert.equal(data.status, undefined);
    });
});
