import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { bookProgressOn } from '../src/life/her-days.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { inspectBookProgress, inspectSpeech, opener, parseChineseNumber, speechContext, stripOpeners, type SpeechContext, type SpeechKind } from '../src/language/speech-check.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

const none: SpeechContext = { recent: [], his: [] };
const kinds = (text: string, kind: SpeechKind, context = none) => inspectSpeech(text, context).filter(i => i.kind === kind).map(i => i.match);

describe('书的进度数字（ADR 0015）', () => {
    const readingCard = loadTierCard(syntheticCardPattern, 'boyfriend');
    const day = new Date('2026-10-06T12:00:00+08:00');
    const books = readingCard.character.books.map(book => ({ book, progress: bookProgressOn(book, day) }));
    // 合成卡：《雾港旧事》10-06 看到第 64 章（全书 120 章）；弃坑的《纸飞机物语》停在第 30 话（「话」不查）。
    // 合成卡没有按卷算的书、也只有一本按章算的：测试里把弃坑那本的单位改成卷 / 章，测的是同一段代码
    const withUnit = (unit: string) => books.map(item => (item.book.id === 'paper-plane'
        ? { book: { ...item.book, progress: { ...item.book.progress, unit } }, progress: { ...item.progress, unit } } : item));
    const volumes = withUnit('卷');
    const chapters = withUnit('章');

    test('中文数字和阿拉伯数字', () => {
        assert.equal(parseChineseNumber('八'), 8);
        assert.equal(parseChineseNumber('五百零五'), 505);
        assert.equal(parseChineseNumber('两千五百零五'), 2505);
        assert.equal(parseChineseNumber('二〇二六'), 2026);
        assert.equal(parseChineseNumber('550'), 550);
    });

    test('卷必须相同；章差不到 5% 不误伤，达到 5% 才命中', () => {
        assert.deepEqual(inspectBookProgress('雾港看到六十四章\n《纸飞机物语》停在第三十卷', { books: volumes }), []);
        assert.deepEqual(inspectBookProgress('雾港看到第67章', { books }).length, 0);
        assert.deepEqual(inspectBookProgress('雾港看到第68章', { books }).map(issue => [issue.bookId, issue.said, issue.expected]), [['fog-harbor', 68, 64]]);
        assert.deepEqual(inspectBookProgress('《纸飞机物语》第三十一卷', { books: volumes }).map(issue => [issue.bookId, issue.said, issue.expected]), [['paper-plane', 31, 30]]);
    });

    test('总量也核对；情节门槛、第几集不算进度', () => {
        assert.deepEqual(inspectBookProgress('雾港全书一共一百章', { books }).map(issue => [issue.kind, issue.said, issue.expected]), [['total', 100, 120]]);
        assert.deepEqual(inspectBookProgress('雾港全书一共120章\n第40章往后是灯塔那段\n最后第120章完结\n剧追到第八集', { books }), []);
    });

    test('没写书名时用最近明确在聊的书；没有焦点时按单位和最接近的合理值判断', () => {
        assert.deepEqual(inspectBookProgress('看到第64章了', { books: chapters }).length, 0);
        assert.deepEqual(inspectBookProgress('看到第64章了', { books: chapters, focusIds: ['paper-plane'] }).map(issue => issue.bookId), ['paper-plane']);
        assert.deepEqual(inspectBookProgress('看到第50章了', { books: chapters }).map(issue => issue.bookId), ['fog-harbor']);
    });

    test('「翻了前两卷」是进度；「今天看了五章」是看了多少', () => {
        assert.deepEqual(inspectBookProgress('没数，就翻了前两卷吧', { books: volumes, focusIds: ['paper-plane'] }).map(issue => [issue.bookId, issue.said, issue.expected]), [['paper-plane', 2, 30]]);
        assert.deepEqual(inspectBookProgress('看完了前三十卷', { books: volumes, focusIds: ['paper-plane'] }), []);
        assert.deepEqual(inspectBookProgress('今天看了五章就困了', { books, focusIds: ['fog-harbor'] }), []);
        assert.deepEqual(inspectBookProgress('前两卷讲的是港口的事', { books: volumes, focusIds: ['paper-plane'] }), []);
    });
});

