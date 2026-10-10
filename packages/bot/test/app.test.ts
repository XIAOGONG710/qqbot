import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp, type App, type Transport } from '../src/app.ts';
import type { HistoryMessage } from '../src/backfill.ts';
import type { ImageDescriber, MEDIA_TIMEOUTS, MediaReader } from '../src/media.ts';
import type { AppConfig } from '../src/config.ts';
import { ChatHistory } from '../src/history.ts';
import type { MessageEvent } from '../src/onebot.ts';
import type { ProactiveRecord } from '../src/proactive.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const SELF = 20000;
const nowSec = () => Math.floor(Date.now() / 1000);

const dirs: string[] = [];
const apps: App[] = [];
afterEach(() => {
    for (const app of apps.splice(0)) app.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-app-'));
    dirs.push(dataDir);
    return {
        llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
        prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
        characterCard: join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'),
        contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }],
        unlistedFriends: false,
        schedule: false,
        moody: false,
        speechCheck: false,
        herDays: false,
        autonomousLife: false,
        projectChoice: false,
        lifeInPrompt: false,
        realWeather: false,
        media: true,
        candidates: 1,
        contextTurns: 0,
        contextContacts: [],
        proactive: 'off',
        dataDir,
        ...overrides,
    };
}

function event(userId: number, messageId: number, text: string, nickname?: string): MessageEvent {
    return {
        post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: userId, message_id: messageId,
        time: nowSec(), message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: userId, nickname },
    };
}

function historyMessage(messageId: number, from: number, text: string, secondsAgo: number): HistoryMessage {
    return { message_id: messageId, time: nowSec() - secondsAgo, sender: { user_id: from }, message: [{ type: 'text', data: { text } }] };
}

function setup(cfg: AppConfig, history: Record<number, HistoryMessage[]> = {}, options: { holdHistory?: Promise<void>; clock?: VirtualClock; media?: MediaReader; vision?: ImageDescriber; mediaTimeouts?: Partial<typeof MEDIA_TIMEOUTS> } = {}) {
    const sent: string[] = [];
    const logs: string[] = [];
    const asked: number[] = [];
    let nextId = 900;
    const transport: Transport = {
        sendPrivateText: async (userId, text) => { sent.push(`${userId}:${text}`); return nextId++; },
        friendHistory: async (userId, count) => {
            asked.push(userId);
            await options.holdHistory;
            const list = history[userId];
            if (!list) throw new Error('OneBot 调用失败 retcode 1200：消息不存在');
            return list.slice(-count);
        },
    };
    const app = startApp({
        config: cfg, transport, log: message => logs.push(message),
        ...(options.media ? { media: options.media } : {}),
        ...(options.vision ? { vision: options.vision } : {}),
        ...(options.mediaTimeouts ? { mediaTimeouts: options.mediaTimeouts } : {}),
        pipeline: {
            generate: async () => '好', settle: { quietMs: 0, maxMs: 0 },
            ...(options.clock ? { now: options.clock.now, waitUntil: options.clock.waitUntil } : {}),
        },
    });
    apps.push(app);
    return { app, sent, logs, asked };
}

/** 等到条件成立（回复器在后台跑），再多等一会儿看有没有多余的回复 */
async function until(check: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) assert.fail('等不到');
        await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 50));
}

const chat = (cfg: AppConfig, qq: number) => new ChatHistory(cfg.dataDir).load(qq).map(m => `${m.role}:${m.content}`);

