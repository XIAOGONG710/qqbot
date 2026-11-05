import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { fileOps } from '../src/memory/json-file.ts';
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise<void>(done => setImmediate(done)); };
for (const kind of ['risk', 'replies'] as const) for (const failure of ['schema', 'json', 'io'] as const) test(`真实App ${kind} ${failure}保原暂停公共启动且恢复后能重试`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-bili-state-')), dataDir = join(root, 'data'), dir = join(dataDir, 'presence');
    mkdirSync(dir, { recursive: true }); mkdirSync(join(dataDir, 'secrets'));
    const path = join(dir, `bilibili-${kind}.json`), originalRead = fileOps.readFileSync, originalDelays = fileOps.readDelaysMs;
    const at = new Date(2026, 10, 5, 12).getTime(); let app: App | undefined, sends = 0, broken = true;
    const good = kind === 'risk' ? { version: 1, seen: [] } : { version: 1, handled: [] };
    const body = failure === 'json' ? '{SYNTHETIC_PRIVATE_FRAGMENT' : JSON.stringify(failure === 'io' ? good : kind === 'risk' ? { ...good, until: 'SYNTHETIC_PRIVATE_BAD_TIME' } : { ...good, count: 'SYNTHETIC_PRIVATE_BAD_COUNT' });
    const logs: string[] = [];
    try {
        writeFileSync(path, body);
        for (const tier of ['stranger', 'classmate', 'classmate-open']) writeFileSync(join(root, `${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), JSON.stringify({ sessdata: 'synthetic', biliJct: 'synthetic', dedeUserId: '123', buvid3: 'synthetic', savedAt: '2026-11-05T00:00:00Z' }));
        fileOps.readDelaysMs = [0]; fileOps.readFileSync = ((target: Parameters<typeof originalRead>[0], ...args: unknown[]) => {
            if (failure === 'io' && broken && String(target) === path) throw Object.assign(Error('synthetic IO'), { code: 'EIO' });
            return Reflect.apply(originalRead, fileOps, [target, ...args]);
        }) as typeof originalRead;
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, '{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], bilibiliAccount: true, bilibiliAtUid: 456, bilibiliReplies: 'on',
            jokes: false, idioms: false, schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic' });
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' }, transport: { friendHistory: async () => [], sendPrivateText: async () => 99 },
            pipeline: { now: () => at, generate: async () => '这只猫看起来真开心' }, bilibiliRequest: async url => {
                let data: object;
                if (url.includes('/nav')) data = { isLogin: true, mid: 123 };
                else if (url.includes('/unread')) data = { sys_msg: 0 };
                else if (url.includes('/msgfeed/reply')) data = { items: [{ reply_time: at / 1000 - 1, user: { mid: 456, nickname: '合成留言者' }, item: { source_id: '701', target_id: '700', root_id: '700', subject_id: 1, business_id: 1, source_content: '猫咪确实很可爱', root_reply_content: '猫咪今天很开心' } }] };
                else if (url.includes('/reply/add')) { sends++; data = { rpid_str: '702' }; }
                else throw Error('unexpected synthetic request');
                return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) };
            } });
        await assert.doesNotReject(app.connected(20000)); await settle();
        assert.equal(sends, 0); assert.equal(readFileSync(path, 'utf8'), body); assert.ok(!readdirSync(dir).some(name => name.includes('.corrupt-')));
        assert.ok(!logs.join('\n').includes('SYNTHETIC_PRIVATE'));
        broken = false; writeFileSync(path, JSON.stringify(good)); await app.connected(20000); await settle(); assert.equal(sends, 1);
    } finally {
        broken = false; await app?.stop(); fileOps.readFileSync = originalRead; fileOps.readDelaysMs = originalDelays;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-bili-state-')); rmSync(root, { recursive: true, force: true });
    }
});
