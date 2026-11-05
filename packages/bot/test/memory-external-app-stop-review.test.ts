import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, type App, type Transport } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { videoPlan } from '../src/bilibili/bilibili.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { acquireLock } from '../src/platform/lock.ts';

function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(done => { release = done; }); return { promise, release }; }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-external-app-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    let day!: Date;
    for (let n = 2; n < 28; n++) { const date = new Date(2026, 10, n, 23); if (videoPlan(`2026-11-${String(n).padStart(2, '0')}`, [0, 6].includes(date.getDay()))) { day = date; break; } }
    assert.ok(day); const clock = new VirtualClock(day);
    const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } }, semester: { start: '2026-09-01', weeks: 30 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [], free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
    const card = { spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule, world: { startDay: '2026-11-01', awayHolidays: [], people: [], events: [] } } } } };
    for (const tier of ['boyfriend', 'boyfriend-open', 'classmate', 'classmate-open', 'stranger', 'stranger-open']) writeFileSync(join(root, `${tier}.json`), JSON.stringify(card));
    function start(transport: Partial<Transport>, browse = true): App {
        const config = parseAppConfig({ dataDir, characterCard: join(root, '{tier}.json'), llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, contacts: [{ qq: 10001, name: '合成甲', tier: 'boyfriend' }], herDays: true, schedule: false, realWeather: false, moody: false, speechCheck: false, proactive: 'off', bilibili: browse ? 'on' : 'off', onlineStatus: !browse }, root, { QQBOT_LLM_API_KEY: 'synthetic' });
        return startApp({ config, log() {}, sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => 1, ...transport },
            pipeline: { now: clock.now, waitUntil: clock.waitUntil, settle: { quietMs: 0, maxMs: 0 }, generate: async () => '这个猫咪回头看也太逗了' },
            bilibiliFetch: async url => ({ ok: true, status: 200, text: async () => JSON.stringify(url.includes('/reply/') ? { code: 0, data: { replies: [] } } : { code: 0, data: { list: [{ bvid: 'BV1abcdefghj', aid: 1, title: '合成猫咪', desc: '合成', owner: { name: '合成作者' }, tname: '喵星人', pic: 'https://synthetic.invalid/cover.jpg', duration: 60, stat: { view: 1000, like: 50 } }] } }) }),
        });
    }
    async function until(check: () => boolean) { const end = Date.now() + 8000; while (!check()) { assert.ok(Date.now() < end, 'synthetic application timeout'); const next = clock.nextTimer(); if (next !== undefined) clock.advanceTo(next); await new Promise(done => setTimeout(done, 5)); } }
    function cleanup() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-external-app-')); rmSync(root, { recursive: true, force: true }); }
    return { root, dataDir, clock, start, until, cleanup, history: () => new ChatHistory(dataDir).load(10001) };
}

test('App停止等待B站封面ACK，取消后不派新文本且保本次封面历史', async () => {
    const f = fixture(), held = gate<number>(); let image = false, links = 0, app: App | undefined;
    try {
        app = f.start({ sendPrivateImage: async () => { image = true; return held.promise; }, sendPrivateText: async (_qq, text) => { if (text.includes('bilibili.com/video')) links++; return 800; } });
        await app.connected(20000); await f.until(() => image); const drain = app.stop(); assert.ok(drain instanceof Promise); assert.equal(app.stop(), drain);
        assert.throws(() => acquireLock(join(f.dataDir, 'bot.lock'))); held.release(801); await drain;
        assert.equal(links, 0); assert.ok(f.history().some(message => message.messageId === 801 && message.content.includes('封面')));
        const release = acquireLock(join(f.dataDir, 'bot.lock')); release();
    } finally { held.release(801); await app?.stop(); f.cleanup(); }
});

test('App停止等待已派链接ACK和ChatHistory，收尾后才释放目录租约', async () => {
    const f = fixture(), held = gate<number>(); let link = false, app: App | undefined;
    try {
        app = f.start({ sendPrivateText: async (_qq, text) => { if (text.includes('bilibili.com/video')) { link = true; return held.promise; } return 810; } });
        await app.connected(20000); await f.until(() => link); const drain = app.stop(); assert.ok(drain instanceof Promise);
        assert.throws(() => acquireLock(join(f.dataDir, 'bot.lock'))); held.release(811); await drain;
        assert.ok(f.history().some(message => message.messageId === 811 && message.content.includes('[分享视频]'))); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
    } finally { held.release(811); await app?.stop(); f.cleanup(); }
});

test('App停止等待存在感在线状态ACK与持久状态，之后才允许另一实例取得锁', async () => {
    const f = fixture(), held = gate<void>(); let entered = false, app: App | undefined;
    try {
        app = f.start({ setOnlineStatus: async () => { entered = true; await held.promise; } }, false); await app.connected(20000); await f.until(() => entered);
        const drain = app.stop(); assert.ok(drain instanceof Promise); assert.throws(() => acquireLock(join(f.dataDir, 'bot.lock')));
        held.release(); await drain; const state = JSON.parse(readFileSync(join(f.dataDir, 'presence', 'presence.json'), 'utf8')); assert.ok(state.status);
        const release = acquireLock(join(f.dataDir, 'bot.lock')); release();
    } finally { held.release(); await app?.stop(); f.cleanup(); }
});
