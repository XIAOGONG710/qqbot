// 线上开着、开关这一层没测过的（docs/reports/2026-11-24-switch-audit.md「测试覆盖」）：readStickers（ADR 0206，看懂他发的表情包）。
// 读的那一步（readMedia / 缓存 / 写法）由 sticker-reads.test.ts 管，群里那条由 group-chat.test.ts 管；这里只管 App 按配置接不接：
// 同样给了表情包专用的看图（stickerReader），开关关着就一次都不调、聊天记录照旧「[动画表情]」；开着就读成「[动画表情：……]」；
// 开着但 media 关着（要 media + 看图）也不读。只用合成角色，不连网。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import type { AppConfig, Contact } from '../src/platform/config.ts';
import type { MessageEvent } from '../src/platform/onebot.ts';
import { ChatHistory } from '../src/memory/history.ts';
import type { ImageDescriber } from '../src/vision/media.ts';
import { baselineConfig } from './baseline/harness.ts';

const SELF = 20000;
const boyfriend: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend' };

// 她在本机的目录指到临时目录（App 会往灵魂目录导出），不碰这台机器上真的那一份
const envKeys = ['QQBOT_SOUL_DIR', 'HER_DIR'] as const;
const envBefore = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const home = mkdtempSync(join(tmpdir(), 'qqbot-live-switches-media-home-'));
before(() => { process.env.QQBOT_SOUL_DIR = join(home, 'soul'); process.env.HER_DIR = join(home, 'her'); });
after(() => {
    for (const key of envKeys) { if (envBefore[key] === undefined) delete process.env[key]; else process.env[key] = envBefore[key]; }
    rmSync(home, { recursive: true, force: true });
});

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 表情包专用看图的假模型：按「文字：…｜画面：…」回，记下被调了几次 */
function fakeStickerReader() {
    const calls: string[] = [];
    const reader: ImageDescriber = { describe: async image => { calls.push(image.url); return '文字：理理我｜画面：一只橘猫委屈地趴在地上'; } };
    return { reader, calls };
}

/** 没有名字的图片表情（sub_type 1、summary 是「[动画表情]」） */
const stickerEvent = (messageId: number): MessageEvent => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: boyfriend.qq, message_id: messageId,
    time: Math.floor(Date.now() / 1000),
    message: [
        { type: 'text', data: { text: '好嘛 ' } },
        { type: 'image', data: { file: 'A1B2C3D4E5F6A7B8.gif', url: 'https://example.invalid/A1B2C3D4E5F6A7B8.gif?rkey=synthetic', sub_type: 1, summary: '[动画表情]' } },
    ],
    raw_message: '', sender: { user_id: boyfriend.qq },
});

async function run(overrides: Partial<AppConfig>) {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-live-switches-media-'));
    dirs.push(dataDir);
    // 生产默认值，连网的关掉；作息关着（几秒内回），不主动
    const config = baselineConfig(dataDir, [boyfriend], { schedule: false, moody: false, speechCheck: false, herDays: false, proactive: 'off', ...overrides });
    const { reader, calls } = fakeStickerReader();
    const prompts: string[] = [];
    const sent: string[] = [];
    const app = startApp({
        config, log: () => {}, sensitive: { on: () => false, describe: () => '' },
        stickerReader: reader,
        transport: { sendPrivateText: async (_qq, text) => { sent.push(text); return 900 + sent.length; }, friendHistory: async () => [] },
        pipeline: { generate: async messages => { prompts.push(messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')); return '怎么啦'; }, settle: { quietMs: 0, maxMs: 0 } },
    });
    apps.push(app);
    await app.connected(SELF);
    app.receive(stickerEvent(5001));
    const deadline = Date.now() + 5000;
    while (!sent.length) {
        assert.ok(Date.now() < deadline, '等不到她回');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const said = new ChatHistory(dataDir).load(boyfriend.qq).filter(message => message.role === 'user').map(message => message.content);
    return { calls, prompts, said };
}

const READ = '[动画表情：上面写着「理理我」；一只橘猫委屈地趴在地上]';

describe('readStickers（ADR 0206）：看懂他发的表情包（开关合并：跟着 media）', () => {
    test('media 关着（给了看图也不读）：一次都不调，聊天记录和提示词里照旧「[动画表情]」', async () => {
        const r = await run({ media: false });
        assert.equal(r.calls.length, 0);
        assert.deepEqual(r.said, ['好嘛 [动画表情]']);
        assert.ok(!r.prompts.some(prompt => prompt.includes(READ)));
    });

    test('开着：读一次，聊天记录里是「[动画表情：上面写着…；画面]」，提示词里也是', async () => {
        const r = await run({ media: true });
        assert.equal(r.calls.length, 1);
        assert.deepEqual(r.said, [`好嘛 ${READ}`]);
        assert.ok(r.prompts.some(prompt => prompt.includes(READ)));
    });
});
