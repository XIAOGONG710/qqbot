import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeIntent, isEndingTurn, saysOwnThing } from '../src/intent.ts';
import type { Schedule, State } from '../src/schedule.ts';

const now = new Date('2026-10-06T20:00:00+08:00');
const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });
const free = (text: string): State => ({ activity: { kind: 'free', text }, where: '学校', outsideSemester: false });

describe('这一轮你想（ADR 0019）', () => {
    test('他刚说了自己的事：问一个具体细节；普通提问不算', () => {
        assert.equal(saysOwnThing([assistant('嗯'), user('我刚下课，累死了')]), true);
        assert.equal(saysOwnThing([assistant('嗯'), user('你今天干嘛')]), false);
        assert.match(describeIntent({ history: [user('昨晚去看电影了')], now })!, /回应他刚说的/);
        assert.match(describeIntent({ history: [user('你帮我讲讲梯度下降是怎么回事')], now, state: free('打独立游戏') })!, /直接回答/);
        // 「到了没」「写完没」「去不去」也是问句（10-07：「你那快递到了没」被当成闲聊，意图行让她讲起了打游戏的进度）
        for (const asked of ['你那快递到了没', '作业写完没有', '周末去不去', '这样行不行']) {
            assert.match(describeIntent({ history: [user(asked)], now, state: free('打独立游戏') })!, /直接回答/, asked);
        }
        assert.doesNotMatch(describeIntent({ history: [user('我今天没')], now, state: free('打独立游戏') }) ?? '', /直接回答/, '只是没说完');
        // 「干嘛」「啥」也是问句（10-08：「你昨天都干嘛了」被当成闲聊，意图行让她讲手上追剧的进度，问昨天常常想不起那天的麻辣烫）
        for (const asked of ['你昨天都干嘛了', '在干嘛', '你晚饭吃的啥', '你上周都忙啥了', '那前天呢，前天干嘛了']) {
            assert.match(describeIntent({ history: [user(asked)], now, state: free('在追一部剧') })!, /直接回答/, asked);
        }
        assert.doesNotMatch(describeIntent({ history: [user('没啥，就是有点累')], now, state: free('在追一部剧') }) ?? '', /直接回答/, '「没啥」不是问');
    });

    test('他报了件好事又顺口问一句：先替他高兴，不被问句顶掉（盲评 v1.1 be-056）', () => {
        const burst = [assistant('你上回说的那个面试 结果出来没'), user('啊 我刚睡醒'), user('手机静音了没听见'), user('出来了 过了！！'), user('你吃了没')];
        assert.match(describeIntent({ history: burst, now, state: free('打独立游戏') })!, /先替他高兴/);
        for (const news of ['我抢到了！', '四级过了！', '考上了！！', '拿到offer了!']) {
            assert.match(describeIntent({ history: [user(news), user('这下算不算惊喜啊')], now })!, /先替他高兴/, news);
        }
        // 难过、吃过、没感叹号、问句都不算
        assert.doesNotMatch(describeIntent({ history: [user('我好难过了！')], now })!, /先替他高兴/);
        assert.match(describeIntent({ history: [user('吃过了！'), user('你呢')], now })!, /直接回答/);
        assert.match(describeIntent({ history: [user('面试过了'), user('你吃了没')], now })!, /直接回答/);
        assert.match(describeIntent({ history: [user('你四级过了没！？')], now })!, /直接回答/);
        // 她上次回复之前的好消息不算
        assert.match(describeIntent({ history: [user('过了！'), assistant('牛'), user('你吃了没')], now })!, /直接回答/);
    });

    test('按线索顺序只给一个：他的事优先于答应的事，答应的事优先于手上的事', () => {
        assert.match(describeIntent({ history: [user('我今天去面试了')], now, promised: true, books: true })!, /回应他刚说的/);
        assert.match(describeIntent({ history: [user('在吗')], now, promised: true, books: true })!, /答应/);
        assert.equal(describeIntent({ history: [user('在吗')], now, books: true }), undefined);
    });

    test('不强塞空闲活动；开场时忙、上硬课、快睡才限制长度；没线索就没有', () => {
        assert.equal(describeIntent({ history: [user('在吗')], now, state: free('在图书馆看《长安的荔枝》') }), undefined);
        assert.match(describeIntent({ history: [user('在吗')], now, state: free('在图书馆赶作业') })!, /回两句/);
        const hard: State = { activity: { kind: 'class', lesson: { kind: 'hard', start: now, end: new Date(now.getTime() + 3_600_000) } }, where: '学校', outsideSemester: false };
        assert.match(describeIntent({ history: [user('在吗')], now, state: hard })!, /回两句/);
        const schedule = { sleep: '02:00' } as Schedule;
        assert.match(describeIntent({ history: [user('在吗')], now: new Date('2026-10-07T01:00:00+08:00'), state: free(''), schedule })!, /回两句/);
        assert.equal(describeIntent({ history: [user('在吗')], now, state: free('') }), undefined);
    });

    test('主动找他时不给：主动说明本身就是意图', () => {
        assert.equal(describeIntent({ history: [user('我今天去面试了')], now, initiating: true }), undefined);
    });

    test('他说晚安、不想聊或只附和时只给收尾意图，不再追问或分享进度', () => {
        for (const text of ['今天累死了，我先睡了，晚安', '今天不想说话', '嗯', '哈哈', '那我去写代码了，你慢慢看']) {
            const history = [assistant('前一句'), user(text)];
            assert.equal(isEndingTurn(history), true, text);
            assert.match(describeIntent({ history, now, state: free('打独立游戏'), promised: true })!, /收尾/, text);
        }
        assert.equal(isEndingTurn([user('你睡了吗')]), false);
    });

    test('撒娇要她哄、陪不是收尾：带「睡觉」也照亲密话接（10-09 13:11 线上「哄我睡觉呗」）', () => {
        for (const text of ['哄我睡觉呗', '陪我聊会儿嘛', '给我讲个睡前故事', '摸摸头']) {
            const history = [assistant('那睡吧，我下午还有节课'), user(text)];
            assert.equal(isEndingTurn(history), false, text);
            const line = describeIntent({ history, now, state: free('打独立游戏'), promised: true })!;
            assert.match(line, /撒娇要你哄他、陪他/, text);
            assert.match(line, /只接他刚说的你们两个人的事/, '候选挑选和气泡上限照亲密话算');
            assert.doesNotMatch(line, /收尾/);
        }
        assert.equal(isEndingTurn([user('想睡觉了')]), true, '他自己说要睡还是收尾');
    });

    test('男朋友要亲近或确认感情：先明确回接，再嘴硬；优先于普通问句和收尾', () => {
        for (const text of ['需要抱抱', '亲我一下行不行', '发个mua', '你想我吗', '爱不爱我', '没爱了', '不准睡，再陪我聊会儿', '喜欢你', '喜欢你❤️', '别走啊', '别走🥺']) {
            const line = describeIntent({ history: [assistant('我去睡了，晚安'), user(text)], now, intimate: true })!;
            assert.match(line, /先给一个明确的亲密回应/, text);
            assert.match(line, /嘴硬不能是整轮唯一内容/, text);
            assert.match(line, /文字里的抱抱、亲一下和 mua 就是真的在抱、在亲/, text);
            assert.doesNotMatch(line, /隔空不算|亲屏幕|明天再补|不要求当面/, text);
            assert.match(line, /只接他刚说的你们两个人的事/, text);
            assert.doesNotMatch(line, /先直接回答|顺着他的话收尾/, text);
        }
    });

    test('亲密邀约只在男朋友档加强，词边界不误伤普通问句', () => {
        assert.match(describeIntent({ history: [user('你想我吗')], now })!, /直接回答/, '非男朋友档不套亲密互惠');
        for (const text of ['你别抱怨了行不行', '你亲戚来了吗', '这件事你亲自去吗', '你想我怎么做', '我想你应该先睡', '别走那条路', '不要走太远', '我喜欢你昨天发的那张', '我爱你推荐的那本书']) {
            assert.doesNotMatch(describeIntent({ history: [user(text)], now, intimate: true }) ?? '', /亲密回应|只接他刚说的你们两个人的事/, text);
        }
    });

    test('好消息和亲密话在同一句：亲密意图同时接住好消息', () => {
        const line = describeIntent({ history: [user('面试过了！！爱你')], now, intimate: true })!;
        assert.match(line, /先替他高兴再接亲密话/);
        assert.match(line, /先给一个明确的亲密回应/);
    });

    test('亲密邀约里带难受或明确收尾：意图同时保留照顾和收尾边界', () => {
        const care = describeIntent({ history: [user('撑不住了，需要抱抱')], now, intimate: true })!;
        assert.match(care, /先心疼他/);
        assert.match(care, /回抱/);
        const closing = describeIntent({ history: [user('我睡了，晚安，亲亲')], now, intimate: true })!;
        assert.match(closing, /回应后顺着收尾/);
    });

    test('男朋友发网络缩写、谐音和故意怪话：先接梗，不落进普通问答或收尾', () => {
        for (const text of ['zdjd', 'xswl', '我先睡为敬', '并非早', '刚才那节课的老师真是死冯了', '史老师真给我气史了']) {
            const line = describeIntent({ history: [user(text)], now, playful: true })!;
            assert.match(line, /顺着同一套逻辑接一句/, text);
            assert.match(line, /不解释梗或报出处/, text);
            assert.match(line, /保留那句被拧过的关键词或句式/, text);
            assert.doesNotMatch(line, /先直接回答|顺着他的话收尾/, text);
        }
        assert.match(describeIntent({ history: [user('zdjd')], now, playful: true })!, /真的假的 \/ 尊嘟假嘟/);
        assert.match(describeIntent({ history: [user('u1s1 你这次说得有道理吗')], now, playful: true })!, /有一说一/);
    });

    test('接梗加强只给男朋友档，普通英文、真事故和正式说法不误触', () => {
        assert.equal(describeIntent({ history: [user('zdjd')], now }), undefined);
        for (const text of ['cos服到了吗', 'mua是什么意思', '我家猫死掉了', '这并非事实', '史老师今天真气坏了']) {
            assert.doesNotMatch(describeIntent({ history: [user(text)], now, playful: true, intimate: true }) ?? '', /网络梗、缩写或谐音|亲密回应/, text);
        }
    });

    test('男朋友要她发照片：先不发，用她自己的理由，再说给他听；他自己要发的不算（10-11 预演买到相机）', () => {
        for (const text of ['可以啊，发我看看', '来张自拍', '发张照片呗', '拍给我看看', '你拍的照片呢', '给我看看你的新相机', '有图吗', '晒一下', '发来康康']) {
            const line = describeIntent({ history: [assistant('买到了 a6100'), user(text)], now, intimate: true })!;
            assert.match(line, /他想看照片/, text);
            assert.doesNotMatch(line, /发不了/, `${text}：意图行不写出不想要的话`);
        }
        for (const text of ['我发你看看', '我拍张给你', '我给你发个照片', '把地址发我', '发个定位']) {
            assert.doesNotMatch(describeIntent({ history: [user(text)], now, intimate: true }) ?? '', /他想看照片/, text);
        }
        assert.doesNotMatch(describeIntent({ history: [user('发我看看')], now }) ?? '', /他想看照片/, '同学档走世界书');
        assert.match(describeIntent({ history: [user('发张自拍，想你了')], now, intimate: true })!, /亲密回应/, '想他了排在要照片前');
    });

    test('明确难过时只接住，不转去讲自己的猫、书或进度；普通短句不脑补', () => {
        for (const text of ['悲', '我哭得很伤心', '今天累死了', '有点难受', '今天被导师骂了，烦死', '好烦啊', '心累']) {
            const line = describeIntent({ history: [user(text)], now, state: free('在追一部剧'), books: true })!;
            assert.match(line, /先接住他此刻的情绪/, text);
            assert.match(line, /第一句先安慰或问怎么了，不先损他/, text);
        }
        assert.equal(describeIntent({ history: [user('烦人精')], now, state: free('在追一部剧') }), undefined, '烦人精是叫他，不是心情');
        assert.match(describeIntent({ history: [user('已经见面5150天了呢')], now, state: free('刷摄影区'), books: true })!, /只接他刚说的你们两个人的事/);
        // 身上不舒服、一般的累也算（10-10 盲评 N3 be-018 / be-017）
        for (const said of [['宝贝', '我嗓子疼', '从下午就开始了 肿了', '没事 喝点水就行'], ['今天有点累', '没事 你不用管我', '考完试出来感觉脑子是空的'], ['我好像感冒了'], ['打球把脚崴了']]) {
            const line = describeIntent({ history: said.map(text => user(text)), now, state: free('在追一部剧'), books: true })!;
            assert.match(line, /第一句先安慰或问怎么了，不先损他/, said.join(' / '));
        }
        assert.match(describeIntent({ history: [user('好累 我先睡了')], now })!, /收尾/, '累了要睡还是收尾');
        assert.match(describeIntent({ history: [user('头疼，明天的课你去不去')], now })!, /先直接回答他刚问的/, '问了事照旧先答');
        assert.equal(describeIntent({ history: [user('背题背得脑瓜子都大了')], now, state: free('在追一部剧') }), undefined);
        assert.match(describeIntent({ history: [user('就你那天拧开的那瓶水'), user('你递过来的时候我心里特别软')], now, state: free('刷摄影区'), books: true })!, /只接他刚说的你们两个人的事/);
    });
});

