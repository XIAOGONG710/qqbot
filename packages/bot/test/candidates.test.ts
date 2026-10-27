import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describePick, pickBest, scoreCandidate, type PickRules } from '../src/language/candidates.ts';

const rules = (kind: PickRules['kind'], maxLines: number, heard = ''): PickRules => ({ kind, maxLines, heard, own: ['土豆', '相机', '药屋少女的呢喃', '追剧'], banned: [] });

describe('候选选择（ADR 0041）', () => {
    test('扣分：说多了、扯到自己的事、约「写完跟我说」、他哭时叮嘱作息；他自己说到的不算', () => {
        assert.deepEqual(scoreCandidate('去吧去吧\n别写到太晚', rules('ending', 2)), { text: '去吧去吧\n别写到太晚', penalty: 0, reasons: [] });
        const long = scoreCandidate('一\n二\n三\n四', rules('care', 2));
        assert.equal(long.penalty, 4);
        assert.deepEqual(long.reasons, ['说了 4 句']);
        assert.match(scoreCandidate('抱抱\n我刚喂完土豆', rules('care', 2)).reasons.join(), /扯到自己的「土豆」/);
        assert.equal(scoreCandidate('土豆没事吧', rules('care', 2, '土豆今天咋样')).penalty, 0, '他问的就是土豆');
        assert.match(scoreCandidate('去吧\n写完跟我说一声', rules('ending', 2)).reasons.join(), /约「写完跟我说一声」/);
        assert.match(scoreCandidate('怎么了\n早点睡吧', rules('care', 2)).reasons.join(), /他难过时叮嘱作息/);
        assert.equal(scoreCandidate('去吧\n早点睡', rules('ending', 2)).penalty, 0, '收尾时叮嘱是她的性格');
        assert.equal(scoreCandidate('', rules('ending', 2)).penalty, 100);
    });

    test('挑扣分最少的，一样少挑先生成的；日志写清别的为什么没挑', () => {
        const candidates = ['去吧\n写完跟我说一声', '去吧去吧\n别熬太晚', '去吧\n我接着追剧了\n你加油'];
        const { index, scored } = pickBest(candidates, rules('ending', 2), text => text);
        assert.equal(index, 1);
        assert.equal(describePick(index, scored), '候选 3 个，挑第 2 个（第 1 个：约「写完跟我说一声」；第 3 个：说了 3 句，扯到自己的「追剧」）');
        assert.equal(pickBest(['好', '好的'], rules('ending', 2), text => text).index, 0);
        // 清理（去动作描写）之后再打分
        assert.equal(pickBest(['（笑）\n一\n二', '一\n二\n三'], rules('ending', 2), text => text.replace(/（[^）]*）\n?/g, '')).index, 0);
    });
});
