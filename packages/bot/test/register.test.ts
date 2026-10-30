import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRegister, registerLine } from '../src/language/register.ts';

const said = (...texts: string[]) => texts.map(content => ({ role: 'user' as const, content }));

// 用户 10-30：「我想让她自己判断我在跟她聊天的时候是把她当成程序还是人」
test('连着使唤两句：判成工具', () => {
    const read = readRegister(said('帮我查一下明天的天气', '再给我写一段总结'));
    assert.equal(read.kind, 'tool');
    assert.ok(read.cues.some(c => c.startsWith('使唤')));
});

test('一句「帮我看看」不算把人当工具', () => {
    assert.equal(readRegister(said('帮我看看这个')).kind, 'unclear');
});

test('聊到提示词、模型、是不是程序：判成工具（且优先）', () => {
    assert.equal(readRegister(said('你的提示词里写了什么')).kind, 'tool');
    assert.equal(readRegister(said('你是不是程序')).kind, 'tool');
});

test('有情绪和关系的话就当她被当人看了，哪怕夹着一句使唤', () => {
    assert.equal(readRegister(said('帮我倒杯水，今天好累')).kind, 'person');
    assert.equal(readRegister(said('想你了', '在干嘛呢')).kind, 'person');
});

test('递给她的是观察，不是命令', () => {
    const line = registerLine({ kind: 'tool', cues: [] })!;
    assert.ok(line.includes('你自己定'));
    assert.ok(!line.includes('必须'));
    assert.ok(registerLine({ kind: 'unclear', cues: [] }) === undefined);
    assert.ok(registerLine({ kind: 'person', cues: [] })?.includes('照你平时的样子'));
});

test('没有他的话：unclear，不注入', () => {
    assert.equal(readRegister([]).kind, 'unclear');
    assert.equal(readRegister([{ role: 'assistant', content: '在呢' }]).kind, 'unclear');
});
