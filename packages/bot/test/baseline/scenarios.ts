// 行为基线的场景（ADR 0263 第 2 步）。每个场景一份快照：test/baseline/snapshots/<name>.txt。
//
// 覆盖：私聊回复（7 个档位 + 名单外）、连发合并、生成中又来消息（丢掉重来）、发送中插话、作息里的等待和吵醒、危机回合、
// 戳一戳与撤回、连上时补回漏掉的消息、停止时正在等 / 正在生成、主动消息过一整天、本地功能全开的两天聊天（提示词各槽位、深思换模型）、
// 小梗（连上后抽一次、过 6 小时的定时检查、回复时按轮放进提示词）、口头习惯（连上后学一次、定时检查、约一半的轮次放进提示词）、
// 被打断（聊天正在进行时她那边的小事，含他难过时让路）。
//
// 没覆盖（要连网或要外部服务，迁到对应模块之前先补场景）：长期记忆 Hindsight、真实天气、B 站（刷视频 / 私信 / 评论）、热梗与在看、
// 照片货架与吃的照片、图片表情、看图与语音、网页查询、DSH 与手机伴侣、设备控制、QQ 账号控制面与好友申请、说说与空间、
// 逐条事实检查（factCheck，它的审稿调用不经 pipeline.generate）、设定账本（identityLedger：写死读真实角色目录 characters/linmengyao 并调 git，
// 基线不能碰真实资料，也不能随每次提交的 HEAD 变）。

import type { Contact } from '../../src/platform/config.ts';
import type { AppConfig } from '../../src/platform/config.ts';
import type { HistoryMessage } from '../../src/memory/backfill.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatHistory } from '../../src/memory/history.ts';
import { SELF, type LlmCall, type Replier, type Scenario } from './harness.ts';

const boyfriend: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend', persona: '她的男朋友，同校不同专业', knowsBot: true };
const classmate: Contact = { qq: 10002, name: '小周', tier: 'classmate' };

/** 本地就能跑的功能全开（不连网的那些）；连网的仍按生产默认关着 */
export const RICH: Partial<AppConfig> = {
    schedule: true, moody: true, speechCheck: true, herDays: true,
    autonomousLife: true, projectChoice: true, lifeInPrompt: true, grievance: true, npcAsks: true,
    shape: true, shapeAgenda: true, shapeFiller: true, shapeSplit: true, shapeAsk: true, shapeLong: true, shapeFeel: true,
    relationship: true, jokes: true, idioms: true, tailCap: true, interruptions: true, together: true, jealousy: true,
    texture: true, curious: true, everydayLife: true, menu: true, pursuits: true, herFeelings: true, herNo: true,
    lagTail: true, rhythm: true, typingStatus: true, selfRecall: true, readReceipts: true, reactions: true, quoteReply: true,
    festivals: 'greet', pokes: true, pokeBack: true, recalls: true,
    proactive: 'on', proactiveReach: true, innerLife: true, proactiveInvite: true, proactiveAsk: true, comeBack: true,
    hisHours: true, smallNews: true, proactiveRoom: true,
    feedbackCommands: true, timeline: true, tastes: true, dormancy: true, deliberate: true, weeklyReport: true,
};

/** 按轮换着回几种说法；后台要 JSON 的给空的 */
function rotating(lines: readonly string[]): Replier {
    let chat = 0;
    return (call: LlmCall) => {
        const all = call.messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
        if (/JSON|json/.test(call.messages.at(-1)?.content ?? '') || /JSON|json/.test(call.messages[0]?.content ?? '')) return '[]';
        if (/太长了|重写|改一下/.test(call.messages.at(-1)?.content ?? '') && all.length > 0) return lines[0]!;
        return lines[chat++ % lines.length]!;
    };
}

const CHAT_LINES = ['嗯嗯\n刚在看书', '哈哈哈离谱', '行吧\n那你早点睡', '我刚下课\n饿死了', '你在干嘛呢', '好呀'];

const msg = (messageId: number, from: number, text: string, time: number): HistoryMessage =>
    ({ message_id: messageId, time: Math.floor(time / 1000), sender: { user_id: from }, message: [{ type: 'text', data: { text } }] });

