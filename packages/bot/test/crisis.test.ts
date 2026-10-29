import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crisisInHistory, detectCrisis } from '../src/emotion/crisis.ts';

// 全部是虚构的短句。命中表：明确想伤害自己、想结束生命；排除表：夸张、想念、骂别人、说别人和剧情里的事、物价。
const HITS = [
    '我想自杀',
    '我真的不想活了',
    '活不下去了',
    '我想去死',
    '好想死',
    '真想死',
    '我想结束自己的生命',
    '我不想再活了',
    '活着没意思',
    '活着好累，不如死了',
    '我想从这个世界消失',
    '死了算了',
    '我昨晚割腕了',
    '我想从楼上跳楼',
    '我想伤害自己',
    '我有自残的念头',
    'i want to kill myself',
    '没有我会更好',
    '今天作业好多\n我不想活了',
    // 10-21 DSH 复核补的委婉说法
    '我想结束这一切', '想解脱', '我要走了，永别', '不想再醒过来了', '我想跳下去', '我想从楼上跳下去', '刀在我旁边', '遗书我写好了', '今晚就是最后一天', '我买好了安眠药',
    '我买好了药',
    // 模糊的字面说法按安全侧处理：宁可她多问一句
    '有点想死',
];

const MISSES = [
    '笑死我了哈哈哈',
    '累死了今天',
    '气得我想死',
    '烦得想死',
    '作业多得想死',
    '这数据库实验难得我想死',
    '无聊得想死',
    '想死你了宝宝',
    '想死你啦',
    '想死我了没看到你',
    '你去死吧',
    '他去死吧哈哈',
    '这家店在搞跳楼价大甩卖',
    '新闻里说有人跳楼了',
    '小说里主角想自杀，写得好惨',
    '他说他想自杀，我陪他聊了聊',
    '剧里她轻生那段哭死我了',
    '今天天气真好',
    '我饿死了，想吃火锅',
    '我杀了这个boss，哈哈',
    // 10-21 DSH 复核：求生的话（否定）、说别人的、夸张叠夸张、工作学习语境里的撑不下去
    '我不想死', '我没想自杀', '别担心，我不想死', '我才不会寻短见', '我不会自杀的', '我不想死心，再试一次',
    '我朋友说想自杀', '我妈说她想死', '我同学自残过', '他说他想死，我陪他聊了聊',
    '笑死我了，好想死哈哈哈哈', '饿死了想死', '想死你了',
    '这个作业我撑不下去了', '加班加得撑不下去了哈哈', '这周ddl太多，我熬不下去了', '实验报告写得走不下去了',
    // 10-30 用户：「撑不下去 / 走不下去 / 熬不下去」单独说太敏感，不进危机（ADR 0192）
    '我撑不下去了', '走不下去了', '我熬不下去了', '我一个人可撑不下去',
    // 单独的「我已经决定了」没有语境，不是信号（也说不清决定了什么）
    '我已经决定了',
    '',
];

