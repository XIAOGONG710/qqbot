import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp } from '../src/platform/app.ts';
import { parseGroups, type AppConfig } from '../src/platform/config.ts';
import { isGroupMessage, type GroupMessageEvent } from '../src/platform/onebot.ts';
import { GROUP_LIMITS, groupLine, groupLog, groupNote, groupReply, nameAts, speakReason, withinBudget, type GroupEntry, type SpeakContext } from '../src/social/group-chat.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// ADR 0210（用户 11-02）：只在名单里的群说话；她本人「基本潜水，有人点我名、聊到吃的剧土豆、有人损你才冒头」
const SELF = 20000;
const BF = { qq: 10001, name: '宝宝' };
const ctx = (extra: Partial<SpeakContext> = {}): SpeakContext => ({ selfId: SELF, boyfriend: BF, boyfriendNames: ['阿明'], herMessageIds: new Set([7001]), topicToday: 0, ...extra });
const text = (value: string) => ({ type: 'text', data: { text: value } });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-group-')); dirs.push(dir); return dir; };

describe('群聊：什么时候开口', () => {
    test('被 @、被回、被叫名字：开口；平常的话：潜水', () => {
        assert.equal(speakReason([{ type: 'at', data: { qq: String(SELF) } }, text(' 你说呢')], '@你 你说呢', 30001, 1, ctx()), 'mentioned');
        assert.equal(speakReason([{ type: 'reply', data: { id: '7001' } }, text('哈哈哈')], '哈哈哈', 30001, 2, ctx()), 'mentioned');
        assert.equal(speakReason([text('梦瑶今天来不来')], '梦瑶今天来不来', 30001, 3, ctx()), 'mentioned');
        assert.equal(speakReason([text('明天几点集合')], '明天几点集合', 30001, 4, ctx()), undefined);
    });

    test('有人损他（叫他的群名片或 @ 他）：出来说两句；他自己说的不算', () => {
        assert.equal(speakReason([text('阿明这把打得也太菜了')], '阿明这把打得也太菜了', 30001, 5, ctx()), 'defend');
        assert.equal(speakReason([{ type: 'at', data: { qq: '10001' } }, text(' 你就这？')], '@宝宝 你就这？', 30001, 6, ctx()), 'defend');
        assert.equal(speakReason([text('我太菜了')], '我太菜了', 10001, 7, ctx()), undefined);
        assert.equal(speakReason([text('阿明明天来吗')], '阿明明天来吗', 30001, 8, ctx()), undefined, '叫他但没损他');
    });

    test('有人说想不开：一定开口（不看间隔）', () => {
        assert.equal(speakReason([text('真的不想活了')], '真的不想活了', 30001, 9, ctx()), 'crisis');
    });

    test('聊到她熟的：只是有时候插一句，一天最多几次', () => {
        const ids = Array.from({ length: 200 }, (_, i) => i + 100);
        const hits = ids.filter(id => speakReason([text('晚上吃火锅吗')], '晚上吃火锅吗', 30001, id, ctx()) === 'topic').length;
        assert.ok(hits > 30 && hits < 100, `${hits}/200`);
        assert.ok(ids.every(id => speakReason([text('晚上吃火锅吗')], '晚上吃火锅吗', 30001, id, ctx({ topicToday: GROUP_LIMITS.topicPerDay })) === undefined));
    });

    test('额度：一小时 / 一天的上限；插话和替他说话要隔一会儿；有人想不开不受限', () => {
        const now = Date.parse('2026-11-02T20:00:00+08:00');
        const mine = (minutesAgo: number[]): GroupEntry[] => minutesAgo.map((m, i) => ({ time: new Date(now - m * 60_000).toISOString(), from: SELF, name: '你', content: 'x', messageId: i, mine: true }));
        assert.deepEqual(withinBudget(mine([10, 20]), now, 'mentioned'), { ok: true });
        assert.equal(withinBudget(mine([1, 2, 3, 4, 5, 6]), now, 'mentioned').ok, false);
        assert.equal(withinBudget(mine([1, 2, 3, 4, 5, 6]), now, 'crisis').ok, true);
        assert.equal(withinBudget(mine([0.5]), now, 'topic').ok, false);
        assert.equal(withinBudget(mine([0.5]), now, 'mentioned').ok, true);
    });
});