describe('挂着的事进意图行（ADR 0023）', () => {
    const waiting = ['阿明周四下午字节面试'];
    const unanswered = ['他国庆回不回家'];

    test('等他说结果的：开口时最先问，只表达想知道，不写介意；收尾、他直接问时让路', () => {
        const line = describeIntent({ history: [user('在吗')], now, waiting, unanswered, promised: true })!;
        assert.match(line, /知道「阿明周四下午字节面试」后来怎么样了/);
        assert.doesNotMatch(line, /介意|委屈|失望|怪他|生气/);
        assert.match(describeIntent({ history: [user('我刚下班，累死了')], now, waiting })!, /接住他此刻的情绪/, '他说自己的事时不拿旧事抢话');
        assert.match(describeIntent({ history: [user('晚安')], now, waiting })!, /收尾/);
        assert.match(describeIntent({ history: [user('你今天吃的啥')], now, waiting })!, /直接回答/);
        assert.equal(describeIntent({ history: [user('在吗')], now, waiting, initiating: true }), undefined);
    });

    test('她问了他没答的：排在答应的事之后，轻轻再问，不追究', () => {
        assert.match(describeIntent({ history: [user('在吗')], now, unanswered, promised: true })!, /答应/);
        const line = describeIntent({ history: [user('在吗')], now, unanswered, books: true })!;
        assert.match(line, /上次问他「他国庆回不回家」他没顾上回，轻轻再问一次；他不接就算了，不追究/);
    });
});

