import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp, type App, type Transport } from '../src/app.ts';
import { SENSITIVE_OFF, type SensitiveSwitch } from '../src/sensitive.ts';
import type { HistoryMessage } from '../src/backfill.ts';
import type { ImageDescriber, MEDIA_TIMEOUTS, MediaReader } from '../src/media.ts';
import type { AppConfig } from '../src/config.ts';
import { ChatHistory } from '../src/history.ts';
import type { MessageEvent, PokeEvent } from '../src/onebot.ts';
import { POKE_BACK_DELAY_MS, POKE_OUT_TEXT, pokeBackPlan } from '../src/pokes.ts';
import { pokeOutPlan } from '../src/presence.ts';
import type { ProactiveRecord } from '../src/proactive.ts';
import { stateAt } from '../src/schedule.ts';
import { videoPlan, type BiliFetch } from '../src/bilibili.ts';
import { credentialPath, saveCredential, type BiliRequest } from '../src/bilibili-account.ts';
import { maybeTypo, RECALL_SHARE } from '../src/expression.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import type { StickerEntry, StickerShelf } from '../src/stickers.ts';
import { CRISIS_FALLBACK } from '../src/exit-check.ts';
import { CRISIS_MARK } from '../src/intent.ts';

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
        lifeInPrompt: false, grievance: false, npcAsks: false, pokes: false, pokeBack: false, pokeOut: false, readReceipts: false, bilibili: 'off', bilibiliAccount: false, bilibiliComment: 'off', bilibiliDm: 'off', bilibiliAtName: '', bilibiliAtUid: 0, reactions: false, onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', recalls: false,
        feedbackCommands: false,
        realWeather: false, festivals: 'off', typingStatus: false, selfRecall: false, rhythm: false, shortReplies: false,
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