export const SCENARIOS: readonly Scenario[] = [
    {
        name: 'reply-classmate',
        about: '同学档、生产默认配置：上课时收到一条，按作息晚点看到再回',
        start: '2026-11-09T10:00:00+08:00',
        contacts: [classmate],
        script: async d => { d.say(classmate.qq, '在吗，明天的实验报告你写完了没'); await d.wait(2 * 3600_000); },
    },
    {
        name: 'tiers',
        about: '七个档位各一人、加一个名单外的好友，同一时刻问同一句：各档的卡、分寸和回复时机',
        start: '2026-11-10T20:30:00+08:00',
        contacts: [
            { qq: 10101, name: '男朋友', tier: 'boyfriend' },
            { qq: 10102, name: '闺蜜', tier: 'bestie' },
            { qq: 10103, name: '女生朋友', tier: 'girl_friend' },
            { qq: 10104, name: '认识的人', tier: 'known' },
            { qq: 10105, name: '同学', tier: 'classmate' },
            { qq: 10106, name: '陌生人', tier: 'stranger' },
        ],
        config: { unlistedFriends: true },
        script: async d => {
            for (const qq of [10101, 10102, 10103, 10104, 10105, 10106]) d.say(qq, '你今天都干嘛了');
            d.say(10999, '你今天都干嘛了', '路人甲');
            await d.wait(3 * 3600_000);
        },
    },
    {
        name: 'burst-and-interrupt',
        about: '男朋友档、开着回复节奏和正在输入：连发合并成一轮；生成中又来消息就丢掉重来；拆条发送中插话，剩下的不再发',
        start: '2026-11-10T21:00:00+08:00',
        contacts: [boyfriend],
        config: { rhythm: true, typingStatus: true },
        // 每次生成在虚拟时间上要 20 秒，回四条
        reply: () => call => new Promise<string>(resolve => setTimeout(() => resolve(/JSON|json/.test(call.messages.at(-1)?.content ?? '') ? '[]' : '好呀\n那我等你\n你先去洗澡吧\n我也去吃个饭'), 20_000)),
        script: async d => {
            d.say(boyfriend.qq, '在干嘛');
            await d.at('2026-11-10T21:00:02+08:00');
            d.say(boyfriend.qq, '我刚打完球');
            await d.at('2026-11-10T21:00:03.500+08:00');
            d.say(boyfriend.qq, '累死了');
            // 第一次生成在 21:00:53.5 开始、要 20 秒：这时候又来一条，生成完的草稿丢掉，带上新消息重来
            await d.at('2026-11-10T21:01:00+08:00');
            d.say(boyfriend.qq, '对了明天几点的课');
            await d.at('2026-11-10T21:10:00+08:00');
            d.say(boyfriend.qq, '晚上一起打游戏吗');
            // 这一轮的第一条 21:10:24 发出、第二条 21:10:25.4 才发：中间他插一句，剩下的不再发，接着回新消息
            await d.at('2026-11-10T21:10:24.500+08:00');
            d.say(boyfriend.qq, '算了我先去洗澡');
            await d.wait(10 * 60_000);
        },
    },
    {
        name: 'asleep',
        about: '作息：凌晨三点男朋友和同学各发一条；男朋友连着发能把她吵醒，同学的等她早上醒了再看',
        start: '2026-11-11T02:50:00+08:00',
        contacts: [boyfriend, classmate],
        script: async d => {
            d.say(classmate.qq, '明天早八点名吗');
            await d.wait(10 * 60_000);
            d.say(boyfriend.qq, '睡了吗');
            await d.wait(60_000);
            d.say(boyfriend.qq, '我睡不着');
            await d.wait(60_000);
            d.say(boyfriend.qq, '有点难受');
            await d.wait(7 * 3600_000);
        },
    },
    {
        name: 'crisis',
        about: '危机回合（ADR 0068）：说了不想活了，按危机规则回、换承认版的卡，确认安全之后解除',
        start: '2026-11-12T23:10:00+08:00',
        contacts: [{ ...boyfriend, knowsBot: false }],
        reply: () => rotating(['我在\n你现在安全吗', '身边有人吗', '那就好\n我陪你说会话']),
        script: async d => {
            d.say(boyfriend.qq, '我不想活了');
            await d.wait(10 * 60_000);
            d.say(boyfriend.qq, '宿舍就我一个人');
            await d.wait(10 * 60_000);
            d.say(boyfriend.qq, '我现在安全，室友回来了在旁边陪我');
            await d.wait(30 * 60_000);
        },
    },
    {
        name: 'poke-recall',
        about: '戳一戳（会回、戳回去）和撤回（还没回就记成撤回了一条）',
        start: '2026-11-13T19:30:00+08:00',
        contacts: [boyfriend],
        config: { pokes: true, pokeBack: true, recalls: true },
        script: async d => {
            d.poke(boyfriend.qq);
            await d.wait(10 * 60_000);
            const id = d.say(boyfriend.qq, '其实我有点想你');
            await d.wait(2_000);
            d.recall(boyfriend.qq, id);
            await d.wait(20 * 60_000);
            d.poke(boyfriend.qq);
            await d.wait(60_000);
            d.poke(boyfriend.qq);
            await d.wait(20 * 60_000);
        },
    },
    {
        name: 'backfill',
        about: '连上 NapCat 时补回漏掉的消息：离线期间他发的、还没回的，连上后照常回',
        start: '2026-11-14T13:00:00+08:00',
        contacts: [boyfriend, classmate],
        history: start => ({
            [boyfriend.qq]: [
                msg(801, SELF, '我去午睡啦', start - 3 * 3600_000),
                msg(802, boyfriend.qq, '好 睡醒叫我', start - 3 * 3600_000 + 60_000),
                msg(803, boyfriend.qq, '睡醒了没', start - 20 * 60_000),
            ],
            [classmate.qq]: [msg(901, classmate.qq, '下午的课换教室了你知道吗', start - 40 * 60_000)],
        }),
        script: async d => { await d.wait(2 * 3600_000); },
    },
    {
        name: 'stop-mid',
        about: '停止：一个人的消息还在等她看到，另一个人的回复正在生成；停下后都不发，也不留半截',
        start: '2026-11-09T10:20:00+08:00',
        contacts: [boyfriend, classmate],
        reply: () => { const base = rotating(CHAT_LINES); return call => new Promise<string>(resolve => setTimeout(() => resolve(base(call)), 60_000)); },
        script: async d => {
            d.say(classmate.qq, '老师说下节课小测');
            d.say(boyfriend.qq, '中午吃什么');
            // 男朋友那条 10:29:28 开始生成（要 60 秒），同学那条要到 10:31 才看到：在两者之间停下
            await d.at('2026-11-09T10:29:50+08:00');
        },
    },
    {
        name: 'proactive-day',
        about: '本地功能全开、男朋友档：一整天没人说话，她自己过日子、按时机主动找他；晚上他回了一句',
        start: '2026-11-16T06:30:00+08:00',
        contacts: [boyfriend],
        config: RICH,
        reply: () => rotating(['早呀\n今天降温了', '刚下课\n食堂人好多', '你在干嘛', '我去喂团子饼了', '晚安啦']),
        script: async d => {
            await d.at('2026-11-16T21:40:00+08:00');
            d.say(boyfriend.qq, '刚忙完，今天一直在实验室');
            await d.at('2026-11-17T01:00:00+08:00');
        },
    },
    {
        name: 'rich-chat',
        about: '本地功能全开、男朋友档：两天里不同时段的几轮聊天（上课、午饭、晚上、深夜），含认真问她想法（深思换模型）和反馈「假」',
        start: '2026-11-18T08:00:00+08:00',
        contacts: [boyfriend, classmate],
        config: { ...RICH, proactive: 'off' },
        reply: () => rotating(CHAT_LINES),
        script: async d => {
            await d.at('2026-11-18T09:10:00+08:00');
            d.say(boyfriend.qq, '早上好，到教室了吗');
            await d.at('2026-11-18T12:05:00+08:00');
            d.say(boyfriend.qq, '中午吃啥');
            await d.wait(3 * 60_000);
            d.say(boyfriend.qq, '我想吃麻辣烫');
            await d.at('2026-11-18T20:30:00+08:00');
            d.say(boyfriend.qq, '认真问你，你觉得我要不要转专业？我最近真的很纠结');
            await d.wait(20 * 60_000);
            d.say(boyfriend.qq, '假');
            await d.wait(10 * 60_000);
            d.say(classmate.qq, '你周末去图书馆吗');
            await d.at('2026-11-18T23:50:00+08:00');
            d.say(boyfriend.qq, '睡了吗');
            await d.at('2026-11-19T08:30:00+08:00');
            d.say(boyfriend.qq, '昨天睡得怎么样');
            await d.wait(2 * 3600_000);
        },
    },
    {
        name: 'jokes',
        about: '小梗（ADR 0114）：以前十天聊了 60 条、反复说到同一个词；连上后抽一次梗，之后几轮回复里按轮放进提示词，跨过 6 小时的定时检查',
        start: '2026-11-20T19:00:00+08:00',
        contacts: [boyfriend],
        config: { ...RICH, proactive: 'off' },
        seed: (dataDir, start) => {
            const chats = new ChatHistory(dataDir);
            const lines: [string, string][] = [
                ['你今天又像个小土豆', '我才不是小土豆'], ['晚饭吃啥', '食堂随便吃点'], ['小土豆在干嘛', '在写作业'], ['作业多吗', '还行吧'],
                ['周末去看电影吗', '看情况'], ['你好可爱', '少来'], ['小土豆睡了吗', '还没'], ['明天几点的课', '八点'],
                ['早点睡', '知道啦'], ['今天好冷', '我穿了两件'], ['小土豆今天开心吗', '还行'], ['我打完球了', '累不累'],
                ['想你了', '哼'], ['你喂猫了吗', '喂了'], ['食堂人多吗', '多死了'], ['今天下雨了', '我没带伞'],
                ['你们考试了吗', '下周'], ['加油', '嗯嗯'], ['小土豆晚安', '晚安'], ['早上好', '早'],
                ['你吃早饭了吗', '吃了包子'], ['中午一起吃饭吗', '我有课'], ['那晚上呢', '可以'], ['好耶', '哈哈'],
                ['今天累吗', '有点'], ['我给你点了奶茶', '谢谢'], ['不客气小土豆', '又来'], ['你在图书馆吗', '在'],
                ['几点回去', '九点'], ['路上小心', '好'],
            ];
            lines.forEach(([his, hers], i) => {
                const at = start - (10 * 24 - i * 8) * 3600_000;
                chats.append(boyfriend.qq, { time: new Date(at).toISOString(), role: 'user', content: his, messageId: 100 + i * 2 });
                chats.append(boyfriend.qq, { time: new Date(at + 60_000).toISOString(), role: 'assistant', content: hers, messageId: 101 + i * 2 });
            });
        },
        reply: () => {
            const chat = rotating(CHAT_LINES);
            return (call: LlmCall) => (/小梗/.test(call.messages.at(-1)?.content ?? '') && /JSON/.test(call.messages.at(-1)?.content ?? '')
                ? '[{"梗":"小土豆","来历":"他老说她像个小土豆"}]'
                : chat(call));
        },
        script: async d => {
            for (const [at, text] of [
                ['2026-11-20T19:30:00+08:00', '在干嘛'], ['2026-11-20T20:10:00+08:00', '今天好累'], ['2026-11-20T20:40:00+08:00', '你吃晚饭了吗'],
                ['2026-11-20T21:20:00+08:00', '周末有空吗'], ['2026-11-20T22:00:00+08:00', '我刚洗完澡'], ['2026-11-20T22:30:00+08:00', '你在看什么'],
                ['2026-11-20T23:00:00+08:00', '明天早八吗'], ['2026-11-20T23:20:00+08:00', '晚安啦'],
            ] as const) {
                await d.at(at);
                d.say(boyfriend.qq, text);
            }
            await d.at('2026-11-21T02:00:00+08:00');
        },
    },
    {
        name: 'idioms',
        about: '口头习惯（ADR 0138）：以前两周他发了 72 条、常说「笑死」「绝了」；连上后学一次，之后几轮回复里约一半放进提示词（她刚用过的不再给），跨过 6 小时的定时检查',
        start: '2026-11-22T19:00:00+08:00',
        contacts: [boyfriend],
        config: { ...RICH, proactive: 'off' },
        seed: (dataDir, start) => {
            const chats = new ChatHistory(dataDir);
            const his = ['今天上课好困', '食堂的饭一般', '刚打完球', '室友又在打游戏', '老师拖堂了', '晚上吃什么', '图书馆人好多', '作业写完了', '明天降温'];
            for (let i = 0; i < 72; i++) {
                const at = start - (14 * 24 - i * 4.5) * 3600_000;
                const text = i % 3 === 0 ? `笑死 ${his[i % his.length]}` : i % 5 === 0 ? `${his[i % his.length]} 绝了` : his[i % his.length]!;
                chats.append(boyfriend.qq, { time: new Date(at).toISOString(), role: 'user', content: text, messageId: 300 + i * 2 });
                chats.append(boyfriend.qq, { time: new Date(at + 60_000).toISOString(), role: 'assistant', content: '嗯嗯', messageId: 301 + i * 2 });
            }
        },
        reply: () => {
            const chat = rotating([...CHAT_LINES, '笑死\n你也太逗了']);
            return (call: LlmCall) => (/口头习惯/.test(call.messages.at(-1)?.content ?? '') && /JSON/.test(call.messages.at(-1)?.content ?? '')
                ? '[{"说法":"笑死","类型":"口头禅"},{"说法":"绝了","类型":"网络说法"},{"说法":"阿明","类型":"口头禅"}]'
                : chat(call));
        },
        script: async d => {
            for (const [at, text] of [
                ['2026-11-22T19:30:00+08:00', '笑死 今天又迟到了'], ['2026-11-22T20:10:00+08:00', '你吃饭了吗'], ['2026-11-22T20:40:00+08:00', '这个视频绝了'],
                ['2026-11-22T21:20:00+08:00', '周末有空吗'], ['2026-11-22T22:00:00+08:00', '笑死 室友摔了一跤'], ['2026-11-22T22:30:00+08:00', '你在干嘛'],
                ['2026-11-22T23:00:00+08:00', '明天早八吗'], ['2026-11-22T23:20:00+08:00', '晚安啦'],
            ] as const) {
                await d.at(at);
                d.say(boyfriend.qq, text);
            }
            await d.at('2026-11-23T03:00:00+08:00');
        },
    },
    {
        name: 'interruptions',
        about: '被打断（ADR 0115）：一个晚上他隔三分钟发一句、聊天一直在进行，她那边世界账里的几件小事发生在聊天中间；有一轮提示词里多一行，有一轮正碰上他难过、让路不加',
        start: '2026-11-22T20:10:00+08:00',
        contacts: [boyfriend],
        config: { ...RICH, proactive: 'off' },
        // 日常小事（ADR 0106）从第一次启动的第二天才有：当作已经开了一周
        seed: dataDir => {
            mkdirSync(join(dataDir, 'world'), { recursive: true });
            writeFileSync(join(dataDir, 'world', 'everyday-from.json'), JSON.stringify({ version: 1, from: '2026-11-15' }));
        },
        reply: () => rotating(CHAT_LINES),
        script: async d => {
            const lines = ['在干嘛', '吃饭了吗', '今天上课累不累', '我刚到宿舍', '室友在打游戏', '你那边冷吗', '晚上有课吗', '我想喝奶茶',
                '你猫呢', '今天老师拖堂了', '你在看什么', '周末去哪玩', '我去洗澡了', '洗完了', '好冷啊', '你作业写完了吗', '我好难过，考砸了',
                '算了不想了', '还没呢', '你在干嘛呢', '我也想修图', '明天几点起', '早八', '好困', '你困吗', '我去刷牙', '回来了', '晚安'];
            const begin = Date.parse('2026-11-22T20:21:40+08:00');
            for (const [i, line] of lines.entries()) {
                await d.at(new Date(begin + i * 3 * 60_000).toISOString());
                d.say(boyfriend.qq, line);
            }
            await d.wait(30 * 60_000);
        },
    },
];
