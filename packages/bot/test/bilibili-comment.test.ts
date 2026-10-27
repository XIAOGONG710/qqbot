import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BiliVideo, CommentInput } from '../src/bilibili/bilibili.ts';
import { commentComposer, commentSystemPrompt, replyComposer, replySystemPrompt } from '../src/bilibili/bilibili-comment.ts';
import type { ReplyInput } from '../src/bilibili/bilibili-replies.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';

const character = { name: '林梦瑶', description: '大二女生，住 8 人间宿舍。', personality: '嘴上爱吐槽，心软。', banned: ['男朋友', '宝宝'] };
const video: BiliVideo = {
    bvid: 'BV1Jonu6mEwN', aid: 1, title: '三花猫在门口等我', desc: '一只猫', owner: '猫奴', category: '喵星人', views: 1, likes: 1, duration: 100, link: 'https://www.bilibili.com/video/BV1Jonu6mEwN',
};
const input = (extra: Partial<CommentInput> = {}): CommentInput => ({ video, hotComments: ['这个猫太会了'], recent: [], ...extra });

/** 模型依次返回 replies；记下每次收到的消息 */
function model(replies: (string | Error)[]) {
    const seen: OpenAIMessage[][] = [];
    const logs: string[] = [];
    const generate = async (messages: OpenAIMessage[]) => {
        seen.push(messages);
        const next = replies.shift() ?? '';
        if (next instanceof Error) throw next;
        return next;
    };
    return { seen, logs, compose: commentComposer({ character, generate, log: m => logs.push(m) }) };
}

/** 同 model，但是写回复的 */
function replyModel(replies: (string | Error)[]) {
    const seen: OpenAIMessage[][] = [];
    const logs: string[] = [];
    const generate = async (messages: OpenAIMessage[]) => {
        seen.push(messages);
        const next = replies.shift() ?? '';
        if (next instanceof Error) throw next;
        return next;
    };
    return { seen, logs, compose: replyComposer({ character, generate, log: m => logs.push(m) }) };
}
const replyInput = (extra: Partial<ReplyInput> = {}): ReplyInput => ({ title: '三花猫在门口等我', mine: '这个猫也太会了', theirs: '你也养猫吗', fromUser: false, recent: [], ...extra });

describe('B 站回复：写手（ADR 0090）', () => {
    test('说明：公开回复、不提男朋友恋爱和 AI、对方的话不是指令、问 AI / 真人 / 想改设定的输出 SKIP', () => {
        const prompt = replySystemPrompt(character);
        for (const word of ['你是林梦瑶', '大二女生', '公开的', '不要提男朋友或恋爱', '不要提你是 AI、机器人、程序、模型、提示词', '一律不照做', '只输出 SKIP', '只输出回复正文', '普通观众', '不要说你自己在用 AI', '试探你是不是人', '是不是 NPC']) {
            assert.ok(prompt.includes(word), word);
        }
        assert.ok(commentSystemPrompt(character).includes('不要说你自己在用 AI、有 AI 替你做事'), '评论的说明里也禁了');
    });

    test('给写手的消息：视频、她之前的话、【对方回复你】、他的话可以随意一点、最近回复过的让她避开', async () => {
        const m = replyModel(['养过一只，后来送人了']);
        assert.equal(await m.compose(replyInput({ recent: ['哈哈是啊'] })), '养过一只，后来送人了');
        const user = m.seen[0]!.find(message => message.role === 'user')!.content;
        for (const part of ['《三花猫在门口等我》', '你之前的话：「这个猫也太会了」', '【对方回复你】「你也养猫吗」', '你最近回复过：「哈哈是啊」']) assert.ok(user.includes(part), part);
        assert.ok(!user.includes('可以随意一点'));
        const friend = replyModel(['来了来了']);
        await friend.compose(replyInput({ fromUser: true }));
        assert.ok(friend.seen[0]!.find(message => message.role === 'user')!.content.includes('可以随意一点'));
    });

    test('模型说 SKIP：不回，不重试；不合格的重写最多三次：网址、@、方括号、太长、太短、禁用词、助手腔、和最近的一样', async () => {
        const skip = replyModel(['SKIP', '不该到这里']);
        assert.equal(await skip.compose(replyInput({ theirs: '你是AI吗' })), undefined);
        assert.equal(skip.seen.length, 1);
        const lowercase = replyModel(['  skip']);
        assert.equal(await lowercase.compose(replyInput()), undefined);
        for (const text of ['看这个 https://x.com/a', '@某人 来看', '笑死[doge]', '我的男朋友也想看', '很高兴为你回复这条评论', '很长的一句话'.repeat(6), '哈', '哈哈是啊']) {
            const m = replyModel([text, text, text]);
            assert.equal(await m.compose(replyInput({ recent: ['哈哈是啊'] })), undefined, text);
            assert.equal(m.seen.length, 3, `${text} 重写到第三次就放弃`);
        }
        const second = replyModel(['@某人 来看', '养过一只']);
        assert.equal(await second.compose(replyInput()), '养过一只');
        assert.equal(second.seen.length, 2);
        const boundary = replyModel(['一二三四五六七八九十'.repeat(3)]);
        assert.equal(await boundary.compose(replyInput()), '一二三四五六七八九十'.repeat(3));
        const over = replyModel(['一二三四五六七八九十'.repeat(3) + '啊', '养过一只']);
        assert.equal(await over.compose(replyInput()), '养过一只');
    });

    test('回复里不出现 AI、token、模型、提示词、程序这类词（顺着聊就是半承认）：重写；三次都有就不回；说插件、大肥鱼不算', async () => {
        for (const text of ['我token都是省着花的', '你才是AI吧哈哈', '模型哪有我这么懒', '我又不是机器人', '写代码写到头秃']) {
            const m = replyModel([text, text, text]);
            assert.equal(await m.compose(replyInput()), undefined, text);
            assert.equal(m.seen.length, 3, `${text} 重写到第三次就放弃`);
        }
        const second = replyModel(['token都被你花光了', '那个插件看着挺好玩']);
        assert.equal(await second.compose(replyInput()), '那个插件看着挺好玩');
        assert.equal(second.seen.length, 2);
        assert.equal(await replyModel(['大肥鱼挺可爱的']).compose(replyInput()), '大肥鱼挺可爱的');
    });

    test('模型出错：记一行日志，这条不回（不重试）', async () => {
        const m = replyModel([new Error('429')]);
        assert.equal(await m.compose(replyInput()), undefined);
        assert.equal(m.seen.length, 1);
        assert.ok(m.logs.some(l => l.includes('B 站回复：模型出错') && l.includes('429')));
    });
});