function setup(cfg: AppConfig, history: Record<number, HistoryMessage[]> = {}, options: { holdHistory?: Promise<void>; clock?: VirtualClock; media?: MediaReader; vision?: ImageDescriber; stickers?: StickerShelf; stickerChance?: number; generate?: (messages: readonly { content: string }[]) => string; mediaTimeouts?: Partial<typeof MEDIA_TIMEOUTS>; sensitive?: SensitiveSwitch; pokeFriend?: (userId: number) => Promise<void>; setInputStatus?: (userId: number) => Promise<void>; markRead?: (userId: number) => Promise<void>; reactMessage?: (messageId: number, emojiId: number) => Promise<void>; setOnlineStatus?: (status: number, ext: number) => Promise<void>; deleteMessage?: (messageId: number) => Promise<void>; bilibiliFetch?: BiliFetch; bilibiliRequest?: BiliRequest; extra?: Partial<Transport> } = {}) {
    const sent: string[] = [];
    const images: string[] = [];
    const logs: string[] = [];
    const asked: number[] = [];
    let nextId = 900;
    const transport: Transport = {
        ...(options.setInputStatus ? { setInputStatus: options.setInputStatus } : {}),
        ...(options.markRead ? { markRead: options.markRead } : {}),
        ...(options.setOnlineStatus ? { setOnlineStatus: options.setOnlineStatus } : {}),
        ...(options.deleteMessage ? { deleteMessage: options.deleteMessage } : {}),
        ...(options.reactMessage ? { reactMessage: options.reactMessage } : {}),
        ...(options.extra ?? {}),
        sendPrivateText: async (userId, text) => { sent.push(`${userId}:${text}`); return nextId++; },
        sendPrivateImage: async (userId, file, summary) => { images.push(`${userId}:${file}:${summary}`); return nextId++; },
        ...(options.pokeFriend ? { pokeFriend: options.pokeFriend } : {}),
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
        ...(options.stickers ? { stickers: options.stickers } : {}),
        ...(options.stickerChance !== undefined ? { stickerChance: options.stickerChance } : {}),
        ...(options.mediaTimeouts ? { mediaTimeouts: options.mediaTimeouts } : {}),
        ...(options.bilibiliFetch ? { bilibiliFetch: options.bilibiliFetch } : {}),
        ...(options.bilibiliRequest ? { bilibiliRequest: options.bilibiliRequest } : {}),
        // 既有测试要核对日志正文和 last-prompt.json，所以默认开着敏感调试；关着的行为在下面单独测
        sensitive: options.sensitive ?? { on: () => true, describe: () => '' },
        pipeline: {
            generate: async messages => options.generate?.(messages) ?? '好', settle: { quietMs: 0, maxMs: 0 },
            ...(options.clock ? { now: options.clock.now, waitUntil: options.clock.waitUntil } : {}),
        },
    });
    apps.push(app);
    return { app, sent, images, logs, asked };
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
    test('承诺状态损坏暂停新增生活安排，但正常聊天继续；约见提示不能把未知当成有空', async () => {
        const cfg = config({ herDays: true, autonomousLife: true, contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }],
            memory: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 50, recallTimeoutMs: 50, bankPrefix: 'test' } });
        const folder = join(cfg.dataDir, 'promises'); mkdirSync(folder);
        const path = join(folder, '10001-boyfriend.json'); const original = 'PRIVATE_PROMISE_STATE bad json'; writeFileSync(path, original);
        const prompts: string[] = [];
        const { app, sent, logs } = setup(cfg, {}, { generate: messages => { prompts.push(messages.map(m => m.content).join('\n')); return '好'; } });
        assert.ok(logs.some(line => line.includes('约定来源不可用，暂停新增安排')));
        app.receive(event(10001, 1, '明天一起吃个饭吗'));
        await until(() => sent.length > 0);
        assert.ok(prompts.some(prompt => prompt.includes('暂不可确认')));
        assert.equal(readFileSync(path, 'utf8'), original);
        assert.ok(logs.every(line => !line.includes('PRIVATE_PROMISE_STATE')));
        const queue = join(cfg.dataDir, 'world', 'action-queue.json');
        if (existsSync(queue)) assert.deepEqual(JSON.parse(readFileSync(queue, 'utf8')).items, []);
    });

    test('危机回合（ADR 0068）：他说想不活了——意图行、换承认版卡、出口检查重写、不打错字不抽签短话；日志和状态页不含内容；只记时间；平常的话不受影响', async () => {
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend', knowsBot: true }] });
        const prompts: string[] = [];
        let first = true;
        const { app, sent, logs } = setup(cfg, {}, {
            generate: messages => {
                prompts.push(messages.map(m => m.content).join('\n'));
                if (/没有发出去/.test(prompts.at(-1)!)) return '我在。你现在安全吗？身边有人吗';
                if (first) { first = false; return '别想太多，早点睡，晚安'; }
                return '好';
            },
        });
        app.receive(event(10001, 1, '我不想活了'));
        await until(() => sent.length >= 1);
        // 重写后通过：发的是接住他的版本，不是第一版的驱离
        assert.deepEqual(sent, ['10001:我在。你现在安全吗？身边有人吗']);
        // 提示词：危机意图、承认版卡（知道她是程序的联系人这一轮也承认）
        assert.match(prompts[0]!, new RegExp(CRISIS_MARK));
        assert.match(prompts[0]!, /大方承认/, '危机回合换用承认版卡');
        // 日志和状态页只有时间，没有他说的内容
        assert.ok(logs.some(line => line.includes('危机信号') && !line.includes('不想活了')));
        const status = app.status().contacts[0]!;
        assert.equal(status.crisis?.paused, true);
        assert.equal(status.crisis?.level, 'high');
        assert.doesNotMatch(JSON.stringify(app.status()), /不想活/);
        assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cfg.dataDir, 'crisis.json'), 'utf8')).contacts), ['10001']);
        // 一句“开玩笑 / 没事”不能解除：仍使用危机意图和承认版卡。
        const before = prompts.length;
        app.receive(event(10001, 2, '开玩笑的，没事了'));
        await until(() => sent.length >= 2);
        const stillCrisis = prompts.slice(before).join('\n');
        assert.match(stillCrisis, new RegExp(CRISIS_MARK));
        assert.match(stillCrisis, /大方承认/);
        // 明确现在安全且有现实中的人陪同，才回到普通回合。
        const safeAt = prompts.length;
        app.receive(event(10001, 3, '我现在安全，室友在旁边陪我'));
        await until(() => sent.length >= 3);
        const normal = prompts.slice(safeAt).join('\n');
        assert.doesNotMatch(normal, new RegExp(CRISIS_MARK));
        assert.doesNotMatch(normal, /大方承认/);
    });

    test('危机回合：重写后仍不过就发固定的关怀兜底（含 12356）', async () => {
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'classmate', knowsBot: true }] });
        const { app, sent } = setup(cfg, {}, { generate: () => '开玩笑吧，晚安' });
        app.receive(event(10001, 1, '我想自杀'));
        await until(() => sent.length >= 2);
        assert.equal(sent.join('\n'), CRISIS_FALLBACK.split('\n').map(line => `10001:${line}`).join('\n'));
        assert.match(sent.join(''), /12356/);
    });

    test('危机回合：玩笑和夸张不触发（照常回复、不记危机、不暂停）', async () => {
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend', knowsBot: true }] });
        const { app, sent } = setup(cfg, {}, { generate: () => '好' });
        app.receive(event(10001, 1, '作业多得想死，笑死我了'));
        await until(() => sent.length >= 1);
        assert.equal(app.status().contacts[0]!.crisis, undefined);
        assert.equal(existsSync(join(cfg.dataDir, 'crisis.json')), false);
    });

    test('图片表情：收到的候选后台交给收藏库，提示词列可用编号，单独气泡按图片发送', async () => {
        const entry: StickerEntry = {
            id: '123456abcdef', file: 'C:/stickers/123456abcdef.gif', description: '白猫捂嘴偷笑', tags: ['好笑'],
            source: { kind: 'qq-custom' }, createdAt: new Date().toISOString(), used: 0,
        };
        const calls = { considered: 0, discovered: 0, used: 0 };
        const stickers: StickerShelf = {
            consider: async () => { calls.considered++; },
            discover: async () => { calls.discovered++; },
            prompt: () => '[你收藏的图片表情]\n- <sticker:123456abcdef>：白猫捂嘴偷笑（好笑）',
            clean: text => text,
            resolve: text => text.trim() === '<sticker:123456abcdef>' ? entry : undefined,
            history: text => text.trim() === '<sticker:123456abcdef>' ? '她发了个表情包：白猫捂嘴偷笑' : text,
            used: () => { calls.used++; },
            status: () => ({ count: 1 }),
        };
        const cfg = config({ stickers: 'send', contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }] });
        let prompt = '';
        const { app, images } = setup(cfg, { 10001: [] }, { stickers, stickerChance: 1, generate: messages => { prompt = messages.map(m => m.content).join('\n'); return '<sticker:123456abcdef>'; } });
        await app.connected(SELF);
        const incoming: MessageEvent = {
            ...event(10001, 9, ''), raw_message: '',
            message: [{ type: 'image', data: { url: 'https://qq.invalid/incoming.gif', sub_type: 1, summary: '[动画表情]' } }],
        };
        app.receive(incoming);
        await until(() => images.length === 1);
        assert.deepEqual(images, ['10001:C:/stickers/123456abcdef.gif:[白猫捂嘴偷笑]']);
        assert.match(prompt, /<sticker:123456abcdef>：白猫捂嘴偷笑/);
        assert.equal(calls.considered, 1);
        assert.equal(calls.discovered, 1);
        assert.equal(calls.used, 1);
        assert.deepEqual(chat(cfg, 10001), ['user:[动画表情]', 'assistant:她发了个表情包：白猫捂嘴偷笑']);
    });

    test('图片表情 collect：只收男朋友发来的候选，不进提示词、不发送图片', async () => {
        const calls = { considered: 0, discovered: 0, prompted: 0 };
        const stickers: StickerShelf = {
            consider: async () => { calls.considered++; },
            discover: async () => { calls.discovered++; },
            prompt: () => { calls.prompted++; return '[不该出现的图片表情清单]'; },
            clean: text => text,
            resolve: () => undefined,
            history: text => text,
            used: () => undefined,
            status: () => ({ count: 2 }),
        };
        const cfg = config({ stickers: 'collect', contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }] });
        let prompt = '';
        const { app, sent, images } = setup(cfg, { 10001: [] }, {
            stickers,
            generate: messages => { prompt = messages.map(m => m.content).join('\n'); return '这个好好笑'; },
        });
        await app.connected(SELF);
        app.receive({
            ...event(10001, 9, ''), raw_message: '',
            message: [{ type: 'image', data: { url: 'https://qq.invalid/incoming.gif', sub_type: 1, summary: '[动画表情]' } }],
        });
        await until(() => sent.length === 1);
        assert.deepEqual(sent, ['10001:这个好好笑']);
        assert.deepEqual(images, []);
        assert.equal(calls.considered, 1);
        assert.equal(calls.discovered, 1);
        assert.equal(calls.prompted, 0);
        assert.doesNotMatch(prompt, /图片表情清单/);
    });

    test('图片表情 send：同学档不收藏、不看清单、不发送，幻觉编号也不会漏成文字', async () => {
        const calls = { considered: 0, discovered: 0, prompted: 0, resolved: 0 };
        const stickers: StickerShelf = {
            consider: async () => { calls.considered++; },
            discover: async () => { calls.discovered++; },
            prompt: () => { calls.prompted++; return '[不该给同学看的图片表情清单]'; },
            clean: text => text,
            resolve: () => { calls.resolved++; return undefined; },
            history: text => text,
            used: () => undefined,
            status: () => ({ count: 3 }),
        };
        const cfg = config({ stickers: 'send' });
        const { app, sent, images } = setup(cfg, { 10001: [] }, {
            stickers,
            generate: () => '<sticker:123456abcdef>\n正常文字',
        });
        await app.connected(SELF);
        app.receive({
            ...event(10001, 10, ''), raw_message: '',
            message: [{ type: 'image', data: { url: 'https://qq.invalid/classmate.gif', sub_type: 1, summary: '[动画表情]' } }],
        });
        await until(() => sent.length === 1);
        assert.deepEqual(sent, ['10001:正常文字']);
        assert.deepEqual(images, []);
        assert.equal(calls.considered, 0);
        assert.equal(calls.prompted, 0);
        assert.equal(calls.resolved, 0);
        assert.equal(calls.discovered, 1, '账号自己的候选池仍可在后台收藏，只有男朋友档能看到');
    });

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

    test('名单外：打开后每人 10 分钟最多接收 30 条，超出的不进聊天记录也不调用模型', async () => {
        const cfg = config({ unlistedFriends: true });
        let generated = 0;
        const on = setup(cfg, {}, { generate: () => { generated++; return '好'; } });
        for (let i = 1; i <= 31; i++) on.app.receive(event(99999, i, `第${i}条`, '小周'));
        await until(() => on.logs.some(line => line.includes('名单外好友个人限流')));
        assert.equal(new ChatHistory(cfg.dataDir).load(99999).filter(message => message.role === 'user').length, 30);
        assert.ok(generated < 31, '限流消息没有触发生成');
        assert.ok(on.logs.some(line => line === '忽略 QQ 99999 的私聊（名单外好友个人限流；约 10 分钟后恢复）'));
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
            // 「今天」按她的一天算（02:00 起）：零点到凌晨几点之间跑，不能让这段落到昨天去（原来 03:21 跑会写成「上一回是昨天晚上」）
            const now = Date.now();
            const herDayStart = new Date(now);
            herDayStart.setHours(2, 5, 0, 0);
            if (herDayStart.getTime() > now) herDayStart.setDate(herDayStart.getDate() - 1);
            const end = new Date(Math.min(Math.max(now - 2 * 3_600_000, herDayStart.getTime() + 30 * 60_000), now - 60_000));
            const start = new Date(Math.max(end.getTime() - 100 * 60_000, herDayStart.getTime()));
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

    test('同一联系人后来的媒体任务在前一条完成前不会启动', async () => {
        const cfg = config();
        const fake = napcat({ 1: '第一条', 2: '第二条' });
        const { app } = setup(cfg, { 10001: [] }, { media: fake.media });
        await app.connected(SELF);
        fake.hold();
        app.receive(mediaEvent(10001, 1, voiceSegment));
        app.receive(mediaEvent(10001, 2, voiceSegment));
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(fake.calls.voice, [1], '第二条仍在联系人队列里，没有提前调用 NapCat');
        fake.release();
        await until(() => chat(cfg, 10001).filter(message => message.startsWith('user:')).length === 2);
        assert.deepEqual(fake.calls.voice, [1, 2]);
        assert.deepEqual(chat(cfg, 10001).filter(message => message.startsWith('user:')), ['user:[语音：第一条]', 'user:[语音：第二条]']);
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
    test('knowsBot（ADR 0067）：知道她是程序的联系人用原卡，其余用承认版卡；状态页和启动日志写明；被认真问到的说明不同', async () => {
        const cfg = config({
            contacts: [
                { qq: 10001, name: '阿明', tier: 'classmate', knowsBot: true },
                { qq: 10002, name: '小红', tier: 'classmate', knowsBot: false },
                { qq: 10003, name: '阿宝', tier: 'boyfriend' },
            ],
        });
        const prompts = new Map<string, string>();
        const { app, sent, logs } = setup(cfg, {
            10001: [historyMessage(1, 10001, '说认真的，你是不是 AI', 5)],
            10002: [historyMessage(2, 10002, '说认真的，你是不是 AI', 5)],
            10003: [historyMessage(3, 10003, '说认真的，你是不是 AI', 5)],
        }, {
            generate: messages => {
                const text = messages.map(m => m.content).join('\n');
                prompts.set(/阿明|小红|阿宝/.exec(text)?.[0] ?? '?', text);
                return '好';
            },
        });
        assert.ok(logs.some(l => l.includes('10001（阿明，classmate，知道她是程序）') && l.includes('10002（小红，classmate，按不知道处理：被认真问到会承认）') && l.includes('10003（阿宝，boyfriend，按不知道处理')), logs.join('|'));
        assert.ok(logs.some(l => l.startsWith('档位 classmate-open：')) && logs.some(l => l.startsWith('档位 boyfriend-open：')) && logs.some(l => l.startsWith('档位 classmate：')));
        const status = app.status();
        assert.deepEqual(status.contacts.map(c => [c.qq, c.knowsBot, c.card]), [[10001, true, 'classmate'], [10002, false, 'classmate-open'], [10003, undefined, 'boyfriend-open']]);
        await app.connected(SELF);
        await until(() => sent.length >= 3);
        const deflect = /不承认、绕开、或者开玩笑/;
        const admit = /不要否认，用你自己的口气大方承认/;
        assert.equal(prompts.size, 3, [...prompts.keys()].join(','));
        assert.match(prompts.get('阿明')!, deflect);
        assert.doesNotMatch(prompts.get('阿明')!, admit);
        for (const name of ['小红', '阿宝']) {
            assert.match(prompts.get(name)!, admit, name);
            assert.doesNotMatch(prompts.get(name)!, deflect, name);
        }
    });
});

describe('心跳（任务书 T3b）', () => {
    test('启动就写 heartbeat.json：只有时间、进程号、提交、启动时间，没有聊天内容；停下后文件留着', async () => {
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }] });
        const { app, sent } = setup(cfg);
        const path = join(cfg.dataDir, 'heartbeat.json');
        assert.equal(existsSync(path), true);
        const beat = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        assert.equal(beat.pid, process.pid);
        assert.deepEqual(Object.keys(beat).sort(), ['at', 'pid', 'ref', 'startedAt']);
        app.receive(event(10001, 1, '今天我偷偷告诉你一个秘密'));
        await until(() => sent.length === 1);
        app.stop();
        assert.equal(existsSync(path), true, '停下后旧心跳留着');
        assert.doesNotMatch(readFileSync(path, 'utf8'), /秘密/);
    });
});

