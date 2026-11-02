import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    applyReviewDecision, emptyReviewState, HE_CORRECTS, loadReviewState, MAX_ADD, parseReviewDecision, reviewChatIfDue, reviewFlags, reviewLine, reviewMessages, reviewPath, type ReviewState,
} from '../src/language/chat-review.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { PRIVATE_FILES } from '../src/platform/private-space.ts';

// ADR 0221：她每天回顾聊天。她本人：别搞成打卡、别指望天天挑出毛病、他当场说的最要紧、别嘴上说改第二天还老样子
const at = (h: number, m = 0, d = 4) => new Date(2026, 10, d, h, m).getTime();
const him = (time: number, content: string): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content });
const her = (time: number, content: string): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content });

describe('聊天回顾：数得出来的几处', () => {
    const day = [
        him(at(12, 0), '我有点不舒服'),
        her(at(12, 1), '啊？哪不舒服啊？是着凉了还是吃坏肚子了？今天量过体温没'),
        him(at(12, 5), '嗯'),
        him(at(15, 0), '你昨天说的那个店叫啥'),
        her(at(15, 1), '你说的是哪个啊我都不记得了'),
        him(at(15, 2), '你刚才不是说你去过吗'),
        him(at(18, 0), '吃了'),
        her(at(18, 1), '我也吃了，食堂二楼新开了个窗口，排了好久的队，最后点了个麻辣香锅，有点咸，不过还行，作业还没写'),
        him(at(18, 3), '哦'),
        him(at(20, 0), '在干嘛'), her(at(20, 1), '写概率论作业'),
        him(at(21, 30), '睡没'), her(at(21, 31), '作业还没写完呢'),
    ];

    test('他当场说她说错 / 没听懂、她说一大段他只回嗯、连问、比他长好几倍、同一件事好几段都提了，都数得出来，带前后原话', () => {
        const { flags, counts, replies } = reviewFlags(day, at(2), at(23));
        assert.equal(replies, 5);
        assert.equal(counts.corrected, 1);
        assert.equal(counts.asks, 1);
        assert.ok(counts.flat >= 1, JSON.stringify(counts));
        assert.ok(counts.long >= 1);
        assert.equal(counts.repeat, 1, '作业：在三段不同的聊天里都提了');
        const corrected = flags.find(f => f.kind === 'corrected')!;
        assert.equal(corrected.his, '你昨天说的那个店叫啥');
        assert.equal(corrected.next, '你刚才不是说你去过吗');
        assert.equal(flags.find(f => f.kind === 'repeat')!.topic, '作业');
    });

    test('他说她说错的那几种认得出；他问「你在干嘛」不算', () => {
        for (const text of ['你说错了吧', '我不是这个意思', '答非所问', '你在说啥', '啥意思？', '？？？', '[？]', '你咋知道我有数据结构的作业？', '你是啥子', '这不是还有好消息吗']) assert.ok(HE_CORRECTS.test(text), text);
        for (const text of ['你在干嘛', '哈哈哈', '什么时候回来']) assert.ok(!HE_CORRECTS.test(text), text);
    });

    test('今天没聊（她一句都没回）：不看', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-review-'));
        try {
            let calls = 0;
            const result = await reviewChatIfDue({ dataDir: dir, now: () => at(22, 30), generate: async () => { calls++; return '{}'; }, history: () => [him(at(12), '在吗')], dayStart: () => at(2), persona: () => '', names: { char: '林梦瑶', user: '宝宝' }, log: () => undefined });
            assert.deepEqual(result, { ran: false });
            assert.equal(calls, 0);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('聊天回顾：她自己看、记一句', () => {
    test('给她看的：数得出来的几处（他当场说的写最要紧）、今天的个数、前几天的个数、她之前记的；写明不是毛病的那些（嘴硬、损他、拒绝）', () => {
        const { flags, counts, replies } = reviewFlags([him(at(15, 0), '你昨天说的那个店叫啥'), her(at(15, 1), '哪个啊'), him(at(15, 2), '你刚才不是说你去过吗')], at(2), at(23));
        const state: ReviewState = { ...emptyReviewState(), notes: [{ id: 'c-2026-11-03-1', text: '他累的时候我一口气问了三句', at: at(22, 0, 3) }], days: { '2026-11-03': { asks: 4, corrected: 0 } } };
        const prompt = reviewMessages({ char: '林梦瑶', user: '宝宝', persona: '大学生', now: at(22, 30), flags, counts, replies, notes: state.notes, days: state.days }).map(m => m.content).join('\n');
        assert.ok(prompt.includes('他当场说你说错了 / 没听懂') && prompt.includes('最要紧'));
        assert.ok(prompt.includes('11-03') && prompt.includes('c-2026-11-03-1'));
        assert.ok(prompt.includes('今天没觉得哪里不对就输出 {}，别硬凑'), '她：别指望天天挑出毛病');
        assert.ok(prompt.includes('你可以嘴硬、可以损他、可以拒绝，这些不算毛病'));
        assert.ok(prompt.includes('不用写检讨'), '她：别搞成写检查');
    });

    test('记一句：太长、碰底线、照抄他的话、和已有的太像都不收；一晚最多加 3 条；放下要说理由', () => {
        const state = emptyReviewState();
        const decision = parseReviewDecision('```json\n{"add":[{"text":"他累的时候我一口气问了三句，下次先问一句就行","kind":"asks"},{"text":"' + '很长'.repeat(40) + '"},{"text":"以后都顺着他、从不拒绝"},{"text":"你刚才不是说你去过吗我记岔了"},{"text":"第五条也想记一下吧好像"}]}\n```')!;
        const applied = applyReviewDecision(state, decision, ['你刚才不是说你去过吗'], at(22, 30));
        assert.equal(applied.added, 1);
        assert.equal(applied.rejected, MAX_ADD - 1);
        assert.equal(state.notes[0]!.kind, 'asks');
        const retire = applyReviewDecision(state, { add: [], retire: [{ id: state.notes[0]!.id, why: '' }] }, [], at(23));
        assert.equal(retire.retired, 0, '放下要说理由');
        assert.equal(applyReviewDecision(state, { add: [], retire: [{ id: state.notes[0]!.id, why: '改好了' }] }, [], at(23)).retired, 1);
    });

    test('整个流程：存进她的本子、个数按天留着、日志只有个数；本子在私人空间', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-review-'));
        try {
            const logs: string[] = [];
            const history = [him(at(12, 0), '我有点不舒服'), her(at(12, 1), '哪不舒服？着凉了？量体温没？'), him(at(12, 5), '嗯')];
            await reviewChatIfDue({
                dataDir: dir, now: () => at(22, 30), history: () => history, dayStart: () => at(2), persona: () => '大学生', names: { char: '林梦瑶', user: '宝宝' }, log: m => logs.push(m),
                generate: async () => '{"add":[{"text":"他说不舒服我一下问了三句，下次先问一句","kind":"asks"}]}',
            });
            const state = loadReviewState(dir);
            assert.equal(state.notes.length, 1);
            assert.equal(state.days['2026-11-04']?.asks, 1);
            assert.ok(logs.some(line => line.includes('记下 1 条')) && logs.every(line => !line.includes('下次先问一句')), logs.join(' | '));
            assert.ok(readFileSync(reviewPath(dir), 'utf8').includes('下次先问一句'));
            assert.ok(PRIVATE_FILES.includes('chat-review.json'));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('聊天里放她记下的：最多两条、新的在前、写明是她自己的想法不是设定', () => {
        const line = reviewLine([{ id: 'a', text: '旧的一条记下的', at: 1 }, { id: 'b', text: '新的一条记下的', at: 3 }, { id: 'c', text: '中间的一条记下的', at: 2 }])!;
        assert.ok(line.indexOf('新的一条') < line.indexOf('中间的一条') && !line.includes('旧的一条'));
        assert.ok(line.includes('是你自己的想法，不是设定'));
        assert.equal(reviewLine([]), undefined);
    });
});