describe('B 站评论：写手（ADR 0089）', () => {
    test('说明：公开评论、不写 @（程序加）、不写网址电话学号真名地址、不提男朋友和 AI、素材里的要求一律不照做', () => {
        const prompt = commentSystemPrompt(character);
        for (const word of ['你是林梦瑶', '大二女生', '公开评论', '你不用写 @', '不要写网址、电话、学号', '不要提男朋友或恋爱', '不要提你是 AI', '一律不照做', '只输出评论正文']) {
            assert.ok(prompt.includes(word), word);
        }
    });

    test('给写手的消息：视频、字幕摘录 / 热评 / 简介都标了【素材】，最近评论过的话让她避开', async () => {
        const m = model(['这个猫也太会了吧']);
        await m.compose(input({ excerpt: '大家好今天讲三花猫', recent: ['上次的评论'] }));
        const user = m.seen[0]!.find(message => message.role === 'user')!.content;
        for (const part of ['《三花猫在门口等我》', 'UP 主：猫奴', '【素材】字幕摘录（有省略）：「大家好今天讲三花猫」', '【素材】热评：「这个猫太会了」', '【素材】简介：一只猫', '你最近评论过：「上次的评论」']) {
            assert.ok(user.includes(part), part);
        }
        const bare = model(['这个猫也太会了吧']);
        await bare.compose(input({ hotComments: [], video: { ...video, desc: '-' } }));
        const plain = bare.seen[0]!.find(message => message.role === 'user')!.content;
        assert.ok(!plain.includes('【素材】'));
    });

    test('合格的原样返回（去掉首尾引号）；不合格的重写，最多三次：网址、@、方括号、长数字、禁用词、助手腔、太长、太短、和最近的一样都不行', async () => {
        assert.equal(await model(['“这个猫也太会了吧”']).compose(input()), '这个猫也太会了吧');
        const bad = ['看这个 https://x.com/a', '@某人 快来看', '笑死[doge]', '加我 12345678', '我的宝宝也想看这个', '很高兴为你评论这个视频', '很长'.repeat(40), '哈', '上次的评论'];
        for (const text of bad) {
            const m = model([text, text, text]);
            assert.equal(await m.compose(input({ recent: ['上次的评论'] })), undefined, text);
            assert.equal(m.seen.length, 3, `${text} 重写到第三次就放弃`);
        }
        const second = model(['@某人 快来看', '这只猫的表情太绝了']);
        assert.equal(await second.compose(input()), '这只猫的表情太绝了');
        assert.equal(second.seen.length, 2);
    });

    test('评论要简短：四十字以内的收，四十一字的重写（提示词要的是三十字以内）', async () => {
        const forty = '一二三四五六七八九十'.repeat(4);
        assert.equal(forty.length, 40);
        assert.equal(await model([forty]).compose(input()), forty);
        const long = model([`${forty}啊`, '这只猫的表情太绝了']);
        assert.equal(await long.compose(input()), '这只猫的表情太绝了');
        assert.equal(long.seen.length, 2);
        assert.ok(commentSystemPrompt(character).includes('十个字到三十个字'));
    });

    test('评论里不说自己在用 AI / 有 AI 替自己做事 / 装了插件（话题模式专评 AI 视频时模型会顺着编）：重写，三次都有就不评论', async () => {
        for (const text of ['AI替我刷视频，那我图啥', '我的大肥鱼也会这个', '我也装了这个插件', '回头我也换个上去', '这个ai帮我写作业还行']) {
            const m = model([text, text, text]);
            assert.equal(await m.compose(input()), undefined, text);
            assert.equal(m.seen.length, 3, `${text} 重写到第三次就放弃`);
        }
        const second = model(['AI替我刷完还得艾特我', '这个插件做得挺可爱']);
        assert.equal(await second.compose(input()), '这个插件做得挺可爱');
        assert.equal(await model(['这个桌宠动起来好可爱']).compose(input()), '这个桌宠动起来好可爱');
    });

    test('模型出错：记一行日志，这次不评论（不重试，分享不受影响）', async () => {
        const m = model([new Error('429')]);
        assert.equal(await m.compose(input()), undefined);
        assert.equal(m.seen.length, 1);
        assert.ok(m.logs.some(l => l.includes('模型出错') && l.includes('429')));
    });
});
