import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { readSource } from '../../character-tools/src/source.ts';
import { addAiPhotoReference, aiPhotoPreview, aiPhotoRuntimeStatus, characterPaths, consoleData, listAiPhotoDrafts, listAiPhotoReferences, listExternalDrafts, publicCharacterError, removeAiPhotoReference, reviewAiPhoto, reviewExternalDraft, runConsoleHealthCheck, saveCharacter, setConsoleState } from '../src/console.ts';
import { aiPhotoDraftStore } from '../../bot/src/vision/ai-photo-drafts.ts';
import { photoShelf } from '../../bot/src/vision/photos.ts';
import { createExternalDraftStore } from '../../bot/src/social/external-drafts.ts';
import { syntheticSourceDir, syntheticStDir } from '../../bot/test/fixtures/card.ts';

const dir = mkdtempSync(join(tmpdir(), 'qqbot-console-'));
cpSync(syntheticSourceDir, join(dir, 'source'), { recursive: true });
cpSync(syntheticStDir, join(dir, 'st'), { recursive: true });
after(() => rmSync(dir, { recursive: true, force: true }));

const paths = characterPaths(join(dir, 'st', 'synthetic-{tier}.json'))!;
setConsoleState({ character: paths });
const mtimes = () => Object.fromEntries(readdirSync(join(dir, 'st')).map(f => [f, statSync(join(dir, 'st', f)).mtimeMs]));

