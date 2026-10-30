import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { facesIn, SENDABLE_FACES } from '../src/language/qq-faces.ts';
import { applyTexture, faceFor, TEXTURE_FACE_WINDOW_MAX, TEXTURE_SHARES, TEXTURE_TILDE_WINDOW, type TextureContext } from '../src/language/texture.ts';

// ADR 0131：说话的质感。纯函数，同一句话结果固定；危机和他难过的回合不加
const ctx = (seed: string, patch: Partial<TextureContext> = {}): TextureContext => ({ seed, said: '', serious: false, recentFaces: 0, ...patch });
const seeds = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
/** 在很多个种子里跑，返回每个种子的结果 */
const sweep = (parts: string[], patch: Partial<TextureContext> = {}, n = 400) => seeds(n).map(seed => applyTexture(parts, ctx(seed, patch)));
const share = (results: { parts: string[] }[], pick: (parts: string[]) => boolean) => results.filter(r => pick(r.parts)).length / results.length;

describe('不加的情形', () => {
    test('serious（危机 / 他难过 / 小别扭）：什么都不动；没有气泡也不出错', () => {
        for (const result of sweep(['你吃了吗', '哈哈', '好的'], { serious: true, said: '哈哈哈' })) assert.deepEqual(result.parts, ['你吃了吗', '哈哈', '好的']);
        assert.deepEqual(applyTexture([], ctx('x')).parts, []);
    });

    test('表情包 / 照片 / 链接 / 已经带了小黄脸的气泡不动', () => {
        for (const bubble of ['<sticker:0123456789ab>', '<photo:0123456789ab>', 'https://example.com/x', '好困啊[睡]', '[图片表情]']) {
            for (const result of sweep([bubble], { said: '哈哈哈' }, 60)) assert.equal(result.parts.at(-1), bubble, bubble);
        }
    });

    test('同一句话每次结果一样', () => {
        const a = applyTexture(['你今天吃了吗', '哈哈'], ctx('same', { said: '笑死' }));
        assert.deepEqual(a, applyTexture(['你今天吃了吗', '哈哈'], ctx('same', { said: '笑死' })));
    });
});

describe('问号 / 感叹号', () => {
    test('看得出是在问的、没带问号：约 TEXTURE_SHARES.question 的情况补「？」；本来就带标点的不动', () => {
        const results = sweep(['你今晚吃什么']);
        const hit = share(results, p => p[0] === '你今晚吃什么？');
        assert.ok(hit > TEXTURE_SHARES.question * 0.7 && hit < TEXTURE_SHARES.question * 1.3 + 0.1, `${hit}`);
        for (const bubble of ['你吃了吗？', '你吃了吗。', '你吃了吗～', '你吃了吗！']) for (const r of sweep([bubble], {}, 50)) assert.ok(r.parts[0]!.startsWith(bubble.slice(0, -1)) && !/[？?]{2}/.test(r.parts[0]!), bubble);
    });

    test('不是问句的不补问号；「太……了」一类感叹的补「！」；只有两三个字的反应不补', () => {
        assert.ok(sweep(['我在写作业']).every(r => !r.parts[0]!.endsWith('？')));
        assert.ok(sweep(['太好看了']).some(r => r.parts[0] === '太好看了！'));
        assert.ok(sweep(['真的']).every(r => r.parts[0] !== '真的！'), '「真的」不当感叹');
    });

    test('问句结尾的省略号换成问号 / 去掉；整条只有“……”的无语反应不动', () => {
        const results = sweep(['你晚上干嘛去了……']);
        assert.ok(results.every(r => !r.parts[0]!.includes('…') || r.parts[0] === '你晚上干嘛去了……'));
        assert.ok(results.some(r => r.parts[0] === '你晚上干嘛去了？' || r.parts[0] === '你晚上干嘛去了'));
        assert.ok(sweep(['……']).every(r => r.parts[0] === '……'));
    });
});

describe('「～」', () => {
    test('轻松的短句（句尾是啦 / 呀 / 哦 / 嘛……）有时换成「～」；一次回复最多一条；不加在问句、长句、陈述性的话上', () => {
        const results = sweep(['不行哦']);
        const hit = share(results, p => p[0] === '不行哦～');
        assert.ok(hit > 0.2 && hit < 0.7, `${hit}`);
        for (const r of sweep(['好呀', '那我先去洗澡啦'])) assert.ok(r.parts.filter(p => /～/.test(p)).length <= 1);
        for (const bubble of ['宿舍有人睡了', '今天上了一天课真的好累', '你吃了吗', '我在写作业呢呢呢呢呢呢呢呢呢呢呢呢呢呢']) assert.ok(sweep([bubble], {}, 80).every(r => !r.parts[0]!.endsWith('～')), bubble);
    });

    test('最近几次回复里带过「～」就不再加（ADR 0134：选择题连着答「X吧～」）；没带过照旧', () => {
        for (const r of sweep(['不行哦'], { recentTildes: 1 })) assert.ok(!r.parts.some(p => /～$/.test(p)), r.parts.join('|'));
        assert.ok(share(sweep(['不行哦'], { recentTildes: 0 }), p => p[0] === '不行哦～') > 0.2);
        assert.ok(share(sweep(['不行哦']), p => p[0] === '不行哦～') > 0.2, '不写按 0');
        assert.equal(TEXTURE_TILDE_WINDOW, 3);
    });
});