describe('小别扭与和好（ADR 0074，配置 grievance）', () => {
    const HOUR = 3_600_000;
    /** 他 4 天前最后说话，她回了晚安，3 天前她主动发了一句没人回；今天他回来（事件用真实时间） */
    const seedAway = (cfg: AppConfig, qq = 10001) => {
        mkdirSync(cfg.dataDir, { recursive: true });
        const history = new ChatHistory(cfg.dataDir);
        const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
        history.append(qq, { time: at(100), role: 'user', content: '晚安', messageId: 701 });
        history.append(qq, { time: at(99.9), role: 'assistant', content: '晚安', messageId: 702 });
        history.append(qq, { time: at(70), role: 'assistant', content: '今天下课好晚', messageId: 703 });
    };
    const bf = [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }];
    const promptsOf = (prompts: string[]) => prompts.join('\n---\n');

    test('开着：他隔了 4 天回来，这一轮的提示词里有小别扭的意图、日志只记天数；带点抱怨的话不被出口检查拦；最多两个气泡', async () => {
        const cfg = config({ contacts: bf, grievance: true, speechCheck: true });
        seedAway(cfg);
        const prompts: string[] = [];
        const { app, sent, logs } = setup(cfg, {}, { generate: messages => { prompts.push(messages.map(m => m.content).join('\n')); return '哟，还知道回来呀'; } });
        app.receive(event(10001, 1, '在吗'));
        await until(() => sent.length >= 1);
        assert.match(promptsOf(prompts), /他已经 4 天没来找你了/);
        assert.match(promptsOf(prompts), /小别扭/);
        assert.deepEqual(sent, ['10001:哟，还知道回来呀'], '「还知道回来」在这一轮不按算账拦');
        assert.ok(logs.includes('[10001] 小别扭：他隔了 4 天才来（他回来后第 1 轮；日志不记内容）'), logs.join('|'));
        assert.ok(logs.every(line => !line.includes('在吗') || !line.includes('小别扭')), '日志里不记内容');
    });

    test('他先道歉：不别扭；别扭一轮后他再道歉：这一轮和好（提示词里是「气顺了」），之后什么都没有', async () => {
        const quick = config({ contacts: bf, grievance: true });
        seedAway(quick);
        const quickPrompts: string[] = [];
        const first = setup(quick, {}, { generate: messages => { quickPrompts.push(messages.map(m => m.content).join('\n')); return '嗯，在'; } });
        first.app.receive(event(10001, 1, '对不起啊这几天没理你'));
        await until(() => first.sent.length >= 1);
        assert.doesNotMatch(promptsOf(quickPrompts), /小别扭|气顺了/);

        const cfg = config({ contacts: bf, grievance: true });
        seedAway(cfg);
        const prompts: string[] = [];
        const { app, sent, logs } = setup(cfg, {}, { generate: messages => { prompts.push(messages.map(m => m.content).join('\n')); return '嗯，在'; } });
        app.receive(event(10001, 2, '在吗'));
        await until(() => sent.length >= 1);
        app.receive(event(10001, 3, '对不起，这几天赶论文，手机都没看'));
        await until(() => sent.length >= 2);
        assert.match(prompts.at(-1)!, /气顺了/);
        assert.ok(logs.includes('[10001] 和好：他隔了 4 天才来（他回来后第 2 轮；日志不记内容）'), logs.join('|'));
        app.receive(event(10001, 4, '好'));
        await until(() => sent.length >= 3);
        assert.doesNotMatch(prompts.at(-1)!, /小别扭|气顺了/, '和好之后不再有');
    });

    test('关着（默认）、同学档、他难过、危机：都不别扭', async () => {
        const off = config({ contacts: bf });
        seedAway(off);
        const offPrompts: string[] = [];
        const a = setup(off, {}, { generate: messages => { offPrompts.push(messages.map(m => m.content).join('\n')); return '嗯，在'; } });
        a.app.receive(event(10001, 1, '在吗'));
        await until(() => a.sent.length >= 1);
        assert.doesNotMatch(promptsOf(offPrompts), /小别扭/);

        const mate = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }], grievance: true });
        seedAway(mate);
        const matePrompts: string[] = [];
        const b = setup(mate, {}, { generate: messages => { matePrompts.push(messages.map(m => m.content).join('\n')); return '嗯，在'; } });
        b.app.receive(event(10001, 1, '在吗'));
        await until(() => b.sent.length >= 1);
        assert.doesNotMatch(promptsOf(matePrompts), /小别扭/, '只有男朋友档');

        const sad = config({ contacts: bf, grievance: true });
        seedAway(sad);
        const sadPrompts: string[] = [];
        const c = setup(sad, {}, { generate: messages => { sadPrompts.push(messages.map(m => m.content).join('\n')); return '怎么了'; } });
        c.app.receive(event(10001, 1, '我今天好难过'));
        await until(() => c.sent.length >= 1);
        assert.doesNotMatch(promptsOf(sadPrompts), /小别扭/, '他难过时先接住他');

        const crisis = config({ contacts: bf, grievance: true });
        seedAway(crisis);
        const crisisPrompts: string[] = [];
        const d = setup(crisis, {}, { generate: messages => { crisisPrompts.push(messages.map(m => m.content).join('\n')); return '我在。你现在安全吗？身边有人吗'; } });
        d.app.receive(event(10001, 1, '我不想活了'));
        await until(() => d.sent.length >= 1);
        assert.doesNotMatch(promptsOf(crisisPrompts), /小别扭/, '危机回合最优先');
        assert.match(promptsOf(crisisPrompts), /想伤害自己/);
    });

    test('开关关着时，带点抱怨的话照旧被出口检查拦（算账）：行为和以前一样', async () => {
        const cfg = config({ contacts: bf, speechCheck: true });
        seedAway(cfg);
        const prompts: string[] = [];
        const { app, sent } = setup(cfg, {}, { generate: messages => { prompts.push(messages.map(m => m.content).join('\n')); return prompts.length === 1 ? '哟，还知道回来呀' : '嗯，在'; } });
        app.receive(event(10001, 1, '在吗'));
        await until(() => sent.length >= 1);
        assert.deepEqual(sent, ['10001:嗯，在'], '第一版算账被重写掉了');
    });
});