describe('控制台的角色资料（ADR 0010）', () => {
    test('一键体检只返回中文安全摘要，不回显内部地址和错误', () => {
        const report = runConsoleHealthCheck({
            running: true, napcat: { online: true }, phoneActions: [], updatedAt: Date.now(),
            status: {
                runtime: { commit: 'abc', branch: 'test', dirty: false, startedAt: new Date().toISOString() }, timeZone: 'Asia/Shanghai', contacts: [], unlistedFriends: false, schedule: true, moody: false, speechCheck: true, herDays: false, proactive: 'off', features: [],
                memory: { baseUrl: 'http://secret.internal', health: { ok: false, at: Date.now(), error: 'token=secret' } },
                externalPlatforms: { tieba: 'off', douyin: 'off', xiaohongshu: 'off' }, externalDrafts: { total: 1, pending: 1, approved: 0, publishing: 0, failed: 0, byPlatform: { tieba: 1, douyin: 0, xiaohongshu: 0 } },
                dsh: { enabled: true }, mobileCompanion: { enabled: true, connected: false, queued: 0, maxQueuedPerClient: 32 },
            },
        });
        assert.equal(report.ok, false);
        assert.ok(report.attentionCount >= 3);
        assert.doesNotMatch(JSON.stringify(report), /secret|token|internal|http/);
    });
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

describe('控制台的外部平台草稿中心', () => {
    test('只列展示字段，人工批准不会触发发布', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-external-console-'));
        try {
            const store = createExternalDraftStore({ dir: join(dataDir, 'external-drafts') });
            const draft = store.create({ platform: 'tieba', title: '测试草稿', body: '只在审核页显示', media: ['media:photo-1'] });
            setConsoleState({ dataDir, status: () => ({ externalPlatforms: { tieba: 'draft', douyin: 'off', xiaohongshu: 'off' } }) as never });
            const listed = listExternalDrafts('tieba', 'pending', 10);
            assert.equal(listed.ok, true);
            if (listed.ok) {
                assert.deepEqual(listed.entries[0], { id: draft.id, platform: 'tieba', title: '测试草稿', body: '只在审核页显示', status: 'pending', source: 'manual', createdAt: draft.createdAt, updatedAt: draft.updatedAt, mediaCount: 1 });
                assert.doesNotMatch(JSON.stringify(listed), /publishRequestId|audit|media:photo/);
            }
            assert.deepEqual(reviewExternalDraft('approve', draft.id, 'confirmed'), { ok: true, status: 'approved' });
            assert.equal(createExternalDraftStore({ dir: join(dataDir, 'external-drafts') }).list()[0]?.status, 'approved');
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
            setConsoleState({ dataDir: undefined, status: undefined });
        }
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
            kind: 'cat', eventKey: 'console-cat', subject: '团子饼蹲在车棚边', caption: '团子饼蹲在车棚边看落叶', at: '2026-11-04T18:20:00+08:00',
        }, async () => ({ bytes: jpeg(1), model: 'secret-model-name' }));

        const listed = listAiPhotoDrafts('pending_review', 24, new Date('2026-11-04T10:00:00.000Z'));
        assert.equal(listed.ok, true);
        if (!listed.ok) return;
        assert.deepEqual(listed.entries, [{
            id: draft.id, kind: 'cat', caption: '团子饼蹲在车棚边看落叶', at: '2026-11-04T10:20:00.000Z',
            createdAt: '2026-11-04T10:00:00.000Z', expiresAt: '2026-11-04T16:20:00.000Z', expired: false, status: 'pending_review',
        }]);
        assert.doesNotMatch(JSON.stringify(listed), /secret-model|console-cat|promptHash|\\|ai-photo-drafts/);
        const expired = listAiPhotoDrafts('pending_review', 24, new Date('2026-11-04T16:20:00.000Z'));
        assert.ok(expired.ok && expired.entries[0]?.expired === true);
        const preview = aiPhotoPreview(draft.id);
        assert.ok(preview.ok && preview.dataUrl.startsWith('data:image/jpeg;base64,'));
        assert.deepEqual(aiPhotoPreview('../../windows'), { ok: false, error: '找不到这张照片草稿。' });
    });

    test('通过才进入照片货架；拒绝后不能直接通过；错误不泄露内部路径', async () => {
        // 自己一份数据目录：上一条把时钟钉在 11-04，共用目录时这条会捞到那张已过期的草稿（11-05 修）
        const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-photo-review-approve-'));
        after(() => rmSync(dataDir, { recursive: true, force: true }));
        setConsoleState({ dataDir });
        const drafts = aiPhotoDraftStore({ dir: join(dataDir, 'ai-photo-drafts') });
        const rejected = await drafts.generate({
            kind: 'view', eventKey: 'console-view', subject: '阴天的窗外', caption: '窗外灰白的云压得很低', at: new Date(Date.now() - 60_000).toISOString(),
        }, async () => ({ bytes: jpeg(2), model: 'm' }));
        assert.deepEqual(reviewAiPhoto('reject', rejected.id, undefined), { ok: false, error: '审核请求无效，请重新确认后再试。' });
        assert.equal(aiPhotoDraftStore({ dir: join(dataDir, 'ai-photo-drafts') }).list().find(item => item.id === rejected.id)?.status, 'pending_review');
        assert.deepEqual(reviewAiPhoto('reject', rejected.id, 'confirmed'), { ok: true, status: 'rejected' });
        const retry = reviewAiPhoto('approve', rejected.id, 'confirmed');
        assert.equal(retry.ok, false);
        assert.doesNotMatch(JSON.stringify(retry), /ai-photo-drafts|runtime|\\|rejected|status/);

        // 这条测试自己造一张待审的草稿（以前是捡上一条测试留下的，隔离目录以后就得自己生）
        await aiPhotoDraftStore({ dir: join(dataDir, 'ai-photo-drafts') }).generate({
            kind: 'cat', eventKey: 'console-pending', subject: '团子饼趴在窗台', caption: '团子饼趴在窗台上晒太阳',
            at: new Date(Date.now() - 60_000).toISOString(),
        }, async () => ({ bytes: jpeg(3), model: 'm' }));
        const pending = listAiPhotoDrafts('pending_review', 24);
        assert.ok(pending.ok && pending.entries.length === 1);
        const approved = reviewAiPhoto('approve', pending.ok ? pending.entries[0]!.id : '', 'confirmed');
        assert.deepEqual(approved, { ok: true, status: 'approved' });
        assert.equal(photoShelf({ dir: join(dataDir, 'photos'), log: () => {} }).status().count, 1);
        assert.deepEqual(listAiPhotoDrafts('pending_review', 24), { ok: true, entries: [] });
        assert.deepEqual(reviewAiPhoto('send', pending.ok ? pending.entries[0]!.id : '', 'confirmed'), { ok: false, error: '审核请求无效，请重新确认后再试。' });
        setConsoleState({ dataDir: undefined, status: undefined });
    });
});

