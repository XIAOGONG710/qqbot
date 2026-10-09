import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { repeatedSentences, sameSentence, sentenceKey } from '../src/sim/repeats.ts';
import { runChecks, type StepRecord } from '../src/sim/runner.ts';

const her = (content: string) => ({ role: 'assistant' as const, content });
const him = (content: string) => ({ role: 'user' as const, content });

describe('模拟器的跨轮重复（DSH 复核 ADR 0036 P2-6）', () => {
    test('归一：去标点、表情、语气词，数字算一样', () => {
        assert.equal(sentenceKey('别熬太晚了啊！'), '别熬太晚');
        assert.equal(sentenceKey('还差1750'), sentenceKey('还差2300'));
        assert.equal(sentenceKey('认识五千多天了呢～'), '认识#多天');
        assert.equal(sentenceKey('我那个Boss还是没过 😭'), '我那个boss还是没过');
    });

    test('短应答不算：「嗯嗯」「好的」「去吧去吧」「晚安」谁都天天说', () => {
        const earlier = [her('嗯嗯'), her('好的'), her('去吧去吧'), her('晚安'), him('我去洗澡了')];
        assert.deepEqual(repeatedSentences('嗯嗯\n好的\n去吧去吧，晚安', earlier), []);
    });

    test('同一句式第二遍就算：标点、语气词、数字不同也是一句', () => {
        const earlier = [her('去吧，别熬太晚啊'), him('嗯'), her('攒相机还差1750呢'), him('我去写代码了')];
        assert.deepEqual(repeatedSentences('去吧去吧\n别熬太晚了！', earlier), [{ said: '别熬太晚了', before: '别熬太晚啊' }]);
        assert.deepEqual(repeatedSentences('我攒相机还差2300', earlier), [{ said: '我攒相机还差2300', before: '攒相机还差1750呢' }]);
        // 这次回复里自己说了两遍
        assert.deepEqual(repeatedSentences('我在宿舍打游戏\n嗯，我在宿舍打游戏', []), [{ said: '我在宿舍打游戏', before: '我在宿舍打游戏' }]);
    });

    test('他说过的不算（接他的话）；只差一个字、意思可能相反的不算', () => {
        const earlier = [him('明天九点二十五集合'), her('九点二十五集合？那么早'), her('明天带你上分')];
        assert.deepEqual(repeatedSentences('九点二十五集合，早点睡', earlier), []);
        assert.deepEqual(repeatedSentences('明天不带你上分了', earlier), []);
        assert.equal(sameSentence(sentenceKey('我刚跟室友扯了半天'), sentenceKey('刚跟室友扯了半天')), true);
        assert.equal(sameSentence(sentenceKey('在看《药屋少女的呢喃》呢'), sentenceKey('药屋')), false);
    });

    test('noRepeat 检查：和这一步之前的聊天比，是回复检查', () => {
        const step: StepRecord = {
            kind: 'say', time: 0, inputs: [], generations: [], logs: [], checks: [],
            bubbles: [{ time: 0, text: '去吧' }, { time: 0, text: '写完早点睡，别熬太晚了' }],
        };
        const [repeated] = runChecks({ noRepeat: true }, step, [], undefined, [her('别熬太晚啊'), him('我去写代码了')]);
        assert.deepEqual([repeated!.ok, Boolean(repeated!.pipeline)], [false, false]);
        assert.match(repeated!.text, /「别熬太晚了」≈ 前面的「别熬太晚啊」/);
        assert.equal(runChecks({ noRepeat: true }, step, [], undefined, [her('嗯'), him('我去写代码了')])[0]!.ok, true);
    });
});