describe('反馈通道（ADR 0073）：男朋友档回「假」/「像」', () => {
    const bf = [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }];
    const feedbackRows = (cfg: AppConfig) => {
        const path = join(cfg.dataDir, 'feedback', `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}.jsonl`);
        return existsSync(path) ? readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as { label: string; messageId: number; herMessageId: number; her: string[]; tier: string }) : [];
    };
    const quote = (messageId: number, id: number, text: string): MessageEvent => ({ ...event(10001, messageId, text), message: [{ type: 'reply', data: { id: String(id) } }, { type: 'text', data: { text } }] });

    test('开关关着（默认）：「假」是一条普通消息，她照常回', async () => {
        const cfg = config({ contacts: bf });
        const { app, sent } = setup(cfg);
        app.receive(event(10001, 1, '在吗'));
        await until(() => sent.length === 1);
        app.receive(event(10001, 2, '假'));
        await until(() => sent.length === 2);
        assert.deepEqual(chat(cfg, 10001), ['user:在吗', 'assistant:好', 'user:假', 'assistant:好']);
        assert.equal(existsSync(join(cfg.dataDir, 'feedback')), false);
    });

    test('开着：「假」被消耗——记一行、她不回、不进聊天记录；日志只有标签；引用指定那一条；同一条再来不重复', async () => {
        const cfg = config({ contacts: bf, feedbackCommands: true });
        const { app, sent, logs } = setup(cfg);
        app.receive(event(10001, 1, '在吗'));
        await until(() => sent.length === 1);
        app.receive(event(10001, 2, '假'));
        await until(() => feedbackRows(cfg).length === 1);
        assert.equal(sent.length, 1, '她没有回应这个字');
        assert.deepEqual(chat(cfg, 10001), ['user:在吗', 'assistant:好'], '不进聊天记录');
        assert.deepEqual(feedbackRows(cfg).map(r => [r.label, r.messageId, r.herMessageId, r.her, r.tier]), [['fake', 2, 900, ['好'], 'boyfriend']]);
        assert.ok(logs.includes('[10001] 反馈：假（本月第 1 条）'), logs.join('|'));
        assert.ok(logs.some(l => l.startsWith('反馈通道：开')));
        // 带引用：目标是被引用的那条
        app.receive(quote(3, 900, '/像。'));
        await until(() => feedbackRows(cfg).length === 2);
        assert.deepEqual(feedbackRows(cfg)[1], { ...feedbackRows(cfg)[1]!, label: 'real', messageId: 3, herMessageId: 900 });
        // 入口重投同一条：吞掉、不再记
        app.receive(event(10001, 2, '假'));
        await new Promise(r => setTimeout(r, 100));
        assert.equal(feedbackRows(cfg).length, 2);
        assert.equal(sent.length, 1);
        assert.deepEqual(chat(cfg, 10001), ['user:在吗', 'assistant:好']);
    });

    test('开着但只对男朋友档：同学档回「假」是普通消息；「假的」「太假了」也是普通消息', async () => {
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }, { qq: 10002, name: '阿宝', tier: 'boyfriend' }], feedbackCommands: true });
        const { app, sent } = setup(cfg);
        app.receive(event(10001, 1, '在吗'));
        await until(() => sent.length === 1);
        app.receive(event(10001, 2, '假'));
        await until(() => sent.length === 2);
        assert.deepEqual(chat(cfg, 10001), ['user:在吗', 'assistant:好', 'user:假', 'assistant:好']);
        app.receive(event(10002, 3, '在吗'));
        await until(() => sent.length === 3);
        app.receive(event(10002, 4, '太假了'));
        await until(() => sent.length === 4);
        assert.deepEqual(chat(cfg, 10002), ['user:在吗', 'assistant:好', 'user:太假了', 'assistant:好']);
        assert.equal(existsSync(join(cfg.dataDir, 'feedback')), false);
    });

    test('名单里单独写了 feedback: true 的同学档才可以：记下来、tier 记 classmate；同档没写的人不行', async () => {
        const cfg = config({
            contacts: [
                { qq: 10001, name: '鸽鸽', tier: 'classmate', feedback: true },
                { qq: 10003, name: '阿华', tier: 'classmate' },
            ],
            feedbackCommands: true,
        });
        const { app, sent, logs } = setup(cfg);
        app.receive(event(10001, 1, '在吗'));
        await until(() => sent.length === 1);
        app.receive(event(10001, 2, '假'));
        await until(() => feedbackRows(cfg).length === 1);
        assert.equal(sent.length, 1, '她没有回应这个字');
        assert.deepEqual(chat(cfg, 10001), ['user:在吗', 'assistant:好']);
        assert.deepEqual(feedbackRows(cfg).map(r => [r.label, r.tier]), [['fake', 'classmate']]);
        assert.ok(logs.some(l => l.startsWith('反馈通道：开（鸽鸽对她的话')), logs.join('|'));
        // 同一档、没写 feedback 的人：「假」是普通消息
        app.receive(event(10003, 3, '在吗'));
        await until(() => sent.length === 2);
        app.receive(event(10003, 4, '假'));
        await until(() => sent.length === 3);
        assert.deepEqual(chat(cfg, 10003), ['user:在吗', 'assistant:好', 'user:假', 'assistant:好']);
        assert.equal(feedbackRows(cfg).length, 1);
    });

    test('她还没说过话（找不到被评价的那一轮）：「假」当普通消息', async () => {
        const cfg = config({ contacts: bf, feedbackCommands: true });
        const { app, sent } = setup(cfg);
        app.receive(event(10001, 1, '假'));
        await until(() => sent.length === 1);
        assert.deepEqual(chat(cfg, 10001), ['user:假', 'assistant:好']);
        assert.equal(feedbackRows(cfg).length, 0);
    });

    test('停机期间他回的「像」：补回时记下来，不当聊天补进记录、她也不回', async () => {
        const cfg = config({ contacts: bf, feedbackCommands: true });
        mkdirSync(cfg.dataDir, { recursive: true });
        new ChatHistory(cfg.dataDir).append(10001, { time: new Date((nowSec() - 600) * 1000).toISOString(), role: 'assistant', content: '晚安啦', messageId: 800 });
        const { app, sent, logs } = setup(cfg, { 10001: [historyMessage(800, SELF, '晚安啦', 600), historyMessage(801, 10001, '像', 300)] });
        await app.connected(SELF);
        await new Promise(r => setTimeout(r, 150));
        assert.deepEqual(feedbackRows(cfg).map(r => [r.label, r.messageId, r.herMessageId, r.her]), [['real', 801, 800, ['晚安啦']]]);
        assert.deepEqual(chat(cfg, 10001), ['assistant:晚安啦'], '没有补回成聊天');
        assert.equal(sent.length, 0);
        assert.ok(!logs.some(l => l.includes('补回')), logs.join('|'));
    });
});