describe('控制台的 AI 照片运行与费用摘要', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-photo-runtime-'));
    after(() => rmSync(dataDir, { recursive: true, force: true }));

    test('只返回开关、供应商角色、今日计数和草稿数', () => {
        const now = new Date();
        const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const usageDir = join(dataDir, 'ai-photo-usage');
        mkdirSync(usageDir, { recursive: true });
        writeFileSync(join(usageDir, 'usage.json'), JSON.stringify({
            version: 1, days: [{ day, attempts: 3, generated: 2, failed: 1, byProvider: { local: { attempts: 1, generated: 1, failed: 0 }, primary: { attempts: 2, generated: 1, failed: 1 } } }],
        }));
        setConsoleState({ dataDir, status: () => ({ features: [{ key: 'aiPhotos', on: true }] }) as never });
        const result = aiPhotoRuntimeStatus({
            QQBOT_IMAGE_LOCAL_BASE_URL: 'http://127.0.0.1:8188/v1/',
            QQBOT_IMAGE_API_KEY: 'secret-primary',
            QQBOT_IMAGE_FALLBACK_BASE_URL: 'https://fallback.example/v1/',
            QQBOT_IMAGE_FALLBACK_API_KEY: 'secret-fallback',
        });
        assert.equal(result.feature, 'on');
        assert.deepEqual(result.providers, ['local', 'primary', 'fallback']);
        assert.deepEqual(result.usage, { day, attempts: 3, generated: 2, failed: 1, remaining: 1 });
        assert.doesNotMatch(JSON.stringify(result), /secret|example|127\.0\.0\.1|gpt|usage\.json|\\/);
    });

    test('用量文件损坏时只降级当前卡片，不暴露错误原文', () => {
        writeFileSync(join(dataDir, 'ai-photo-usage', 'usage.json'), '{"token":"secret","path":"C:\\\\private"}');
        setConsoleState({ dataDir, status: () => { throw new Error('secret status'); } });
        const result = aiPhotoRuntimeStatus({});
        assert.equal(result.feature, 'unknown');
        assert.equal(result.usage, undefined);
        assert.equal(result.degraded, '今日用量暂时无法读取。');
        assert.doesNotMatch(JSON.stringify(result), /secret|private|token|path|\\/);
    });
});

describe('控制台的非人物视觉参考（ADR 0242）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-photo-references-'));
    after(() => rmSync(dataDir, { recursive: true, force: true }));
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(1024, 16); png.writeUInt32BE(1024, 20);
    png[24] = 8; png[25] = 2;
    const image = `data:image/png;base64,${png.toString('base64')}`;

    test('必须明确确认不含人物，列表不暴露哈希、服务编号和路径', () => {
        setConsoleState({ dataDir });
        assert.equal(addAiPhotoReference('cat', image, 'potato-v1', false, 'confirmed').ok, false);
        assert.equal(addAiPhotoReference('cat', image, 'potato-v1', true, undefined).ok, false);
        const added = addAiPhotoReference('cat', image, 'potato-v1', true, 'confirmed');
        assert.ok(added.ok && added.entry?.kind === 'cat');

        const listed = listAiPhotoReferences();
        assert.ok(listed.ok && listed.entries.length === 1);
        assert.doesNotMatch(JSON.stringify(listed), /potato-v1|contentHash|data:image|ai-photo-references|\\|\//);
    });

    test('拒绝伪造图片、人物引用和未确认删除', () => {
        setConsoleState({ dataDir });
        assert.deepEqual(addAiPhotoReference('desk', 'data:image/png;base64,AAAA', 'desk-v1', true, 'confirmed'), {
            ok: false, error: '请选择 5 MB 以内的 JPEG、PNG 或 WebP 图片。',
        });
        const human = addAiPhotoReference('cat', image, 'selfie-face-v1', true, 'confirmed');
        assert.equal(human.ok, false);
        assert.doesNotMatch(JSON.stringify(human), /selfie|face|index\.json|\\|\//);

        const listed = listAiPhotoReferences();
        assert.ok(listed.ok && listed.entries.length === 1);
        const id = listed.ok ? listed.entries[0]!.id : '';
        assert.equal(removeAiPhotoReference(id, undefined).ok, false);
        assert.deepEqual(removeAiPhotoReference(id, 'confirmed'), { ok: true });
        assert.deepEqual(listAiPhotoReferences(), { ok: true, entries: [] });
    });

    test('索引不是普通文件时失败关闭，不暴露本地信息', () => {
        const unsafe = mkdtempSync(join(tmpdir(), 'qqbot-photo-references-unsafe-'));
        mkdirSync(join(unsafe, 'ai-photo-references', 'index.json'), { recursive: true });
        setConsoleState({ dataDir: unsafe });
        const result = listAiPhotoReferences();
        assert.equal(result.ok, false);
        assert.doesNotMatch(JSON.stringify(result), /index\.json|unsafe|tmp|\\|\//);
        rmSync(unsafe, { recursive: true, force: true });
    });
});