describe('编排（app.ts）', () => {
    test('连上时补回（小号自己发的算她说的），补的时候到的消息攒着、补完按顺序处理不重复，然后只回一次', async () => {
        const cfg = config();
        let release!: () => void;
        const hold = new Promise<void>(r => { release = r; });
        const { app, sent } = setup(cfg, {
            10001: [historyMessage(1, 10001, '在吗', 60), historyMessage(2, SELF, '在', 50), historyMessage(3, 10001, '吃了吗', 40)],
        }, { holdHistory: hold });
        const connected = app.connected(SELF);
        app.receive(event(10001, 3, '吃了吗'));
        app.receive(event(10001, 4, '人呢'));
        assert.deepEqual(chat(cfg, 10001), [], '补完之前不处理');
        release();
        await connected;
        await until(() => sent.length > 0);
        assert.deepEqual(sent, ['10001:好']);
        assert.deepEqual(chat(cfg, 10001), ['user:在吗', 'assistant:在', 'user:吃了吗', 'user:人呢', 'assistant:好']);
    });

    test('拉不到历史（没有任何记录时 NapCat 也报错）：写日志、跳过这个人，其他人照常补回', async () => {
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }, { qq: 10002, name: '宝宝', tier: 'boyfriend' }] });
        const { app, sent, logs } = setup(cfg, { 10002: [historyMessage(7, 10002, '睡了吗', 30)] });
        await app.connected(SELF);
        await until(() => sent.length > 0);
        assert.deepEqual(sent, ['10002:好']);
        assert.ok(logs.some(l => l.startsWith('[10001] 拉取历史消息失败，跳过补回：') && l.includes('消息不存在')));
    });

    test('名单外：开关关着时忽略；开着时按 unlisted 档、用 QQ 昵称回复', async () => {
        const off = setup(config());
        off.app.receive(event(99999, 1, '你好', '小周'));
        await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(off.sent, []);
        assert.ok(off.logs.includes('忽略 QQ 99999 的私聊（不在名单）'));

        const cfg = config({ unlistedFriends: true });
        const on = setup(cfg);
        on.app.receive(event(99999, 1, '你好', ' 小周 '));
        await until(() => on.sent.length > 0);
        assert.deepEqual(on.sent, ['99999:好']);
        assert.ok(on.logs.includes('QQ 99999（小周）不在名单，按 unlisted 档回复'));
        assert.equal(JSON.parse(readFileSync(join(cfg.dataDir, 'tiers.json'), 'utf8'))['99999'].tier, 'unlisted');
    });

    test('状态（控制台用，ADR 0010）：每人的档位、回复器状态、最后一条是谁发的，名单外的好友也在；不含聊天内容；作息开着时有「她现在在干什么」', async () => {
        const cfg = config({ unlistedFriends: true, schedule: true, contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }] });
        const { app } = setup(cfg);
        let status = app.status();
        assert.deepEqual(status.contacts.map(c => [c.qq, c.tier, c.unlisted, c.responder.phase, c.last]), [[10001, 'classmate', false, 'idle', undefined]]);
        assert.equal(typeof status.contacts[0]!.now, 'string');
        assert.equal(status.schedule, true);
        assert.equal(status.memory, undefined);

        app.receive(event(99999, 1, '你好', '小周'));
        await until(() => app.status().contacts.length === 2);
        status = app.status();
        const stranger = status.contacts[1]!;
        assert.deepEqual([stranger.qq, stranger.name, stranger.tier, stranger.unlisted], [99999, '小周', 'unlisted', true]);
        // 作息按现在的时间算，她可能已经回了，也可能在等
        assert.ok(stranger.last && ['user', 'assistant'].includes(stranger.last.from));
        assert.doesNotMatch(JSON.stringify(status), /你好/, '不含聊天内容');
    });

    test('她自己的日子（ADR 0015）：启动日志、当天摘要只写一次、时间块里的心情行、状态页的「今天」；关掉或卡上没有就都没有', async () => {
        const cfg = config({ herDays: true, contacts: [{ qq: 10002, name: '宝宝', tier: 'boyfriend' }] });
        const { app, sent, logs } = setup(cfg, { 10002: [historyMessage(1, 10002, '在吗', 5)] });
        assert.ok(logs.includes('她自己的日子：开（每日心情、在读的书、进度数字的检查）'), '作息关着时没有看书的空闲活动');
        assert.equal(logs.filter(l => /^她自己的日子：今天（\d\d-\d\d）：心情 .+（.+）；在读 药屋少女的呢喃 第 \d+ 卷、惹金枝 /.test(l)).length, 1);
        await app.connected(SELF);
        await until(() => sent.length > 0);
        const prompt = JSON.parse(readFileSync(join(cfg.dataDir, 'last-prompt.json'), 'utf8')) as { messages: { content: string }[] };
        assert.ok(prompt.messages.some(m => /^\[你今天的心情：/m.test(m.content)));
        assert.ok(!prompt.messages.some(m => m.content.includes('{{user}}')));
        assert.equal(logs.filter(l => l.startsWith('她自己的日子：今天')).length, 1, '同一天第一次生成不再重复写');
        const today = app.status().today!;
        assert.match(today.day, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(typeof today.mood!.name, 'string');
        assert.deepEqual(today.books.map(book => [book.title, book.unit, book.putDown]), [['药屋少女的呢喃', '卷', false], ['惹金枝', '章', false], ['恰似寒光遇骄阳', '章', true]]);
        assert.equal(app.status().herDays, true);

        const off = setup(config({ contacts: [{ qq: 10002, name: '宝宝', tier: 'boyfriend' }] }));
        assert.ok(off.logs.includes('她自己的日子：关（配置 herDays: false）'));
        assert.equal(off.app.status().today, undefined);
        const stranger = setup(config({ herDays: true, contacts: [{ qq: 10003, name: '路人', tier: 'stranger' }] }));
        assert.ok(stranger.logs.includes('她自己的日子：开，但用到的档位卡上都没有心情和书'));
        assert.equal(stranger.app.status().today, undefined);
    });

    test('没人聊天时她一件件过日子（ADR 0040/0045）：默认关；开了有启动日志、需要锚点并排到现在', async () => {
        const bf = [{ qq: 10002, name: '宝宝', tier: 'boyfriend' as const }];
        const off = setup(config({ herDays: true, schedule: true, contacts: bf }));
        assert.ok(!off.logs.some(l => l.startsWith('没人聊天时她一件件过日子')));
        const cfg = config({ herDays: true, schedule: true, autonomousLife: true, contacts: bf });
        const on = setup(cfg);
        assert.ok(on.logs.includes('没人聊天时她一件件过日子：开（ADR 0040/0045，影子模式：需要值只改行动账，不进提示词）'));
        assert.ok(existsSync(join(cfg.dataDir, 'world', 'needs-anchor.json')));
        // 启动时写当天摘要读过一次世界：排到了现在（这一刻正在上课一半、赶路时跳到下一个边界，可能还没有一件）
        const queue = join(cfg.dataDir, 'world', 'action-queue.json');
        if (existsSync(queue)) assert.ok(JSON.parse(readFileSync(queue, 'utf8')).items.every((item: { id: string }) => item.id.startsWith('life:')));
    });

    test('生活账进提示词（lifeInPrompt，默认关）：她这几天练拍照修图写一行，只有开着、账上真有才写', async () => {
        const bf = [{ qq: 10002, name: '宝宝', tier: 'boyfriend' as const }];
        const seed = (cfg: AppConfig) => {
            const end = new Date(Date.now() - 2 * 3_600_000);
            const start = new Date(end.getTime() - 100 * 60_000);
            const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
            mkdirSync(join(cfg.dataDir, 'world'), { recursive: true });
            writeFileSync(join(cfg.dataDir, 'world', 'events.json'), JSON.stringify({ version: 1, events: [{
                id: `life:${start.toISOString()}:work_on_project`, actor: 'linmengyao', kind: 'work_on_project', day,
                startedAt: start.toISOString(), endedAt: end.toISOString(), source: 'simulation', result: 'succeeded',
                subject: '修昨天拍的片子', target: 'photography_growth',
            }] }));
        };
        const promptOf = async (cfg: AppConfig) => {
            seed(cfg);
            const { app, sent } = setup(cfg, { 10002: [historyMessage(1, 10002, '在干嘛', 5)] });
            await app.connected(SELF);
            await until(() => sent.length > 0);
            const prompt = JSON.parse(readFileSync(join(cfg.dataDir, 'last-prompt.json'), 'utf8')) as { messages: { content: string }[] };
            return prompt.messages.map(m => m.content).join('\n');
        };
        const on = await promptOf(config({ herDays: true, schedule: false, autonomousLife: true, lifeInPrompt: true, contacts: bf }));
        assert.match(on, /\[你这几天拍照修图（你自己过的日子，账上记着的；用不用、怎么说你自己定，没写的别编）：3 天里有 1 天在弄（修昨天拍的片子）；上一回是今天/);
        const off = await promptOf(config({ herDays: true, schedule: false, autonomousLife: true, contacts: bf }));
        assert.doesNotMatch(off, /你这几天拍照修图/, '默认关');
    });

    test('stop：释放锁；之后收到的消息、再连上都不处理', async () => {
        const cfg = config();
        const { app, sent, asked } = setup(cfg, { 10001: [historyMessage(1, 10001, '在吗', 10)] });
        assert.ok(existsSync(join(cfg.dataDir, 'bot.lock')));
        app.stop();
        assert.equal(existsSync(join(cfg.dataDir, 'bot.lock')), false);
        app.receive(event(10001, 2, '人呢'));
        await app.connected(SELF);
        await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(sent, []);
        assert.deepEqual(asked, []);
        assert.deepEqual(chat(cfg, 10001), []);
    });
});

describe('主动消息（ADR 0011）', () => {
    // 男朋友档（卡上有主动设置）；10-05 国庆放假，09:30 起，早安在 09:40–10:10
    const boyfriend = { qq: 10002, name: '宝宝', tier: 'boyfriend' as const };
    const records = (cfg: AppConfig): ProactiveRecord[] =>
        JSON.parse(readFileSync(join(cfg.dataDir, 'proactive', '10002-boyfriend.json'), 'utf8')).records;
    /** 把虚拟时钟拨到计划器等着的那个时刻 */
    const fireNext = (clock: VirtualClock) => clock.advanceTo(clock.nextTimer()!);

    test('开关关着、作息关着、低档位：都不排', async () => {
        const off = setup(config({ schedule: true, contacts: [boyfriend] }));
        await off.app.connected(SELF);
        assert.ok(off.logs.includes('主动消息：关'));
        assert.equal(off.app.status().contacts[0]!.proactive, undefined);

        const noSchedule = setup(config({ proactive: 'on', contacts: [boyfriend] }));
        assert.ok(noSchedule.logs.includes('主动消息：作息关着，不主动（时机按作息算）'));

        const classmate = setup(config({ proactive: 'on', schedule: true }));
        await classmate.app.connected(SELF);
        assert.ok(classmate.logs.includes('主动消息：开：名单里没有会主动找的档位'));
        assert.equal(classmate.app.status().contacts[0]!.proactive, undefined);
    });

    test('试运行：补回完才排；状态里有下一次；到点只写日志不发、不进聊天记录，记成试运行', async () => {
        const clock = new VirtualClock(new Date(2026, 9, 5, 9, 0));
        const cfg = config({ proactive: 'dryRun', schedule: true, contacts: [boyfriend] });
        const { app, sent, logs } = setup(cfg, { 10002: [] }, { clock });
        assert.equal(clock.nextTimer(), undefined, '补回之前不排');
        await app.connected(SELF);
        await until(() => clock.nextTimer() !== undefined);
        const next = app.status().contacts[0]!.proactive!;
        assert.equal(next.mode, 'dryRun');
        assert.match(next.next!.label, /^早安（起床后 \d+ 分钟）$/);
        assert.ok(next.next!.at >= new Date(2026, 9, 5, 9, 40).getTime() && next.next!.at <= new Date(2026, 9, 5, 10, 10).getTime());
        assert.ok(logs.some(l => /^\[10002\] 主动（试运行）：下一次 今天 09:\d\d 早安/.test(l) || /^\[10002\] 主动（试运行）：下一次 今天 10:\d\d 早安/.test(l)));

        fireNext(clock);
        await until(() => logs.some(l => l.includes('主动（试运行，没发）')));
        assert.ok(logs.some(l => l.startsWith('[10002] 主动（试运行，没发）：早安（起床后') && l.endsWith('今天第 1 条；本来要说：好')));
        assert.deepEqual(sent, []);
        assert.deepEqual(chat(cfg, 10002), []);
        assert.deepEqual(records(cfg).map(r => [r.id, r.result]), [['2026-10-05:morning', 'dryRun']]);
        assert.equal(app.status().contacts[0]!.proactive!.today, 1);
    });

    test('打开：到点真的发出去、进聊天记录；重启（同一个数据目录）后不重复发', async () => {
        const clock = new VirtualClock(new Date(2026, 9, 5, 9, 0));
        const cfg = config({ proactive: 'on', schedule: true, contacts: [boyfriend] });
        const first = setup(cfg, { 10002: [] }, { clock });
        await first.app.connected(SELF);
        await until(() => clock.nextTimer() !== undefined);
        fireNext(clock);
        await until(() => first.sent.length > 0, 8000);
        assert.deepEqual(first.sent, ['10002:好']);
        assert.deepEqual(chat(cfg, 10002), ['assistant:好']);
        assert.deepEqual(records(cfg).map(r => [r.id, r.result, r.messageIds]), [['2026-10-05:morning', 'sent', [900]]]);
        assert.ok(first.logs.some(l => /^\[10002\] 主动找他（早安（起床后 \d+ 分钟））：好$/.test(l)));
        first.app.stop();

        // 重启：同一时刻、同一个数据目录（补回拿到的是她刚发的那条）
        const again = setup(cfg, { 10002: [{ message_id: 900, time: Math.floor(clock.now() / 1000), sender: { user_id: SELF }, message: [{ type: 'text', data: { text: '好' } }] }] }, { clock });
        await again.app.connected(SELF);
        // 他还没回早安：除了日子先不排
        await until(() => again.logs.some(l => l.includes('等他回了再排')));
        assert.ok(again.logs.includes('[10002] 主动：上一条主动消息他还没回，等他回了再排；今明两天没有要发的了'), again.logs.join('\n'));
        assert.equal(again.app.status().contacts[0]!.proactive!.paused, '上一条主动消息他还没回，等他回了再排');
        assert.deepEqual(again.sent, []);
        assert.deepEqual(chat(cfg, 10002), ['assistant:好']);
    });

    test('错过的不补：12:00 才启动，早安记成「错过了，不补」', async () => {
        const clock = new VirtualClock(new Date(2026, 9, 5, 12, 0));
        const cfg = config({ proactive: 'on', schedule: true, contacts: [boyfriend] });
        const { app, logs, sent } = setup(cfg, { 10002: [] }, { clock });
        await app.connected(SELF);
        await until(() => logs.some(l => l.includes('错过了，不补')));
        assert.ok(logs.some(l => /^\[10002\] 主动：早安（起床后 \d+ 分钟）计划在 \d\d:\d\d，错过了，不补$/.test(l)));
        assert.deepEqual(records(cfg).map(r => [r.id, r.result, r.reason]), [['2026-10-05:morning', 'skipped', '错过了，不补']]);
        assert.deepEqual(sent, []);
    });
});

describe('他发的语音、图片（ADR 0052，假 NapCat）', () => {
    const voiceSegment: MessageEvent['message'] = [{ type: 'record', data: { file: 'abc.amr', file_size: '3000' } }];
    const photoSegment = (url: string): MessageEvent['message'] => [{ type: 'image', data: { file: 'a.jpg', url, sub_type: 0, summary: '' } }];
    const mediaEvent = (userId: number, messageId: number, message: MessageEvent['message']): MessageEvent => ({ ...event(userId, messageId, ''), message, raw_message: '' });
    const hang = <T>() => new Promise<T>(() => {});

    /** 按消息 id 给转写、按 URL 给 OCR；hold 的那几条等 release 了才回；记下调了几次 */
    function napcat(voices: Record<number, string | 'hang'>, ocr: Record<string, string[] | 'hang'> = {}) {
        const calls = { voice: [] as number[], ocr: [] as string[] };
        const held: (() => void)[] = [];
        let holding = false;
        const media: MediaReader = {
            voiceToText: async id => {
                calls.voice.push(id);
                if (holding) await new Promise<void>(r => held.push(r));
                const result = voices[id];
                if (result === 'hang') return hang();
                if (result === undefined) throw new Error('消息不存在');
                return result;
            },
            ocr: async url => {
                calls.ocr.push(url);
                const result = ocr[url];
                return result === 'hang' ? hang() : result ?? [];
            },
        };
        return { media, calls, hold: () => { holding = true; }, release: () => { holding = false; for (const r of held.splice(0)) r(); } };
    }

    test('他发语音：转出来的字进聊天记录，照常回；重启后补回拿到同一条，不再转', async () => {
        const cfg = config();
        const fake = napcat({ 1: '今天食堂人好多' });
        const first = setup(cfg, { 10001: [] }, { media: fake.media });
        await first.app.connected(SELF);
        first.app.receive(mediaEvent(10001, 1, voiceSegment));
        await until(() => first.sent.length > 0);
        assert.deepEqual(chat(cfg, 10001), ['user:[语音：今天食堂人好多]', 'assistant:好']);
        assert.deepEqual(fake.calls.voice, [1]);
        assert.ok(first.logs.some(l => /^\[10001\] 听语音：转出 7 个字（\d+\.\d 秒）$/.test(l)), first.logs.join('\n'));
        first.app.stop();

        // 重启：NapCat 的历史里还是那条语音和她的回复
        const again = napcat({ 1: '今天食堂人好多' });
        const second = setup(cfg, { 10001: [
            { message_id: 1, time: nowSec() - 5, sender: { user_id: 10001 }, message: voiceSegment },
            { message_id: 900, time: nowSec() - 3, sender: { user_id: SELF }, message: [{ type: 'text', data: { text: '好' } }] },
        ] }, { media: again.media });
        await second.app.connected(SELF);
        await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(again.calls.voice, [], '聊天记录里有了，不再转');
        assert.deepEqual(chat(cfg, 10001), ['user:[语音：今天食堂人好多]', 'assistant:好']);
    });

    test('补回：漏掉的语音、截图读过再记；补的时候实时又收到同一条语音，只转一次、只记一次', async () => {
        const cfg = config();
        const fake = napcat({ 5: '你下课了吗' }, { 'https://x/shot.png': ['期中考试安排'] });
        const { app, sent } = setup(cfg, { 10001: [
            { message_id: 5, time: nowSec() - 30, sender: { user_id: 10001 }, message: voiceSegment },
            { message_id: 6, time: nowSec() - 20, sender: { user_id: 10001 }, message: photoSegment('https://x/shot.png') },
        ] }, { media: fake.media });
        // 断线前实时收到的那条还在转，这时连上了、补回也拿到它
        fake.hold();
        app.receive(mediaEvent(10001, 5, voiceSegment));
        const connected = app.connected(SELF);
        await new Promise(r => setTimeout(r, 20));
        fake.release();
        await connected;
        await until(() => sent.length > 0);
        await until(() => chat(cfg, 10001).filter(m => m.startsWith('user:')).length === 2);
        assert.deepEqual(fake.calls.voice, [5]);
        assert.deepEqual(fake.calls.ocr, ['https://x/shot.png']);
        assert.deepEqual(chat(cfg, 10001).filter(m => m.startsWith('user:')), ['user:[语音：你下课了吗]', 'user:[图片，上面写着：期中考试安排]']);
    });

    test('读的时候后面来的话排在后面，顺序不乱；没字的图（NapCat 不回）超时退回「[图片]」，回复不卡住', async () => {
        const cfg = config();
        const fake = napcat({}, { 'https://x/cat.jpg': 'hang' });
        const { app, sent, logs } = setup(cfg, { 10001: [] }, { media: fake.media, mediaTimeouts: { ocr: 100 } });
        await app.connected(SELF);
        app.receive(mediaEvent(10001, 1, photoSegment('https://x/cat.jpg')));
        app.receive(event(10001, 2, '我家猫'));
        await until(() => sent.length > 0);
        assert.deepEqual(chat(cfg, 10001).filter(m => m.startsWith('user:')), ['user:[图片]', 'user:我家猫']);
        assert.ok(logs.includes('[10001] 看图：没认出字（超时 0.1 秒）'), logs.join('\n'));
    });

    test('看图只给名单里的人（用户 10-10）：名单外好友发来的照片不送看图模型，照旧只认图上的字', async () => {
        const cfg = config({ unlistedFriends: true });
        const fake = napcat({}, { 'https://x/cat.jpg': ['猫粮'], 'https://x/dog.jpg': ['狗粮'] });
        const described: string[] = [];
        const vision = { describe: async ({ url }: { url: string }) => { described.push(url); return '一只猫趴在窗台上'; } };
        const { app, sent } = setup(cfg, { 10001: [], 20002: [] }, { media: fake.media, vision });
        await app.connected(SELF);
        app.receive(mediaEvent(10001, 1, photoSegment('https://x/cat.jpg')));
        app.receive(mediaEvent(20002, 2, photoSegment('https://x/dog.jpg')));
        await until(() => sent.length >= 2);
        assert.deepEqual(described, ['https://x/cat.jpg'], '只看了名单里的人发的');
        assert.match(chat(cfg, 10001).find(m => m.startsWith('user:'))!, /一只猫趴在窗台上/);
        assert.doesNotMatch(chat(cfg, 20002).find(m => m.startsWith('user:'))!, /猫|窗台/);
        assert.deepEqual(fake.calls.ocr.sort(), ['https://x/cat.jpg', 'https://x/dog.jpg'], 'OCR 两边照旧');
    });

    test('表情包不跑 OCR、照旧用名字；转不出来的语音照旧「[语音]」；配置关了什么都不调', async () => {
        const cfg = config();
        const fake = napcat({}, { 'https://x/a.gif': ['哈哈'] });
        const { app, sent } = setup(cfg, { 10001: [] }, { media: fake.media });
        await app.connected(SELF);
        app.receive(mediaEvent(10001, 1, [{ type: 'image', data: { url: 'https://x/a.gif', sub_type: 1, summary: '[动画表情]' } }]));
        app.receive(mediaEvent(10001, 2, voiceSegment));
        await until(() => sent.length > 0 && chat(cfg, 10001).filter(m => m.startsWith('user:')).length === 2);
        assert.deepEqual(chat(cfg, 10001).filter(m => m.startsWith('user:')), ['user:[动画表情]', 'user:[语音]']);
        assert.deepEqual(fake.calls.ocr, []);
        assert.deepEqual(fake.calls.voice, [2]);

        const off = config({ media: false });
        const quiet = napcat({ 1: '在吗' });
        const offApp = setup(off, { 10001: [] }, { media: quiet.media });
        await offApp.app.connected(SELF);
        offApp.app.receive(mediaEvent(10001, 1, voiceSegment));
        await until(() => offApp.sent.length > 0);
        assert.deepEqual(chat(off, 10001)[0], 'user:[语音]');
        assert.deepEqual(quiet.calls.voice, []);
        assert.ok(offApp.logs.includes('听语音、看图：关（配置 media: false），照旧「[语音]」「[图片]」'));
    });
});