describe('敏感调试关着的时候（ADR 0070 第 8 项）', () => {
    test('默认关：收到、已回复只记字数，不写 last-prompt.json，上次留下的也删掉', async () => {
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }] });
        mkdirSync(cfg.dataDir, { recursive: true });
        writeFileSync(join(cfg.dataDir, 'last-prompt.json'), JSON.stringify({ qq: 10001, messages: [{ content: '上次开着时留下的完整提示词' }] }));
        const { app, sent, logs } = setup(cfg, { 10001: [] }, { sensitive: SENSITIVE_OFF });
        assert.equal(existsSync(join(cfg.dataDir, 'last-prompt.json')), false, '上次留下的被清掉');
        await app.connected(SELF);
        app.receive(event(10001, 1, '今天我偷偷告诉你一个秘密'));
        await until(() => sent.length === 1);
        assert.ok(logs.some(line => line.includes('收到：12 字')), logs.join(' | '));
        assert.ok(logs.some(line => line.includes('已回复：1 字')), logs.join(' | '));
        assert.ok(!logs.some(line => line.includes('秘密')), '日志里没有聊天正文');
        assert.equal(existsSync(join(cfg.dataDir, 'last-prompt.json')), false, '关着不写完整提示词');
    });
});

describe('戳一戳（ADR 0079，配置 pokes）', () => {
    const bf = [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }];
    const pokeFrom = (userId: number, secondsAgo = 0): PokeEvent => ({
        post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: SELF, user_id: userId, target_id: SELF, time: nowSec() - secondsAgo,
    });
    const lastPrompt = (prompts: string[][]) => prompts.at(-1)!.join('\n');

    test('关着（默认）：戳了不理；开着：名单里的人戳一下，她看到一条「[戳了戳你]」并回一句，聊天记录里是他发的这一条', async () => {
        const off = setup(config({ contacts: bf }));
        off.app.receivePoke(pokeFrom(10001));
        await new Promise(r => setTimeout(r, 100));
        assert.equal(off.sent.length, 0);

        const seen: string[][] = [];
        const cfg = config({ contacts: bf, pokes: true });
        const on = setup(cfg, {}, { generate: messages => { seen.push(messages.map(m => m.content)); return '戳我干嘛'; } });
        on.app.receivePoke(pokeFrom(10001));
        await until(() => on.sent.length === 1);
        assert.equal(on.sent[0], '10001:戳我干嘛');
        assert.match(lastPrompt(seen), /\[戳了戳你\]/);
        const stored = new ChatHistory(cfg.dataDir).load(10001);
        assert.deepEqual(stored.map(m => [m.role, m.content]), [['user', '[戳了戳你]'], ['assistant', '戳我干嘛']]);
        assert.ok(on.logs.includes('[10001] 戳了她一下'));
    });

    test('不理：不在名单的人、旧的通知（断线后补推）；5 分钟里第 4 下起不理，日志只记次数', async () => {
        const cfg = config({ contacts: bf, pokes: true, unlistedFriends: true });
        const { app, sent, logs } = setup(cfg);
        app.receivePoke(pokeFrom(99999));
        app.receivePoke(pokeFrom(10001, 120));
        await new Promise(r => setTimeout(r, 100));
        assert.equal(sent.length, 0);
        assert.deepEqual(logs.filter(l => l.includes('戳')), []);

        for (let i = 0; i < 5; i++) app.receivePoke(pokeFrom(10001));
        assert.equal(logs.filter(l => l === '[10001] 戳了她一下').length, 3);
        assert.equal(logs.filter(l => l.includes('已经戳过 3 下')).length, 2);
    });

    test('戳回去（配置 pokeBack）：算数的戳里按概率她也戳回去一下，隔一两秒；5 分钟里不戳第二次；关着或戳没算数就不戳', async () => {
        // 找两个有「戳回去」的通知时间（按人和时间定，同一下每次一样）
        const times: number[] = [];
        for (let back = 0; back < 40 && times.length < 2; back++) if (pokeBackPlan(10001, nowSec() - back)) times.push(nowSec() - back);
        assert.equal(times.length, 2, '40 个时间里该有两个');
        const poke = (time: number): PokeEvent => ({ ...pokeFrom(10001), time });
        const called: number[] = [];
        const cfg = config({ contacts: bf, pokes: true, pokeBack: true });
        const on = setup(cfg, {}, { pokeFriend: async userId => { called.push(userId); } });
        const offCalled: number[] = [];
        const off = setup(config({ contacts: bf, pokes: true }), {}, { pokeFriend: async userId => { offCalled.push(userId); } });
        const failing = setup(config({ contacts: bf, pokes: true, pokeBack: true }), {}, { pokeFriend: async () => { throw new Error('packet 服务不可用'); } });
        on.app.receivePoke(poke(times[0]!));
        on.app.receivePoke(poke(times[1]!));
        off.app.receivePoke(poke(times[0]!));
        failing.app.receivePoke(poke(times[0]!));
        await new Promise(r => setTimeout(r, POKE_BACK_DELAY_MS[1] + 400));
        assert.deepEqual(called, [10001], '5 分钟里只戳一次');
        assert.ok(on.logs.includes('[10001] 戳回去了'), on.logs.join('|'));
        assert.deepEqual(offCalled, [], '关着不戳');
        assert.equal(failing.sent.length, 1);
        assert.ok(failing.logs.some(l => l.startsWith('[10001] 戳回去失败：packet 服务不可用')), '失败只记日志，文字回复照常：' + failing.logs.join('|'));
    });

    test('她睡着、在上课时的戳不算（日志记在干什么，不进聊天记录、不排回复）；空闲时算', async () => {
        const schedule = loadCharacterCard(resolve(repoRoot, 'characters/linmengyao/st/linmengyao-boyfriend.json')).schedule!;
        let classTime: Date | undefined;
        for (let minute = 8 * 60; minute < 18 * 60 && !classTime; minute++) {
            const at = new Date(2026, 9, 12, 0, minute);
            if (stateAt(schedule, at).activity.kind === 'class') classTime = at;
        }
        assert.ok(classTime, '10-12（周一）白天应该有课');
        const cfg = (clockAt: Date) => ({ cfg: config({ contacts: bf, pokes: true, schedule: true }), clock: new VirtualClock(clockAt) });

        for (const [at, word] of [[new Date(2026, 9, 12, 3, 0), '睡觉'], [classTime, '上课']] as const) {
            const { cfg: c, clock } = cfg(at);
            const { app, logs } = setup(c, {}, { clock });
            app.receivePoke(pokeFrom(10001));
            assert.ok(logs.includes(`[10001] 戳了她一下，她在${word}，不理`), `${word}：${logs.join('|')}`);
            assert.equal(new ChatHistory(c.dataDir).load(10001).length, 0);
        }

        const { cfg: c, clock } = cfg(new Date(2026, 9, 10, 15, 0));
        const { app, logs } = setup(c, {}, { clock });
        app.receivePoke(pokeFrom(10001));
        assert.ok(logs.includes('[10001] 戳了她一下'), logs.join('|'));
    });
});

describe('正在输入（ADR 0077）：整条线接通', () => {
    test('开着 typingStatus 且她要打字一阵：app 把 setInputStatus 接到回复器上（contact.ts 以前没转发，开了也不会触发）；关着不调', async () => {
        const reply = '今天去了食堂吃了面条还不错';
        const run = async (typingStatus: boolean) => {
            const clock = new VirtualClock(new Date(2026, 9, 10, 15, 0));
            const typed: number[] = [];
            const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }], schedule: true, typingStatus });
            const { app, sent } = setup(cfg, {}, { clock, generate: () => reply, setInputStatus: async userId => { typed.push(userId); } });
            app.receive({ ...event(10001, 1, '在吗'), time: Math.floor(clock.now() / 1000) });
            const deadline = Date.now() + 8000;
            while (sent.length === 0 && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 20));
                const next = clock.nextTimer();
                if (next !== undefined) clock.advanceTo(next);
            }
            assert.equal(sent.length, 1, '回复发出去了');
            return typed;
        };
        assert.ok((await run(true)).length >= 1, '开着：打字那几秒调了 setInputStatus');
        assert.deepEqual(await run(false), [], '关着：不调');
    });
});

