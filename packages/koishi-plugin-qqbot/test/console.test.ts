import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { readSource } from '../../character-tools/src/source.ts';
import { aiPhotoPreview, characterPaths, consoleData, listAiPhotoDrafts, publicCharacterError, reviewAiPhoto, saveCharacter, setConsoleState } from '../src/console.ts';
import { aiPhotoDraftStore } from '../../bot/src/vision/ai-photo-drafts.ts';
import { photoShelf } from '../../bot/src/vision/photos.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'qqbot-console-'));
cpSync(join(repoRoot, 'characters/linmengyao/source'), join(dir, 'source'), { recursive: true });
cpSync(join(repoRoot, 'characters/linmengyao/st'), join(dir, 'st'), { recursive: true });
after(() => rmSync(dir, { recursive: true, force: true }));

const paths = characterPaths(join(dir, 'st', 'linmengyao-{tier}.json'))!;
setConsoleState({ character: paths });
const mtimes = () => Object.fromEntries(readdirSync(join(dir, 'st')).map(f => [f, statSync(join(dir, 'st', f)).mtimeMs]));

describe('控制台的角色资料（ADR 0010）', () => {
    test('从角色卡路径推出资料目录和文件名前缀', () => {
        assert.deepEqual(paths, { stDir: join(dir, 'st'), sourceDir: join(dir, 'source'), prefix: 'linmengyao' });
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
        const scene = source.scenes.find(s => s.tiers.includes('boyfriend') && s.tiers.length === 1)!;
        scene.examples.push('虚构的一句新例句');
        const result = saveCharacter('scenes', source.scenes);
        // 用到这个场景的世界书：这一档的原卡一本，加上它的承认版一本（ADR 0067）
        assert.deepEqual(result, { ok: true, written: ['linmengyao-scenes-boyfriend.json', 'linmengyao-scenes-boyfriend-open.json'] });
        assert.ok(readFileSync(join(dir, 'source', 'scenes.yml'), 'utf8').includes('虚构的一句新例句'));
        assert.ok(readFileSync(join(dir, 'st', 'linmengyao-scenes-boyfriend.json'), 'utf8').includes('「虚构的一句新例句」'));
        assert.ok(readFileSync(join(dir, 'st', 'linmengyao-scenes-boyfriend-open.json'), 'utf8').includes('「虚构的一句新例句」'));
    });

    test('档位隐私检查不过：不写，返回哪一档、哪个场景、哪个词', () => {
        const source = readSource(paths.sourceDir);
        const before = readFileSync(join(dir, 'source', 'scenes.yml'), 'utf8');
        const word = source.tiers.tiers.find(t => t.name === 'classmate')!.banned[0]!;
        const scene = source.scenes.find(s => s.tiers.includes('classmate'))!;
        scene.avoid.push(word);
        const result = saveCharacter('scenes', source.scenes);
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.problems?.some(p => p.tier === 'classmate' && p.where === `世界书 ${scene.id}` && p.word === word));
        assert.equal(readFileSync(join(dir, 'source', 'scenes.yml'), 'utf8'), before);
    });

    test('结构写错、引用写错：不写，返回一句话的错误', () => {
        const source = readSource(paths.sourceDir);
        const bad = saveCharacter('tiers', { ...source.tiers, tiers: [{ ...source.tiers.tiers[0]!, social: 'nobody' }, ...source.tiers.tiers.slice(1)] });
        assert.deepEqual(bad, { ok: false, error: '资料中有一项引用不存在，请重新选择相关的说话方式、场景档或条目。' });
        const shape = saveCharacter('schedule', { ...source.schedule, sleep: '2点' });
        assert.deepEqual(shape, { ok: false, error: '时间格式不正确，请按“时:分”填写，例如 08:30。' });
        assert.doesNotMatch(`${bad.ok ? '' : bad.error} ${shape.ok ? '' : shape.error}`, /yml|boyfriend|social|nobody|HH:MM/);
        assert.equal(publicCharacterError(new Error('C:\\private\\source.yml token=secret')), '资料格式不正确，请检查当前页面的必填项和选择项。');
    });

    test('心情和在读的书（ADR 0015）：没变不写；改了重新生成带它们的卡；清空的可选项当作没写；书的内容也过档位隐私检查', () => {
        const source = readSource(paths.sourceDir);
        const before = mtimes();
        assert.deepEqual(saveCharacter('moods', source.moods), { ok: true, written: [] });
        assert.deepEqual(saveCharacter('books', source.books), { ok: true, written: [] });
        assert.deepEqual(mtimes(), before);

        const moods = structuredClone(source.moods)!;
        moods.moods.find(mood => mood.name === '安静')!.style.text = '今天有点蔫，回得短（虚构的改写）';
        const saved = saveCharacter('moods', moods);
        assert.ok(saved.ok && saved.written.includes('linmengyao-classmate.json') && !saved.written.includes('linmengyao-stranger.json'));
        assert.ok(readFileSync(join(dir, 'st', 'linmengyao-classmate.json'), 'utf8').includes('虚构的改写'));

        const books = structuredClone(source.books)!;
        (books.books[0] as { activity?: unknown }).activity = { window: '', text: '' };
        (books.books[0] as { progress: { max?: unknown } }).progress.max = '';
        assert.ok(saveCharacter('books', books).ok);
        const reread = readSource(paths.sourceDir).books!.books[0]!;
        assert.equal(reread.activity, undefined);
        assert.equal(reread.progress.max, undefined);

        const word = source.tiers.tiers.find(t => t.name === 'classmate')!.banned[0]!;
        const leaky = structuredClone(source.books)!;
        leaky.books[1]!.nodes[0]!.points.push(`虚构的一句${word}`);
        const leak = saveCharacter('books', leaky);
        assert.ok(!leak.ok && leak.problems?.some(p => p.tier === 'classmate' && p.word === word));
    });

    test('页面的数据：插件没在跑时带上原因', () => {
        setConsoleState({ running: false, error: '配置有误，插件没有启动：apiKey=secret C:\\private\\config.json' });
        const data = consoleData();
        assert.equal(data.running, false);
        assert.equal(data.error, '配置有误，插件没有启动。请检查插件设置；详细原因见运行日志。');
        assert.doesNotMatch(data.error ?? '', /secret|apiKey|private|config\.json/);
        assert.equal(data.status, undefined);
        assert.equal('character' in data, false, '状态数据不应暴露角色资料的绝对磁盘路径');
    });

    test('状态采集失败时给中文处理建议，不再误显示为运行正常或泄露异常原文', () => {
        setConsoleState({ running: true, error: undefined, status: () => { throw new Error('token=secret C:\\private\\state.json'); } });
        const data = consoleData();
        assert.equal(data.running, true);
        assert.equal(data.status, undefined);
        assert.equal(data.error, '状态读取失败，请查看运行日志；插件可能仍在运行。');
        assert.doesNotMatch(data.error ?? '', /token|secret|private|state\.json/);
    });
});