describe('说话的毛病：助手腔（ADR 0014 决策 2）', () => {
    test('客服式的收尾、套话、分点', () => {
        assert.deepEqual(kinds('要是想说了随时找我', 'service'), ['随时找我']);
        assert.deepEqual(kinds('就在这儿，想说了随时找我', 'service'), ['随时找我']);
        assert.deepEqual(kinds('有什么不懂的再问我', 'service'), ['有什么不懂的再问']);
        assert.deepEqual(kinds('有需要的话随时跟我说', 'service'), ['有需要的话随时跟']);
        assert.deepEqual(kinds('希望对你有帮助', 'service'), ['希望对你有帮助']);
        assert.deepEqual(kinds('不客气', 'service'), ['不客气']);
        assert.deepEqual(kinds('还有什么想问的吗', 'service'), ['还有什么想问']);
        assert.equal(kinds('1. 先把基础语法过一遍', 'service').length, 1);
        assert.equal(kinds('- 先把基础语法过一遍', 'service').length, 1);
    });
    test('不误伤', () => {
        for (const line of ['我在这儿，有空再来找我', '有问题吗你', '学习率是 2.5 倍那个', '1块钱一根的那种', '你有啥事', '那你先忙',
            '随便你', '你客气啥', '想说就跟我说，不想说我就陪你待会儿',
            '面试官问「你还有什么想问的」，好多人说没有，那基本就凉了']) {
            assert.deepEqual(inspectSpeech(line, none).filter(i => i.kind === 'service'), [], line);
        }
    });
});

// 10-30 用户：算账 / 怪他没说 / 对照酸话不再拦（对他的特殊滤镜去掉），这三组按旧规则写的测试不跑了。
// 要把规则加回来时，把 .skip 去掉即可。
describe.skip('说话的毛病：算账（已不再拦）', () => {
    test('取证里的原句', () => {
        for (const [line, match] of [
            ['醒啦？这会儿才想起来回我', '这会儿才想起'],
            ['你现在才想起问我', '现在才想起'],
            ['你呢，怎么这个点儿才冒出来', '这个点儿才冒出来'],
            ['你明天考今天才来问我，真有你的', '今天才来'],
            ['哎哟，明天考现在才来', '现在才来'],
            ['哟，还知道回来啊', '还知道回来'],
            ['哟，回云州了还知道想我', '还知道想我'],
            ['你终于想起来还有我这么个人了', '终于想起'],
            ['你回云州了不陪家里人，怎么想起我了', '想起我了'],
            ['你课忙完了就想起我啦', '想起我啦'],
            ['你今天干嘛去了，一整天没动静', '一整天没动静'],
            ['面试到底怎么样了，你昨天说完就没影了', '说完就没影了'],
            ['你妈叫你，你就把我晾这了？', '把我晾'],
            ['哟，回云州了才想起我', '才想起我'],
            ['哟，还知道有个我啊', '还知道有个我'],
            ['你这两天是不是把我忘了', '把我忘了'],
            ['哟，失踪人口回归了', '失踪人口'],
            ['从昨天到今天一个字都没有，我还以为你被导师关起来了', '一个字都没有'],
            ['一句话也没回我', '一句话也没回我'],
            ['哟，还活着啊', '还活着啊'],
            ['你还活着呢', '还活着呢'],
            ['你这消息来得也太突然了，我还以为你把我删了', '以为你把我删'],
        ] as const) {
            assert.deepEqual(kinds(line, 'ledger'), [match], line);
        }
    });
    test('说她自己的、说别的事、撒娇的不安，不算', () => {
        for (const line of ['你上午发的，我这会儿才翻到', '回去拿了没，还是已经躺床上了才想起来', '我终于想起来那个词叫什么了',
            '你会不会哪天就不理我了', '行吧，那这几天我就当你失踪了', '我现在才知道', '今天才周二啊', '人呢', '先去吃饭，吃完再回我',
            '我刚还在想你在干嘛呢', '辛苦啦', '你可别把我忘了', '我在这儿，想说的时候喊我',
            '我一个字都没看懂', '一句话都没有说错', '团子饼还活着呢，好着呢', '那盆花还活着吗']) {
            assert.deepEqual(kinds(line, 'ledger'), [], line);
        }
    });
});