describe('打错字撤回重发（ADR 0086）：整条线接通', () => {
    test('开着 selfRecall：app 把 deleteMessage 接到回复器上，打错字改口时先发打错的、撤回、再发对的（关着、没有 deleteMessage 的情形在 runtime / expression 的单元测试里）', async () => {
        // 找一句话，让它在这个联系人那里抽中「打错字 + 撤回重发」，且撤回前等得短（真实时间的等待，省测试时间）
        const reply = Array.from({ length: 20000 }, (_, i) => `我应该明天去${i}`).find(text => {
            const plan = maybeTypo([text], `10001 ${text}`, 1, RECALL_SHARE).recall;
            return plan && plan.afterMs < 1700;
        })!;
        assert.ok(reply, '找到了一句会撤回重发的话');
        const clock = new VirtualClock(new Date(2026, 9, 10, 15, 0));
        const deleted: number[] = [];
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }], schedule: true, selfRecall: true });
        const { app, sent, logs } = setup(cfg, {}, { clock, generate: () => reply, deleteMessage: async id => { deleted.push(id); } });
        app.receive({ ...event(10001, 1, '你哪天去'), time: Math.floor(clock.now() / 1000) });
        const deadline = Date.now() + 20000;
        while (sent.length < 2 && Date.now() < deadline) {
            await new Promise(r => setImmediate(r));
            const next = clock.nextTimer();
            if (next !== undefined) clock.advanceTo(next);
        }
        assert.deepEqual(sent, [`10001:${reply.replace('应该', '因该')}`, `10001:${reply}`], '先发打错的，再发对的');
        assert.deepEqual(deleted, [900], '撤回的是第一条');
        assert.ok(logs.some(l => l.includes('撤回重发')), logs.join('|'));
    });
});

describe('已读回执、表情回应（ADR 0083）：整条线接通', () => {
    const bf = [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }];
    const drive = async (clock: VirtualClock, done: () => boolean) => {
        const deadline = Date.now() + 8000;
        while (!done() && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 20));
            const next = clock.nextTimer();
            if (next !== undefined) clock.advanceTo(next);
        }
        await new Promise(r => setTimeout(r, 60));
    };

    test('开着 readReceipts：她看到他的消息的那一刻标已读（回复之前），关着不标', async () => {
        const run = async (readReceipts: boolean) => {
            const clock = new VirtualClock(new Date(2026, 9, 10, 15, 0));
            const marked: number[] = [];
            const cfg = config({ contacts: bf, schedule: true, readReceipts });
            const { app, sent } = setup(cfg, {}, { clock, markRead: async userId => { marked.push(userId); } });
            app.receive({ ...event(10001, 1, '在吗'), time: Math.floor(clock.now() / 1000) });
            await drive(clock, () => sent.length === 1);
            assert.equal(sent.length, 1);
            return marked;
        };
        assert.deepEqual(await run(true), [10001]);
        assert.deepEqual(await run(false), []);
    });

    test('她已经道了晚安、他只回「嗯嗯」：不回，但已读 + 点个表情回应（reactions 开着）；reactions 关着只已读', async () => {
        const run = async (reactions: boolean) => {
            const clock = new VirtualClock(new Date(2026, 9, 10, 15, 0));
            const cfg = config({ contacts: bf, schedule: true, readReceipts: true, reactions });
            const now = clock.now();
            const history = new ChatHistory(cfg.dataDir);
            history.append(10001, { time: new Date(now - 300_000).toISOString(), role: 'user', content: '我要睡了', messageId: 11 });
            history.append(10001, { time: new Date(now - 240_000).toISOString(), role: 'assistant', content: '晚安啦', messageId: 12 });
            const marked: number[] = [];
            const reacted: [number, number][] = [];
            const { app, sent, logs } = setup(cfg, {}, { clock, markRead: async userId => { marked.push(userId); }, reactMessage: async (messageId, emojiId) => { reacted.push([messageId, emojiId]); } });
            app.receive({ ...event(10001, 13, '嗯嗯'), time: Math.floor(now / 1000) });
            await drive(clock, () => logs.some(l => l.includes('她已经收尾')));
            assert.equal(sent.length, 0, '不回');
            return { marked, reacted };
        };
        const on = await run(true);
        assert.deepEqual(on.marked, [10001]);
        assert.equal(on.reacted.length, 1);
        assert.equal(on.reacted[0]![0], 13, '点的是他最后那一条');
        assert.ok([66, 76].includes(on.reacted[0]![1]));
        const off = await run(false);
        assert.deepEqual(off.marked, [10001]);
        assert.deepEqual(off.reacted, []);
    });
});

describe('存在感（ADR 0083）：接进应用', () => {
    const bf = [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }];
    test('开着 onlineStatus：第一次连上就按她此刻在干什么设状态（周六下午空闲 → 在线）；一个开关都没开就不起；没有作息不起', async () => {
        const calls: string[] = [];
        const clock = new VirtualClock(new Date(2026, 9, 10, 15, 0));
        const on = setup(config({ contacts: bf, schedule: true, herDays: true, onlineStatus: true }), { 10001: [] }, { clock, setOnlineStatus: async (status, ext) => { calls.push(`${status}/${ext}`); } });
        await on.app.connected(SELF);
        await until(() => calls.length === 1);
        assert.deepEqual(calls, ['10/0']);
        assert.ok(on.logs.some(l => l.startsWith('存在感：在线状态')), on.logs.join('|'));
        // NapCat 重新连上（重新登录后 QQ 把状态重置成在线）：再设一遍，不等到下次状态变
        await on.app.connected(SELF);
        await until(() => calls.length === 2);
        assert.deepEqual(calls, ['10/0', '10/0']);

        const idle: string[] = [];
        const none = setup(config({ contacts: bf, schedule: true, herDays: true }), { 10001: [] }, { clock: new VirtualClock(new Date(2026, 9, 10, 15, 0)), setOnlineStatus: async (status, ext) => { idle.push(`${status}/${ext}`); } });
        await none.app.connected(SELF);
        await new Promise(r => setTimeout(r, 100));
        assert.deepEqual(idle, [], '开关没开不动');
        assert.ok(!none.logs.some(l => l.startsWith('存在感')));

        const noWorld = setup(config({ contacts: bf, schedule: true, herDays: false, onlineStatus: true }), { 10001: [] }, { clock: new VirtualClock(new Date(2026, 9, 10, 15, 0)), setOnlineStatus: async () => { throw new Error('不该调'); } });
        await noWorld.app.connected(SELF);
        await new Promise(r => setTimeout(r, 100));
        assert.ok(noWorld.logs.some(l => l.includes('存在感：没有作息')), noWorld.logs.join('|'));
    });
});

describe('主动戳他（ADR 0087）：接进应用', () => {
    const bf = [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }];
    const planNight = () => {
        for (let day = 2; day < 29; day++) {
            const date = new Date(2026, 10, day, 21, 45);
            const weekend = date.getDay() === 0 || date.getDay() === 6;
            if (pokeOutPlan(`2026-11-${String(day).padStart(2, '0')}`, weekend)) return date;
        }
        return assert.fail('找不到要戳的日子');
    };
    const until2 = async (done: () => boolean, ms = 5000) => {
        const deadline = Date.now() + ms;
        while (!done() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    };

    test('开着 pokeOut：聊天安静了、最后一条是她说的 → 戳他一下并记进聊天记录；最后一条是他说的（还等她回）或关着就不戳', async () => {
        const night = planNight();
        const run = async (pokeOut: boolean, lastRole: 'assistant' | 'user', wait = 5000) => {
            const poked: number[] = [];
            const cfg = config({ contacts: bf, schedule: true, herDays: true, pokeOut });
            const store = new ChatHistory(cfg.dataDir);
            store.append(10001, { time: new Date(night.getTime() - 180 * 60_000).toISOString(), role: 'user', content: '在吗', messageId: 1 });
            store.append(10001, { time: new Date(night.getTime() - 170 * 60_000).toISOString(), role: lastRole, content: lastRole === 'assistant' ? '在呀' : '嗯嗯', messageId: 2 });
            const { app, logs } = setup(cfg, { 10001: [] }, { clock: new VirtualClock(night), pokeFriend: async qq => { poked.push(qq); } });
            await app.connected(SELF);
            await until2(() => poked.length >= 1, wait);
            await new Promise(r => setTimeout(r, 100));
            return { poked, stored: new ChatHistory(cfg.dataDir).load(10001), logs };
        };
        const on = await run(true, 'assistant');
        assert.deepEqual(on.poked, [10001]);
        assert.equal(on.stored.at(-1)?.content, POKE_OUT_TEXT, '记进聊天记录，他问起时她知道自己戳过');
        assert.equal(on.stored.at(-1)?.role, 'assistant');
        assert.ok(on.logs.some(l => l.includes('主动戳他')), on.logs.join('|'));
        assert.deepEqual((await run(true, 'user', 400)).poked, [], '他说的最后一条，她还没回：不戳');
        assert.deepEqual((await run(false, 'assistant', 400)).poked, [], '关着不戳');
    });
});