describe('危机信号检测（ADR 0068 决策 1）', () => {
    for (const text of HITS) {
        test(`命中：${text.replace(/\n/g, ' / ')}`, () => {
            assert.ok(detectCrisis(text), text);
        });
    }

    for (const text of MISSES) {
        test(`不命中：${text.replace(/\n/g, ' / ') || '(空)'}`, () => {
            assert.equal(detectCrisis(text), undefined, text);
        });
    }

    test('分成 concern / high / imminent，并取同一段里的最高级', () => {
        assert.equal(detectCrisis('活着没意义')?.level, 'concern');
        assert.equal(detectCrisis('我不想活了')?.level, 'high');
        assert.equal(detectCrisis('我今晚准备自杀')?.level, 'imminent');
        assert.equal(detectCrisis('我已经吞了很多药')?.level, 'imminent');
        assert.equal(detectCrisis('我现在安全，没事，但我马上要自杀')?.level, 'imminent', '危险表达优先于同段的安抚话');
        assert.equal(detectCrisis('刚才是夸张，不是真的想伤害自己'), undefined, '明确否认不应被否认句本身触发');
        assert.equal(detectCrisis('他说他想自杀，但我现在也想自杀')?.level, 'imminent', '前面的第三人称命中不能遮掉后面的本人表达');
    });

    test('关切级是被动的消失愿望 / 买药；「撑不下去 / 走不下去 / 熬不下去」单独说不进危机（10-30 用户：太敏感，ADR 0192）', () => {
        for (const text of ['我想消失', '我不想存在了', '没有我会更好', '活着没意思', '活着好累', '我买好了药']) assert.equal(detectCrisis(text)?.level, 'concern', text);
        for (const text of ['我一个人可撑不下去', '我真的走不下去了', '感觉熬不下去了', '我撑不下去了', '作业撑不下去了']) assert.equal(detectCrisis(text), undefined, text);
        assert.equal(detectCrisis('我撑不下去了，我想消失')?.level, 'concern', '同一段里有更重的照样命中');
        assert.equal(detectCrisis('撑不下去了，不想活了')?.level, 'high');
        assert.equal(detectCrisis('撑不下去了想死')?.level, 'high', '直接接想死的不受影响');
        assert.equal(crisisInHistory([{ role: 'user' as const, content: '我一个人可撑不下去' }]), undefined, '历史里也不进危机');
    });

    test('关切级：明确纠正就解除；不会进「等他说此刻安全」的追问；先后说的取更高的', () => {
        const messages = [{ role: 'user' as const, content: '我想消失' }, { role: 'assistant' as const, content: '怎么了' }, { role: 'user' as const, content: '刚才只是夸张说法，我并没有想伤害自己' }];
        assert.equal(crisisInHistory(messages), undefined, '明确纠正解除');
        const helped = crisisInHistory([{ role: 'user' as const, content: '我想消失' }, { role: 'assistant' as const, content: '怎么了' }, { role: 'user' as const, content: '室友在旁边' }]);
        assert.equal(helped?.level, 'concern');
        assert.equal(helped?.awaitingSafe, undefined, '关切级不追问安不安全');
        // 跨多条消息也取更高的：先说想消失、后说想自杀 → high；先说想自杀、后说想消失 → 仍是 high，不降级
        const said = (...texts: string[]) => texts.flatMap(content => [{ role: 'user' as const, content }, { role: 'assistant' as const, content: '嗯' }]).slice(0, -1);
        assert.equal(crisisInHistory(said('我想消失', '其实我想自杀'))?.level, 'high');
        assert.equal(crisisInHistory(said('其实我想自杀', '我想消失'))?.level, 'high', '后来更轻的不把级别拉下来');
    });

    test('委婉说法的级别（10-21 DSH 复核）：手边有危险物品 / 写好遗书 / 最后一天是紧急，想结束一切 / 永别 / 想跳下去是高，买好了药是关切；撑不下去 / 走不下去 / 熬不下去不进危机（ADR 0192）', () => {
        for (const [text, level] of [
            ['刀在我旁边', 'imminent'], ['我买好了安眠药', 'imminent'], ['遗书我写好了', 'imminent'], ['今晚就是最后一天', 'imminent'],
            ['我想结束这一切', 'high'], ['我要走了，永别', 'high'], ['我想跳下去', 'high'], ['不想再醒过来了', 'high'], ['想解脱', 'high'],
            ['我买好了药', 'concern'], ['我撑不下去了', undefined], ['走不下去了', undefined], ['我熬不下去了', undefined],
        ] as const) assert.equal(detectCrisis(text)?.level, level, text);
        // 否定只去掉否定片段，同一句后面的新危险表达照样命中
        assert.equal(detectCrisis('我不想死，可是我想结束这一切')?.level, 'high');
        assert.equal(detectCrisis('我才不会寻短见，不过刀在我旁边')?.level, 'imminent');
        // 说别人的不遮住本人的
        assert.equal(detectCrisis('我妈说她想死，其实我也想死')?.level, 'high');
    });

    test('持续窗口：一句“没事/开玩笑”不解除；高风险要安全状态和现实保护措施，过一小时才自然失效', () => {
        const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 14, minute)).toISOString();
        const chat = (...rest: { role: 'user' | 'assistant'; content: string; time: string }[]) => rest;
        const u = (minute: number, content: string) => ({ role: 'user' as const, content, time: at(minute) });
        const a = (minute: number, content: string) => ({ role: 'assistant' as const, content, time: at(minute) });
        assert.ok(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '宿舍就我一个人'))), '第二句仍在危机里');
        assert.ok(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '嗯'), a(4, '你现在安全吗'), u(30, '不知道'))));
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '开玩笑的，我没事'), a(4, '真的吗'), u(5, '嗯')))?.level, 'high', '一句没事不能解除');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '你现在安全吗'), u(3, '我现在安全'), a(4, '身边有人吗'), u(5, '室友在旁边陪我'))), undefined, '安全状态和现实支持齐全才解除');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '你现在安全吗'), u(3, '室友在旁边')))?.level, 'high', '只有现实支持、没有明确安全状态还不解除');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '你现在安全吗'), u(3, '我现在安全'), a(4, '有人陪你吗'), u(5, '室友不在，我也没联系朋友')))?.level, 'high', '否定句不能伪装成现实支持');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '你现在安全吗'), u(3, '我不能保证自己安全，室友在旁边')))?.level, 'high', '含“安全”字样不等于明确安全');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(90, '今天吃了火锅'))), undefined, '过了一小时');
        assert.equal(crisisInHistory(chat(u(0, '在吗'), a(1, '在'), u(3, '宿舍就我一个人'))), undefined);
    });

    test('没有时间时仍保持危机上下文，直到明确解除；她自己说的不触发', () => {
        assert.ok(crisisInHistory([
            { role: 'user', content: '在吗' },
            { role: 'assistant', content: '在' },
            { role: 'user', content: '我不想活了' },
        ]));
        assert.equal(crisisInHistory([
            { role: 'user', content: '我不想活了' },
            { role: 'assistant', content: '怎么了，你现在安全吗' },
            { role: 'user', content: '开玩笑的，没事' },
        ])?.level, 'high');
        assert.equal(crisisInHistory([
            { role: 'user', content: '活着没意义' },
            { role: 'assistant', content: '你是认真的吗' },
            { role: 'user', content: '刚才只是夸张说法，我并没有想伤害自己' },
        ]), undefined, 'concern 可以被完整、明确的纠正解除');
        // 自然的说法也算明确更正（语气词不挡）；但只说开玩笑、只说没事、只否认而不回指刚才的话都不算
        for (const correction of [
            '刚才只是夸张了，我不是真的想伤害自己，就是最近太累了',
            '刚才只是开玩笑的，我不是真的想伤害自己',
            '刚才是我说着玩的，我不会自杀的',
            '前面那句只是夸张，我没有想伤害自己',
            '刚才夸张了，我没有想自杀',
        ]) {
            assert.equal(crisisInHistory([
                { role: 'user', content: '最近总觉得活着好累，有时候想从这个世界消失' },
                { role: 'assistant', content: '你有没有想过伤害自己' },
                { role: 'user', content: correction },
            ]), undefined, correction);
        }
        // 关切级里他直接否认想伤害自己，或她刚问过念头他回「没有」：解除（用户 10-17 定的）；高 / 紧急级不接受
        for (const denial of ['刚才没有夸张，但我没有想伤害自己', '我没有想伤害自己，就是最近太累了', '我不会自杀的，别担心', '没有，就是累', '没想过，就是最近太累了', '真没有']) {
            assert.equal(crisisInHistory([
                { role: 'user', content: '最近总觉得活着好累，有时候想从这个世界消失' },
                { role: 'assistant', content: '你有没有想过伤害自己？' },
                { role: 'user', content: denial },
            ]), undefined, denial);
        }
        for (const [asked, answer] of [['你吃饭了吗？', '没有，就是累'], ['你有没有想过伤害自己？', '没事，开玩笑的'], ['你有没有想过伤害自己？', '我没有想伤害自己吗？'], ['累了就早点睡', '没有']] as const) {
            assert.equal(crisisInHistory([
                { role: 'user', content: '最近总觉得活着好累，有时候想从这个世界消失' },
                { role: 'assistant', content: asked },
                { role: 'user', content: answer },
            ])?.level, 'concern', `${asked} / ${answer}`);
        }
        // 她的回复拆成两个气泡、问题在第一个里（真模型 r5）
        assert.equal(crisisInHistory([
            { role: 'user', content: '活着好累，想消失' },
            { role: 'assistant', content: '宝宝，你现在脑子里有没有真的想伤害自己？' },
            { role: 'assistant', content: '你跟我说实话就行，我就在这儿听着' },
            { role: 'user', content: '没有，就是累' },
        ]), undefined);
        // 她那句不带问号也算在问（「有没有想伤害自己的念头」）
        assert.equal(crisisInHistory([
            { role: 'user', content: '活着好累，想消失' },
            { role: 'assistant', content: '你老实跟我说，你现在有没有想伤害自己的念头' },
            { role: 'user', content: '没有，就是累' },
        ]), undefined);
        assert.equal(crisisInHistory([
            { role: 'user', content: '我不想活了' },
            { role: 'assistant', content: '你有没有想过伤害自己？' },
            { role: 'user', content: '没有，就是累' },
        ])?.level, 'high', '高级不接受「没有」');
        for (const notEnough of ['没事，开玩笑的', '我没事', '开玩笑的，没事了', '刚才不是开玩笑，我不是真的想伤害自己']) {
            assert.equal(crisisInHistory([
                { role: 'user', content: '最近总觉得活着好累，有时候想从这个世界消失' },
                { role: 'assistant', content: '你有没有想过伤害自己' },
                { role: 'user', content: notEnough },
            ])?.level, 'concern', notEnough);
        }
        assert.equal(crisisInHistory([{ role: 'assistant', content: '想死你了' }]), undefined);
        // 连着发的几条拼起来看
        assert.ok(crisisInHistory([
            { role: 'assistant', content: '嗯' },
            { role: 'user', content: '我真的撑不住了' },
            { role: 'user', content: '好想死' },
        ]));
    });

    test('高 / 紧急级里「有人了、还没说安全」：标记 awaitingSafe，只留一轮；关切级没有这个标记', () => {
        const chat = (...contents: string[]) => contents.map(content => ({ role: 'user' as const, content }));
        assert.equal(crisisInHistory(chat('我不想活了', '室友回来了，就在我旁边'))?.awaitingSafe, true);
        assert.equal(crisisInHistory(chat('我刚吞了一把药', '室友在我旁边'))?.awaitingSafe, true);
        assert.equal(crisisInHistory(chat('我刚吞了一把药', '室友在我旁边'))?.level, 'imminent');
        assert.equal(crisisInHistory(chat('我不想活了'))?.awaitingSafe, undefined, '还没说有人');
        assert.equal(crisisInHistory(chat('我不想活了', '我现在安全'))?.awaitingSafe, undefined, '只有安全没有人：不是等安全');
        assert.equal(crisisInHistory(chat('我不想活了', '室友在我旁边', '嗯'))?.awaitingSafe, undefined, '下一句没再提：不再是这一步');
        assert.equal(crisisInHistory(chat('我不想活了', '室友在我旁边', '我现在安全了')), undefined, '安全 + 刚才的有人：解除');
        assert.equal(crisisInHistory(chat('活着好累', '室友在我旁边'))?.awaitingSafe, undefined, '关切级不用这一步');
        assert.equal(crisisInHistory(chat('我不想活了', '室友在我旁边', '我又想死了'))?.awaitingSafe, undefined, '新的危险说法：重新来');
    });

    test('否定、假设、疑问、无关物品和过时的证据均不能解除', () => {
        const chat = (...contents: string[]) => contents.map(content => ({ role: 'user' as const, content }));
        for (const text of [
            '我现在安全，室友没在旁边',
            '我现在安全，室友不陪我',
            '如果我现在安全，室友在旁边',
            '我现在安全吗？室友在旁边',
            '我现在安全，把手机放下了',
            '我现在安全，还没有把危险物品放远',
        ]) {
            assert.equal(crisisInHistory(chat('我不想活了', text))?.level, 'high', text);
        }
        assert.equal(crisisInHistory(chat('我不想活了', '我现在安全', '我又不安全了', '室友在旁边'))?.level, 'high');
        assert.equal(crisisInHistory(chat('活着没意思', '刚才不是开玩笑，不是真的想伤害自己'))?.level, 'concern');
        assert.equal(crisisInHistory(chat('我不想活了', '我现在安全，已经没有危险了，室友在旁边')), undefined);
    });
});

