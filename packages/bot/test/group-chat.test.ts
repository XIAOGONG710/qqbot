import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp } from '../src/platform/app.ts';
import { parseGroups, type AppConfig } from '../src/platform/config.ts';
import { isGroupMessage, type GroupMessageEvent } from '../src/platform/onebot.ts';
import { GROUP_LIMITS, groupLine, groupLog, groupNote, groupPokePlan, groupReply, herNameList, mentionSegments, mentionsHer, nameAts, speakReason, withinBudget, type GroupEntry, type SpeakContext } from '../src/social/group-chat.ts';
import { moodStateLine } from '../src/emotion/express.ts';
import { analyzeGroupStyle, renderGroupStyle } from '../src/social/group-style.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// ADR 0210（用户 11-02）：只在名单里的群说话；她本人「基本潜水，有人点我名、聊到吃的剧团子饼、有人损你才冒头」
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
        assert.equal(speakReason([text('梦瑶你来不来')], '梦瑶你来不来', 30001, 3, ctx()), 'mentioned');
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
        // 夸张、想念、说别人的都不算——和私聊同一套判定（原来群聊自己那行正则把「想死你了」也当危机，当众甩热线）
        for (const joking of ['想死你了', '笑死我了，想死哈哈哈哈', '作业撑不下去了', '我室友说他想死', '我不想死']) {
            assert.notEqual(speakReason([text(joking)], joking, 30001, 10, ctx()), 'crisis', joking);
        }
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
        // 认识的人和心境都进说明（2026-11-14）
        const withMemory = groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned', memory: '[认识的人：老王]', mood: '[你这会儿有点累]' });
        assert.ok(withMemory.includes('[认识的人：老王]') && withMemory.includes('[你这会儿有点累]'));
    });

    test('心境只说怎么样，不把私聊的来由带进群', () => {
        const line = moodStateLine([
            { kind: 'sad', level: 'strong' }, { kind: 'tired', level: 'clear' }, { kind: 'joy', level: 'faint' },
        ])!;
        assert.ok(line.includes('有点低落') && line.includes('有点累'), line);
        assert.ok(!line.includes('faint') && !line.includes('joy'), line);
        assert.ok(line.includes('话少一点'), '提不起劲时让她少说');
        assert.equal(moodStateLine([{ kind: 'joy', level: 'faint' }]), undefined, '几乎察觉不到就不写');
    });

    test('她写的整理成一两条：去掉名字前缀和内部标记；「不说」就不发', () => {
        assert.deepEqual(groupReply('你：火锅！\n<<记住：x>>\n走起'), ['火锅！', '走起']);
        assert.deepEqual(groupReply('不说'), []);
        assert.deepEqual(groupReply('（不说）'), []);
        assert.deepEqual(groupReply('一\n二\n三'), ['一', '二']);
    });

    test('「@老王」认得出的名字换成段；认不出的留着当文字；戳一戳有冷却', () => {
        const names = new Map([['老王', 30001], ['陈陈', 30003]]);
        const segments = mentionSegments('@老王 你说呢', names)!;
        assert.deepEqual(segments.map(segment => segment.type), ['at', 'text']);
        assert.equal(String(segments[0]!.data.qq), '30001');
        assert.equal(String(segments[1]!.data.text), ' 你说呢');
        assert.equal(mentionSegments('@路人甲 你好', names), undefined, '不认识就不换');
        assert.equal(mentionSegments('没有 at 的普通话', names), undefined);
        // 同一句话里两个都认得：两段 at
        assert.equal(mentionSegments('@老王 @陈陈 来', names)!.filter(segment => segment.type === 'at').length, 2);
        // 戳一戳：找一天里会发生的种子，同一个人 10 分钟内不重复
        const now = Date.parse('2026-11-14T12:00:00+08:00');
        let seed = '';
        for (let i = 0; i < 200 && !seed; i++) if (groupPokePlan(String(i), undefined, now)) seed = String(i);
        assert.ok(seed, '两百个种子里总该有戳的');
        assert.ok(groupPokePlan(seed, now - 60_000, now) === undefined, '刚戳过就不戳了');
        assert.ok(groupPokePlan(seed, now - 11 * 60_000, now), '隔了十分钟可以再戳');
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
    function app(groupChat: 'dryRun' | 'on', knowsBot = false, extra: {
        vision?: { describe: (image: { url: string }) => Promise<string> };
        stickerReader?: { describe: (image: { url: string }) => Promise<string> };
        generate?: (messages: { content: string }[]) => Promise<string>;
        pokeGroup?: (groupId: number, userId: number) => Promise<void>;
        callAction?: (action: string, params: Record<string, unknown>) => Promise<unknown>;
    } = {}) {
        const dataDir = tmp();
        const cfg = {
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            characterCard: syntheticCardPattern,
            contacts: [{ qq: 10001, name: '宝宝', tier: 'boyfriend', knowsBot: true }],
            unlistedFriends: false, schedule: false, moody: false, speechCheck: false, herDays: false, autonomousLife: false, projectChoice: false,
            lifeInPrompt: false, grievance: false, feedbackCommands: false, realWeather: false, media: true, readStickers: Boolean(extra.stickerReader),
            herFeelings: true,
            candidates: 1, contextTurns: 0, contextContacts: [], proactive: 'off', dataDir,
            groupChat, groups: [{ id: 555, name: '宿舍群', ...(knowsBot ? { knowsBot: true } : {}) }],
        } as unknown as AppConfig;
        const sentGroup: string[] = [];
        const sentRich: { segments: { type: string; data: Record<string, unknown> }[]; replyTo?: number }[] = [];
        const prompts: string[] = [];
        const started = startApp({
            config: cfg, log: () => {},
            transport: {
                sendPrivateText: async () => 1, friendHistory: async () => [],
                sendGroupText: async (groupId, value) => { sentGroup.push(`${groupId}:${value}`); return 8000 + sentGroup.length; },
                sendGroupMessage: async (groupId, segments, replyTo) => {
                    sentRich.push({ segments: segments as { type: string; data: Record<string, unknown> }[], ...(replyTo === undefined ? {} : { replyTo }) });
                    sentGroup.push(`${groupId}:${segments.map(s => (s.type === 'at' ? `@${String(s.data.qq)}` : String(s.data.text ?? ''))).join('')}`);
                    return 9000 + sentRich.length;
                },
                ...(extra.pokeGroup ? { pokeGroup: extra.pokeGroup } : {}),
                callAction: async (action, params) => (extra.callAction ? extra.callAction(action, params) : ({} as never)),
            },
            pipeline: { generate: async messages => { prompts.push(messages.map(m => m.content).join('\n')); return extra.generate ? extra.generate(messages) : '来了来了'; }, settle: { quietMs: 0, maxMs: 0 } },
            ...(extra.vision ? { vision: extra.vision } : {}),
            ...(extra.stickerReader ? { stickerReader: extra.stickerReader } : {}),
        });
        return { app: started, sentGroup, sentRich, prompts, dataDir };
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
        a.receiveGroup(said(555, 30002, 'Lisa', [text('我也去')]));
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
        // 群名片里的字母 s 不能被当成空白吃掉（2026-11-14 修：/s+/ 少了反斜杠，「Lisa」会变成「Li a」）
        assert.ok(prompt.includes('Lisa：我也去'), prompt.slice(-400));
        assert.ok(prompt.includes('别喊得黏'), '他在群里');
        assert.ok(prompt.includes('你在这个群认识的人') && prompt.includes('老王'), '群里认识谁要写进去（不能再见就不认识）');
        assert.match(prompt, /不要否认，用你自己的口气大方承认/, '没标「都知道」的群用承认版');
        const log = readFileSync(join(dataDir, 'groups', '555.jsonl'), 'utf8');
        assert.ok(log.includes('"mine":true') && log.includes('来了来了'));
    });

    test('两个人前后脚叫她：攒成一段、只回一次，说明里点出是谁在叫她', async () => {
        const { app: a, sentGroup, prompts } = app('on');
        await a.connected(SELF);
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 在吗')]));
        a.receiveGroup(said(555, 30003, '陈陈', [text('梦瑶你中午吃啥')]));
        await until(() => sentGroup.length > 0);
        await new Promise(r => setTimeout(r, 200));
        a.stop();
        // 不是一人回一条：这一批只发一次
        assert.deepEqual(sentGroup, ['555:来了来了']);
        const prompt = prompts.at(-1)!;
        assert.ok(prompt.includes('老王、陈陈在跟你说话'), prompt.slice(-500));
        assert.ok(prompt.includes('不用挨个都应'), '多人找她时让她自己挑');
    });

    test('她说话的时候又有人叫她：不丢，说完接着处理下一批', async () => {
        const pending: (() => void)[] = [];
        const { app: a, sentGroup } = app('on', false, {
            generate: async () => { await new Promise<void>(resolve => pending.push(resolve)); return '来了来了'; },
        });
        await a.connected(SELF);
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 在吗')]));
        await until(() => pending.length === 1);
        // 她正在想的时候第二个人叫她
        a.receiveGroup(said(555, 30003, '陈陈', [{ type: 'at', data: { qq: String(SELF) } }, text(' 梦瑶呢')]));
        pending.shift()!();
        await until(() => pending.length === 1);
        pending.shift()!();
        await until(() => sentGroup.length === 2);
        a.stop();
        assert.deepEqual(sentGroup, ['555:来了来了', '555:来了来了']);
    });

    test('群里的昵称也算叫她：真名之外，群里那个名字要认', () => {
        const withAlias = ctx({ herNames: ['小瑶'] });
        assert.equal(mentionsHer('小瑶昨天那条视频', ['小瑶']), true);
        assert.equal(mentionsHer('小瑶昨天那条视频'), false, '不给她群里那个名字，就只认真名');
        assert.equal(speakReason([text('小瑶你说呢')], '小瑶你说呢', 30001, 11, withAlias), 'mentioned');
        assert.equal(speakReason([text('小瑶是不是有点傻')], '小瑶是不是有点傻', 30001, 12, withAlias), 'overheard');
        // 一个字的别名不算（「瑶」会撞普通字）
        assert.deepEqual(herNameList(['瑶', '小瑶']), ['小瑶', '林梦瑶', '梦瑶', '瑶瑶', '瑶姐']);
        // 说明里告诉她：这些名字也是你
        const note = groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned', myNames: ['小瑶', '林梦瑶'] });
        assert.ok(note.includes('「小瑶」'), note);
        assert.ok(!note.includes('「林梦瑶」'), '真名不用再解释一遍');
    });

    test('群里人都知道她是 AI：不用瞒也不用主动提', () => {
        const note = groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned', knowsBot: true });
        assert.ok(note.includes('都知道你是 AI'), note);
        assert.ok(note.includes('不用主动提'), note);
        assert.ok(!groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned' }).includes('都知道你是 AI'));
    });

    test('从聊天记录里学这个群的口气：长度、常出现的词、表情、谁话多、示范原话', () => {
        const entries = Array.from({ length: 12 }, (_, i) => ({
            time: `2026-11-${String(3 + (i % 5)).padStart(2, '0')}T20:0${i % 10}:00+08:00`,
            from: 30001 + (i % 3),
            name: ['小肥鱼', '大肥鱼', '老吴'][i % 3]!,
            content: i % 3 === 0 ? '这破显卡才 3g 显存😂' : i % 3 === 1 ? '跑整首歌要两个钟😂' : '我嘞个豆',
            messageId: i,
        }));
        const style = analyzeGroupStyle(entries);
        assert.ok(style.avgChars > 3 && style.avgChars < 30, String(style.avgChars));
        assert.ok(style.topWords.includes('显卡') || style.topWords.includes('显存'), style.topWords.join(','));
        assert.ok(style.emojis.includes('😂'), style.emojis.join(''));
        assert.equal(style.talkers.length, 3);
        assert.ok(style.exemplars.length > 0);
        const text = renderGroupStyle(style)!;
        assert.ok(text.includes('学他们的口气') && text.includes('「'), text);
        assert.equal(renderGroupStyle(undefined), undefined);
    });

    test('有人问「你也是来养鱼的吗」：说明里给了口径', () => {
        const note = groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned', disguise: true, cover: '算是来养鱼的，被穹P拉进来的' });
        assert.ok(note.includes('你也是来养鱼的吗'), note);
        assert.ok(note.includes('算是来养鱼的，被穹P拉进来的'), note);
        assert.ok(note.includes('别主动扯上他和你的关系'), note);
    });

    test('导过以前的记录：补过课，但她是刚进群的', () => {
        const note = groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned', veteran: true });
        assert.ok(note.includes('刚进群'), note);
        assert.ok(note.includes('别把旧事说成你在场'), note);
        assert.ok(!groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned' }).includes('刚进群'));
    });

    test('要装成真人：别提、别承认是 AI', () => {
        const note = groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned', disguise: true });
        assert.ok(note.includes('别主动提、也别承认自己是 AI'), note);
        assert.ok(note.includes('含糊带过'), note);
        assert.ok(!groupNote({ groupName: 'x', boyfriendHere: false, reason: 'mentioned' }).includes('别承认自己是 AI'));
    });

    test('没 @ 她、只在群里提到她：听见了；叫她名字才是一定要接', () => {
        // 名字 + 第二人称 = 在跟她说话
        assert.equal(speakReason([text('梦瑶你说呢')], '梦瑶你说呢', 30001, 1, ctx()), 'mentioned');
        assert.equal(speakReason([text('梦瑶在吗')], '梦瑶在吗', 30001, 2, ctx()), 'mentioned');
        // 只是被提起来：按消息 id 抽签，抽中的算听见
        let heard = 0;
        for (let id = 100; id < 200; id++) if (speakReason([text('梦瑶昨天那个视频真好笑')], '梦瑶昨天那个视频真好笑', 30001, id, ctx()) === 'overheard') heard++;
        assert.ok(heard > 20 && heard < 90, `听见 ${heard}/100`);
        // 说她不好听的：一定接一句
        assert.equal(speakReason([text('林梦瑶是不是有点傻')], '林梦瑶是不是有点傻', 30001, 3, ctx()), 'overheard');
        // 今天听见的额度用完就不接了
        assert.equal(speakReason([text('林梦瑶是不是有点傻')], '林梦瑶是不是有点傻', 30001, 4, ctx({ overheardToday: GROUP_LIMITS.overheardPerDay })), undefined);
        // 提到别人、没提她：不算
        assert.equal(mentionsHer('老王昨天那个视频真好笑'), false);
    });

    test('听见别人聊她时，说明里是「恰好接一句」，不是「他们在问你」', () => {
        const note = groupNote({ groupName: 'x', boyfriendHere: false, reason: 'overheard' });
        assert.ok(note.includes('没人在跟你说话'), note);
        assert.ok(note.includes('不想理就只写「不说」'), note);
    });

    test('群里有人夸她：这一句她带着好心情说', async () => {
        const { app: a, sentGroup, prompts } = app('on');
        await a.connected(SELF);
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 你唱得真好听')]));
        await until(() => sentGroup.length > 0);
        await new Promise(r => setTimeout(r, 200));
        a.stop();
        assert.ok(prompts.at(-1)!.includes('你这会儿心情不错'), prompts.at(-1)!.slice(-500));
    });

    test('对某个人的印象写下来、下次带上', async () => {
        const { app: a, sentGroup, prompts, dataDir } = app('on', false, {
            generate: async messages => (messages.some(message => message.content.includes('用一句话写出')) ? '爱打球，说话直' : '来了来了'),
        });
        await a.connected(SELF);
        for (let i = 0; i < 5; i++) a.receiveGroup(said(555, 30001, '老王', [text(`第${i + 1}句`) ]));
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 在不在')]));
        await until(() => sentGroup.length > 0);
        await until(() => { try { return readFileSync(join(dataDir, 'groups', '555.people.json'), 'utf8').includes('爱打球，说话直'); } catch { return false; } });
        // 下一批说话时，印象已经在她看得到的那段里
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 在干嘛')]));
        await until(() => prompts.at(-1)!.includes('你对他的印象：爱打球，说话直'));
        a.stop();
        assert.ok(prompts.at(-1)!.includes('你对他的印象：爱打球，说话直'), prompts.at(-1)!.slice(-500));
    });

    test('她写「@老王」就真的 @ 他；第一条引用那条叫她的话', async () => {
        const { app: a, sentRich, sentGroup } = app('on', false, { generate: async () => '@老王 昨晚那场我也看了' });
        await a.connected(SELF);
        const call = said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 昨晚那场你看了吗')]);
        a.receiveGroup(call);
        await until(() => sentRich.length > 0);
        a.stop();
        assert.equal(sentRich.length, 1);
        assert.deepEqual(sentRich[0]!.segments.map(segment => segment.type), ['at', 'text'], '认得出的名字换成 at 段');
        assert.equal(String(sentRich[0]!.segments[0]!.data.qq), '30001');
        assert.equal(sentRich[0]!.replyTo, call.message_id, '引用叫她那一条');
        assert.ok(sentGroup[0]!.includes('@30001'), sentGroup.join('|'));
    });

    test('认不出的 @ 不瞎换，照旧发文字、不带引用', async () => {
        const { app: a, sentRich, sentGroup } = app('on', false, { generate: async () => '@路人甲 你说呢' });        await a.connected(SELF);
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 你看呢')]));
        await until(() => sentGroup.length > 0);
        a.stop();
        assert.equal(sentGroup[0], '555:@路人甲 你说呢');
    });

    test('没 @ 她、只在群里聊到她：她听得见，也能接一句', async () => {
        const { app: a, sentGroup, prompts, sentRich } = app('on');
        await a.connected(SELF);
        a.receiveGroup(said(555, 30001, '老王', [text('林梦瑶是不是有点傻')]));
        await until(() => sentGroup.length > 0);
        a.stop();
        const prompt = prompts.at(-1)!;
        assert.ok(prompt.includes('没人在跟你说话'), prompt.slice(-500));
        assert.equal(sentRich.length, 0, '没叫她，就不引用她那一条');
    });

    test('她在群里被叫别的名字（QQ 昵称「繁星」）：那也是她，叫了要应', async () => {
        const { app: a, sentGroup, prompts, dataDir } = app('on', false, {
            // 和线上一样：她的 QQ 昵称是「繁星」；群成员接口这条不给（有的 NapCat 版本要权限）
            callAction: async action => {
                if (action === 'get_login_info') return { nickname: '繁星' };
                throw new Error('没有权限读群成员资料');
            },
        });
        await a.connected(SELF);
        await new Promise(r => setTimeout(r, 100)); // 连上之后读自己的名字
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'at', data: { qq: String(SELF) } }, text(' 繁星你来不来')]));
        await until(() => sentGroup.length > 0);
        a.stop();
        assert.equal(sentGroup.length, 1, '叫到的是她，要应');
        const prompt = prompts.at(-1)!;
        assert.ok(prompt.includes('群里他们也可能叫你「繁星」'), prompt.slice(-600));
        // 名字存下来：下次 NapCat 读不到也还认得
        assert.ok(readFileSync(join(dataDir, 'groups', 'self-names.json'), 'utf8').includes('繁星'));
    });

    test('群里的图：没人叫她就不读；叫到她了才读，读出来的进提示词', async () => {
        let looked = 0;
        const vision = { describe: async () => { looked++; return '一张火锅照片'; } };
        const { app: a, sentGroup, prompts, dataDir } = app('on', false, { vision });
        await a.connected(SELF);
        // 没叫到她：不读图，记录里留着占位（记录在安静 1.5 秒后这一批处理时才落盘）
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'image', data: { url: 'http://x/1.jpg' } }, text('今晚吃这个')]));
        await until(() => existsSync(join(dataDir, 'groups', '555.jsonl')));
        assert.equal(looked, 0, '没触发就不该调看图接口');
        assert.ok(readFileSync(join(dataDir, 'groups', '555.jsonl'), 'utf8').includes('[图片]'));
        // @ 她 + 一张图：读图，提示词里是她看出来的内容
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'image', data: { url: 'http://x/2.jpg' } }, { type: 'at', data: { qq: String(SELF) } }, text(' 这啥')]));
        await until(() => sentGroup.length > 0);
        a.stop();
        assert.equal(looked, 1);
        assert.ok(prompts.at(-1)!.includes('[图片：一张火锅照片]'), prompts.at(-1)!.slice(-400));
    });

    test('群里的表情包：用表情包那条提示词先抄字，读一次就进记录', async () => {
        let read = 0;
        const stickerReader = { describe: async () => { read++; return '文字：好耶｜画面：一只举手的猫'; } };
        const { app: a, prompts, sentGroup } = app('on', false, { stickerReader });
        await a.connected(SELF);
        a.receiveGroup(said(555, 30001, '老王', [{ type: 'image', data: { file: 'c15a5b9e3b6e.png', summary: '[动画表情]', url: 'http://x/s.png' } }, { type: 'at', data: { qq: String(SELF) } }, text(' 看这个')]));
        await until(() => sentGroup.length > 0);
        a.stop();
        assert.equal(read, 1);
        assert.ok(prompts.at(-1)!.includes('[动画表情：上面写着「好耶」；一只举手的猫]'), prompts.at(-1)!.slice(-400));
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