describe('群聊：给她看的样子', () => {
    test('@QQ号 换成人话；一行写清是谁说的；她自己 =「你」，他 =「宝宝（你男朋友）」', () => {
        const names = new Map([[30001, '老王']]);
        assert.equal(nameAts(`@${SELF} 来不来 @30001 @10001 @99999 `, SELF, names, BF), '@你 来不来 @老王 @宝宝 @某人 ');
        assert.equal(groupLine({ time: '', from: 30001, name: '老王', content: '吃啥', messageId: 1 }, BF), '老王：吃啥');
        assert.equal(groupLine({ time: '', from: 10001, name: '阿明', content: '随便', messageId: 2 }, BF), '宝宝（你男朋友）：随便');
        assert.equal(groupLine({ time: '', from: SELF, name: '你', content: '火锅', messageId: 3, mine: true }, BF), '你：火锅');
    });

    test('说明：群里收着点、不说私事；他在群里时别喊得黏；可以不说', () => {
        const note = groupNote({ groupName: '宿舍群', boyfriendHere: true, boyfriendName: '宝宝', reason: 'defend' });
        for (const part of ['QQ 群「宿舍群」', '不在群里说你和他之间的私事', '别喊得黏', '替他说两句', '不想说就只写「不说」']) assert.ok(note.includes(part), part);
        assert.ok(!groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned' }).includes('男朋友）也在'));
        assert.ok(groupNote({ groupName: 'x', boyfriendHere: false, reason: 'crisis' }).includes('12356'));
    });

    test('她写的整理成一两条：去掉名字前缀和内部标记；「不说」就不发', () => {
        assert.deepEqual(groupReply('你：火锅！\n<<记住：x>>\n走起'), ['火锅！', '走起']);
        assert.deepEqual(groupReply('不说'), []);
        assert.deepEqual(groupReply('（不说）'), []);
        assert.deepEqual(groupReply('一\n二\n三'), ['一', '二']);
    });

    test('群记录按群分文件，读回来一样；配置 groups 校验', () => {
        const dir = tmp();
        const logA = groupLog(dir);
        logA.append(555, { time: '2026-11-02T12:00:00.000Z', from: 1, name: 'a', content: 'hi', messageId: 9 });
        assert.ok(groupLog(dir).has(555, 9) && !groupLog(dir).has(556, 9));
        assert.deepEqual(parseGroups([{ id: 555, name: ' 宿舍群 ', knowsBot: true }, { id: '556', name: '班群' }]), [{ id: 555, name: '宿舍群', knowsBot: true }, { id: 556, name: '班群' }]);
        assert.deepEqual(parseGroups(undefined), []);
        assert.throws(() => parseGroups([{ id: 555, name: 'a' }, { id: 555, name: 'b' }]), /重复/);
        assert.throws(() => parseGroups([{ id: 555, name: 'a', knowsBot: 'yes' }]), /knowsBot/);
    });

    test('认得群消息：她自己发的、匿名的不算', () => {
        const base = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: SELF, user_id: 30001, group_id: 555, message_id: 1, time: 1, message: [], raw_message: '', sender: { user_id: 30001 } };
        assert.ok(isGroupMessage(base as never));
        assert.ok(!isGroupMessage({ ...base, user_id: SELF } as never));
        assert.ok(!isGroupMessage({ ...base, sub_type: 'anonymous' } as never));
        assert.ok(!isGroupMessage({ ...base, message_type: 'private' } as never));
        assert.ok(!isGroupMessage({ ...base, group_id: Number.NaN } as never));
        assert.ok(!isGroupMessage({ ...base, sender: { user_id: 999 } } as never));
        assert.ok(!isGroupMessage({ ...base, message: [{ type: 'text', data: null }] } as never));
    });
});