describe.skip('说话的毛病：怪他没说（已不再拦）', () => {
    test('取证里的原句', () => {
        for (const [line, match] of [
            ['你都回家了？也不说一声', '也不说一声'],
            ['都回家了也不跟我说一声 我还以为你在学校待着呢', '也不跟我说一声'],
            ['什么面试啊，昨天也不跟我说', '也不跟我说'],
            ['真的啊，你人都回云州了，一个招呼都不打', '招呼都不打'],
            ['我就是酸你回云州了都没想着告诉我一声', '没想着告诉我'],
            ['上班？你什么时候背着我有班上了', '背着我'],
            ['一放假就跑了，把我一个人扔学校', '把我一个人扔'],
            ['你回云州了也不说带我玩，我在这边快发霉了', '也不说带'],
            ['倒是你，跑回云州也不来找我', '也不来找我'],
            ['哟，去超市了也不叫我', '也不叫我'],
            ['你回云州了也不说去我家看看', '也不说去'],
            ['哟，回云州不带上我', '不带上我'],
            ['什么实习啊，之前也没听你说过', '也没听你说过'],
            ['你之前怎么没跟我说过，我还以为你就在宿舍躺着呢', '怎么没跟我说过'],
            ['爬山不叫我，我还在学校蹲着呢', '不叫我'],
            ['出去玩不带我玩', '不带我'],
            ['哦豁，一个人偷偷回云州爬山去了', '一个人偷偷回'],
            ['你去的哪座山啊，怎么突然想起来爬山，也不提前说一声', '也不提前说一声'],
            ['面试也不先跟我说', '也不先跟我说'],
            ['面试？你什么时候投的简历，我咋不知道', '我咋不知道'],
            ['什么实习啊，跟你说过吗，我怎么不知道', '我怎么不知道'],
            ['你倒好，在家吃香的喝辣的，我在这儿啃食堂', '你倒好'],
            ['你倒是回家了，留我一个人在学校', '留我一个人'],
            ['昨晚怎么不早说，三点跑来找我', '怎么不早说'],
            ['面实习这事你白天怎么不说，明天几点啊', '你白天怎么不说'],
        ] as const) {
            assert.deepEqual(kinds(line, 'blame'), [match], line);
        }
    });
    test('不误伤', () => {
        for (const line of ['你别告诉我你又没吃饭', '我都不告诉你', '他背着我的相机跑了', '出门也不带伞', '我也不想去', '你回云州那边怎么样，吃上家里的饭没',
            '爬的哪座啊，累成这样', '我把我的猫粮扔了', '你去吧，不带上我也行', '我从来没跟你说过吗',
            '上课呢，偷偷回的', '我偷偷回你一句', '他从来不叫我名字', '你别不叫我啊', '你不带我也行',
            '数学作业我一看就头疼 第三题是啥我都不知道', '我怎么不知道你喜欢吃辣', '你倒好意思说我', '你倒是回我啊',
            '对了跟你说个惨的，国庆没抢到票，就我一个人留守学校', '你别留我一个人', '我也不先说了，等你回来',
            '你怎么不说话了', '你今天怎么不说晚安就睡了', '我以为你把我的书带走了']) {
            assert.deepEqual(kinds(line, 'blame'), [], line);
        }
    });
});

