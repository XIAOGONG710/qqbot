import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { memesPath, saveMemes } from '../src/language/memes.ts';

for (const command of ['remove', 'add'] as const) test(`真实App在作者CLI ${command}后下一轮提示词读取已提交的新事实`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-meme-author-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const previousFetch = globalThis.fetch, term = '合成喵梗', oldMeaning = '独有的旧解释用于合成验证', newMeaning = '独有的新解释用于合成验证';
    const now = new Date(), day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let app: App | undefined, sent = 0; const prompts: { content: string }[][] = [];
    try {
        globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `card-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        saveMemes(memesPath(dataDir), { version: 1, refreshedAt: now.toISOString(), entries: [{ term, meaning: oldMeaning, example: '', confidence: 'high', firstSeen: day, lastSeen: day, seen: 1 }] });
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'card-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], memes: true, bilibiliAccount: false,
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic' });
        app = startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: () => {}, transport: { friendHistory: async () => [], sendPrivateText: async () => ++sent + 900 },
            pipeline: { now: () => now.getTime(), settle: { quietMs: 0, maxMs: 0 }, generate: async messages => { prompts.push(messages); return '合成回应'; } } });
        await app.connected(20000);
        const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../src/ops/meme-cli.ts', import.meta.url)), command, term, ...(command === 'add' ? [newMeaning] : []), '--dir', dataDir], { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 800, real_seq: '8000001', time: Math.floor(now.getTime() / 1000),
            raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: `今天聊聊${term}` } }] });
        const deadline = Date.now() + 3000;
        while (!sent) { assert.ok(Date.now() < deadline, '合成回复超时'); await new Promise(done => setTimeout(done, 5)); }
        assert.ok(prompts.length);
        assert.equal(prompts.at(-1)!.some(message => message.content.includes(oldMeaning)), false, '不能继续暴露作者已删除或纠正的旧解释');
        assert.equal(prompts.at(-1)!.some(message => message.content.includes(newMeaning)), command === 'add');
    } finally {
        await app?.stop(); globalThis.fetch = previousFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-meme-author-')); rmSync(root, { recursive: true, force: true });
    }
});