describe('群聊：进应用', () => {
    function app(groupChat: 'dryRun' | 'on', knowsBot = false) {
        const dataDir = tmp();
        const cfg = {
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            characterCard: join(resolve(import.meta.dirname, '../../..'), 'characters/linmengyao/st/linmengyao-{tier}.json'),
            contacts: [{ qq: 10001, name: '宝宝', tier: 'boyfriend', knowsBot: true }],
            unlistedFriends: false, schedule: false, moody: false, speechCheck: false, herDays: false, autonomousLife: false, projectChoice: false,
            lifeInPrompt: false, grievance: false, feedbackCommands: false, realWeather: false, media: true,
            candidates: 1, contextTurns: 0, contextContacts: [], proactive: 'off', dataDir,
            groupChat, groups: [{ id: 555, name: '宿舍群', ...(knowsBot ? { knowsBot: true } : {}) }],
        } as unknown as AppConfig;
        const sentGroup: string[] = [];
        const prompts: string[] = [];
        const started = startApp({
            config: cfg, log: () => {},
            transport: {
                sendPrivateText: async () => 1, friendHistory: async () => [],
                sendGroupText: async (groupId, value) => { sentGroup.push(`${groupId}:${value}`); return 8000 + sentGroup.length; },
            },
            pipeline: { generate: async messages => { prompts.push(messages.map(m => m.content).join('\n')); return '来了来了'; }, settle: { quietMs: 0, maxMs: 0 } },
        });
        return { app: started, sentGroup, prompts, dataDir };
    }
    let id = 1;
    const said = (groupId: number, from: number, card: string, segments: unknown[]): GroupMessageEvent => ({
        post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: SELF, user_id: from, group_id: groupId, message_id: 6000 + id++,
        time: Math.floor(Date.now() / 1000), message: segments as GroupMessageEvent['message'], raw_message: '', sender: { user_id: from, card, nickname: card },
    });
    const until = async (done: () => boolean) => { const deadline = Date.now() + 3000; while (!done() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10)); };

    test('名单外的群什么都不做（不记、不说）；名单里的群平常潜水，被 @ 才说，说的进记录', async () => {
        const { app: a, sentGroup, prompts, dataDir } = app('on');
        await a.connected(SELF);
        a.receiveGroup(said(999, 30001, '路人', [text('@梦瑶 在吗')]));
        a.receiveGroup(said(555, 10001, '阿明', [text('今晚吃啥')]));
        a.receiveGroup(said(555, 30001, '老王', [text('明天几点集合')]));
        await new Promise(r => setTimeout(r, 100));
        assert.equal(sentGroup.length, 0);
        assert.ok(!existsSync(join(dataDir, 'groups', '999.jsonl')), '名单外的群不记');
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 你来不来')]));
        await until(() => sentGroup.length > 0);
        a.stop();
        assert.deepEqual(sentGroup, ['555:来了来了']);
        const prompt = prompts.at(-1)!;
        // 群里写他的群名片，不写「宝宝」（她会当众喊出来）
        assert.ok(prompt.includes('阿明（你男朋友）：今晚吃啥') && prompt.includes('老王：@你  你来不来') && !prompt.includes('宝宝（你男朋友）'), prompt.slice(-400));
        assert.ok(prompt.includes('别喊得黏'), '他在群里');
        assert.match(prompt, /不要否认，用你自己的口气大方承认/, '没标「都知道」的群用承认版');
        const log = readFileSync(join(dataDir, 'groups', '555.jsonl'), 'utf8');
        assert.ok(log.includes('"mine":true') && log.includes('来了来了'));
    });

    test('标了「都知道」的群用原卡（被问时由她定）', async () => {
        const { app: a, sentGroup, prompts } = app('on', true);
        await a.connected(SELF);
        a.receiveGroup(said(555, 30001, '老王', [text('梦瑶你说呢')]));
        await until(() => sentGroup.length > 0);
        a.stop();
        assert.match(prompts.at(-1)!, /承不承认、怎么说，你自己决定/);
    });

    test('试运行：只写草稿，不发', async () => {
        const { app: a, sentGroup, dataDir } = app('dryRun');
        await a.connected(SELF);
        a.receiveGroup(said(555, 30001, '老王', [text('梦瑶你说呢')]));
        await until(() => existsSync(join(dataDir, 'groups', 'drafts.md')));
        a.stop();
        assert.equal(sentGroup.length, 0);
        assert.match(readFileSync(join(dataDir, 'groups', 'drafts.md'), 'utf8'), /群「宿舍群」（mentioned）：来了来了/);
    });
});