describe('她那边的事还没跟他说过（ADR 0057 调整）', () => {
    const news = ['在山大路科技市场买到了二手索尼 a6100 加 16-50 套机镜头'];

    test('他开口问「在干嘛」、说「在吗」：先回他，接着说这件；不给台词', () => {
        for (const text of ['在干嘛', '在吗', '你吃了没', '我回来了']) {
            const line = describeIntent({ history: [user(text)], now, news, state: free('在宿舍') })!;
            assert.match(line, /先回他刚说的；你今天在山大路科技市场买到了二手索尼 a6100 加 16-50 套机镜头，还没跟他说过，接着就说这件/, text);
            assert.doesNotMatch(line.replace('「你那边」', ''), /「/, text);
        }
    });

    test('他难过、生病、收尾、要亲近、报好事时让路', () => {
        assert.match(describeIntent({ history: [user('我发烧了，好难受')], now, news })!, /接住他此刻的情绪/);
        assert.match(describeIntent({ history: [user('今天好累啊不想动')], now, news })!, /接住他此刻的情绪/);
        assert.match(describeIntent({ history: [user('晚安')], now, news })!, /收尾/);
        assert.match(describeIntent({ history: [user('想抱抱你')], now, news, intimate: true })!, /亲密回应/);
        assert.match(describeIntent({ history: [user('我面试过了！！')], now, news })!, /替他高兴/);
        assert.equal(describeIntent({ history: [user('在吗')], now, news, initiating: true }), undefined);
    });
});