describe('控制台的 AI 照片审核（ADR 0239）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-photo-review-'));
    after(() => rmSync(dataDir, { recursive: true, force: true }));
    const jpeg = (marker: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, marker, 0, 1, 2, 3]);

    test('只返回页面需要的中文资料，缩略图只能按合法编号读取', async () => {
        setConsoleState({ dataDir });
        const store = aiPhotoDraftStore({ dir: join(dataDir, 'ai-photo-drafts'), now: () => new Date('2026-11-04T10:00:00.000Z') });
        const draft = await store.generate({
            kind: 'cat', eventKey: 'console-cat', subject: '土豆蹲在车棚边', caption: '土豆蹲在车棚边看落叶', at: '2026-11-04T18:20:00+08:00',
        }, async () => ({ bytes: jpeg(1), model: 'secret-model-name' }));

        const listed = listAiPhotoDrafts('pending_review', 24);
        assert.equal(listed.ok, true);
        if (!listed.ok) return;
        assert.deepEqual(listed.entries, [{
            id: draft.id, kind: 'cat', caption: '土豆蹲在车棚边看落叶', at: '2026-11-04T10:20:00.000Z',
            createdAt: '2026-11-04T10:00:00.000Z', status: 'pending_review',
        }]);
        assert.doesNotMatch(JSON.stringify(listed), /secret-model|console-cat|promptHash|\\|ai-photo-drafts/);
        const preview = aiPhotoPreview(draft.id);
        assert.ok(preview.ok && preview.dataUrl.startsWith('data:image/jpeg;base64,'));
        assert.deepEqual(aiPhotoPreview('../../windows'), { ok: false, error: '找不到这张照片草稿。' });
    });

    test('通过才进入照片货架；拒绝后不能直接通过；错误不泄露内部路径', async () => {
        setConsoleState({ dataDir });
        const drafts = aiPhotoDraftStore({ dir: join(dataDir, 'ai-photo-drafts') });
        const rejected = await drafts.generate({
            kind: 'view', eventKey: 'console-view', subject: '阴天的窗外', caption: '窗外灰白的云压得很低', at: '2026-11-04T11:00:00.000Z',
        }, async () => ({ bytes: jpeg(2), model: 'm' }));
        assert.deepEqual(reviewAiPhoto('reject', rejected.id, undefined), { ok: false, error: '审核请求无效，请重新确认后再试。' });
        assert.equal(aiPhotoDraftStore({ dir: join(dataDir, 'ai-photo-drafts') }).list().find(item => item.id === rejected.id)?.status, 'pending_review');
        assert.deepEqual(reviewAiPhoto('reject', rejected.id, 'confirmed'), { ok: true, status: 'rejected' });
        const retry = reviewAiPhoto('approve', rejected.id, 'confirmed');
        assert.equal(retry.ok, false);
        assert.doesNotMatch(JSON.stringify(retry), /ai-photo-drafts|runtime|\\|rejected|status/);

        const pending = listAiPhotoDrafts('pending_review', 24);
        assert.ok(pending.ok && pending.entries.length === 1);
        const approved = reviewAiPhoto('approve', pending.ok ? pending.entries[0]!.id : '', 'confirmed');
        assert.deepEqual(approved, { ok: true, status: 'approved' });
        assert.equal(photoShelf({ dir: join(dataDir, 'photos'), log: () => {} }).status().count, 1);
        assert.deepEqual(listAiPhotoDrafts('pending_review', 24), { ok: true, entries: [] });
        assert.deepEqual(reviewAiPhoto('send', pending.ok ? pending.entries[0]!.id : '', 'confirmed'), { ok: false, error: '审核请求无效，请重新确认后再试。' });
    });
});
