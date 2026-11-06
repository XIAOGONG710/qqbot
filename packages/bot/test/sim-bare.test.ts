import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { bareMessages, bubblesOf, runBare, type BareCase, type BareSetup } from '../src/sim/bare.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS, loadWorldInfo } from '../src/st/world-info.ts';
import { syntheticStDir, syntheticCardPath } from './fixtures/card.ts';

const stDir = syntheticStDir;
const character = loadCharacterCard(syntheticCardPath('boyfriend', true));
const setup: BareSetup = {
    card: { character, worldInfo: loadWorldInfo(resolve(stDir, `${character.world}.json`), character.world) },
    userName: '宝宝',
    settings: { maxContext: 8192, maxTokens: 300, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
    now: new Date('2026-10-24T21:00:00+08:00'),
};
const item: BareCase = {
    id: 'jc-001',
    stimulus: ['在吗', '想你了'],
    context: [{ role: 'user', content: '吃饭了没' }, { role: 'assistant', content: '刚吃完' }],
};

describe('「不带框架」对照臂（ADR 0175）', () => {
    test('提示词 = 卡 + 聊天记录：卡的描述在，聊天按原顺序，他这一轮的每个气泡各占一条，没有运行时塞的提示行', () => {
        const messages = bareMessages(setup, item);
        const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        assert.ok(system.includes('在读大学生'), '角色卡的描述在（宏已替换）');
        assert.ok(system.includes('说话短，一条消息一两句'), '卡自己写的说话规矩在（persona 的 reply_style）——B 是「卡作者写的东西」，不是空白模型');
        const chat = messages.filter(m => m.role !== 'system');
        assert.deepEqual(chat.map(m => [m.role, m.content]), [['user', '吃饭了没'], ['assistant', '刚吃完'], ['user', '在吗'], ['user', '想你了']]);
        // 运行时才有的东西（contact.ts 现拼的「他最后说的是」、时间提示）一律不带；整块「系统部分每轮不变」见下一条
        for (const marker of ['他最后说的是：「', '先接这一句，别接更早的话']) assert.ok(!system.includes(marker), marker);
    });

    test('只有卡的内容：没有 afterMain / afterHistory 那类运行时消息', () => {
        const withoutChat = bareMessages(setup, { id: 'x', stimulus: ['嗯'] }).filter(m => m.role === 'system');
        const fromCardOnly = bareMessages(setup, { id: 'y', stimulus: ['别的话'] }).filter(m => m.role === 'system');
        assert.deepEqual(withoutChat.map(m => m.content), fromCardOnly.map(m => m.content), '换一句话，系统部分一字不变——没有随这一轮变的东西');
    });

    test('回复按行拆成气泡，空行跳过', () => {
        assert.deepEqual(bubblesOf('在呢\n\n怎么了'), ['在呢', '怎么了']);
    });

    test('runBare：每题只生成一次；失败的和空话单独记，不拖累别的题', async () => {
        const cases: BareCase[] = [item, { id: 'jc-002', stimulus: ['坏的'] }, { id: 'jc-003', stimulus: ['空的'] }, { id: 'jc-004', stimulus: ['好的'] }];
        const calls: string[] = [];
        const run = await runBare(cases, {
            setup,
            parallel: 2,
            generate: async messages => {
                const last = messages.filter(m => m.role !== 'system').at(-1)!.content;
                calls.push(last);
                if (last === '坏的') throw new Error('模型连不上');
                if (last === '空的') return '  \n ';
                return `回：${last}\n第二条`;
            },
        });
        assert.equal(calls.length, 4, '一题一次');
        assert.deepEqual(Object.keys(run.hers).sort(), ['jc-001', 'jc-004']);
        assert.deepEqual(run.hers['jc-004'], ['回：好的', '第二条']);
        assert.deepEqual(run.failed.map(f => f.id).sort(), ['jc-002', 'jc-003']);
        assert.match(run.failed.find(f => f.id === 'jc-002')!.error, /模型连不上/);
    });
});
