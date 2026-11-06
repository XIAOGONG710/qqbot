import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { ImageDescriber } from '../src/vision/media.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { qzoneComposer, qzoneSystemPrompt, type QzoneComposerDeps } from '../src/social/qzone.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// 最小的合法 PNG（1×1），vision 假的不检查内容
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function setup(replies: (string | Error)[], vision?: ImageDescriber) {
    const photoDir = mkdtempSync(join(tmpdir(), 'qqbot-qzone-'));
    dirs.push(photoDir);
    writeFileSync(join(photoDir, 'a.png'), PNG);
    const seen: OpenAIMessage[][] = [];
    const logs: string[] = [];
    const deps: QzoneComposerDeps = {
        character: { name: '林梦瑶', description: '大学生，爱拍照', personality: '嘴硬心软', banned: ['云杉学院'] },
        generate: async messages => {
            seen.push(messages);
            const next = replies.shift();
            if (next instanceof Error) throw next;
            return next ?? '';
        },
        ...(vision ? { vision } : {}),
        photoDir,
        situation: () => ['你现在：在宿舍刷手机', '天气：下雨'],
        log: message => logs.push(message),
    };
    return { compose: qzoneComposer(deps), seen, logs };
}

describe('写说说（ADR 0083）', () => {
    test('说明里有风格要求和「不要」的几样；用的是传进来的这一档的资料', () => {
        const prompt = qzoneSystemPrompt({ name: '林梦瑶', description: '大学生，爱拍照', personality: '嘴硬心软', banned: [] });
        assert.match(prompt, /你是林梦瑶/);
        assert.match(prompt, /大学生，爱拍照/);
        for (const word of ['一两句', '不要 @ 人', '网址', '电话或学号', '不要提男朋友或恋爱', '不要提你是 AI', '只输出说说正文']) assert.ok(prompt.includes(word), word);
    });

    test('没图：写一句文字说说，不带图；提示词里有当下的状态和最近发过的', async () => {
        const { compose, seen } = setup(['今天的云好看']);
        const result = await compose({ now: Date.UTC(2026, 10, 3, 12), recent: ['昨天的面不错'] });
        assert.deepEqual(result, { text: '今天的云好看', withPhoto: false });
        const user = seen[0]!.at(-1)!.content;
        assert.match(user, /你现在：在宿舍刷手机/);
        assert.match(user, /这次没有照片/);
        assert.match(user, /昨天的面不错/);
    });

    test('有图且看图成功：照描述写，带图；看图失败或没开看图：写成纯文字，不带图', async () => {
        const described: string[] = [];
        const vision: ImageDescriber = { describe: async ({ dataUrl }) => { described.push(dataUrl ?? ''); return '傍晚的天空，云被染成粉色'; } };
        const withPhoto = setup(['傍晚的云被染粉了'], vision);
        assert.deepEqual(await withPhoto.compose({ now: 0, photoFile: 'a.png', recent: [] }), { text: '傍晚的云被染粉了', withPhoto: true });
        assert.match(withPhoto.seen[0]!.at(-1)!.content, /傍晚的天空，云被染成粉色/);
        assert.match(described[0]!, /^data:image\/png;base64,/);

        const broken = setup(['随手一条'], { describe: async () => { throw new Error('看图模型返回 500'); } });
        assert.deepEqual(await broken.compose({ now: 0, photoFile: 'a.png', recent: [] }), { text: '随手一条', withPhoto: false });
        assert.ok(broken.logs.some(l => l.includes('看图失败')), broken.logs.join('|'));

        const none = setup(['随手一条']);
        assert.deepEqual(await none.compose({ now: 0, photoFile: 'a.png', recent: [] }), { text: '随手一条', withPhoto: false });
        assert.ok(none.logs.some(l => l.includes('没开看图')));
    });

    test('不合格重写（最多 3 次）：网址、禁用词、和最近的重复；三次都不行返回 undefined；模型出错返回 undefined', async () => {
        const retry = setup(['看这个 https://x.com', '我在云杉学院', '昨天的面不错', '终于下课了']);
        assert.deepEqual(await retry.compose({ now: 0, recent: ['昨天的面不错'] }), undefined, '前三次都不合格');
        const ok = setup(['我在云杉学院', '昨天的面不错', '终于下课了']);
        assert.deepEqual(await ok.compose({ now: 0, recent: ['昨天的面不错'] }), { text: '终于下课了', withPhoto: false });
        const broken = setup([new Error('模型不可用')]);
        assert.equal(await broken.compose({ now: 0, recent: [] }), undefined);
        assert.ok(broken.logs.some(l => l.includes('模型出错')));
    });
});