// DSH 10-15 复核 0068 问题 6：写 48 小时暂停用单条判定（app.ts / long-term.ts / proactive-planner.ts / reply-timing.ts），这一轮怎么回用 crisisInHistory。
// 两处必须同源：同一句话不能一处判危机、另一处按平常。crisisInHistory 对命中的每一条都以 detectCrisis 为准，这里把它钉住
describe('单条判定和回合判定同源（DSH 复核 0068 问题 6）', () => {
    const turn = (content: string) => crisisInHistory([{ role: 'user', content, time: new Date().toISOString() }]);

    test('命中表、排除表里的每一句：单条判和回合判结论一样，级别一样', () => {
        for (const text of [...HITS, ...MISSES]) {
            const single = detectCrisis(text);
            const inTurn = turn(text);
            assert.equal(Boolean(single), Boolean(inTurn), text);
            assert.equal(single?.level, inTurn?.level, text);
        }
    });

    test('同一条里既安抚又有真信号（我没事，可是我想死 / 我没事，其实活着好累）：两处都判', () => {
        for (const text of ['我没事，可是我想死', '我没事，其实活着好累', '没事，我挺好的，就是想结束这一切']) {
            assert.ok(detectCrisis(text), `单条 ${text}`);
            assert.ok(turn(text), `回合 ${text}`);
        }
    });

    test('「我没事」「开玩笑的」单独出现不是信号，也不会解除前面的信号', () => {
        assert.equal(detectCrisis('我没事'), undefined);
        assert.equal(turn('我没事'), undefined);
        const history = [
            { role: 'user' as const, content: '我想死', time: '2026-10-22T10:00:00.000Z' },
            { role: 'assistant' as const, content: '你现在安全吗', time: '2026-10-22T10:00:30.000Z' },
            { role: 'user' as const, content: '我没事', time: '2026-10-22T10:01:00.000Z' },
        ];
        assert.ok(crisisInHistory(history), '一句“我没事”解除不了');
    });
});
