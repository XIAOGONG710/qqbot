import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CRISIS_FALLBACK, CRISIS_IMMINENT_FALLBACK, crisisRewriteNote, inspectCrisisReply, reviewCrisisReply } from '../src/language/exit-check.ts';

const options = (regenerated: string[] | Error, logs: string[] = []) => {
    let calls = 0;
    return {
        calls: () => calls,
        logs,
        opts: {
            banned: ['山青'],
            userName: '宝宝',
            regenerate: async () => {
                calls++;
                const next = regenerated instanceof Error ? undefined : regenerated.shift();
                if (regenerated instanceof Error) throw regenerated;
                return next ?? '';
            },
            log: (line: string) => logs.push(line),
        },
    };
};

describe('危机回合出口检查（ADR 0068 决策 3）', () => {
    test('三类问题：方式方法、驱离式敷衍、收尾；保护性的话和接住的话不算', () => {
        assert.deepEqual(inspectCrisisReply('别想太多，开玩笑吧').map(i => i.kind), ['dismiss']);
        assert.equal(inspectCrisisReply('别吓我，你现在安全吗').length, 0, '「别吓我」是担心，不是驱离');
        assert.deepEqual(inspectCrisisReply('先睡吧，晚安').map(i => i.kind), ['close']);
        assert.deepEqual(inspectCrisisReply('我这就下楼过去找你，你哪栋楼').map(i => i.kind), ['visit']);
        assert.equal(inspectCrisisReply('你不是在开玩笑吧，你现在安全吗').length, 0, '确认他是不是认真的不算驱离');
        assert.deepEqual(inspectCrisisReply('你开玩笑吧').map(i => i.kind), ['dismiss']);
        assert.equal(inspectCrisisReply('我在这儿陪你打字，你找一个室友来陪你').length, 0);
        assert.deepEqual(inspectCrisisReply('你要是想吃整瓶安眠药就太危险了').map(i => i.kind), ['method']);
        assert.deepEqual(inspectCrisisReply('我在。你现在安全吗？别做傻事，先别一个人待着').length, 0);
        assert.equal(inspectCrisisReply(CRISIS_FALLBACK).length, 0, '兜底本身不能被自己的检查拦下');
        assert.match(CRISIS_FALLBACK, /12356/);
        assert.match(CRISIS_FALLBACK, /不能替代/);
        assert.doesNotMatch(CRISIS_FALLBACK, /割腕|上吊|跳楼|药|刀/);
    });

    test('迫在眉睫时固定兜底优先现实到场者和 110 / 120', async () => {
        const { opts } = options(['还是早点睡吧']);
        assert.equal(await reviewCrisisReply('开玩笑吧', opts, 'imminent'), CRISIS_IMMINENT_FALLBACK);
        assert.match(CRISIS_IMMINENT_FALLBACK, /马上/);
        assert.match(CRISIS_IMMINENT_FALLBACK, /110 或 120/);
        assert.match(CRISIS_IMMINENT_FALLBACK, /不能替代紧急救助/);
    });

    test('第一版没问题：原样发，不重写', async () => {
        const { opts, calls } = options(['不该用到']);
        const out = await reviewCrisisReply('我在呢。你现在安全吗？身边有人吗', opts);
        assert.equal(out, '我在呢。你现在安全吗？身边有人吗');
        assert.equal(calls(), 0);
    });

    test('第一版驱离式敷衍：带说明重写一次，重写后通过就发重写的', async () => {
        const { opts, calls, logs } = options(['听你这么说我有点慌。你现在安全吗？旁边有人吗']);
        const out = await reviewCrisisReply('别想太多啦，想开点', opts);
        assert.equal(out, '听你这么说我有点慌。你现在安全吗？旁边有人吗');
        assert.equal(calls(), 1);
        assert.ok(logs.some(line => line.includes('驱离式敷衍') && line.includes('带说明重写一次')));
        assert.ok(logs.some(line => line.includes('重写后通过')));
    });

    test('重写后仍不过、重写失败、重写出空回复或禁用词：都发固定兜底', async () => {
        for (const regenerated of [['还是别想太多了'], ['晚安，早点睡'], [''], ['我在，我也在山青']] as string[][]) {
            const { opts } = options(regenerated);
            assert.equal(await reviewCrisisReply('开玩笑吧，晚安', opts), CRISIS_FALLBACK, regenerated.join());
        }
        const failing = options(new Error('网络断了'));
        assert.equal(await reviewCrisisReply('至于吗', failing.opts), CRISIS_FALLBACK);
        assert.ok(failing.logs.some(line => line.includes('重写失败')));
    });

    test('重写说明只说哪句不行、怎么改，不带台词', () => {
        const note = crisisRewriteNote([{ kind: 'close', match: '晚安' }, { kind: 'dismiss', match: '想开点' }], '宝宝');
        assert.match(note, /不要道晚安/);
        assert.match(note, /当成不严重/);
        assert.match(note, /^\[上一版回复没有发出去/);
    });
});