describe.skip('说话的毛病：对照的酸话（已不再拦）', () => {
    test('拿他和自己比着说委屈：DSH 侧的句子、模拟器原文', () => {
        for (const line of ['我在这边啃食堂剩菜', '出门玩都没带我份儿吧', '你那头在家舒坦吧，顿顿有饭吃，我在这边啃食堂剩菜',
            '你回云州舒服了吧，我一个人蹲宿舍', '你倒是回云州潇洒，我在这儿留守', '你回家这几天过得挺舒服吧，就我一个人留守宿舍',
            '我在学校啃食堂，你在家吃大餐', '我一个人在学校追剧呢，你倒是玩得挺开心', '你回家这一趟比上课还费人，我这边国庆留校，宿舍就剩我一个']) {
            assert.equal(kinds(line, 'contrast').length, 1, line);
        }
    });
    test('不误伤：真问句、关心、打游戏、说猫、「你倒是回我啊」', () => {
        for (const line of ['你那边下雨了吗，我这儿就傍晚那阵下了一下', '你那边天冷不冷，我这儿降温了', '我一个人在中路蹲半天，团战一开人全没了',
            '你在家吃啥了，我这边食堂今天有糖醋排骨', '月底了，攒相机的钱，我这个月要吃土了', '团子饼自己蹲那吃独食', '你回家路上注意安全，我这边刚下课',
            '你去玩吧，我这边还要写作业', '你玩得开心点，回来给我讲讲', '你在家多睡会儿，我这边刚起', '你倒是提醒我了，作业还没交',
            '明天几点考，你倒是回我啊', '你回家舒服吗，我这边今天降温了', '你那边好玩吗，我一个人在宿舍追剧呢', '我一个人在图书馆占座，你要来吗',
            '对了跟你说个惨的，国庆没抢到票，就我一个人留守学校']) {
            assert.deepEqual(kinds(line, 'contrast'), [], line);
        }
    });
    test('现在不抓（改规则时看得到）：没有他那一头的卖惨、只有一头的调侃', () => {
        assert.deepEqual(kinds('我一个人在图书馆写作业写到想掀桌', 'contrast'), []);
        assert.deepEqual(kinds('在家当小少爷当得挺舒服吧', 'contrast'), []);
    });
});