describe('小黄脸', () => {
    test('语气对得上才加：笑 → 笑哭 / 偷笑，晚安 → 睡，想你 → 爱心 / 飞吻，无语 → 白眼；加的都在她能发的 16 个里', () => {
        const check = (bubble: string, allowed: string[]) => {
            // 用户 10-23「不要用或者少用黄豆表情」：语气对得上时也只是偶尔（约 10%），所以多跑一些种子
            const faced = sweep([bubble], {}, 1500).filter(r => facesIn(r.parts.at(-1)!).sendable.length);
            assert.ok(faced.length > 60 && faced.length < 400, `${bubble}：${faced.length}`);
            // 没有线索（或这次没抽中）时可能带中性的 doge
            for (const r of faced) assert.ok([...allowed, 'doge'].some(name => r.parts.at(-1)!.endsWith(`[${name}]`)), `${bubble} → ${r.parts.at(-1)}`);
        };
        check('哈哈哈你好搞笑', ['笑哭', '偷笑']);
        check('那我睡了，晚安', ['睡']);
        check('我也想你', ['爱心', '飞吻']);
        check('你烦死了', ['白眼']);
        for (const name of ['笑哭', '偷笑', '睡', '爱心', '飞吻', '白眼', '捂脸', '委屈', '可怜', '害羞', '拥抱', '快哭了', '大哭', '敲打', 'OK', 'doge']) assert.ok(name in SENDABLE_FACES, name);
        assert.equal(faceFor('今天作业好多', 'x'), undefined);
    });

    test('一次回复最多一个；最近 6 次里已经带了 TEXTURE_FACE_WINDOW_MAX 次就不带；整条只是一个字母词的不带', () => {
        for (const r of sweep(['哈哈哈真的好好笑', '笑死我了', '晚安'], {}, 100)) assert.ok(r.parts.filter(p => /\[[^\]]+\]/.test(p)).length <= 1);
        for (const r of sweep(['哈哈哈真的好好笑'], { recentFaces: TEXTURE_FACE_WINDOW_MAX })) assert.ok(!/\[[^\]]+\]/.test(r.parts[0]!));
        assert.ok(sweep(['哈哈哈真的好好笑'], { recentFaces: TEXTURE_FACE_WINDOW_MAX - 1 }, 1500).some(r => /\[[^\]]+\]/.test(r.parts[0]!)));
        for (const r of sweep(['ok'], { said: '哈哈' }, 80)) assert.equal(r.parts.at(-1), 'ok');
    });

    test('他在笑 / 撒娇时，她接得短的话也可能带一个同样语气的（偶尔）', () => {
        const results = sweep(['你才傻呢'], { said: '哈哈哈哈你好傻' }, 1500);
        assert.ok(results.some(r => /\[(?:笑哭|偷笑)\]$/.test(r.parts.at(-1)!)));
    });
});