describe('刷 B 站（ADR 0084）：接进应用', () => {
    const bf = [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }];
    const body = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
    const fetchStub = (urls: string[]): BiliFetch => async url => {
        urls.push(url);
        if (url.includes('/reply/')) return body({ code: 0, data: { replies: [{ content: { message: '这个也太真实了吧哈哈' } }] } });
        return body({ code: 0, data: { list: [{ bvid: 'BV1Jonu6mEwN', aid: 11, title: '一条搞笑视频', desc: '-', owner: { name: '某 UP' }, tname: '搞笑', stat: { view: 1000, like: 50 }, duration: 100 }] } });
    };
    const planDay = () => {
        for (let day = 2; day < 29; day++) {
            const date = new Date(2026, 10, day, 22, 40);
            const weekend = date.getDay() === 0 || date.getDay() === 6;
            const key = `2026-11-${String(day).padStart(2, '0')}`;
            if (videoPlan(key, weekend)) return date;
        }
        return assert.fail('找不到要刷的日子');
    };
    const drive = async (clock: VirtualClock, done: () => boolean) => {
        const deadline = Date.now() + 8000;
        while (!done() && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 20));
            const next = clock.nextTimer();
            if (next !== undefined) clock.advanceTo(next);
        }
        await new Promise(r => setTimeout(r, 80));
    };

    test('开着：第一次连上后到点，读热门榜和热评、让她主动说一句、再把真链接发在后面并记进聊天记录；关着不碰 B 站', async () => {
        const evening = planDay();
        const urls: string[] = [];
        const clock = new VirtualClock(evening);
        const cfg = config({ contacts: bf, schedule: true, herDays: true, bilibili: 'on' });
        const { app, sent, logs } = setup(cfg, { 10001: [] }, { clock, bilibiliFetch: fetchStub(urls), generate: () => '这个也太真实了' });
        await app.connected(SELF);
        await drive(clock, () => sent.length >= 2);
        assert.equal(sent.length, 2, sent.join('|') + logs.join('|'));
        assert.equal(sent[0], '10001:这个也太真实了');
        assert.equal(sent[1], '10001:https://www.bilibili.com/video/BV1Jonu6mEwN');
        assert.ok(urls.some(u => u.includes('/popular')) && urls.some(u => u.includes('/reply/')));
        const stored = new ChatHistory(cfg.dataDir).load(10001);
        assert.ok(stored.some(m => m.role === 'assistant' && m.content === 'https://www.bilibili.com/video/BV1Jonu6mEwN（《一条搞笑视频》）'), JSON.stringify(stored));

        const offUrls: string[] = [];
        const off = setup(config({ contacts: bf, schedule: true, herDays: true }), { 10001: [] }, { clock: new VirtualClock(evening), bilibiliFetch: fetchStub(offUrls) });
        await off.app.connected(SELF);
        await new Promise(r => setTimeout(r, 150));
        assert.deepEqual(offUrls, []);
    });

    test('试运行：生成但不发给他，话和链接存进 presence/drafts.md', async () => {
        const clock = new VirtualClock(planDay());
        const cfg = config({ contacts: bf, schedule: true, herDays: true, bilibili: 'dryRun' });
        const { app, sent, logs } = setup(cfg, { 10001: [] }, { clock, bilibiliFetch: fetchStub([]), generate: () => '这个梗我能玩一年' });
        await app.connected(SELF);
        await drive(clock, () => logs.some(l => l.includes('试运行，没发')));
        assert.deepEqual(sent, []);
        assert.match(readFileSync(join(cfg.dataDir, 'presence', 'drafts.md'), 'utf8'), /这个梗我能玩一年[\s\S]*bilibili\.com\/video\/BV1Jonu6mEwN/);
    });

    describe('她的账号（ADR 0089）', () => {
        const credential = { sessdata: 's', biliJct: 'j', dedeUserId: '4242', buvid3: 'b', savedAt: '2026-10-20T00:00:00.000Z' };
        const accountRequest = (calls: { url: string; body?: string }[]): BiliRequest => async (url, init) => {
            calls.push({ url, ...(init.body ? { body: init.body } : {}) });
            if (url.includes('web-interface/nav')) return body({ code: 0, data: { isLogin: true, uname: '繁星小窝', mid: 4242, wbi_img: { img_url: 'https://x/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://x/4932caff0ff746eab6f01bf08b70ac45.png' } } });
            if (url.includes('wbi/search/type')) return body({ code: 0, data: { result: [{ bvid: 'BV1search001', aid: 101, title: '三花猫日常', description: '猫', author: '猫奴', typename: '喵星人', play: 5000, like: 10, duration: '2:00' }] } });
            if (url.includes('web-interface/view')) return body({ code: 0, data: { cid: 555 } });
            if (url.includes('player/wbi/v2')) return body({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/a.json' }] } } });
            if (url.includes('aisubtitle.hdslb.com')) return body({ body: [{ content: '今天讲讲楼下那只三花猫' }] });
            if (url.includes('reply/add')) return body({ code: 0, data: { rpid: 777, rpid_str: '777' } });
            if (url.includes('reply/main')) return body({ code: 0, data: { replies: [{ rpid: 777, rpid_str: '777' }] } });
            throw new Error(`没有准备这个请求：${url}`);
        };

        test('有凭证：按口味搜到的排第一，读字幕，摘录进她的提示词；日志说已登录；凭证内容不进日志', async () => {
            const clock = new VirtualClock(planDay());
            const cfg = config({ contacts: bf, schedule: true, herDays: true, bilibili: 'on', bilibiliAccount: true });
            saveCredential(credentialPath(cfg.dataDir), credential);
            const calls: { url: string; body?: string }[] = [];
            const prompts: string[] = [];
            const { app, sent, logs } = setup(cfg, { 10001: [] }, {
                clock, bilibiliFetch: fetchStub([]), bilibiliRequest: accountRequest(calls),
                generate: messages => { prompts.push(messages.map(m => m.content).join('\n')); return '这个也太真实了'; },
            });
            await app.connected(SELF);
            await drive(clock, () => sent.length >= 2);
            assert.equal(sent[1], '10001:https://www.bilibili.com/video/BV1search001', sent.join('|') + logs.join('|'));
            assert.ok(logs.some(l => l.includes('已登录「繁星小窝」')));
            assert.ok(logs.some(l => l.includes('读了字幕')));
            assert.ok(prompts.some(p => p.includes('今天讲讲楼下那只三花猫')), '字幕摘录进了提示词');
            assert.ok(calls.some(c => c.url.includes('wbi/search/type')));
            assert.ok(!calls.some(c => c.url.includes('reply/add')), '没开评论就不评论');
            assert.ok(!logs.join('\n').includes(credential.sessdata + credential.biliJct), '日志里没有凭证');
        });

        test('开关开着但没有凭证文件：记一次日志说怎么办，照旧读热门榜', async () => {
            const clock = new VirtualClock(planDay());
            const cfg = config({ contacts: bf, schedule: true, herDays: true, bilibili: 'on', bilibiliAccount: true });
            const calls: { url: string }[] = [];
            const { app, sent, logs } = setup(cfg, { 10001: [] }, { clock, bilibiliFetch: fetchStub([]), bilibiliRequest: accountRequest(calls), generate: () => '这个也太真实了' });
            await app.connected(SELF);
            await drive(clock, () => sent.length >= 2);
            assert.equal(sent[1], '10001:https://www.bilibili.com/video/BV1Jonu6mEwN');
            assert.equal(logs.filter(l => l.includes('没有凭证文件')).length, 1);
            assert.deepEqual(calls, [], '没有凭证就不请求 B 站账号接口');
        });

        test('评论开着：分享之后在视频下评论并真 @ 他（昵称 + uid），写评论的用最低隐私档的卡；复核在 2 分钟后', async () => {
            const clock = new VirtualClock(planDay());
            const cfg = config({ contacts: bf, schedule: true, herDays: true, bilibili: 'on', bilibiliAccount: true, bilibiliComment: 'on', bilibiliAtName: '小明', bilibiliAtUid: 98765 });
            saveCredential(credentialPath(cfg.dataDir), credential);
            const calls: { url: string; body?: string }[] = [];
            const prompts: string[] = [];
            const { app, sent, logs } = setup(cfg, { 10001: [] }, {
                clock, bilibiliFetch: fetchStub([]), bilibiliRequest: accountRequest(calls),
                generate: messages => { prompts.push(messages.map(m => m.content).join('\n')); return '这个也太真实了'; },
            });
            await app.connected(SELF);
            await drive(clock, () => calls.some(c => c.url.includes('reply/add')));
            const add = calls.find(c => c.url.includes('reply/add'))!;
            const form = new URLSearchParams(add.body);
            assert.equal(form.get('message'), '@小明 这个也太真实了');
            assert.deepEqual(JSON.parse(form.get('at_name_to_mid')!), { 小明: 98765 });
            assert.equal(form.get('oid'), '101');
            assert.equal(sent.length, 2, '先发了 QQ 的话和链接');
            assert.ok(prompts.some(p => p.includes('现在你要在 B 站一个视频下面发一条公开评论')), '评论走的是评论写手的说明');
            assert.ok(logs.some(l => l.includes('评论并 @ 了 小明')), logs.join('|'));
            assert.ok(logs.some(l => l.includes('分享后在视频下评论并 @ 小明（真发）')));
        });

        test('评论开着但没填要 @ 的人，或没开账号：不评论，各记一行日志', async () => {
            for (const [overrides, expected] of [
                [{ bilibiliAccount: true, bilibiliComment: 'on' as const }, '没填 bilibiliAtName / bilibiliAtUid'],
                [{ bilibiliComment: 'on' as const, bilibiliAtName: '小明', bilibiliAtUid: 98765 }, '要 bilibiliAccount 也开着'],
            ] as const) {
                const clock = new VirtualClock(planDay());
                const cfg = config({ contacts: bf, schedule: true, herDays: true, bilibili: 'on', ...overrides });
                saveCredential(credentialPath(cfg.dataDir), credential);
                const calls: { url: string }[] = [];
                const { app, sent, logs } = setup(cfg, { 10001: [] }, { clock, bilibiliFetch: fetchStub([]), bilibiliRequest: accountRequest(calls), generate: () => '这个也太真实了' });
                await app.connected(SELF);
                await drive(clock, () => sent.length >= 2);
                assert.ok(logs.some(l => l.includes(expected)), logs.join('|'));
                assert.ok(!calls.some(c => c.url.includes('reply/add')));
            }
        });
    });
});