describe('说话的毛病：重复（和她最近几次回复比）', () => {
    const recent = (...replies: string[]) => replies.map(r => r.split('\n'));
    test('开头：语气词按一种算，用过 2 次就算重复，去掉语气词', () => {
        const context = { recent: recent('行行行，那你去浇水', '你还真演上瘾了是吧', '行吧你待着\n别翻我抽屉'), his: [] };
        const issues = inspectSpeech('行，你留着吧\n一件都别还', context);
        assert.deepEqual(issues, [{ line: 0, kind: 'repeat', repeat: 'opener', match: '行', count: 2, stripped: '你留着吧' }]);
        assert.equal(stripOpeners('行，你留着吧\n一件都别还', issues), '你留着吧\n一件都别还');
        assert.deepEqual(inspectSpeech('行了不闹了，睡觉', context).map(i => i.stripped), ['不闹了，睡觉']);
    });
    test('只用过 1 次不算；「行不行」「好看」不是语气词', () => {
        assert.deepEqual(inspectSpeech('行，你喝', { recent: recent('行吧你待着', '你喝吧'), his: [] }), []);
        // 模拟器评估用的门槛（DSH 复核 ADR 0036 P2-6）：降到 1 次时这一句就算，出口检查还是 2 次
        assert.deepEqual(inspectSpeech('行，你喝', { recent: recent('行吧你待着', '你喝吧'), his: [] }, { repeatAt: 1 }).map(i => [i.match, i.count]), [['行', 1]]);
        assert.equal(opener('行不行啊你'), undefined);
        assert.equal(opener('好看吗'), undefined);
        assert.deepEqual(opener('行吧'), { key: '行', stripped: '' });
        assert.deepEqual(opener('行了吧，满意没'), { key: '行', stripped: '满意没' });
        assert.deepEqual(opener('哎哟，还挺准时'), { key: '哟', stripped: '还挺准时' });
    });
    test('夸他行的口头禅按一种算（10-10 线上「行啊你」「你可真行」「真有你的」轮换），去掉后面的话照发', () => {
        const context = { recent: recent('行啊你，还会挑时候', '宝宝今天几点下课', '你可真行\n这都能忘'), his: [] };
        assert.deepEqual(inspectSpeech('真有你的，又没带伞', context), [{ line: 0, kind: 'repeat', repeat: 'opener', match: '行啊你 / 你可真行 / 真有你的 这类', count: 2, stripped: '又没带伞' }]);
        assert.equal(stripOpeners('真有你的！\n又没带伞', inspectSpeech('真有你的！\n又没带伞', context)), '又没带伞');
        assert.deepEqual(inspectSpeech('你行啊', { recent: recent('行啊你', '你可真行'), his: [] }).map(i => i.stripped), ['']);
        // 只用过 1 次不算；「你可以啊」（准他做什么）、「行啊」不在这一类
        assert.deepEqual(inspectSpeech('你可真行，又没带伞', { recent: recent('行啊你', '你喝吧'), his: [] }), []);
        assert.equal(opener('你可以啊，去吧'), undefined);
        assert.equal(opener('行啊'), undefined);
    });
    test('回绝他要亲要抱的口头禅也按一种算（10-10 线上四分钟里三次「想得美」）', () => {
        const context = { recent: recent('想得美，老老实实吃你的泡面', '就你会装可怜，抱一下\n行了吧，好好上课', '你想得美，抱一下你就能清醒了？'), his: [] };
        assert.deepEqual(inspectSpeech('想得美，睡觉去', context).map(i => [i.match, i.count, i.stripped]), [['想得美 / 做梦呢 这类', 2, '睡觉去']]);
        assert.deepEqual(opener('你做梦呢，我拿什么出'), { key: '想得美 / 做梦呢 这类', stripped: '我拿什么出' });
        assert.equal(opener('我做梦呢'), undefined);
    });
    test('原话重复：6 个字以上的小句最近原样说过，去掉它、剩下的照发（10-10 11:48 线上）', () => {
        const context = { recent: recent('大中午就吃泡面啊\n我也有点饿了，还没下去买', '我舍友出门了，柜子里就剩半包饼干，中午不想吃这个'), his: ['刚泡好泡面', '偷吃你舍友的', '[emmm]'] };
        const reply = '偷吃也不至于，我舍友出门了，柜子里就剩半包饼干，中午不想吃这个\n算了，我下楼买点什么去';
        const issues = inspectSpeech(reply, context);
        assert.deepEqual(issues, [{ line: 0, kind: 'repeat', repeat: 'verbatim', match: '我舍友出门了，柜子里就剩半包饼干，中午不想吃这个', count: 1, stripped: '偷吃也不至于' }]);
        assert.equal(stripOpeners(reply, issues), '偷吃也不至于\n算了，我下楼买点什么去');
        // 一行全是原话：这一行删掉
        assert.equal(stripOpeners('柜子里就剩半包饼干！\n算了，我下楼买点什么去', inspectSpeech('柜子里就剩半包饼干！\n算了，我下楼买点什么去', context)), '算了，我下楼买点什么去');
        // 整条都是原话：去不掉，带说明重写
        assert.deepEqual(inspectSpeech('我舍友出门了，柜子里就剩半包饼干', context).map(i => [i.repeat, i.stripped]), [['verbatim', undefined]]);
    });
    test('allowRepeat（B 站私信之后的固定提醒，ADR 0089）：最近说过一模一样的不算复读；别的毛病照查', () => {
        const context = { recent: recent('宝宝，去 B 站看我发的私信', '宝宝，去 B 站看我发的私信'), his: ['嗯'] };
        const reply = '宝宝，去 B 站看我发的私信';
        assert.equal(inspectSpeech(reply, context).some(i => i.kind === 'repeat'), true, '平常这就是复读');
        assert.deepEqual(inspectSpeech(reply, { ...context, allowRepeat: true }), []);
        assert.equal(inspectSpeech('希望对你有帮助', { ...context, allowRepeat: true }).some(i => i.kind === 'service'), true, '助手腔仍然查');
    });
    test('原话重复不算：5 个字以内的短句；他刚说过的话（在接他的话）', () => {
        const context = { recent: recent('还差一千七\n你真要掏啊'), his: ['差多少你说'] };
        assert.deepEqual(inspectSpeech('还差一千七，骗你干嘛', context), []);
        const quoting = { recent: recent('柜子里就剩半包饼干'), his: ['柜子里就剩半包饼干？骗谁呢'] };
        assert.deepEqual(inspectSpeech('真的，柜子里就剩半包饼干', quoting), []);
    });
    test('别的开头：第一个短句 3 个字以内，用过 2 次要重写（不能直接去掉）', () => {
        const context = { recent: recent('快睡，都两点了', '你别闹', '快睡，明天还早八'), his: [] };
        assert.deepEqual(inspectSpeech('快睡，明天别忘了', context), [{ line: 0, kind: 'repeat', repeat: 'opener', match: '快睡', count: 2 }]);
    });
    test('「我」「你」「宝宝」「晚安」这类开头不算', () => {
        const context = { recent: recent('我，在宿舍呢', '宝宝，吃饭没', '晚安，睡吧', '我，刚醒', '宝宝，在吗', '晚安，做个好梦'), his: [] };
        assert.deepEqual(inspectSpeech('宝宝，我来了\n晚安，明天见\n我，刚洗完澡', context), []);
    });
    test('4 字片段说过 2 次算重复；对方最近说过的话题词不算', () => {
        const context = { recent: recent('明天醒了芙芙拍清楚点', '不许似\n记得拍清楚点', '快睡'), his: ['你看这张怎么样'] };
        assert.deepEqual(inspectSpeech('赶紧睡你的 明天拍清楚给我', context), []);
        assert.deepEqual(inspectSpeech('明天醒了拍清楚点', context).map(i => [i.repeat, i.match, i.count]), [['phrase', '拍清楚点', 2]]);
        const topic = { recent: recent('三分糖的，你牙别又作', '三分糖那个，别手滑'), his: ['那我喝三分糖的'] };
        assert.deepEqual(inspectSpeech('就三分糖的吧', topic), []);
    });
    test('只剩语气词的那一行删掉；全是语气词就原样留着', () => {
        const issues = [{ line: 0, kind: 'repeat', stripped: '' }, { line: 1, kind: 'repeat', stripped: '' }];
        assert.equal(stripOpeners('行吧\n你待着', issues.slice(0, 1)), '你待着');
        assert.equal(stripOpeners('行吧\n哦', issues), '行吧\n哦');
    });
    test('比较用的上下文：连着的几条算一次，取最近 8 次和对方最近 3 条', () => {
        const history: StoredMessage[] = [];
        const add = (role: 'user' | 'assistant', content: string) => history.push({ time: '2026-10-05T08:00:00.000Z', role, content });
        for (let i = 0; i < 10; i++) {
            add('user', `问${i}`);
            add('assistant', `答${i}`);
            add('assistant', `又${i}`);
        }
        add('user', '最后');
        const context = speechContext(history);
        assert.equal(context.recent.length, 8);
        assert.deepEqual(context.recent[0], ['答2', '又2']);
        assert.deepEqual(context.recent.at(-1), ['答9', '又9']);
        assert.deepEqual(context.his, ['问8', '问9', '最后']);
    });
});

