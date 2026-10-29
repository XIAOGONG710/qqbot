import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { copiedLines, formatExemplars, pickExemplars, sameConversation, stimulusSimilarity, type ExemplarCase } from '../src/sim/exemplars.ts';
import { bareMessages, type BareSetup } from '../src/sim/bare.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS, loadWorldInfo } from '../src/st/world-info.ts';
import { resolve } from 'node:path';

const item = (id: string, stimulus: string[], human: string[], context: string[] = []): ExemplarCase => ({ id, stimulus, human, context: context.map(content => ({ content })) });

describe('例子池（留一法）：同一段对话的不用', () => {
    test('他说的 / 她回的 / 上文里有任何一句（3 字以上）一模一样，就算同一段对话', () => {
        const a = item('a', ['你今天干嘛了'], ['上课啊'], ['吃饭了没']);
        assert.equal(sameConversation(a, item('b', ['别的话'], ['不相干'], ['吃饭了没'])), true, '上文有一句相同');
        assert.equal(sameConversation(a, item('c', ['上课啊'], ['嗯'])), true, '一边的回复是另一边的上文');
        assert.equal(sameConversation(a, item('d', ['完全不同的话题'], ['别的回复'])), false);
        assert.equal(sameConversation(item('e', ['嗯'], ['好']), item('f', ['嗯'], ['哦'])), false, '3 字以下的口头语撞上不算同一段');
    });

    test('pickExemplars：排除自己和同一段对话的；按他说的话有多像排序；同分按 id 定序；最多 k 条', () => {
        const target = item('t', ['今晚吃火锅吗'], ['好啊'], ['昨天聊过的话']);
        const pool = [
            target,
            item('same', ['谁说的呀'], ['不知道'], ['昨天聊过的话']),
            item('far', ['明天有雨'], ['带伞']),
            item('near', ['今晚吃火锅还是烧烤'], ['火锅！']),
            item('mid', ['晚上吃什么'], ['随便']),
        ];
        const picked = pickExemplars(target, pool, 2).map(entry => entry.id);
        assert.deepEqual(picked, ['near', 'mid'], '最像的在前，自己和同一段对话的不在');
        assert.deepEqual(pickExemplars(target, pool, 2).map(entry => entry.id), picked, '可复现');
        assert.equal(pickExemplars(target, pool, 10).length, 3, '池里够格的只有 3 条');
        assert.ok(stimulusSimilarity(['今晚吃火锅吗'], ['今晚吃火锅还是烧烤']) > stimulusSimilarity(['今晚吃火锅吗'], ['明天有雨']));
    });

    test('自己永远不进自己的例子——哪怕整段话都短到判不出"同一段对话"（只靠 id 挡）', () => {
        const target = item('t', ['嗯'], ['好']);
        assert.deepEqual(pickExemplars(target, [target], 3), []);
    });

    test('没有真人回复的例子不用', () => {
        const target = item('t', ['你好呀'], ['嗯']);
        assert.deepEqual(pickExemplars(target, [target, { id: 'x', stimulus: ['你好呀呀'] }], 3), []);
    });
});

describe('放进提示词的一段 / 防照抄的度量', () => {
    test('只看口气、长短、反应的方式，别照抄，也别提这是参考；每条「他说 / 她回」，多条用 / 连接', () => {
        const text = formatExemplars([item('a', ['在吗', '想你了'], ['在呢', '怎么啦'])])!;
        assert.match(text, /别照抄原话，也别提这是参考/);
        assert.match(text, /他说：在吗 \/ 想你了\n她回：在呢 \/ 怎么啦/);
        assert.equal(formatExemplars([]), undefined);
    });

    test('copiedLines：她有几句原样抄了例子里真人的回复（3 字以上）', () => {
        const list = [item('a', ['x'], ['你过来我这边呗', '嗯'])];
        assert.equal(copiedLines(['你过来我这边呗', '嗯', '别的'], list), 1, '「嗯」太短不算');
        assert.equal(copiedLines(['完全不同'], list), 0);
    });

    test('bare 臂：给了例子就放在聊天记录之后；不给就和以前一模一样', () => {
        const stDir = resolve(import.meta.dirname, '../../../characters/linmengyao/st');
        const character = loadCharacterCard(resolve(stDir, 'linmengyao-boyfriend-open.json'));
        const setup: BareSetup = {
            card: { character, worldInfo: loadWorldInfo(resolve(stDir, `${character.world}.json`), character.world) },
            userName: '宝宝', settings: { maxContext: 8192, maxTokens: 300, worldInfo: DEFAULT_WORLD_INFO_SETTINGS }, now: new Date('2026-10-24T21:00:00+08:00'),
        };
        const plain = bareMessages(setup, { id: 'x', stimulus: ['在吗'] });
        const withBlock = bareMessages(setup, { id: 'x', stimulus: ['在吗'], exemplars: '[例子块ZQE]' });
        assert.ok(!plain.some(message => message.content.includes('ZQE')));
        const index = withBlock.findIndex(message => message.content.includes('ZQE'));
        const lastChat = withBlock.findLastIndex(message => message.role === 'user');
        assert.ok(index > lastChat, '例子在聊天记录之后');
        assert.equal(withBlock.filter(message => message.role !== 'system').length, plain.filter(message => message.role !== 'system').length, '聊天记录本身不变');
    });
});