describe('叠字 / 英文字母 / 并条 / 先回一个字', () => {
    test('整条只是一个语气词才叠字；整条是「好的」「哈哈哈」才可能写成 ok / hhh；句子里的字不动', () => {
        assert.ok(sweep(['哈哈']).some(r => r.parts[0] === '哈哈哈哈') || sweep(['哈哈']).some(r => r.parts[0] === 'hh'));
        assert.ok(sweep(['嗯']).some(r => r.parts[0] === '嗯嗯'));
        assert.ok(sweep(['好的']).some(r => r.parts[0] === 'ok'));
        for (const r of sweep(['哈哈你怎么这样', '我嗯了一声'], {}, 80)) assert.ok(r.parts[0]!.startsWith('哈哈你怎么这样') || r.parts[0]!.startsWith('我嗯了一声') || /^hh|哈哈你/.test(r.parts[0]!));
    });

    test('连着两条都很短的偶尔并成一条；有问号 / 小黄脸 / 长的不并；不增加条数', () => {
        const results = sweep(['你说', '我听着']);
        assert.ok(results.some(r => r.parts.length === 1 && r.parts[0] === '你说，我听着'));
        assert.ok(results.every(r => r.parts.length <= 2));
        for (const r of sweep(['你说？', '我听着'], {}, 80)) assert.equal(r.parts.length, 2);
        for (const r of sweep(['我今天去图书馆待了一下午', '真的好累'], {}, 80)) assert.equal(r.parts.length, 2);
    });

    test('他在笑 / 觉得离谱时，偶尔先单独回一个字的反应；要有空位；已经是反应开头的不加；没有线索不加', () => {
        const laugh = sweep(['你这也太离谱了吧'], { said: '哈哈哈哈笑死我了' });
        assert.ok(laugh.some(r => r.parts.length === 2 && /^(?:哈哈|哈哈哈|笑死)$/.test(r.parts[0]!)));
        const surprise = sweep(['这也太突然了'], { said: '我刚刚居然中奖了！！' });
        assert.ok(surprise.some(r => r.parts.length === 2 && /^(?:啊？|？|真的假的)$/.test(r.parts[0]!)));
        for (const r of sweep(['这也太突然了'], { said: '居然中奖了', maxBubbles: 1 }, 80)) assert.equal(r.parts.length, 1);
        for (const r of sweep(['哈哈哈真的啊'], { said: '笑死我了' }, 80)) assert.ok(!/^哈哈$|^哈哈哈$|^笑死$/.test(r.parts[0]!) || r.parts[0] === '哈哈哈真的啊');
        assert.ok(sweep(['今天作业好多'], { said: '在吗' }).every(r => r.parts[0] === '今天作业好多' || r.parts[0]!.startsWith('今天作业好多')));
    });

    test('他陈述了件事、她第一条比较长：偶尔先“嗯嗯”一声；他在问就不', () => {
        const said = '我今天去图书馆待了一下午';
        assert.ok(sweep(['那你今天一定很专心吧'], { said }).some(r => r.parts.length === 2 && /^(?:嗯嗯|嗯|好|对)$/.test(r.parts[0]!)));
        for (const r of sweep(['那你今天一定很专心吧'], { said: '你今天去哪了？' }, 100)) assert.equal(r.parts.length, 1);
    });
});

describe('小黄脸很少（用户 10-23：不要用或者少用黄豆表情）', () => {
    test('一般的回合里带小黄脸的不到 5%；没有语气线索的回合不带中性的小黄脸', () => {
        const turns = [['你吃了吗'], ['我在写作业'], ['晚上吃什么呢'], ['今天好冷啊'], ['哈哈哈哈你好搞笑'], ['想你了'], ['那我先去洗澡啦'], ['好的']];
        let faced = 0;
        let total = 0;
        for (const parts of turns) for (const seed of seeds(300)) { total++; if (/\[[\p{Script=Han}A-Za-z0-9]{1,6}\]/u.test(applyTexture(parts, ctx(seed, { said: '' })).parts.join(''))) faced++; }
        assert.ok(faced / total < 0.05, `${faced}/${total}`);
        for (const seed of seeds(300)) assert.ok(!/\[doge\]/.test(applyTexture(['宿舍有人睡了'], ctx(seed)).parts.join('')), '中性的 doge 不带');
    });
});

describe('先“嗯嗯”一声的判法（10-30 通读：「吃的啥啊」→「好」，「你看过没」→「嗯嗯」）', () => {
    const LONG = ['那你今天一定很专心吧'];
    const acked = (said: string, n = 300) => sweep(LONG, { said }, n).filter(r => r.parts.length === 2 && /^(?:嗯嗯|嗯|好|行|对)$/.test(r.parts[0]!));

    test('他是在问的（啥 / 没 / 哪 / 谁 / 是不是 / 嘛 / 句尾的不）：一条都不先应一声', () => {
        for (const said of ['吃的啥啊', '你看过没', '你吃了没', '哪个男的教你的', '是不是打算再买几个', '你周六有空吗', '你去不', '我在我在老婆干嘛呀', '小宝上床了嘛', '这个怎么弄', '谁知道呢']) {
            assert.equal(acked(said).length, 0, said);
        }
    });

    test('道谢 / 道歉 / 示爱 / 问候 / 道别：不先应一声（「爱你」→「好」不对）', () => {
        for (const said of ['谢谢你听我说', '爱你', '我也想你呀', '对不起我错了', '晚安', '早安', '辛苦你了', '拜拜']) {
            assert.equal(acked(said).length, 0, said);
        }
    });

    test('陈述只接「嗯嗯 / 嗯」，不接「好 / 对」；他提了件要一起做的事才接「好 / 行」', () => {
        const statement = acked('我今天去图书馆待了一下午', 600);
        assert.ok(statement.length > 20, `陈述里还是偶尔会先应一声：${statement.length}`);
        for (const r of statement) assert.ok(['嗯嗯', '嗯'].includes(r.parts[0]!), r.parts[0]);
        for (const said of ['我今天累死了', '老板又让我改方案']) for (const r of acked(said, 600)) assert.ok(['嗯嗯', '嗯'].includes(r.parts[0]!), `${said} → ${r.parts[0]}`);
        const proposal = acked('那就周六晚上一起去吃火锅', 600);
        assert.ok(proposal.length > 20);
        for (const r of proposal) assert.ok(['好', '行'].includes(r.parts[0]!), r.parts[0]);
    });
});