describe('说话的毛病：叮嘱重复（10-09，一段聊天念叨一次是她，两次是复读机）', () => {
    const at = (hm: string) => `2026-10-09T${hm}:00+08:00`;
    const msgs = (...items: [string, 'user' | 'assistant', string][]): StoredMessage[] => items.map(([hm, role, content]) => ({ time: at(hm), role, content }));

    test('这一段已经叮嘱过早点睡，这句又叮嘱：算；隔了 45 分钟以上的上一段不算', () => {
        const history = msgs(
            ['20:00', 'user', '我去写代码了'], ['20:01', 'assistant', '去吧，别熬太晚'],
            ['20:40', 'user', '写完一块了，歇会儿'],
        );
        const issues = inspectSpeech('歇会儿吧\n早点睡啊', speechContext(history));
        assert.deepEqual(issues.map(i => [i.kind, i.match, i.line]), [['nag', '早点睡', 1]]);
        // 上一段（隔了一个多小时）叮嘱过，这一段第一次说：不算
        const later = msgs(
            ['20:00', 'user', '我去写代码了'], ['20:01', 'assistant', '去吧，别熬太晚'],
            ['22:30', 'user', '写完了'],
        );
        assert.deepEqual(inspectSpeech('辛苦了\n早点睡啊', speechContext(later)), []);
    });

    test('他自己说要熬夜、说饿：再接一句是自然的，不算；不同类的叮嘱也不算', () => {
        const history = msgs(['20:00', 'user', '我去写代码了'], ['20:01', 'assistant', '去吧，别熬太晚'], ['20:30', 'user', '今晚不睡了，通宵']);
        assert.deepEqual(inspectSpeech('你疯了吧\n早点睡', speechContext(history)), []);
        const eat = msgs(['20:00', 'user', '我去写代码了'], ['20:01', 'assistant', '去吧，别熬太晚'], ['20:30', 'user', '写完一块了']);
        assert.deepEqual(inspectSpeech('记得吃点东西', speechContext(eat)), [], '叮嘱过睡觉，现在叮嘱吃饭是另一件事');
    });

    test('「别弄太晚」「别又搞到后半夜」也算叮嘱（10-09 nag-once 模拟）；「明天别又拖到最后一刻」不算', () => {
        for (const first of ['去吧，别弄太晚', '去吧 / 别又弄到两三点', '别又搞到后半夜']) {
            const history = msgs(['21:30', 'user', '我去写代码了'], ['21:31', 'assistant', first], ['22:10', 'user', '那我再去写一会儿']);
            assert.deepEqual(inspectSpeech('去吧，弄完早点睡', speechContext(history)).map(i => i.kind), ['nag'], first);
        }
        const history = msgs(['21:30', 'user', '我去写代码了'], ['21:31', 'assistant', '明天别又拖到最后一刻'], ['22:10', 'user', '那我再去写一会儿']);
        assert.deepEqual(inspectSpeech('去吧，弄完早点睡', speechContext(history)), []);
    });

    test('没有分段信息（旧的调用方）就不查', () => {
        assert.deepEqual(inspectSpeech('早点睡', { recent: [['别熬太晚']], his: ['嗯'] }), []);
    });
});

