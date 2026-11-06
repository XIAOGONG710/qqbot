import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileOps } from '../src/memory/json-file.ts';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const NOW = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!check()) { assert.ok(Date.now() < deadline, 'synthetic crisis checkpoint timed out'); await tick(); }
}

test('危机状态首次发布失败但磁盘在正常停机前恢复：释放目录租约前完成最后持久化', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-crisis-stop-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const crisisPath = join(dataDir, 'crisis.json'), originalRename = fileOps.renameSync, originalDelays = fileOps.writeDelaysMs;
    let app: App | undefined;
    try {
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({
            spec: 'chara_card_v2', data: { name: '合成角色' },
        }));
        const config = parseAppConfig({
            llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], schedule: false, moody: false, speechCheck: false,
            herDays: false, realWeather: false, proactive: 'off', media: false, jokes: false, idioms: false,
        }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from, to) => {
            if (String(to) === crisisPath) throw Object.assign(new Error('SYNTHETIC_CRISIS_COMMIT_FAILURE'), { code: 'EIO' });
            return originalRename(from, to);
        }) as typeof originalRename;
        app = startApp({ config, log() {}, sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => 1 },
            pipeline: { now: () => NOW, generate: async () => '我在。你现在安全吗？身边有人吗？' },
        });
        app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001,
            message_id: 1, real_seq: '100001', time: NOW / 1000, raw_message: '我不想活了', sender: { user_id: 10001 }, message: '我不想活了' });
        await until(() => app!.status().contacts[0]?.crisis?.paused === true);
        assert.equal(existsSync(crisisPath), false, '首次发布仍处于dirty RAM状态');

        fileOps.renameSync = originalRename;
        await app.stop();
        assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        const saved = JSON.parse(readFileSync(crisisPath, 'utf8')) as { contacts: Record<string, { level: string }> };
        assert.equal(saved.contacts['10001']?.level, 'high');
    } finally {
        fileOps.renameSync = originalRename; fileOps.writeDelaysMs = originalDelays; await app?.stop();
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-crisis-stop-'));
        rmSync(root, { recursive: true, force: true });
    }
});
