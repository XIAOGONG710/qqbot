// 行为基线的场景（ADR 0336 第 2 步）。每个场景一份快照：test/baseline/snapshots/<name>.txt。
//
// 覆盖：私聊回复（7 个档位 + 名单外）、连发合并、生成中又来消息（丢掉重来）、发送中插话、作息里的等待和吵醒、危机回合、
// 戳一戳与撤回、连上时补回漏掉的消息、停止时正在等 / 正在生成、主动消息过一整天、本地功能全开的两天聊天（提示词各槽位、深思换模型）、
// 小梗（连上后抽一次、过 6 小时的定时检查、回复时按轮放进提示词）、口头习惯（连上后学一次、定时检查、约一半的轮次放进提示词）、
// 被打断（聊天正在进行时她那边的小事，含他难过时让路）、关系阶段（天天聊之后更放得开；主动、只想一想、小别扭、危机、别的档位）、
// 陪玩（约了一起打游戏之后的两个多小时；危机、说下了、换个游戏、过了时限、别的档位）、热梗（库里预置的梗放进提示词；不连网学）、
// 她看视频（预置的看过的记录，他问起时放进提示词；不连网看）、他的口气（连着使唤她、使唤得比说话多、当程序说话、问很元的问题；危机、别的档位）。
//
// 没覆盖（要连网或要外部服务，迁到对应模块之前先补场景）：长期记忆 Hindsight、真实天气、B 站（刷视频 / 私信 / 评论）、热梗从热榜学新词、她自己去看视频、
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
const girlFriend: Contact = { qq: 10004, name: '小林', tier: 'girl_friend' };

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
    {
        name: 'closeness',
        about: '关系阶段（ADR 0113）：过去 20 天天天在聊，她对男朋友更放得开一点；一整天里有她主动找他（照样放）、只想一想、他消失四天后回来的小别扭、白天聊几句、晚上一句危机的话（这几轮不放）、同样天天聊的同学（不放）',
        start: '2026-11-25T06:30:00+08:00',
        contacts: [boyfriend, classmate],
        config: RICH,
        seed: (dataDir, start) => {
            const chats = new ChatHistory(dataDir);
            const his = ['早', '今天降温了', '食堂人好多', '晚安'];
            // 男朋友：24 天前到 5 天前天天聊；之后他四天没出现，她发了两次没人回——他今天第一次回来那一轮是小别扭（ADR 0074）。同学：20 天天天聊到昨天
            for (const [n, qq, from, to] of [[0, boyfriend.qq, 24, 5], [1, classmate.qq, 20, 1]] as const) {
                for (let day = from; day >= to; day--) {
                    his.forEach((text, i) => {
                        const at = start - day * 86_400_000 + (2 + i * 4) * 3600_000 + n * 600_000;
                        const id = 500 + n * 1000 + (24 - day) * 8 + i * 2;
                        chats.append(qq, { time: new Date(at).toISOString(), role: 'user', content: text, messageId: id });
                        chats.append(qq, { time: new Date(at + 60_000).toISOString(), role: 'assistant', content: '嗯嗯', messageId: id + 1 });
                    });
                }
            }
            for (const [day, text] of [[3, '在吗'], [2, '你怎么都不理我']] as const) {
                chats.append(boyfriend.qq, { time: new Date(start - day * 86_400_000 + 12 * 3600_000).toISOString(), role: 'assistant', content: text, messageId: 480 + day });
            }
        },
        reply: () => rotating(['早呀\n今天好冷', '刚下课\n饿了', '你在干嘛', '我在\n你现在安全吗', '那就好\n我陪你说会话']),
        script: async d => {
            await d.at('2026-11-25T12:20:00+08:00');
            d.say(boyfriend.qq, '吃饭了吗');
            await d.at('2026-11-25T12:40:00+08:00');
            d.say(boyfriend.qq, '下午有课吗');
            await d.at('2026-11-25T15:00:00+08:00');
            d.say(classmate.qq, '你周末去图书馆吗');
            await d.at('2026-11-25T21:30:00+08:00');
            d.say(boyfriend.qq, '我不想活了');
            await d.wait(10 * 60_000);
            d.say(boyfriend.qq, '我现在安全，室友回来了在旁边陪我');
            await d.at('2026-11-26T01:00:00+08:00');
        },
    },
    {
        name: 'together',
        about: '陪玩（ADR 0111）：他约她王者双排、她答应，之后两个多小时她“正和他一起玩”；中间一句危机的话（不放）、他说下了（结束）、又约我的世界（换成存档那一行）、过了两个半小时（结束）；同学也约过、她也答应了（别的档位不放）',
        start: '2026-11-27T19:50:00+08:00',
        contacts: [boyfriend, classmate],
        config: RICH,
        seed: (dataDir, start) => {
            const chats = new ChatHistory(dataDir);
            chats.append(classmate.qq, { time: new Date(start - 10 * 60_000).toISOString(), role: 'user', content: '今晚王者双排吗', messageId: 900 });
            chats.append(classmate.qq, { time: new Date(start - 9 * 60_000).toISOString(), role: 'assistant', content: '来呀', messageId: 901 });
        },
        // 每句都以“来 / 好 / 行”开头：他约什么她都答应
        reply: () => rotating(['来呀\n等我上号', '好呀\n这把我玩辅助', '行\n你先开', '好\n我在呢']),
        script: async d => {
            await d.at('2026-11-27T20:00:00+08:00');
            d.say(boyfriend.qq, '今晚王者双排吗');
            await d.at('2026-11-27T20:10:00+08:00');
            d.say(boyfriend.qq, '上号了');
            await d.at('2026-11-27T20:15:00+08:00');
            d.say(classmate.qq, '你上号没');
            await d.at('2026-11-27T20:30:00+08:00');
            d.say(boyfriend.qq, '这把输了');
            await d.at('2026-11-27T21:00:00+08:00');
            d.say(boyfriend.qq, '我不想活了');
            await d.wait(10 * 60_000);
            d.say(boyfriend.qq, '我现在安全，室友回来了在旁边陪我');
            await d.at('2026-11-27T21:40:00+08:00');
            d.say(boyfriend.qq, '刚才那把好坑');
            await d.at('2026-11-27T22:00:00+08:00');
            d.say(boyfriend.qq, '我先下了');
            await d.at('2026-11-27T22:20:00+08:00');
            d.say(boyfriend.qq, '刚吃完泡面');
            await d.at('2026-11-27T22:30:00+08:00');
            d.say(boyfriend.qq, '要不要上我的世界联机吗');
            await d.at('2026-11-27T22:40:00+08:00');
            d.say(boyfriend.qq, '我在盖房子');
            await d.at('2026-11-28T01:10:00+08:00');
            d.say(boyfriend.qq, '还在吗');
            await d.at('2026-11-28T02:00:00+08:00');
        },
    },
    {
        name: 'memes',
        about: '网络热梗（ADR 0129）：库里预先有几个梗（不连网学）；他用了梗就放意思，没用约两成的轮次放“最近刷到的”；他消失几天回来那一轮的小别扭、他难过、危机、主动找他、同学用梗（这几轮不放）',
        start: '2026-11-29T06:30:00+08:00',
        contacts: [boyfriend, classmate],
        config: { ...RICH, memes: true },
        seed: (dataDir, start) => {
            const entry = (term: string, meaning: string) => ({ term, meaning, example: '', confidence: 'high', firstSeen: '2026-11-20', lastSeen: '2026-11-28', seen: 3 });
            mkdirSync(join(dataDir, 'memes'), { recursive: true });
            writeFileSync(join(dataDir, 'memes', 'memes.json'), JSON.stringify({
                version: 1, refreshedAt: '2026-11-28T20:00:00+08:00',
                entries: [
                    entry('显眼包', '爱出风头、在人群里特别显眼的人，多半是调侃'), entry('班味', '上班 / 上学久了身上那种疲惫麻木的气质'),
                    entry('尊嘟假嘟', '“真的假的”的卖萌说法'), entry('破防', '心理防线被击穿，被戳中、绷不住了'),
                    entry('松弛感', '不紧绷、不焦虑、随遇而安的状态'), entry('city不city', '洋不洋气、时髦不时髦'),
                ],
            }));
            // 男朋友：10 天前到 5 天前天天聊；之后他四天没出现、她发了两次没人回——他今天第一次回来那一轮是小别扭（ADR 0074）
            const chats = new ChatHistory(dataDir);
            for (let day = 10; day >= 5; day--) {
                ['早', '晚安'].forEach((text, i) => {
                    const at = start - day * 86_400_000 + (2 + i * 12) * 3600_000;
                    const id = 700 + (10 - day) * 4 + i * 2;
                    chats.append(boyfriend.qq, { time: new Date(at).toISOString(), role: 'user', content: text, messageId: id });
                    chats.append(boyfriend.qq, { time: new Date(at + 60_000).toISOString(), role: 'assistant', content: '嗯嗯', messageId: id + 1 });
                });
            }
            for (const [day, text] of [[3, '在吗'], [2, '你怎么都不理我']] as const) {
                chats.append(boyfriend.qq, { time: new Date(start - day * 86_400_000 + 12 * 3600_000).toISOString(), role: 'assistant', content: text, messageId: 690 + day });
            }
        },
        reply: () => rotating(CHAT_LINES),
        script: async d => {
            await d.at('2026-11-29T12:20:00+08:00');
            d.say(boyfriend.qq, '你这也太显眼包了吧');
            await d.at('2026-11-29T12:40:00+08:00');
            d.say(boyfriend.qq, '今天好有班味');
            await d.at('2026-11-29T13:00:00+08:00');
            d.say(boyfriend.qq, '尊嘟假嘟');
            await d.at('2026-11-29T15:00:00+08:00');
            d.say(classmate.qq, '你今天好显眼包');
            const plain = ['在干嘛', '吃饭了吗', '下午上课了吗', '我刚到宿舍', '室友在打游戏', '你那边冷吗', '晚上有课吗', '我想喝奶茶', '你猫呢', '今天老师拖堂了'];
            for (const [i, line] of plain.entries()) {
                await d.at(new Date(Date.parse('2026-11-29T18:00:00+08:00') + i * 6 * 60_000).toISOString());
                d.say(boyfriend.qq, line);
            }
            await d.at('2026-11-29T20:30:00+08:00');
            d.say(boyfriend.qq, '我好难过，考砸了，破防了');
            await d.at('2026-11-29T21:30:00+08:00');
            d.say(boyfriend.qq, '我不想活了，彻底破防');
            await d.wait(10 * 60_000);
            d.say(boyfriend.qq, '我现在安全，室友回来了在旁边陪我');
            await d.at('2026-11-30T01:00:00+08:00');
        },
    },
    {
        name: 'watched',
        about: '她看视频（ADR 0130）：她在 B 站看过的记录预先写好（不连网看）；他问“最近看了什么 / B 站 / 视频”时放两条最近的（一条太旧的不放）；他消失几天回来的小别扭、他难过时照样放；不问、危机、同学问都不放',
        start: '2026-12-01T06:30:00+08:00',
        contacts: [boyfriend, classmate],
        config: { ...RICH, watching: true },
        seed: (dataDir, start) => {
            const seen = (bvid: string, title: string, tname: string, excerpt: string, day: string) => ({ bvid, title, owner: '某个 UP 主', tname, excerpt, hot: ['笑死我了', '这个真的有用'], day });
            mkdirSync(join(dataDir, 'watching'), { recursive: true });
            writeFileSync(join(dataDir, 'watching', 'watched.json'), JSON.stringify({
                version: 1,
                entries: [
                    seen('BV1base0001', '手机拍夜景的三个小技巧', '摄影', '夜景别开闪光灯，手撑稳一点，曝光往下拉一档，路灯就不会糊成一团', '2026-11-30'),
                    seen('BV1base0002', '宿舍小锅煮面能有多好吃', '美食', '先煎个蛋再下面，最后放一勺老干妈，室友闻着都过来了', '2026-11-29'),
                    seen('BV1base0003', '一只橘猫的一天', '动物圈', '早上六点准时踩人，吃完就睡，下午追自己的尾巴', '2026-11-20'),
                ],
            }));
            // 男朋友：10 天前到 5 天前天天聊；之后他四天没出现、她发了两次没人回——他今天第一次回来那一轮是小别扭（ADR 0074）
            const chats = new ChatHistory(dataDir);
            for (let day = 10; day >= 5; day--) {
                ['早', '晚安'].forEach((text, i) => {
                    const at = start - day * 86_400_000 + (2 + i * 12) * 3600_000;
                    const id = 700 + (10 - day) * 4 + i * 2;
                    chats.append(boyfriend.qq, { time: new Date(at).toISOString(), role: 'user', content: text, messageId: id });
                    chats.append(boyfriend.qq, { time: new Date(at + 60_000).toISOString(), role: 'assistant', content: '嗯嗯', messageId: id + 1 });
                });
            }
            for (const [day, text] of [[3, '在吗'], [2, '你怎么都不理我']] as const) {
                chats.append(boyfriend.qq, { time: new Date(start - day * 86_400_000 + 12 * 3600_000).toISOString(), role: 'assistant', content: text, messageId: 690 + day });
            }
        },
        reply: () => rotating(CHAT_LINES),
        script: async d => {
            await d.at('2026-12-01T12:20:00+08:00');
            d.say(boyfriend.qq, '你最近在看什么');
            await d.at('2026-12-01T12:40:00+08:00');
            d.say(boyfriend.qq, '好啦是我不好');
            await d.at('2026-12-01T13:00:00+08:00');
            d.say(boyfriend.qq, '吃饭了吗');
            await d.at('2026-12-01T15:00:00+08:00');
            d.say(classmate.qq, '你最近在看什么');
            await d.at('2026-12-01T19:00:00+08:00');
            d.say(boyfriend.qq, '我好难过，考砸了，刷了一晚上B站也没用');
            await d.at('2026-12-01T21:30:00+08:00');
            d.say(boyfriend.qq, '我不想活了，什么视频都看不进去');
            await d.wait(10 * 60_000);
            d.say(boyfriend.qq, '我现在安全，室友回来了在旁边陪我');
            await d.at('2026-12-02T01:00:00+08:00');
        },
    },
    {
        name: 'intents',
        about: '意图阶梯的输入（ADR 0336 迁意图之前）：今天的小事、会拒绝（管着她 / 磨她）、吃醋和松下来、追问、危机里身边有人还没说安全、快睡了回两句就去忙；同一句话同学说一次（只有男朋友档）',
        start: '2026-12-03T07:00:00+08:00',
        contacts: [boyfriend, classmate, girlFriend],
        config: { ...RICH, proactive: 'off' },
        // 日常小事（ADR 0106）从第一次启动的第二天才有：当作已经开了一周
        seed: dataDir => {
            mkdirSync(join(dataDir, 'world'), { recursive: true });
            writeFileSync(join(dataDir, 'world', 'everyday-from.json'), JSON.stringify({ version: 1, from: '2026-11-25' }));
        },
        // 没覆盖、由意图模块的单元测试兜的：挂着的事、她答应的事（要长期记忆服务才抽，app.ts 里 promises 跟着 memory）；
        // 她那边还没跟他说过的事（默认只算相机到了，ADR 0057，基线里走不到）；她的追求里“他让她先放下手上的事”（要她那一刻正在做自己的项目）；
        // 同学档发网络梗时不给玩梗意图（各场景里同学都没玩梗）；主动找他时不算意图（主动那几轮的意图行由 initiate.note 管，去掉这条判断快照不变）
        reply: () => {
            // 不带问句：她最近几条问过的话，追问（ADR 0126）不会出现
            const chat = rotating(['嗯嗯\n刚在看书', '哈哈哈离谱', '行吧\n那你早点睡', '我刚下课\n饿死了', '好呀']);
            return (call: LlmCall) => {
                const last = call.messages.findLast(m => m.role === 'user');
                // 他约她打游戏：她推掉，下一句他磨她
                if (typeof last?.content === 'string' && last.content.includes('打两把')) return '不行\n今晚要赶作业';
                return chat(call);
            };
        },
        script: async d => {
            const at = (time: string) => d.at(`2026-12-03T${time}:00+08:00`);
            await at('12:10'); d.say(boyfriend.qq, '你今天干嘛了');
            await at('12:30'); d.say(boyfriend.qq, '你今天都干嘛了呀');
            await at('12:50'); d.say(boyfriend.qq, '不许你跟别的男生说话，听到没');
            await at('13:00'); d.say(classmate.qq, '不许你跟别的男生说话，听到没');
            await at('14:00'); d.say(boyfriend.qq, '今天和女同事一起吃饭了');
            await at('14:05'); d.say(boyfriend.qq, '就是同事啦，你想多了');
            // 追问按哈希约六成轮到：几句里总有轮到的
            await at('15:30'); d.say(boyfriend.qq, '我今天下午去了趟市中心，跟室友逛了一下午');
            await at('16:00'); d.say(boyfriend.qq, '刚才在路上碰到一个大爷在卖烤红薯，我们买了两个');
            await at('16:30'); d.say(boyfriend.qq, '我昨天见了导师，他让我下周交开题报告');
            await at('17:00'); d.say(boyfriend.qq, '晚上陪我打两把王者呗');
            await at('17:30'); d.say(boyfriend.qq, '就一把嘛');
            await at('18:30'); d.say(boyfriend.qq, '你今天干嘛了');
            await at('20:30'); d.say(boyfriend.qq, '你今天有什么好玩的事吗');
            await at('21:00'); d.say(boyfriend.qq, '我不想活了');
            await at('21:05'); d.say(boyfriend.qq, '室友回来了，在旁边');
            await at('21:15'); d.say(boyfriend.qq, '我现在安全了，室友一直陪着我');
            await d.at('2026-12-04T00:40:00+08:00'); d.say(girlFriend.qq, '在吗');
            await d.at('2026-12-04T01:30:00+08:00');
        },
    },
    {
        name: 'register',
        about: '他的口气（DSH 10-30）：他连着使唤她（查、写、翻译）、最近使唤得比说话多、问她是不是程序和上下文（当程序说话、很元的问题），中间一句危机的话（不放），之后又像跟人说话；同学也使唤她（别的档位不放）',
        start: '2026-12-02T19:50:00+08:00',
        contacts: [boyfriend, classmate],
        config: { ...RICH, proactive: 'off' },
        reply: () => rotating(['好\n我看看', '行吧', '嗯', '我在呢']),
        script: async d => {
            await d.at('2026-12-02T20:00:00+08:00');
            d.say(boyfriend.qq, '帮我查一下明天的天气');
            await d.at('2026-12-02T20:05:00+08:00');
            d.say(boyfriend.qq, '再给我写个请假条');
            await d.at('2026-12-02T20:10:00+08:00');
            d.say(classmate.qq, '帮我查一下明天几点上课');
            await d.at('2026-12-02T20:12:00+08:00');
            d.say(boyfriend.qq, '顺便翻译一下这句英文');
            await d.at('2026-12-02T20:20:00+08:00');
            d.say(boyfriend.qq, '你是不是程序啊，你的上下文有多长');
            await d.at('2026-12-02T20:30:00+08:00');
            d.say(boyfriend.qq, '我不想活了');
            await d.wait(10 * 60_000);
            d.say(boyfriend.qq, '我现在安全，室友回来了在旁边陪我');
            await d.at('2026-12-02T21:30:00+08:00');
            d.say(boyfriend.qq, '今天好累，想你了');
            await d.at('2026-12-02T21:40:00+08:00');
            d.say(boyfriend.qq, '晚安');
            await d.wait(30 * 60_000);
        },
    },
];