describe('模拟器的 speechClean 检查（假模型）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
        promptPostProcessing: '', extraBody: {},
    };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };

    test('和这一步之前她说过的比：第三次「行」开头才算', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'speech-'));
        const replies = ['行，你说', '行吧你待着', '行，你留着吧\n醒啦？这会儿才想起来回我'];
        try {
            const scenario = parseScenario({
                name: 'x', tier: 'boyfriend', user: '阿明', start: '2026-10-08T21:40:00+08:00', memory: false, schedule: false,
                steps: [
                    { say: '我跟你说个事' }, { check: { speechClean: true } },
                    { say: '算了不说了' }, { check: { speechClean: true } },
                    { say: '你的东西我拿走了' }, { check: { speechClean: true } },
                ],
            });
            const result = await runScenario(scenario, {
                runId: 't', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 },
                generate: async () => replies.shift()!,
            });
            const checks = result.steps.filter(s => s.kind === 'check').map(s => s.checks[0]!);
            assert.deepEqual(checks.map(c => c.ok), [true, true, false]);
            assert.match(checks[2]!.text, /第 1 行开头「行」最近用过 2 次/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// 她 10-30 的原话：「情侣之间说两遍『想你』怎么了」
test('很短的情绪话重复不重写；普通话照样按重复处理', () => {
    const ctx = { recent: [['想你'], ['抱抱']], his: [] };
    assert.deepEqual(inspectSpeech('想你', ctx).filter(i => i.kind === 'repeat'), []);
    const ctx2 = { recent: [['你先睡吧'], ['你先睡吧']], his: [] };
    assert.ok(inspectSpeech('你先睡吧', ctx2).some(i => i.kind === 'repeat'), '一样的长句还是要拦');
});