describe('她知道自己在 QQ 上的样子（ADR 0083）：进提示词', () => {
    test('签名和 3 天内真发的说说进时间块；日志里签名只记字数', async () => {
        const clock = new VirtualClock(new Date(2026, 10, 5, 20, 0));
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }], schedule: true, herDays: true, signature: 'on' });
        mkdirSync(join(cfg.dataDir, 'presence'), { recursive: true });
        const now = clock.now();
        writeFileSync(join(cfg.dataDir, 'presence', 'presence.json'), JSON.stringify({
            version: 1, signature: { text: '土豆又胖了', at: now - 86_400_000, next: now + 3 * 86_400_000 },
            qzone: [{ at: now - 20 * 3_600_000, text: '今天的云好看', photo: 'a.jpg', tid: 't1', mode: 'on' }], photosUsed: ['a.jpg'],
        }));
        const seen: string[] = [];
        const { app, sent, logs } = setup(cfg, { 10001: [] }, { clock, generate: messages => { seen.push(messages.map(m => m.content).join('\n')); return '看到了'; } });
        await app.connected(SELF);
        app.receive({ ...event(10001, 1, '我看到你那条说说了'), time: Math.floor(now / 1000) });
        const deadline = Date.now() + 8000;
        while (sent.length === 0 && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 20));
            const next = clock.nextTimer();
            if (next !== undefined) clock.advanceTo(next);
        }
        assert.equal(sent.length, 1);
        const prompt = seen.at(-1)!;
        assert.match(prompt, /个性签名现在是「土豆又胖了」/);
        assert.match(prompt, /发了一条说说「今天的云好看」，配了一张图/);
        assert.ok(!logs.some(l => l.includes('土豆又胖了')), '日志里没有签名原文');
    });
});

describe('全开冒烟（整包上线用）', () => {
    const bf = [{ qq: 10001, name: '阿明', tier: 'boyfriend' as const }];
    test('所有开关一起开：连上、来一条消息、被戳、撤回——一个完整的来回不抛错、不丢回复、日志里没有失败', async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => { rejections.push(reason); };
        process.on('unhandledRejection', onRejection);
        try {
            const clock = new VirtualClock(new Date(2026, 9, 10, 15, 0));
            const calls: string[] = [];
            const note = (name: string) => async (...args: unknown[]) => { calls.push(name + ':' + args.join('/')); };
            const bili = async (): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { list: [] } }) });
            const cfg = config({
                contacts: bf, schedule: true, herDays: true, pokes: true, pokeBack: true, pokeOut: true, recalls: true, readReceipts: true, reactions: true,
                onlineStatus: true, profileLikes: true, signature: 'dryRun', qzone: 'dryRun', bilibili: 'dryRun', typingStatus: true, selfRecall: true,
                rhythm: true, shortReplies: true, festivals: 'greet', npcAsks: true,
            });
            const { app, sent, logs } = setup(cfg, { 10001: [] }, {
                clock, generate: () => '在呢，刚忙完', bilibiliFetch: bili,
                setOnlineStatus: note('status'), markRead: note('read'), reactMessage: note('react'), setInputStatus: note('typing'),
                deleteMessage: note('delete'), pokeFriend: note('poke'),
                extra: { sendLike: note('like'), setSignature: note('signature'), postQzone: async () => 'tid' },
            });
            const drive = async (done: () => boolean, ms = 15000) => {
                const deadline = Date.now() + ms;
                while (!done() && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 20));
                    const next = clock.nextTimer();
                    if (next !== undefined) clock.advanceTo(next);
                }
                await new Promise(r => setTimeout(r, 80));
            };
            await app.connected(SELF);
            await drive(() => calls.some(c => c.startsWith('status:')));
            assert.ok(calls.some(c => c.startsWith('status:')), '连上就设了在线状态');

            app.receive({ ...event(10001, 1, '在吗'), time: Math.floor(clock.now() / 1000) });
            await drive(() => sent.length >= 1);
            assert.ok(sent.length >= 1, '回了话（节奏和更短都开着也照回）');
            assert.ok(calls.includes('read:10001'), '已读');

            const before = sent.length;
            app.receivePoke({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: SELF, user_id: 10001, target_id: SELF, time: Math.floor(clock.now() / 1000) });
            await drive(() => sent.length > before);
            assert.ok(sent.length > before, '被戳了回一句');

            app.receive({ ...event(10001, 3, '你猜'), time: Math.floor(clock.now() / 1000) });
            app.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: SELF, user_id: 10001, message_id: 3, time: Math.floor(clock.now() / 1000) });
            await drive(() => false, 2000);
            const failures = logs.filter(l => /失败|出错|异常|未捕获|Error/.test(l));
            assert.deepEqual(failures, [], '全开时日志里不该有失败 / 出错：' + failures.join(' | '));
            assert.deepEqual(rejections, [], '没有没接住的 Promise 错误');
        } finally {
            process.off('unhandledRejection', onRejection);
        }
    });
});
